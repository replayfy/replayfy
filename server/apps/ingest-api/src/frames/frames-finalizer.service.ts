import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { Redis } from "ioredis";
import { getPostgresClient } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";
import { StorageService } from "../storage/storage.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { SignalsService } from "../signals/signals.service";
import {
  finalizeLockKey,
  framesGzKey,
  framesMpKey,
  framesOwnerKey,
  framesStreamKey,
  nextStreamId,
  streamRetainMs,
  SESSION_EXPIRY_ZSET,
} from "./frames.constants";
import { SessionUpload } from "./session-upload";

/** Running totals a finalizing party computed while producing the archive. */
export interface FrameTotals {
  count: number;
  bytes: number;
  lastTs: number;
}

/**
 * Session lifecycle / finalization.
 *
 * Replaces the legacy filesystem sweep (setInterval + readdir/stat) with a
 * Redis sorted-set poll. Two responsibilities:
 *
 *   1. recordAndCleanup() — the SHARED tail of every finalize: complete-time
 *      Postgres accounting (moved off the ingest hot path) + Redis cleanup.
 *      Called by the stream worker after it completes an owned session's
 *      upload, AND by this service's orphan path. The CALLER must already hold
 *      the finalize:{sid} lock.
 *
 *   2. The @Interval orphan poll — finalizes ENDED sessions that have NO live
 *      owner (the owning instance died, or the session never got leased).
 *      It rebuilds the archive from the durable stream from scratch, since the
 *      dead owner's in-memory gzip state is gone.
 *
 * Idempotency: SET finalize:{sid} NX guards single execution; the Postgres
 * write is an absolute SET (re-runnable) and the storage-stats bump is by the
 * delta vs the session's previous dataSizeBytes, so a rare double finalize
 * after a mid-crash can't double-count.
 */
@Injectable()
export class FramesFinalizerService {
  private readonly log = new Logger(FramesFinalizerService.name);
  private readonly db = getPostgresClient();
  private readonly enabled =
    (process.env.FRAMES_WORKER_ENABLED ?? "true") !== "false";
  private polling = false;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly stats: WorkspaceStatsService,
    private readonly signals: SignalsService,
  ) {}

  /** NX idempotency lock. Returns true if THIS caller may finalize `sid`. */
  async acquireFinalizeLock(sid: string): Promise<boolean> {
    const res = await this.redis.set(
      finalizeLockKey(sid),
      "1",
      "PX",
      300_000,
      "NX",
    );
    return res === "OK";
  }

  /**
   * Abort + clear any multipart upload a previous (dead) owner left half-done,
   * so its staged parts don't linger in R2 as an incomplete upload. Single-
   * deflate parts can't be resumed across a process, so whoever takes the
   * session over rebuilds from the durable stream — this just reclaims the
   * orphaned parts. Called when a worker re-leases a session AND before an
   * orphan rebuild. No-op when there's no prior upload (the common case).
   */
  async abortStaleUpload(sid: string): Promise<void> {
    const staleUploadId = await this.redis.hget(framesMpKey(sid), "uploadId");
    if (staleUploadId) {
      await this.storage.abortMultipartUpload(framesGzKey(sid), staleUploadId);
      await this.redis.del(framesMpKey(sid));
    }
  }

  /**
   * Complete-time accounting + cleanup. The archive object has already been
   * completed by the caller; here we (a) write the session's final
   * count/size/duration to Postgres, (b) HEAD the object so it's warm before
   * the frontend asks, (c) drop all Redis state for the session.
   */
  async recordAndCleanup(sid: string, totals: FrameTotals): Promise<void> {
    try {
      // publicId is indexed (same lookup the replay read path uses) — a single
      // PK-style fetch at finalize, not per-batch. No N+1.
      const session = await this.db.session.findFirst({
        where: { publicId: sid },
        select: {
          id: true,
          workspaceId: true,
          startedAt: true,
          dataSizeBytes: true,
          durationMs: true,
        },
      });
      if (session) {
        const newBytes = BigInt(totals.bytes);
        const delta = newBytes - (session.dataSizeBytes ?? 0n);
        // The last frame's offset from session start. Take the GREATER of this
        // and the event-driven duration the ingest path already maintains, so
        // finalize can only EXTEND the duration — a session whose events ran
        // longer than its last captured frame keeps the longer span.
        const frameDurationMs =
          totals.lastTs > session.startedAt.getTime()
            ? totals.lastTs - session.startedAt.getTime()
            : 0;
        const durationMs = Math.max(
          Number(session.durationMs ?? 0),
          frameDurationMs,
        );
        await this.db.session.update({
          where: { id: session.id },
          // Absolute SET (not increment): one write at finalize replaces the
          // legacy per-batch increments, so re-running it is idempotent.
          //
          // status=COMPLETED here is the authoritative session-end for a native
          // session — finalize IS the end event (mirrors the reference's ender
          // marking the session ended on detection). Without it the row stays
          // LIVE until the per-minute retention sweep flips it (endedAt+60s),
          // and the Recordings list hides LIVE native sessions — so the session
          // wouldn't appear until ~1-2 min AFTER its archive was ready. Setting
          // it now makes the session visible the instant the archive exists.
          data: {
            status: "COMPLETED",
            nativeSnapshotCount: totals.count,
            dataSizeBytes: newBytes,
            ...(durationMs > 0 ? { durationMs } : {}),
            endedAt: new Date(),
          },
        });
        // Bump workspace storage by the DELTA so a double finalize is a no-op;
        // the 30-min stats reconcile corrects any residual drift.
        if (delta !== 0n) {
          this.stats
            .bump(session.workspaceId, { storageBytes: delta })
            .catch(() => {});
        }
        // Native finalize IS the session-end, so derive Overview signals here —
        // the exact hook the WEB path fires at replay-persistence
        // (deriveForSession after COMPLETED). This is the ONLY finalize point a
        // native session passes through, so without it mobile sessions never get
        // scored, never group errors/crashes into Issues, and never build cards.
        // The mobile crash/error events are projected to ClickHouse at ingest
        // (well before finalize), so they're already queryable here. Fire-and-
        // forget + idempotent by contract — it must never reject the finalize
        // path; any failure is swallowed and the nightly backfill re-derives.
        void this.signals.deriveForSession(session.id);
      }
      // Warm the object so the first replay request hits an existing key.
      await this.storage.headPublicUrl(framesGzKey(sid)).catch(() => null);
    } finally {
      // Stand the session down regardless of DB outcome — the archive is in R2.
      //   • ZREM expiry + DEL owner   → no longer active; nothing re-finalizes
      //     it (finalization is driven by ZSET membership, not stream presence).
      //   • DEL finalize lock          → release it so that if the SAME id
      //     RESUMES, the next finalize can re-acquire and re-run cumulatively
      //     (the lock is concurrency protection, not a permanent tombstone).
      //   • EXPIRE (not DEL) the stream → keep the frames for streamRetainMs so
      //     a resume accumulates onto them instead of overwriting; Redis
      //     reclaims the memory if the session never comes back.
      //   • DEL mp state               → the completed upload's state is spent;
      //     a resume starts a fresh multipart.
      await this.redis
        .multi()
        .expire(framesStreamKey(sid), Math.ceil(streamRetainMs() / 1000))
        .del(framesMpKey(sid))
        .del(framesOwnerKey(sid))
        .del(finalizeLockKey(sid))
        .zrem(SESSION_EXPIRY_ZSET, sid)
        .exec();
    }
  }

  /**
   * Orphan poll: finalize ENDED sessions (expiry score ≤ now) that no live
   * worker owns. The owning worker normally finalizes its own sessions inline
   * (warm gzip state) — this is the backstop for a dead instance or a session
   * that expired before any worker leased it.
   */
  @Interval(Number(process.env.FRAMES_FINALIZE_POLL_MS) || 3_000)
  async pollExpired(): Promise<void> {
    // Not gated on storage.enabled — same reason as the worker tick: with no R2
    // we still finalize the bookkeeping (DB metadata + Redis cleanup) so the
    // expiry set + streams don't leak; the upload calls inside simply no-op.
    if (!this.enabled) return;
    if (this.polling) return; // never overlap ticks
    this.polling = true;
    try {
      const now = Date.now();
      // ENDED set, oldest-first, bounded page. Backed by the ZSET's score
      // index — O(log N + K), never a scan of all sessions.
      const ended = await this.redis.zrangebyscore(
        SESSION_EXPIRY_ZSET,
        "-inf",
        now,
        "LIMIT",
        0,
        100,
      );
      for (const sid of ended) {
        // Skip sessions a live worker still owns — it will finalize them with
        // its warm in-memory upload (the cheap path).
        const owned = await this.redis.exists(framesOwnerKey(sid));
        if (owned) continue;
        if (!(await this.acquireFinalizeLock(sid))) continue;
        try {
          await this.finalizeOrphan(sid);
        } catch (err) {
          this.log.warn(`orphan finalize ${sid} failed: ${String(err)}`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Rebuild a session's archive from the durable stream and finalize it. Used
   * only when no worker holds warm state, so we abort any dangling multipart
   * the dead owner left and recompress from the first frame.
   */
  private async finalizeOrphan(sid: string): Promise<void> {
    // Abort the dead owner's half-done upload (single-deflate parts can't be
    // resumed across a process) before starting a fresh one.
    await this.abortStaleUpload(sid);

    const upload = new SessionUpload(sid, this.storage, this.redis);
    const streamKey = framesStreamKey(sid);
    let cursor = "-";
    for (;;) {
      // XRANGE in pages; the next cursor is the id AFTER this page's last entry
      // (inclusive), so we never re-read it — the portable equivalent of the
      // `(id` exclusive operator, which Redis 6.0 (prod) rejects (see
      // nextStreamId). Stream is retained until cleanup, so the full history is
      // always available to rebuild from.
      const entries = (await this.redis.xrangeBuffer(
        streamKey,
        cursor,
        "+",
        "COUNT",
        500,
      )) as Array<[Buffer, Buffer[]]>;
      if (entries.length === 0) break;
      for (const [, fields] of entries) {
        const data = this.fieldValue(fields, "data");
        if (data) await upload.writeBatch(data);
      }
      await upload.flushFullParts();
      cursor = nextStreamId(entries[entries.length - 1][0].toString());
    }

    await upload.finish();
    await this.recordAndCleanup(sid, {
      count: upload.count,
      bytes: upload.bytes,
      lastTs: upload.lastTs,
    });
  }

  /** Pull a field's Buffer value out of an XRANGE entry's flat field array. */
  private fieldValue(fields: Buffer[], name: string): Buffer | null {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i].toString() === name) return fields[i + 1];
    }
    return null;
  }
}
