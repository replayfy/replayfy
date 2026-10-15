import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import type { Readable } from "stream";
import { createGunzip } from "zlib";
import type { Redis } from "ioredis";
import { getPostgresClient } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";
import { toInt4 } from "../common/int4";
import { StorageService } from "../storage/storage.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { SignalsService } from "../signals/signals.service";
import {
  FINALIZE_LOCK_TTL_MS,
  finalizeLockKey,
  framesCancelKey,
  framesGzKey,
  framesMpKey,
  framesOwnerKey,
  framesStreamKey,
  nextStreamId,
  streamRetainMs,
  SESSION_EXPIRY_ZSET,
} from "./frames.constants";
import { FrameSplitter, frameTs, splitFrames } from "./frames-codec";
import { SessionUpload } from "./session-upload";

/** The Session columns a finalize reads once, up front. */
interface FinalizeRow {
  id: number;
  workspaceId: number;
  status: string;
  startedAt: Date;
  clockSkewMs: bigint | null;
  dataSizeBytes: bigint;
  durationMs: number;
  nativeSnapshotCount: number;
}

/** An archive's frame totals: what the Session row's counters record. */
type ArchiveTotals = Pick<SessionUpload, "count" | "bytes" | "lastTs">;

/**
 * Session lifecycle / finalization.
 *
 * Replaces the legacy filesystem sweep (setInterval + readdir/stat) with a
 * Redis sorted-set poll. Two responsibilities:
 *
 *   1. finalize() — the SHARED body of every finalize: bring the R2 archive up
 *      to date (append-safe — see finalize), complete-time Postgres accounting
 *      (moved off the ingest hot path), Redis cleanup. Called by the stream
 *      worker with its warm upload for an owned session, AND by this service's
 *      orphan path. The CALLER must already hold the finalize:{sid} lock.
 *
 *   2. The @Interval orphan poll — finalizes ENDED sessions that have NO live
 *      owner (the owning instance died, or the session never got leased).
 *      It rebuilds the archive from the durable stream from scratch, since the
 *      dead owner's in-memory gzip state is gone. It also does every merge into
 *      an existing archive, which the worker hands over (see finalize).
 *
 * Idempotency: SET finalize:{sid} NX guards single execution. A re-run after a
 * mid-finalize crash is safe: the archive is only ever replaced by a superset
 * of itself, and the Postgres counters only grow toward that archive's totals
 * — a re-run whose merge adds nothing still records the archive a failed run
 * stored — so it can neither shrink a recording nor double-count its storage.
 * The one exception is a cancelled session, which is discarded (see discard).
 */
@Injectable()
export class FramesFinalizerService {
  private readonly log = new Logger(FramesFinalizerService.name);
  private readonly db = getPostgresClient();
  private readonly enabled =
    (process.env.FRAMES_WORKER_ENABLED ?? "true") !== "false";
  private polling = false;
  /** Where the orphan poll's walk of the ENDED range resumes: the last entry
   *  a tick visited, or null to start from the oldest (see pollExpired). Per
   *  instance; a restart starts from the oldest again. */
  private scanAfter: { sid: string; score: string } | null = null;

  /** Merge output is handed to the gzip in batches of about this size, so a
   *  long recording costs one write per MiB rather than one per frame. */
  private static readonly MERGE_BATCH_BYTES = 1024 * 1024;

  /** Ended sessions the orphan poll reads per page, and per tick at most. */
  private static readonly ORPHAN_PAGE = 100;
  private static readonly ORPHAN_SCAN_MAX = 1_000;
  /** Finalizes the orphan poll starts per tick at most — each can be a long
   *  rebuild or merge. */
  private static readonly ORPHAN_ATTEMPTS_MAX = 100;

  /**
   * One page of the expiry ZSET in score order, starting just after the entry
   * a previous page ended on, or at the oldest. ZRANK finds where that entry
   * is now; if it has left the set (finalized), ZCOUNT of the lower scores is
   * where it was, give or take entries sharing its score, which are then read
   * again (harmless: the finalize lock guards each). By rank, so a page costs
   * O(log N + page) however far into the set it starts.
   * KEYS: expiry zset. ARGV: after sid ('' = from the oldest), its score, page.
   * Returns [sid, score, sid, score, ...]; the caller stops at score > now.
   */
  private static readonly ENDED_PAGE_LUA = `
    local start = 0
    if ARGV[1] ~= '' then
      local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
      if rank then
        start = rank + 1
      else
        start = redis.call('ZCOUNT', KEYS[1], '-inf', '(' .. ARGV[2])
      end
    end
    return redis.call('ZRANGE', KEYS[1], start, start + tonumber(ARGV[3]) - 1, 'WITHSCORES')`;

  /**
   * Cleanup as ONE atomic step, unless the session must be finalized again:
   *   • a frames batch re-armed it while it was being finalized (its expiry
   *     score is in the future again). Then the session stays active: no
   *     stream TTL (those frames aren't in any archive yet), no ZREM (that
   *     would drop the re-arm and strand them), and the owner/upload state is
   *     left to whoever drains them next.
   *   • it was cancelled while being finalized, after this finalize checked
   *     (the cancel mark exists and this finalize didn't act on it). Then it
   *     stays queued, so the next pass discards what this one stored.
   * Only the finalize lock is released either way.
   * KEYS: expiry zset, stream, mp, owner, lock, cancel mark.
   * ARGV: sid, now, retain secs, cancel handled ('1'/'0').
   */
  private static readonly CLEANUP_LUA = `
    local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
    redis.call('DEL', KEYS[5])
    if score and tonumber(score) > tonumber(ARGV[2]) then
      return 0
    end
    if ARGV[4] == '0' and redis.call('EXISTS', KEYS[6]) == 1 then
      return 0
    end
    redis.call('EXPIRE', KEYS[2], ARGV[3])
    redis.call('DEL', KEYS[3], KEYS[4])
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 1`;

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
      FINALIZE_LOCK_TTL_MS,
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
   * Finalize one ENDED session. `warm` is the owning worker's upload, already
   * drained to the stream's tail; the orphan path passes null.
   *
   * APPEND-SAFE. The same session id is finalized again whenever it comes back
   * after an idle finalize: frames resume (a long background, a paused or
   * excluded screen), or the SDK sends /late when it rotates the session on
   * return. By then the stream may hold only the frames since the last
   * finalize, or nothing at all, because it is only retained for
   * streamRetainMs. So the stream alone must never replace the archive:
   *
   *   • No archive yet (Postgres has no frame count): the stream IS the whole
   *     recording — complete the warm upload, or rebuild from the stream.
   *   • An archive exists: merge the stream's new frames into it (see
   *     mergeIntoArchive), never rebuild from the stream alone. The worker
   *     doesn't merge: it hands the session to the orphan poll (returns false).
   *   • Nothing new, or no frames at all: the archive is left exactly as it is
   *     — an empty archive is never uploaded over it.
   *   • Postgres counters only grow, toward the archive actually stored.
   *
   * A CANCELLED session (POST /v1/mobile/cancel) is the exception: it is
   * discarded, archive and all (see discard).
   *
   * Failure before Postgres is updated throws, and nothing is cleaned up: the
   * session stays queued with its stream intact, and the finalize lock's TTL
   * is the backoff before the orphan poll retries it.
   *
   * Returns false when the session was left for the orphan poll: its finalize
   * lock is released, and the caller must release its lease.
   */
  async finalize(sid: string, warm: SessionUpload | null): Promise<boolean> {
    // publicId is unique-indexed (the same lookup the replay read path uses) —
    // one row fetch per finalize, not per batch. No N+1. It runs FIRST because
    // the frame count it returns decides whether an archive already exists.
    const session: FinalizeRow | null = await this.db.session.findFirst({
      where: { publicId: sid },
      select: {
        id: true,
        workspaceId: true,
        status: true,
        startedAt: true,
        clockSkewMs: true,
        dataSizeBytes: true,
        durationMs: true,
        nativeSnapshotCount: true,
      },
    });
    if (!session) {
      // The row was deleted (reaped, workspace teardown) while the session was
      // ending. An upload now would leave an object no session points at, and
      // with no row there is nothing for a cancel to discard either.
      await warm?.abort().catch(() => {});
      await this.cleanup(sid, true);
      return true;
    }

    // One O(1) EXISTS per finalize: the mark drop() leaves on a cancel.
    if ((await this.redis.exists(framesCancelKey(sid))) === 1) {
      await this.discard(sid, session, warm);
      await this.cleanup(sid, true);
      return true;
    }

    if (warm && session.nativeSnapshotCount > 0) {
      // The warm upload only holds what the stream holds now — completing it
      // is exactly the overwrite that wiped recordings. Discard it. The merge
      // that replaces it rewrites the WHOLE archive (download, re-gzip,
      // upload), which can outlast the worker's lease TTL, and the worker
      // awaits each finalize inside the tick that renews its other sessions'
      // leases — so the orphan poll, which owns no leases, does it instead.
      await warm.abort();
      await this.redis.del(finalizeLockKey(sid));
      return false;
    }

    // The archive in R2 once this finalize is done (null: none, or unknown —
    // the stream had nothing to add), and the upload that stores it (null: the
    // stored archive already is that archive).
    let totals: ArchiveTotals | null = null;
    let upload: SessionUpload | null = null;
    try {
      if (session.nativeSnapshotCount > 0) {
        const merged = await this.mergeIntoArchive(sid);
        if (merged) ({ upload, totals } = merged);
      } else {
        upload = warm ?? (await this.buildFromStream(sid));
        if (upload.count === 0) {
          // No frames (an event-only session): finishing would store a
          // 20-byte empty gzip.
          await upload.abort();
          upload = null;
        }
        totals = upload;
      }
      if (upload) await upload.finish();
    } catch (err) {
      await upload?.abort().catch(() => {});
      throw err;
    }

    await this.record(session, totals);
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
    // Warm the object so the first replay request hits an existing key.
    if (upload) {
      await this.storage.headPublicUrl(framesGzKey(sid)).catch(() => null);
    }
    await this.cleanup(sid, false);
    return true;
  }

  /**
   * Complete-time accounting, only when something changed. `totals` is the
   * archive in R2 once this finalize is done, or null when there is none or
   * the stream had nothing to add.
   */
  private async record(
    session: FinalizeRow,
    totals: ArchiveTotals | null,
  ): Promise<void> {
    if (!totals || totals.count <= session.nativeSnapshotCount) {
      // Already COMPLETED and nothing archived: a no-op. This is the SDK's
      // /late for a session that idled out long ago — touching the row would
      // stretch endedAt (and with it the session) to the moment the user
      // came back.
      if (session.status !== "LIVE") return;
      // First end of a session with nothing to archive: mark it ended, as
      // before, but leave its counters. The old absolute SET to 0 here also
      // erased the message bytes /i had already counted. This lists it at
      // once: the LIVE sweep holds it while this finalize is pending.
      await this.db.session.update({
        where: { id: session.id },
        data: { status: "COMPLETED", endedAt: new Date() },
      });
      return;
    }

    // The last frame's offset from session start. Frame timestamps are on the
    // DEVICE clock; so is startedAt + clockSkewMs. Clamped: a device clock
    // jump past ~24.8 days would overflow the INT4 column and fail the write.
    const deviceStartMs =
      session.startedAt.getTime() + Number(session.clockSkewMs ?? 0n);
    const frameDurationMs = toInt4(
      totals.lastTs > deviceStartMs ? totals.lastTs - deviceStartMs : 0,
    );
    // Finalize may only EXTEND the duration: a session whose events ran longer
    // than its last captured frame keeps the longer span. The row was read
    // before the archive work, and /i keeps raising durationMs meanwhile, so
    // the comparison runs in SQL against the CURRENT value — an UPDATE
    // guarded by `durationMs < x` is atomic per row, so it can't overwrite a
    // larger value written since the read. Skipped when the read already
    // shows it can't raise (durationMs never drops). By primary key; one
    // statement per finalize, not per batch. It runs BEFORE the write below,
    // whose nativeSnapshotCount is what a retry keys on: if that write fails,
    // the retry raises again (a no-op) and repeats it.
    if (frameDurationMs > session.durationMs) {
      await this.db.session.updateMany({
        where: { id: session.id, durationMs: { lt: frameDurationMs } },
        data: { durationMs: frameDurationMs },
      });
    }
    // dataSizeBytes also counts the message bytes /i adds, so the archive's
    // size may only RAISE it (to at least the archive's raw size), never set it
    // lower. An atomic increment, so a concurrent /i increment isn't lost.
    const bytesDelta = BigInt(totals.bytes) - (session.dataSizeBytes ?? 0n);
    await this.db.session.update({
      where: { id: session.id },
      // status=COMPLETED here is the authoritative session-end for a native
      // session with frames — finalize IS the end event (mirrors the
      // reference's ender marking the session ended on detection). The
      // Recordings list hides LIVE native sessions, and the per-minute LIVE
      // sweep leaves a native row LIVE while its finalize is pending (see
      // RetentionService.sweepLiveSessions), so THIS write lists the session,
      // in the same step that records its archive: it is never listed before
      // it can be played. Only a finalize overdue past FINALIZE_OVERDUE_MAX_MS
      // (one that keeps failing, or a backlog longer than that) is completed
      // by the sweep instead, and this write then records its archive.
      //
      // nativeSnapshotCount is the count of the archive in R2, which holds
      // every frame of the previous one, so it only grows — and with it the
      // player's ?v= cache-bust, so the new archive is never served stale.
      data: {
        status: "COMPLETED",
        nativeSnapshotCount: totals.count,
        ...(bytesDelta > 0n ? { dataSizeBytes: { increment: bytesDelta } } : {}),
        endedAt: new Date(),
      },
    });
    // Storage stats move by the same delta; the 30-min stats reconcile
    // corrects any residual drift.
    if (bytesDelta > 0n) {
      this.stats
        .bump(session.workspaceId, { storageBytes: bytesDelta })
        .catch(() => {});
    }
  }

  /**
   * Discard a cancelled session's recording (POST /v1/mobile/cancel, see
   * FramesStreamService.drop): abort the warm upload, delete the archive an
   * earlier finalize stored, and zero the counters the player and storage
   * read — a zero frame count is the player's "no replay". The delete throws
   * on failure, so a failed one leaves the session queued to retry rather than
   * recorded as gone. Like the retention prune of an aged-out replay, the
   * Session row and its ClickHouse events stay.
   */
  private async discard(
    sid: string,
    session: FinalizeRow,
    warm: SessionUpload | null,
  ): Promise<void> {
    await warm?.abort();
    // Unconditional — an archive can exist that the row doesn't count yet (a
    // finalize that stored it, then failed to record it). One DELETE per
    // cancelled session; a missing object is not an error.
    await this.storage.removeOrThrow(framesGzKey(sid));
    const stored = session.dataSizeBytes ?? 0n;
    if (
      session.status !== "LIVE" &&
      session.nativeSnapshotCount === 0 &&
      stored === 0n
    ) {
      return; // already discarded (a retry, or a straggler batch)
    }
    await this.db.session.update({
      where: { id: session.id },
      data: {
        status: "COMPLETED",
        nativeSnapshotCount: 0,
        dataSizeBytes: 0n,
        // Only a session still LIVE ends now. An already-ended one keeps its
        // endedAt: moving it would re-enter billing's settle window.
        ...(session.status === "LIVE" ? { endedAt: new Date() } : {}),
      },
    });
    if (stored > 0n) {
      this.stats
        .bump(session.workspaceId, { storageBytes: -stored })
        .catch(() => {});
    }
  }

  /**
   * Stand the session down (CLEANUP_LUA, one round-trip):
   *   • ZREM expiry + DEL owner   → no longer active; nothing re-finalizes
   *     it (finalization is driven by ZSET membership, not stream presence).
   *   • DEL finalize lock          → release it so that if the SAME id
   *     RESUMES, the next finalize can re-acquire and merge onto this archive
   *     (the lock is concurrency protection, not a permanent tombstone).
   *   • EXPIRE (not DEL) the stream → keep the frames for streamRetainMs;
   *     Redis reclaims the memory if the session never comes back.
   *   • DEL mp state               → the completed upload's state is spent;
   *     a resume starts a fresh multipart.
   * All but the lock release are skipped when a batch re-armed the session
   * mid-finalize, so its new frames are drained and archived next time, and
   * when a cancel this finalize didn't act on (`cancelHandled` false) landed
   * mid-finalize, so the next pass discards it. The cancel mark itself stays
   * until its TTL, so straggling frames are discarded too.
   */
  private async cleanup(sid: string, cancelHandled: boolean): Promise<void> {
    await this.redis.eval(
      FramesFinalizerService.CLEANUP_LUA,
      6,
      SESSION_EXPIRY_ZSET,
      framesStreamKey(sid),
      framesMpKey(sid),
      framesOwnerKey(sid),
      finalizeLockKey(sid),
      framesCancelKey(sid),
      sid,
      String(Date.now()),
      String(Math.ceil(streamRetainMs() / 1000)),
      cancelHandled ? "1" : "0",
    );
  }

  /**
   * Orphan poll: finalize ENDED sessions (expiry score ≤ now) that no live
   * worker owns. The owning worker normally finalizes its own sessions inline
   * (warm gzip state) — this is the backstop for a dead instance or a session
   * that expired before any worker leased it, and it retries every finalize
   * that failed.
   *
   * It walks the ENDED range oldest-first and resumes each tick where the last
   * one stopped, wrapping to the oldest once it passes the newest. A finalize
   * that keeps failing keeps its score, so it stays at the head of the range:
   * a poll that read only the oldest page each tick let a page of those
   * (waiting out their retry backoff) hide every session behind them, which
   * then never got finalized or retried. Walking past them, every ended
   * session is reached, however long the backlog.
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
      const maxAttempts = FramesFinalizerService.ORPHAN_ATTEMPTS_MAX;
      let after = this.scanAfter;
      let read = 0;
      let attempts = 0;
      // Access pattern: pages of the ENDED range by rank (ENDED_PAGE_LUA,
      // O(log N + page) each) plus one pipelined pair of EXISTS per page
      // entry; at most ORPHAN_SCAN_MAX entries and ORPHAN_ATTEMPTS_MAX
      // finalizes a tick, never a scan of all sessions.
      while (
        read < FramesFinalizerService.ORPHAN_SCAN_MAX &&
        attempts < maxAttempts
      ) {
        const page = await this.endedPage(after, now);
        const blocked = await this.finalizeBlocked(page.map((e) => e.sid));
        for (let i = 0; i < page.length && attempts < maxAttempts; i++) {
          const { sid } = page[i];
          after = page[i];
          read += 1;
          // Its finalize lock is held (a finalize is running, or a failed one
          // is waiting out its retry backoff) or a live worker owns it: skip
          // it without a round-trip of its own.
          if (blocked[i]) continue;
          // Skip sessions a live worker still owns — it will finalize them with
          // its warm in-memory upload (the cheap path). Checked again here: a
          // finalize earlier in this tick can take a while.
          const owned = await this.redis.exists(framesOwnerKey(sid));
          if (owned) continue;
          if (!(await this.acquireFinalizeLock(sid))) continue;
          attempts += 1;
          try {
            await this.finalizeOrphan(sid);
          } catch (err) {
            this.log.warn(`orphan finalize ${sid} failed: ${String(err)}`);
          }
        }
        if (attempts >= maxAttempts) break; // resume after `after` next tick
        if (page.length < FramesFinalizerService.ORPHAN_PAGE) {
          after = null; // past the newest ended session: start over next tick
          break;
        }
      }
      this.scanAfter = after;
    } finally {
      this.polling = false;
    }
  }

  /** The ENDED entries (score ≤ now) of one ENDED_PAGE_LUA page, in order. */
  private async endedPage(
    after: { sid: string; score: string } | null,
    now: number,
  ): Promise<Array<{ sid: string; score: string }>> {
    const flat = (await this.redis.eval(
      FramesFinalizerService.ENDED_PAGE_LUA,
      1,
      SESSION_EXPIRY_ZSET,
      after?.sid ?? "",
      after?.score ?? "0",
      String(FramesFinalizerService.ORPHAN_PAGE),
    )) as string[];
    const page: Array<{ sid: string; score: string }> = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (Number(flat[i + 1]) > now) break; // still active
      page.push({ sid: flat[i], score: flat[i + 1] });
    }
    return page;
  }

  /** Per sid: is its finalize lock held, or is it owned by a live worker? One
   *  pipelined round-trip of O(1) EXISTS for the whole page. */
  private async finalizeBlocked(sids: string[]): Promise<boolean[]> {
    if (sids.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const sid of sids) {
      pipe.exists(finalizeLockKey(sid));
      pipe.exists(framesOwnerKey(sid));
    }
    const res = (await pipe.exec()) ?? [];
    return sids.map(
      (_, i) => res[2 * i]?.[1] === 1 || res[2 * i + 1]?.[1] === 1,
    );
  }

  /**
   * Finalize a session no worker holds warm state for (a dead owner's, or one
   * a worker handed over to merge). Abort any dangling multipart left first
   * (single-deflate parts can't be resumed across a process); finalize() then
   * rebuilds from the stream or merges.
   */
  private async finalizeOrphan(sid: string): Promise<void> {
    await this.abortStaleUpload(sid);
    await this.finalize(sid, null);
  }

  /**
   * Rebuild a FIRST archive from the durable stream, recompressing from the
   * first frame — the orphan path's equivalent of the worker's warm upload.
   * Returned unfinished.
   */
  private async buildFromStream(sid: string): Promise<SessionUpload> {
    const upload = new SessionUpload(sid, this.storage, this.redis);
    try {
      const streamKey = framesStreamKey(sid);
      let cursor = "-";
      for (;;) {
        // XRANGE in pages; the next cursor is the id AFTER this page's last
        // entry (inclusive), so we never re-read it — the portable equivalent
        // of the `(id` exclusive operator, which Redis 6.0 (prod) rejects (see
        // nextStreamId). Stream is retained until cleanup, so the full history
        // is always available to rebuild from.
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
      return upload;
    } catch (err) {
      await upload.abort().catch(() => {});
      throw err;
    }
  }

  /**
   * Merge the stream's frames into the session's EXISTING archive, as a fresh
   * upload of the whole recording: R2 can't append to an object, and the
   * player reads one single-member gzip at one key, so the archive is
   * rewritten — as a strict superset of itself. Returns the merged archive's
   * totals and its upload, unfinished; the upload is null when the stream adds
   * no frame, and the archive is then not touched. Null when the stream can't
   * hold anything unarchived, so there was nothing to read.
   */
  private async mergeIntoArchive(
    sid: string,
  ): Promise<{ upload: SessionUpload | null; totals: ArchiveTotals } | null> {
    // A stream with no TTL has taken batches since the archive was written:
    // append() PERSISTs on every batch, and cleanup sets the retention TTL.
    // Gone (expired, cancelled) or still on that TTL ⇒ nothing new, so skip
    // the download. O(1).
    if ((await this.redis.pttl(framesStreamKey(sid))) !== -1) return null;

    // Missing object (never stored, or storage disabled) reads as null; an R2
    // failure throws, so an outage can't pass for an empty archive.
    const archive = await this.storage.openReadStream(framesGzKey(sid));
    const upload = new SessionUpload(sid, this.storage, this.redis);
    try {
      const added = await this.mergeFrames(
        this.archiveFrames(archive),
        this.streamFrames(sid),
        upload,
      );
      if (added > 0) return { upload, totals: upload };
      // Nothing new: the stored archive already holds every frame, so it stays
      // as it is. Its totals still count — the merge read all of it — because
      // a finalize that stored it may have failed before recording it, and
      // this retry is then the only one left to.
      await upload.abort();
      const { count, bytes, lastTs } = upload;
      return { upload: null, totals: { count, bytes, lastTs } };
    } catch (err) {
      archive?.destroy();
      await upload.abort().catch(() => {});
      throw err;
    }
  }

  /**
   * Two-way merge by capture timestamp into `upload`, so the archive stays in
   * time order when each source is. Every archive frame is kept — the archive
   * never loses a frame, even one sharing a timestamp. A stream frame is
   * skipped when its timestamp is already written: within the retention window
   * the stream still holds every frame the archive was built from, and a
   * retried /images batch repeats frames. Memory is the timestamp set plus one
   * output batch; both sources are read incrementally. Returns how many stream
   * frames were added.
   */
  private async mergeFrames(
    archive: AsyncGenerator<Buffer>,
    stream: AsyncGenerator<Buffer>,
    upload: SessionUpload,
  ): Promise<number> {
    const written = new Set<number>();
    let batch: Buffer[] = [];
    let batchBytes = 0;
    let added = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await upload.writeBatch(Buffer.concat(batch, batchBytes));
      await upload.flushFullParts();
      batch = [];
      batchBytes = 0;
    };
    const write = async (frame: Buffer): Promise<void> => {
      written.add(frameTs(frame));
      batch.push(frame);
      batchBytes += frame.length;
      if (batchBytes >= FramesFinalizerService.MERGE_BATCH_BYTES) await flush();
    };

    let a = await archive.next();
    let s = await stream.next();
    while (!a.done || !s.done) {
      // Ties go to the archive, so its copy is the one kept.
      if (!a.done && (s.done || frameTs(a.value) <= frameTs(s.value))) {
        await write(a.value);
        a = await archive.next();
      } else if (!s.done) {
        if (!written.has(frameTs(s.value))) {
          await write(s.value);
          added += 1;
        }
        s = await stream.next();
      }
    }
    await flush();
    return added;
  }

  /** The stored archive's frames in stored order, through a streaming gunzip. */
  private async *archiveFrames(
    body: Readable | null,
  ): AsyncGenerator<Buffer> {
    if (!body) return;
    const gunzip = createGunzip();
    // pipe() doesn't forward a source error: a dropped R2 read must fail the
    // merge, not end it early as if the archive were shorter.
    body.on("error", (err) => gunzip.destroy(err));
    body.pipe(gunzip);
    const splitter = new FrameSplitter();
    try {
      for await (const chunk of gunzip) yield* splitter.push(chunk as Buffer);
    } finally {
      body.destroy();
    }
  }

  /**
   * Every frame in the session's stream, oldest entry first. Small pages: an
   * entry is a whole /images batch, not one frame.
   */
  private async *streamFrames(sid: string): AsyncGenerator<Buffer> {
    const streamKey = framesStreamKey(sid);
    let cursor = "-";
    for (;;) {
      const entries = (await this.redis.xrangeBuffer(
        streamKey,
        cursor,
        "+",
        "COUNT",
        100,
      )) as Array<[Buffer, Buffer[]]>;
      if (entries.length === 0) return;
      for (const [, fields] of entries) {
        const data = this.fieldValue(fields, "data");
        if (data) yield* splitFrames(data);
      }
      cursor = nextStreamId(entries[entries.length - 1][0].toString());
    }
  }

  /** Pull a field's Buffer value out of an XRANGE entry's flat field array. */
  private fieldValue(fields: Buffer[], name: string): Buffer | null {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i].toString() === name) return fields[i + 1];
    }
    return null;
  }
}
