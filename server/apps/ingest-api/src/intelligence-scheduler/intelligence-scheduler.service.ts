import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { QueueService } from "../queue/queue.service";

/**
 * Cron coordinator for the intelligence pipeline — the analog of
 * RetentionService for signals + precompute. Every tick only SCANS (keyset,
 * index-served, bounded) and fans the work out into the intelligence Bull queue;
 * the heavy derivation/precompute runs in IntelligenceProcessor with retries and
 * backpressure. No long-running work happens in the tick itself, so a single
 * slow workspace can't stall the sweep and a horizontally-scaled API no longer
 * runs the whole derive N times (Bull's per-tick idempotent jobId dedupes the
 * fan-out, and only one worker picks up each job).
 *
 * The REAL-TIME path is unchanged: a web session's finalize still derives
 * in-process (inside the already-retried replay-batch job) for low latency.
 * These crons are the BULK paths — the mobile end-of-session trigger, the
 * nightly safety-net backfill, and the dirty-gated precompute sweep — which is
 * exactly where queue backpressure + multi-instance safety matter.
 */
@Injectable()
export class IntelligenceSchedulerService {
  private readonly logger = new Logger(IntelligenceSchedulerService.name);
  private readonly db = getPostgresClient();

  /** Keyset page size for every session scan → one derive-signals job per page.
   *  The derive is set-based over the whole page (fixed query count regardless
   *  of size), so a page is also the natural batch. */
  private static readonly PAGE = 500;
  /** Backfill look-back window (ms) — covers retention's out-of-band
   *  LIVE→COMPLETED flips + any finalize-time derive failure. */
  private static readonly BACKFILL_WINDOW_MS = 48 * 60 * 60 * 1000;
  /** Mobile resume window — a finalized mobile session can re-open within this,
   *  so it's only "done" once quiet this long. Mirrors the SDK streamRetainMs. */
  private static readonly MOBILE_QUIET_MS = 30 * 60 * 1000;
  /** How far back the mobile-quiet sweep scans; older is left to the backfill,
   *  keeping the scan bounded to the recent window. */
  private static readonly MOBILE_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** Recompute a clean workspace at least this often so its relative 7d window
   *  doesn't drift stale. */
  private static readonly PRECOMPUTE_STALE_MS = 60 * 60 * 1000;

  constructor(private readonly queue: QueueService) {}

  /**
   * Nightly safety-net backfill. Keyset-walks COMPLETED sessions in the recent
   * window by id (index-served on (status, endedAt); never a whole-table load)
   * and enqueues one derive-signals job per page. Idempotent, so overlap with
   * the finalize hook is harmless. `bumpDaily` is OFF — re-deriving must not
   * double-count the daily rollup; the nightly reconcile is authoritative.
   *
   * Access pattern: `WHERE status=COMPLETED AND endedAt >= since AND id > cursor
   * ORDER BY id ASC LIMIT PAGE` — an index range-scan from the last id, bounded
   * memory, O(pages) round trips, no OFFSET, no silent cap.
   */
  @Cron("15 2 * * *")
  async tickBackfill(): Promise<void> {
    const since = new Date(
      Date.now() - IntelligenceSchedulerService.BACKFILL_WINDOW_MS,
    );
    const now = Date.now();
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await this.db.session.findMany({
        where: {
          status: "COMPLETED",
          endedAt: { gte: since },
          id: { gt: cursor },
        },
        orderBy: { id: "asc" },
        take: IntelligenceSchedulerService.PAGE,
        select: { id: true },
      });
      if (page.length === 0) break;
      const ids = page.map((r) => r.id);
      await this.queue.enqueueDeriveSignals({
        sessionIds: ids,
        bumpDaily: false,
        source: "backfill",
        enqueuedAt: now,
      });
      pages += 1;
      cursor = ids[ids.length - 1];
      if (page.length < IntelligenceSchedulerService.PAGE) break;
    }
    if (pages > 0) {
      this.logger.log(`backfill enqueued ${pages} derive page(s)`);
    }
  }

  /**
   * Mobile end-of-session trigger. A finalized mobile session can resume within
   * MOBILE_QUIET_MS (a new batch re-opens it), so it isn't truly "done" until
   * it's been quiet that long. This sweep (every 5 min) enqueues derivation for
   * mobile sessions whose resume window has elapsed and that haven't been
   * processed since their last (re-)finalize — giving mobile timely derivation
   * instead of it waiting for the nightly backfill.
   *
   * The processor stamps `processedAt` only AFTER a successful derive (via
   * markProcessedAt), so a failed batch stays unstamped and is re-enqueued next
   * sweep — the same self-healing the in-process version had, now backed by
   * Bull's own retries too. (A session already enqueued but not yet processed
   * may be re-scanned by the next tick; the coarse per-batch jobId dedupes
   * within a tick and the derive is idempotent, so at worst it's a cheap
   * duplicate.)
   *
   * Access pattern: keyset by id over the recent quiet window
   * [now-24h, now-30min], mobile platforms only, index-served on
   * (status, endedAt); the `processedAt < endedAt` column-compare needs raw SQL.
   */
  @Cron("45 */5 * * * *")
  async tickMobileQuiet(): Promise<void> {
    const now = Date.now();
    const quietCutoff = new Date(
      now - IntelligenceSchedulerService.MOBILE_QUIET_MS,
    );
    const windowFloor = new Date(
      now - IntelligenceSchedulerService.MOBILE_WINDOW_MS,
    );
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await this.db.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "Session"
        WHERE status = 'COMPLETED'
          AND platform IN ('ios', 'android', 'react_native', 'flutter')
          AND "endedAt" < ${quietCutoff}
          AND "endedAt" >= ${windowFloor}
          AND ("processedAt" IS NULL OR "processedAt" < "endedAt")
          AND id > ${cursor}
        ORDER BY id ASC
        LIMIT ${IntelligenceSchedulerService.PAGE}`;
      if (page.length === 0) break;
      const ids = page.map((r) => Number(r.id));
      await this.queue.enqueueDeriveSignals({
        sessionIds: ids,
        bumpDaily: false,
        markProcessedAt: true,
        source: "mobile-quiet",
        enqueuedAt: now,
      });
      pages += 1;
      cursor = ids[ids.length - 1];
      if (page.length < IntelligenceSchedulerService.PAGE) break;
    }
    if (pages > 0) {
      this.logger.log(`mobile-quiet enqueued ${pages} derive page(s)`);
    }
  }

  /**
   * Dirty-gated precompute sweep (every 5 min). Enqueues a precompute-workspace
   * job for every workspace that is dirty (lastActivityAt > snapshotAt), never
   * computed, or stale (>1h — so the relative-window metrics don't drift).
   * Clean, fresh workspaces are skipped entirely, so cost tracks CHANGE, not
   * total volume.
   *
   * Access pattern (was: single LIMIT 200 that silently dropped the remainder):
   * keyset-paginate WorkspaceSnapshot by the PK `workspaceId` within the dirty
   * predicate. Enqueue-only ticks are cheap, so we drain the ENTIRE dirty set
   * each tick with no silent cap. WorkspaceSnapshot holds one row per
   * workspace-with-sessions, so the scan is bounded by workspace count, not
   * session/event volume; the PK range-scan pages it.
   */
  @Cron("15 */5 * * * *")
  async tickPrecompute(): Promise<void> {
    const staleCutoff = new Date(
      Date.now() - IntelligenceSchedulerService.PRECOMPUTE_STALE_MS,
    );
    const now = Date.now();
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.db.$queryRaw<Array<{ workspaceId: number }>>`
        SELECT "workspaceId" FROM "WorkspaceSnapshot"
        WHERE "workspaceId" > ${cursor}
          AND ("snapshotAt" IS NULL
               OR "lastActivityAt" > "snapshotAt"
               OR "snapshotAt" < ${staleCutoff})
        ORDER BY "workspaceId" ASC
        LIMIT ${IntelligenceSchedulerService.PAGE}`;
      if (rows.length === 0) break;
      await this.queue.enqueuePrecomputeWorkspaceBulk(
        rows.map((r) => ({ workspaceId: r.workspaceId, enqueuedAt: now })),
      );
      total += rows.length;
      cursor = rows[rows.length - 1].workspaceId;
      if (rows.length < IntelligenceSchedulerService.PAGE) break;
    }
    if (total > 0) {
      this.logger.log(
        `precompute enqueued ${total} dirty/stale workspace(s)`,
      );
    }
  }
}
