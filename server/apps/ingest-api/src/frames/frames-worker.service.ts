import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { randomBytes } from "crypto";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis.module";
import { StorageService } from "../storage/storage.service";
import {
  framesOwnerKey,
  framesStreamKey,
  nextStreamId,
  SESSION_EXPIRY_ZSET,
} from "./frames.constants";
import { SessionUpload } from "./session-upload";
import { FramesFinalizerService } from "./frames-finalizer.service";

/**
 * Frames STREAM worker — drains per-session Redis streams and pushes each
 * session's gzip archive to R2 incrementally (multipart parts as ≥5 MiB of
 * output accumulates), then completes the upload when the session ends. No
 * disk anywhere.
 *
 * Ownership model (gives ordering + single-writer multipart + horizontal
 * scale): each worker leases a session via `SET frames:owner:{sid} <me> NX`
 * before touching it, renews the lease each tick, and keeps the session's warm
 * gzip state in memory. Because it holds that state, the OWNER finalizes its
 * own sessions the moment they go idle (the cheap path — just flush the tail +
 * complete). A dead owner's sessions are rebuilt from the durable stream by
 * FramesFinalizerService's orphan poll.
 *
 * The single `session:expiry` ZSET drives everything: score > now ⇒ active
 * (drain); score ≤ now ⇒ ended (finalize). Runs in every API instance; the NX
 * lease ensures only one instance owns any given session.
 */
@Injectable()
export class FramesWorkerService implements OnModuleDestroy {
  private readonly log = new Logger(FramesWorkerService.name);
  private readonly enabled =
    (process.env.FRAMES_WORKER_ENABLED ?? "true") !== "false";
  private readonly workerId = randomBytes(8).toString("hex");
  private readonly leaseTtlMs =
    Number(process.env.FRAMES_LEASE_TTL_MS) || 15_000;
  /** Cap sessions owned per instance so memory (one gzip stream each) is
   *  bounded; unowned active sessions are picked up by other instances. */
  private readonly maxOwned = Number(process.env.FRAMES_MAX_OWNED) || 250;

  private readonly owned = new Map<string, SessionUpload>();
  private ticking = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly finalizer: FramesFinalizerService,
  ) {}

  @Interval(Number(process.env.FRAMES_WORKER_TICK_MS) || 1_000)
  async tick(): Promise<void> {
    // NOTE: deliberately NOT gated on storage.enabled. With no R2 (local dev),
    // we still drain the streams + write session metadata + clean up Redis —
    // the multipart calls inside no-op, so there's just no archive. Gating here
    // would leak Redis (streams + expiry set never reclaimed) and leave mobile
    // sessions stuck LIVE with 0 frames, which the legacy disk path didn't.
    if (!this.enabled) return;
    if (this.ticking) return; // never overlap ticks
    this.ticking = true;
    try {
      const now = Date.now();

      // 1. Owned sessions: check each one's expiry score (bounded by owned
      //    size, NOT by the global ended backlog — so a worker can't stall on a
      //    large ZSET). Score ≤ now (or gone) ⇒ finalize with warm state; else
      //    renew lease + drain new frames.
      const sids = [...this.owned.keys()];
      if (sids.length > 0) {
        const pipe = this.redis.pipeline();
        for (const sid of sids) pipe.zscore(SESSION_EXPIRY_ZSET, sid);
        const res = await pipe.exec();
        for (let i = 0; i < sids.length; i++) {
          const sid = sids[i];
          const upload = this.owned.get(sid);
          if (!upload) continue;
          const raw = res?.[i]?.[1] as string | null | undefined;
          const score = raw == null ? null : Number(raw);
          if (score == null || score <= now) {
            await this.finalizeOwned(sid, upload);
          } else if (!(await this.renewLease(sid))) {
            // Lost the lease (stall/takeover) — drop local state without
            // finalizing; whoever holds it now (or the orphan poll) owns it.
            await upload.abort().catch(() => {});
            this.owned.delete(sid);
          } else {
            await this.drain(sid, upload);
          }
        }
      }

      // 2. Discover + drain NEW active sessions (score > now), bounded page.
      const activeList = await this.redis.zrangebyscore(
        SESSION_EXPIRY_ZSET,
        `(${now}`,
        "+inf",
        "LIMIT",
        0,
        1000,
      );
      for (const sid of activeList) {
        if (this.owned.has(sid)) continue;
        if (this.owned.size >= this.maxOwned) break;
        if (!(await this.acquireLease(sid))) continue; // another instance owns it
        // If a previous (dead) owner left a half-done multipart for this
        // session, reclaim its staged parts before we rebuild from the stream.
        await this.finalizer.abortStaleUpload(sid);
        const upload = new SessionUpload(sid, this.storage, this.redis);
        this.owned.set(sid, upload);
        await this.drain(sid, upload);
      }
    } catch (err) {
      this.log.warn(`tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful shutdown: abort in-flight uploads + release leases, leaving the
    // stream + expiry entry intact so another instance rebuilds cleanly.
    for (const [sid, upload] of this.owned) {
      await upload.abort().catch(() => {});
      await this.releaseLease(sid).catch(() => {});
    }
    this.owned.clear();
  }

  /** Drain newly-arrived stream entries into the session's gzip upload. */
  private async drain(sid: string, upload: SessionUpload): Promise<void> {
    const streamKey = framesStreamKey(sid);
    // Inclusive start at the id AFTER lastId (portable across Redis 6.0, which
    // rejects the `(id` exclusive operator — see nextStreamId).
    let start = upload.lastId ? nextStreamId(upload.lastId) : "-";
    for (let page = 0; page < 20; page++) {
      // Bounded pages so one busy session can't monopolise a tick. The stream
      // is retained until finalize, so any remainder is read next tick.
      const entries = (await this.redis.xrangeBuffer(
        streamKey,
        start,
        "+",
        "COUNT",
        500,
      )) as Array<[Buffer, Buffer[]]>;
      if (entries.length === 0) break;
      for (const [id, fields] of entries) {
        const data = this.fieldValue(fields, "data");
        if (data) await upload.writeBatch(data);
        upload.lastId = id.toString();
      }
      await upload.flushFullParts();
      start = nextStreamId(upload.lastId);
      if (entries.length < 500) break;
    }
  }

  /** Complete an owned session's upload using its warm in-memory state. */
  private async finalizeOwned(
    sid: string,
    upload: SessionUpload,
  ): Promise<void> {
    this.owned.delete(sid);
    if (!(await this.finalizer.acquireFinalizeLock(sid))) {
      // Someone else is finalizing (e.g. our lease lapsed) — discard our parts.
      await upload.abort().catch(() => {});
      return;
    }
    try {
      // Drain any final entries that landed since the last tick, then complete.
      await this.drain(sid, upload);
      await upload.finish();
      await this.finalizer.recordAndCleanup(sid, {
        count: upload.count,
        bytes: upload.bytes,
        lastTs: upload.lastTs,
      });
    } catch (err) {
      this.log.warn(`finalize ${sid} failed: ${String(err)}`);
      await upload.abort().catch(() => {});
    }
  }

  private async acquireLease(sid: string): Promise<boolean> {
    const res = await this.redis.set(
      framesOwnerKey(sid),
      this.workerId,
      "PX",
      this.leaseTtlMs,
      "NX",
    );
    return res === "OK";
  }

  /** Renew only if we still hold it (value-checked) — never stomp a takeover. */
  private async renewLease(sid: string): Promise<boolean> {
    const res = (await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      framesOwnerKey(sid),
      this.workerId,
      String(this.leaseTtlMs),
    )) as number;
    return res === 1;
  }

  private async releaseLease(sid: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      framesOwnerKey(sid),
      this.workerId,
    );
  }

  private fieldValue(fields: Buffer[], name: string): Buffer | null {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i].toString() === name) return fields[i + 1];
    }
    return null;
  }
}
