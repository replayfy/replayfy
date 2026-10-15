import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis.module";
import {
  APP_STATE_TTL_MS,
  appStateKey,
  type AppState,
  CANCEL_RETAIN_MS,
  FINALIZE_OVERDUE_MAX_MS,
  framesCancelKey,
  framesStreamKey,
  SESSION_EXPIRY_ZSET,
  idleMs,
} from "./frames.constants";

/** FramesStreamService.pendingFinalize: sessions by finalize state. */
export interface FinalizeStates {
  /** A frames finalize is still to come. */
  pending: Set<string>;
  /** Ended longer than FINALIZE_OVERDUE_MAX_MS ago and still not finalized
   *  (still "being processed" to GET /frames, within its age bound). */
  overdue: Set<string>;
}

/**
 * Ingest WRITE path for mobile frames — the hot path behind
 * POST /v1/mobile/images. Replaces the old disk append (fs.appendFile).
 *
 * Does exactly two Redis writes, pipelined into ONE round-trip, and NOTHING
 * else — no parsing, no gzip, no R2, no Postgres, no disk:
 *
 *   XADD frames:{sid} * ts <recvMs> data <raw>     (durable ordered append)
 *   ZADD session:expiry <recvMs + idleMs> sid       (arm/extend the idle timer)
 *
 * The stream is the durable buffer the worker drains; the ZSET score is the
 * epoch-ms the session is considered ended. Re-arming it on every batch is the
 * "session is still alive" heartbeat — once batches stop for idleMs, the score
 * falls into the past and the session gets finalized. User interaction on the
 * message path extends it too (trackMessageBatch), so pausing frames isn't an
 * ending.
 *
 * Stateless + Redis-only ⇒ any ingest node can serve any batch (horizontal
 * scale), and an XADD survives Redis reconnects (client queues + replays), so
 * the SDK never sees a transient blip. Target: <10ms.
 */
@Injectable()
export class FramesStreamService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Append one batch's raw `[ts][size][jpeg]` bytes for a session.
   * `recvMs` is the server receive time (the SDK's own frame timestamps are
   * inside `raw` and are re-derived by the worker — ingest never parses).
   */
  async append(sid: string, raw: Buffer, recvMs: number): Promise<void> {
    // Access pattern: O(1) append keyed by session id + O(log N) ZADD on the
    // expiry set. No table scans, no per-row loops; scales horizontally because
    // it's pure Redis with no shared in-process state. Pipelined → 1 RTT.
    //
    // PERSIST clears any retention TTL a prior finalize left on the stream: if
    // this session RESUMES the same id, its frames must not expire mid-record.
    // No-op (cheap) on a stream with no TTL — the common, never-finalized case.
    await this.redis
      .multi()
      .xadd(framesStreamKey(sid), "*", "ts", String(recvMs), "data", raw)
      .persist(framesStreamKey(sid))
      .zadd(SESSION_EXPIRY_ZSET, String(recvMs + idleMs()), sid)
      .exec();
  }

  /**
   * The message path's per-batch session state (/v1/mobile/i and /late), in
   * ONE round-trip:
   *
   *   • App state. Whether the app is in the foreground or the background, as
   *     the batches last showed it. `appState` is what THIS batch shows (null:
   *     nothing), stored for APP_STATE_TTL_MS past the last batch. Returns the
   *     state from BEFORE this batch — null when unknown (never shown, or
   *     expired) — because a batch's performance samples are activity only
   *     while the app is in the foreground, and the samples ahead of the
   *     batch's own first marker take the earlier state (see MobileService).
   *
   *   • keepAlive (when `keepAlive`): hold a recording session open while its
   *     user is active but no frames are arriving (an excluded screen,
   *     pauseRecording, a capture opt-out); the caller asks for it on a batch
   *     with user input. Without it, idleMs after the last frames batch the
   *     session was finalized and marked COMPLETED mid-use. Only EXTENDS a
   *     session that is still active (score in the future) and only forward.
   *     It never arms a session the frames path hasn't (an event-only session
   *     keeps ending through the LIVE sweep, and is never leased), and never
   *     revives one that already ended — /late dropped its score into the
   *     past, or the finalizer removed it — so a straggling message batch
   *     can't hold back an ended session's finalize.
   *
   * Kept beside the expiry score because both are liveness state the message
   * path reads per batch, so one round-trip serves both.
   *
   * Access pattern: one EVAL per message batch — GET + SET/EXPIRE on the
   * session's own state key (O(1)) and, for keepAlive, ZSCORE + ZADD on the
   * expiry set (O(log N)). No stream or Postgres I/O. Scripted (not ZADD XX
   * GT) because GT needs Redis 6.2 and prod runs 6.0.
   */
  async trackMessageBatch(
    sid: string,
    recvMs: number,
    opts: { appState: AppState | null; keepAlive: boolean },
  ): Promise<AppState | null> {
    const prior = await this.redis.eval(
      FramesStreamService.MESSAGE_BATCH_LUA,
      2,
      appStateKey(sid),
      SESSION_EXPIRY_ZSET,
      opts.appState ?? "",
      String(Math.ceil(APP_STATE_TTL_MS / 1000)),
      opts.keepAlive ? "1" : "0",
      sid,
      String(recvMs),
      String(recvMs + idleMs()),
    );
    return prior === "foreground" || prior === "background" ? prior : null;
  }

  /** KEYS: app state, expiry zset. ARGV: new state ('' = none), state TTL
   *  secs, keepAlive flag, sid, now, now + idleMs. Returns the prior state. */
  private static readonly MESSAGE_BATCH_LUA = `
    local prior = redis.call('GET', KEYS[1])
    if ARGV[1] ~= '' then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    elseif prior then
      redis.call('EXPIRE', KEYS[1], ARGV[2])
    end
    if ARGV[3] == '1' then
      local score = redis.call('ZSCORE', KEYS[2], ARGV[4])
      if score and tonumber(score) > tonumber(ARGV[5])
         and tonumber(score) < tonumber(ARGV[6]) then
        redis.call('ZADD', KEYS[2], ARGV[6], ARGV[4])
      end
    end
    return prior`;

  /**
   * Mark a session ended NOW (the /late terminate beacon). Just drops its
   * expiry score into the past so the next worker/finalizer tick picks it up —
   * no synchronous packing on the request path. Idempotent.
   */
  async markEnded(sid: string, recvMs: number): Promise<void> {
    // Score = recvMs - 1 ⇒ strictly in the past ⇒ enters the "ended" range.
    await this.redis.zadd(SESSION_EXPIRY_ZSET, String(recvMs - 1), sid);
  }

  /**
   * Discard a cancelled session's frames (POST /v1/mobile/cancel). DELETE the
   * durable stream so NOTHING more gets packed to R2, mark the session
   * cancelled, then drop the expiry score into the past so the finalizer picks
   * it up on its next tick. The mark is what makes the finalizer DISCARD the
   * recording — abort the warm upload, delete an archive an earlier finalize
   * stored, zero its counters — rather than treat the missing stream as
   * "nothing new" and leave that archive playable. It outlives the finalize
   * (CANCEL_RETAIN_MS), so frames still in flight are discarded too.
   * Access pattern: O(1) DEL + O(1) SET + O(log N) ZADD, pipelined into one
   * round-trip — same shape as the append hot path, no scans. Idempotent.
   */
  async drop(sid: string, recvMs: number): Promise<void> {
    await this.redis
      .multi()
      .del(framesStreamKey(sid))
      .set(framesCancelKey(sid), "1", "PX", CANCEL_RETAIN_MS)
      .zadd(SESSION_EXPIRY_ZSET, String(recvMs - 1), sid)
      .exec();
  }

  /** How long pendingFinalize waits for Redis before it fails open. */
  private static readonly PENDING_TIMEOUT_MS = 2_000;

  /**
   * Where each of `sids` stands with its frames finalize, by its expiry score:
   *
   *   • pending: a finalize is still to come. The score is in the future
   *     (frames still arriving, or less than idleMs since the last batch), or
   *     in the past by less than FINALIZE_OVERDUE_MAX_MS (ended; the finalize
   *     is queued, running, or retrying after a failure). The LIVE sweep keeps
   *     these LIVE (unlisted) until the finalizer completes them together with
   *     their archive, and GET /frames reports them as pending.
   *   • overdue: the score is further in the past than that. The finalize
   *     keeps failing, or is stuck behind a longer backlog, so it stops
   *     counting: the sweep completes the session without its archive (a
   *     broken finalizer can delay a listing by the cap, never strand it).
   *     GET /frames still reports it as pending while the session is less
   *     than 2.5 days old (MobileFramesService), because a retried finalize
   *     can still store the archive; the cap only bounds the listing.
   *
   * A sid in neither set has no score: it never had frames, or it is
   * finalized (cleanup removes the score).
   *
   * Access pattern: one ZSCORE per sid (O(log N) each) pipelined into ONE
   * round-trip; ZMSCORE would be one command but needs Redis 6.2 (prod runs
   * 6.0). Callers pass at most one sweep page. Fails open: a Redis error, or
   * no reply within PENDING_TIMEOUT_MS (the shared client queues commands
   * while disconnected, maxRetriesPerRequest: null), returns two empty sets,
   * so the sweep flips sessions as it did before rather than stall.
   */
  async pendingFinalize(
    sids: readonly string[],
    now: number,
  ): Promise<FinalizeStates> {
    const states: FinalizeStates = { pending: new Set(), overdue: new Set() };
    if (sids.length === 0) return states;
    const pipeline = this.redis.pipeline();
    for (const sid of sids) pipeline.zscore(SESSION_EXPIRY_ZSET, sid);
    let timer: NodeJS.Timeout | undefined;
    try {
      const replies = await Promise.race([
        pipeline.exec(),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            FramesStreamService.PENDING_TIMEOUT_MS,
          );
        }),
      ]);
      if (!replies) return states; // no answer in time: fail open
      replies.forEach(([err, score], i) => {
        if (err || score === null || score === undefined) return;
        // One comparison covers both halves of pending: a score in the
        // future, and one in the past by less than the cap.
        if (Number(score) > now - FINALIZE_OVERDUE_MAX_MS) {
          states.pending.add(sids[i]);
        } else {
          states.overdue.add(sids[i]);
        }
      });
      return states;
    } catch {
      return { pending: new Set(), overdue: new Set() };
    } finally {
      clearTimeout(timer);
    }
  }
}
