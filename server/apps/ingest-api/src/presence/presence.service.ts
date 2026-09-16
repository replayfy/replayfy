import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis.module";

/**
 * Redis-backed live presence — "how many people are using your app right now".
 *
 * Replaces the LiveGateway's in-memory `Map<sessionId, PresenceEntry>`, which
 * had a fatal flaw for horizontal scale: the map lives in ONE process, so the
 * instant ingest runs on more than one node (or the WebSocket gateway is split
 * out), every reader sees only the slice of presence whose SDK sockets happened
 * to land on that node. Moving presence to Redis makes it node-local-state-free:
 * any ingest node records activity, any api node reads the true global count.
 *
 * Model: two per-workspace sorted sets, member → last-seen epoch ms.
 *   presence:u:{ws}  member = endUser distinctId   (distinct PEOPLE)
 *   presence:s:{ws}  member = session publicId      (live SESSIONS / live-dot)
 * "Online" = score within a rolling window (default 30s, ~the SDK batch cadence
 * and the old socket grace period). Writes come from the INGEST accept path —
 * an actual batch is a far more reliable "still here" signal than a held-open
 * socket, and it makes presence independent of worker-drain lag. BOTH writes and
 * reads prune the stale tail (so a continuously-ingested-but-never-read set can
 * never grow past its active membership), and each key carries a TTL so a fully
 * idle workspace's sets vanish on their own. Reads are fail-soft (timeout →
 * "nobody online") so a Redis blip never stalls a core dashboard/recordings read.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Active-within-this-window = online. 30s covers the gap between SDK batches
  // so a mid-session user always counts as present.
  private readonly windowMs = Number(process.env.PRESENCE_WINDOW_MS ?? 30_000);
  // Idle-workspace self-clean: a set with no new writes for this long is
  // dropped by Redis. Comfortably larger than the window.
  private readonly keyTtlMs = Number(
    process.env.PRESENCE_KEY_TTL_MS ?? 300_000,
  );
  // Presence is a best-effort UI signal — it must never take down a core read.
  // The shared ioredis client uses maxRetriesPerRequest:null + offline queue, so
  // a Redis outage makes a command HANG (queued) rather than reject; without a
  // bound, a Redis blip would stall the Postgres-backed Overview counts + the
  // recordings list. Reads race this timeout and fall back to "nobody online".
  private readonly readTimeoutMs = Number(
    process.env.PRESENCE_READ_TIMEOUT_MS ?? 300,
  );

  private userKey(workspaceId: number): string {
    return `presence:u:${workspaceId}`;
  }
  private sessionKey(workspaceId: number): string {
    return `presence:s:${workspaceId}`;
  }

  /**
   * Record a user + session as active NOW. Called on every ACCEPTED batch at
   * ingest time. Two ZADDs (score = last-seen ms; a re-touch just updates the
   * score) + two PEXPIREs, pipelined into ONE round-trip. O(log N) — no scans,
   * no per-node state, so it scales horizontally exactly like the frames XADD.
   */
  async touch(
    workspaceId: number,
    sessionId: string,
    distinctId: string,
    nowMs: number,
  ): Promise<void> {
    const uKey = this.userKey(workspaceId);
    const sKey = this.sessionKey(workspaceId);
    const min = nowMs - this.windowMs;
    // Prune the stale tail ON EVERY WRITE (not just on read). Reads may never
    // come — a workspace can ingest 24/7 while its dashboard is opened weekly —
    // and the pexpire below re-arms the TTL on every batch, so without a write
    // prune the set would grow one member per session forever (session ids
    // never coalesce) until Redis OOMs. Trimming after the zadd keeps each set
    // bounded to its active-window membership at all times; it's one extra op in
    // the same pipelined round-trip, and the removed tail is tiny when trimmed
    // continuously. (zadd first so the just-added now-scored member survives.)
    await this.redis
      .pipeline()
      .zadd(uKey, nowMs, distinctId)
      .zadd(sKey, nowMs, sessionId)
      .zremrangebyscore(uKey, "-inf", `(${min}`)
      .zremrangebyscore(sKey, "-inf", `(${min}`)
      .pexpire(uKey, this.keyTtlMs)
      .pexpire(sKey, this.keyTtlMs)
      .exec();
  }

  /**
   * Online end-USER count — distinct people active in the window. THE
   * "people using your app" number. Prunes the stale tail then counts what
   * remains; both in one round-trip.
   */
  async onlineUserCount(workspaceId: number, nowMs: number): Promise<number> {
    return this.countActive(this.userKey(workspaceId), nowMs);
  }

  /** Live SESSION count in the window (a user may have several). */
  async liveSessionCount(workspaceId: number, nowMs: number): Promise<number> {
    return this.countActive(this.sessionKey(workspaceId), nowMs);
  }

  /**
   * The set of session public-ids currently live — drives the recordings-list
   * live-dot. Prunes the stale tail then returns the active members (1 RTT).
   */
  async liveSessionIds(
    workspaceId: number,
    nowMs: number,
  ): Promise<Set<string>> {
    const key = this.sessionKey(workspaceId);
    const min = nowMs - this.windowMs;
    // Fail-soft → empty set: the live-dot is decorative, and a Redis outage must
    // not hang the Postgres-backed recordings list.
    return this.failSoft(
      this.redis
        .pipeline()
        .zremrangebyscore(key, "-inf", `(${min}`) // drop score < min (stale)
        .zrangebyscore(key, min, "+inf") // remaining = active in window
        .exec()
        .then(
          (res) => new Set((res?.[1]?.[1] as string[] | undefined) ?? []),
        ),
      new Set<string>(),
    );
  }

  /** Prune members older than the window, then return the count that remain
   *  (all necessarily active). One pipelined round-trip. Fail-soft → 0. */
  private async countActive(key: string, nowMs: number): Promise<number> {
    const min = nowMs - this.windowMs;
    return this.failSoft(
      this.redis
        .pipeline()
        .zremrangebyscore(key, "-inf", `(${min}`)
        .zcard(key)
        .exec()
        .then((res) => Number(res?.[1]?.[1] ?? 0)),
      0,
    );
  }

  /** Race a presence read against the timeout and swallow errors — a Redis
   *  outage/hang degrades presence to `fallback` (nobody online) instead of
   *  stalling or 500ing the caller. The timer is cleared when the op wins. */
  private failSoft<T>(op: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), this.readTimeoutMs);
    });
    return Promise.race([op.catch(() => fallback), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
