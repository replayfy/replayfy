import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { QueueService } from "../queue/queue.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { RetentionJob } from "../queue/queue.types";
import { BILLING_SERVICE, type BillingPort } from "../billing/billing.port";
import { SignalsService } from "../signals/signals.service";
import { PLAN_TIERS, resolvePlan } from "../billing/plan-catalog";
import { FramesStreamService } from "../frames/frames-stream.service";
import { nativeSweepGraceMs } from "../frames/frames.constants";

// Storage is not a billed dimension — PLAN_TIERS sells SESSIONS. This quota
// exists only to drive the advisory "you're near your storage" notification, so
// it is DERIVED from the plan's session allowance rather than kept as a second
// hand-maintained table. The old table did the latter and rotted: it still keyed
// off the legacy PRO/TEAM names, so every current paid tier (STARTER/GROWTH/
// SCALE/BUSINESS) missed the lookup, fell through to the FREE default, and got
// alerted against a 1 GB ceiling it blows past in a day.
//
// 1 MiB per allowed session is the implied budget of the old FREE row (1 GB /
// 1,000 sessions) — the one number in that table that was still current. Owner
// tunes THIS constant; the ladder follows automatically on any pricing change.
const STORAGE_BYTES_PER_SESSION = 1024 ** 2;

// A workspace can only be over its 80% alert threshold if it's already
// past 80% of the SMALLEST plan quota (FREE). Below this floor no
// plan can be over-threshold, so the storage cron's index range-scan
// starts here and never touches the bulk of the fleet.
const STORAGE_FLOOR_BYTES = BigInt(
  Math.floor(
    0.8 * (PLAN_TIERS.FREE.sessions ?? 0) * STORAGE_BYTES_PER_SESSION,
  ),
);

// Keyset page size for every sweep. Small enough to bound memory + lock
// scope, large enough that O(pages) round trips stays tiny.
const PAGE = 500;

// A live session refreshes EndUser.lastSeenAt on every ingest batch (and on
// presence-socket connect), so a row idle longer than this is genuinely gone.
// Same window the LIVE→COMPLETED session sweep uses for web sessions, so a
// session and its user transition offline together (a native session is held
// LIVE longer, until its frames archive exists — see sweepLiveSessions).
const PRESENCE_STALE_MS = 60_000;

/** The Session columns one LIVE-sweep page reads. */
interface LiveSweepRow {
  id: number;
  publicId: string;
  platform: string | null;
  endedAt: Date;
}

/**
 * Cron coordinator — fans each tick out into Bull jobs (one per workspace,
 * per kind). The actual work runs in RetentionProcessor with retries and
 * backpressure. This service stays tiny on purpose: scheduling only,
 * no long-running DB work in the cron tick itself.
 *
 * Every cron here is written to scale to millions of workspaces: it scopes
 * to the rows that actually matter (active workspaces / near-quota tail /
 * the recent-session window) and walks them in keyset pages backed by an
 * index — never `findMany` of a whole table, never an N+1 enqueue loop.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly pg = getPostgresClient();

  constructor(
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    @Optional() @Inject(BILLING_SERVICE) private readonly billing: BillingPort | undefined,
    private readonly signals: SignalsService,
    // The frames pipeline's expiry scores: the LIVE sweep holds a native
    // session until its frames finalize has run (FramesModule is @Global).
    private readonly frames: FramesStreamService,
  ) {}

  /**
   * Every hour, alert admins of any workspace whose cached storage has
   * crossed 80% of its plan quota. emitOnce dedupes so we don't spam the
   * bell — at most one per 24h per admin.
   *
   * Access pattern (was: findMany ALL workspaces + JS filter):
   *   Keyset-paginate WorkspaceStats by the composite (storageBytes,
   *   workspaceId), scoped to `storageBytes >= STORAGE_FLOOR_BYTES`. The
   *   scan is driven by @@index([storageBytes]) so only the near-quota
   *   tail is ever read — the 99% of workspaces nowhere near quota are
   *   skipped entirely. workspaceId is the unique tiebreaker that makes
   *   the cursor stable across equal byte counts. Each page computes the
   *   exact per-plan percentage in JS, then ONE batched admins query feeds
   *   the notifications (no per-workspace admin lookup).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async checkStorageThresholds() {
    let curBytes = STORAGE_FLOOR_BYTES;
    let curWs = 0;
    for (;;) {
      const rows = await this.pg.workspaceStats.findMany({
        where: {
          workspace: { deletedAt: null },
          // Composite keyset over (storageBytes, workspaceId). The first
          // page starts at the floor; `storageBytes = floor AND ws > 0`
          // captures rows sitting exactly on the floor.
          OR: [
            { storageBytes: { gt: curBytes } },
            { storageBytes: curBytes, workspaceId: { gt: curWs } },
          ],
        },
        select: {
          workspaceId: true,
          storageBytes: true,
          workspace: { select: { name: true, plan: true } },
        },
        orderBy: [{ storageBytes: "asc" }, { workspaceId: "asc" }],
        take: PAGE,
      });
      if (rows.length === 0) break;
      await this.notifyOverThreshold(rows);
      const last = rows[rows.length - 1];
      curBytes = last.storageBytes;
      curWs = last.workspaceId;
      if (rows.length < PAGE) break;
    }
  }

  /** Hourly purge — fan out to one job per active workspace.
   *
   *  Access pattern (was: findMany ALL workspaces, take 10_000 — silently
   *  dropped workspace #10_001+):
   *    Keyset-paginate WorkspaceStats (rows exist only for workspaces that
   *    have ingested ≥1 batch — our universal "active workspace" index)
   *    where sessionsTotal>0, ordered by the PK workspaceId. Each page is a
   *    PK index range-scan from the last id (no OFFSET, no full load), and
   *    the whole page is bulk-enqueued in one addBulk. Scales to millions:
   *    bounded memory, O(pages) round trips, no silent cap. */
  @Cron(CronExpression.EVERY_HOUR)
  async tickPurge() {
    const now = Date.now();
    const count = await this.drainWorkspaceStats(
      { sessionsTotal: { gt: 0 } },
      (ids) => this.enqueueKind("purge", ids, now),
    );
    if (count > 0) this.logger.log(`Enqueued purge for ${count} workspaces`);
  }

  /** Per-minute LIVE → COMPLETED sweep, run in this tick (not queued), then
   *  billing's settle judge over the freshly-completed sessions.
   *
   *  A session the sweep completes is listed. A NATIVE one is only playable
   *  once its frames archive exists, and the frames finalizer is the writer
   *  that completes it together with the archive (FramesFinalizerService
   *  record()). So native rows are HELD (left LIVE, which the Recordings list
   *  hides) while that finalize may still come: for nativeSweepGraceMs past
   *  their last activity, and for as long as
   *  FramesStreamService.pendingFinalize says one is pending (frames still
   *  arriving, or ended and not yet finalized, up to FINALIZE_OVERDUE_MAX_MS).
   *  The sweep still completes a native session that never had frames, and
   *  one whose finalize is overdue; for the latter it also stamps endedAt with
   *  the time it completes it, as record() would have, because its stored
   *  endedAt can be far older than its last frame and would miss billing's
   *  settle window (BillingService.SETTLED), and warns with how many it
   *  completed that way. Web rows flip once their endedAt is 60 s old, as
   *  before.
   *
   *  The ids are selected first so the same ids are derived (signals/Issues):
   *  the inline finalize hooks (web replay-persistence, the native frames
   *  finalizer) only fire for sessions that self-finalize; an event-only mobile
   *  session (a crash with no captured frames) never enters the frames ZSET,
   *  so this sweep is the ONLY place it reaches COMPLETED. Without deriving
   *  here, its crash waits for the nightly backfill.
   *
   *  Access pattern: keyset pages over (endedAt, id) within `status = 'LIVE'
   *  AND endedAt < now-60s`, minus the native rows still inside the frames
   *  grace (held without a read), oldest first, LIVE_SWEEP_PAGE rows a page
   *  and at most LIVE_SWEEP_MAX_PAGES pages a tick. Served by
   *  @@index([status, endedAt]): the `endedAt >= cursor` bound makes each page
   *  an index range scan that starts at the cursor (the id tiebreak only
   *  orders equal timestamps; platform is a residual filter on the scanned
   *  rows), so a page never re-reads the pages before it. The range holds only
   *  sessions that ended over 60 s ago and are not yet completed, never the
   *  table. Held rows stay in the range, so when the budget ends a walk the
   *  next tick resumes from its cursor instead of the oldest row: every row in
   *  the range is reached within (range size / budget) ticks, and held rows
   *  ahead in the order can't starve the rows behind them. A walk that reaches
   *  the end of the range resets the cursor. Per page: one pipelined Redis
   *  round-trip for the native rows' expiry scores, at most two set-based
   *  `UPDATE ... WHERE id IN (page)` (plain, and overdue with endedAt), both
   *  guarded by `status = 'LIVE' AND endedAt < now-60s` (so a row the
   *  finalizer completed, or that took a new batch, since the read is left
   *  alone), and one batched derive. No per-row query. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepLiveSessions() {
    const now = Date.now();
    const cutoff = new Date(now - 60_000);
    const nativeCutoff = now - nativeSweepGraceMs();
    // Resume where the last tick's walk stopped at its budget (null: oldest).
    let cursor = this.liveSweepCursor;
    let flipped = 0;
    let held = 0;
    // Of `flipped`, those completed with their frames finalize overdue.
    let overdueFlipped = 0;
    let pages = 0;
    let more = true;
    while (more && pages < RetentionService.LIVE_SWEEP_MAX_PAGES) {
      pages += 1;
      const rows: LiveSweepRow[] = await this.pg.session.findMany({
        where: {
          status: "LIVE",
          endedAt: cursor ? { lt: cutoff, gte: cursor.endedAt } : { lt: cutoff },
          AND: [
            // Not a native row inside the frames grace. NULL-safe: `platform
            // NOT IN (...)` is NULL for a legacy null-platform row, which
            // flips like a web one, hence its own arm.
            {
              OR: [
                { platform: null },
                { platform: { notIn: [...RetentionService.NATIVE_PLATFORMS] } },
                { endedAt: { lt: new Date(nativeCutoff) } },
              ],
            },
            // After the cursor in (endedAt, id) order (with `endedAt >=
            // cursor` above, `id > cursor` only decides equal timestamps).
            ...(cursor
              ? [
                  {
                    OR: [
                      { endedAt: { gt: cursor.endedAt } },
                      { id: { gt: cursor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: { id: true, publicId: true, platform: true, endedAt: true },
        orderBy: [{ endedAt: "asc" }, { id: "asc" }],
        take: RetentionService.LIVE_SWEEP_PAGE,
      });
      more = rows.length === RetentionService.LIVE_SWEEP_PAGE;
      if (rows.length === 0) break;

      const { plain, overdue } = await this.completableIds(
        rows,
        now,
        nativeCutoff,
      );
      held += rows.length - plain.length - overdue.length;
      flipped += await this.completeLive(plain, cutoff, {});
      const flippedOverdue = await this.completeLive(overdue, cutoff, {
        endedAt: new Date(now),
      });
      flipped += flippedOverdue;
      overdueFlipped += flippedOverdue;
      if (plain.length + overdue.length > 0) {
        // Derive the freshly-completed sessions: one batched call (CH reads
        // grouped per workspace inside), fire-and-forget + idempotent, so a
        // slow or failing derive never blocks the sweep or billing settle
        // below, and an id the guard left alone is at worst derived twice.
        void this.signals.deriveForSessions([...plain, ...overdue]);
      }

      const last = rows[rows.length - 1];
      cursor = { endedAt: last.endedAt, id: last.id };
    }
    // Kept only when the budget, not the end of the range, stopped the walk.
    this.liveSweepCursor = more ? cursor : null;
    if (flipped > 0 || held > 0) {
      this.logger.log(
        `Flipped ${flipped} stale LIVE sessions to COMPLETED; ` +
          `held ${held} native ones for their frames finalize`,
      );
    }
    if (overdueFlipped > 0) {
      // Listed without their archive: a finalizer that keeps failing (or is
      // not running) shows up here, not only as "still being processed" in
      // the player.
      this.logger.warn(
        `Completed ${overdueFlipped} native sessions whose frames finalize is overdue; their frames archive is not stored yet`,
      );
    }
    if (more) {
      // Never a silent truncation: the next tick resumes from this cursor.
      this.logger.warn(
        `LIVE sweep stopped at its ${RetentionService.LIVE_SWEEP_MAX_PAGES}-page budget; the next tick resumes from there`,
      );
    }

    // The settle-time judge: bill the real sessions, delete the short throwaways
    // (replaces the old excludedShort flag-and-hide — see BillingService). Same
    // per-minute cadence and 3-min grace the flag used, now with an authoritative
    // outcome instead of a reversible flag.
    if (this.billing) await this.billing.settleSweep();
  }

  /** Per-minute presence-staleness sweep — the SOLE writer of
   *  EndUser.isOnline=false.
   *
   *  isOnline=true is written by the ingest paths (mobile + web HTTP), which
   *  stamp it on every batch. There is no live socket clearing it anymore (the
   *  WebSocket presence gateway was removed — live presence is now derived from
   *  ingest recency in Redis, and this column is the durable per-user flag), so
   *  without this sweep a user's row would stay "online" forever once their
   *  device stops sending. This is now the ONLY thing that flips a user offline.
   *
   *  Access pattern: a single set-based UPDATE — no queue, no row load into
   *  memory. Backed by @@index([isOnline, lastSeenAt]) so the scan only ever
   *  touches the small currently-online subset (isOnline=true) with a stale
   *  lastSeenAt, never the whole EndUser table — scales to millions of end
   *  users. Mirror of sweepLiveSessions. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepStalePresence() {
    const cutoff = new Date(Date.now() - PRESENCE_STALE_MS);
    const stale = await this.pg.endUser.updateMany({
      where: { isOnline: true, lastSeenAt: { lt: cutoff } },
      data: { isOnline: false },
    });
    if (stale.count > 0)
      this.logger.log(`Marked ${stale.count} stale end users offline`);
  }


  /** Every 5 minutes, fan out AUTO playlist refreshes.
   *
   *  Access pattern (was: findMany ALL workspaces, take 10_000):
   *    Keyset-paginate the DISTINCT workspaceIds that actually own ≥1
   *    playlist (backed by Playlist @@index([workspaceId])) and bulk-
   *    enqueue each page — workspaces with no playlists are never touched. */
  @Cron("*/5 * * * *")
  async tickRefreshPlaylists() {
    const now = Date.now();
    await this.drainDistinctWorkspaceIds("Playlist", (ids) =>
      this.enqueueKind("refreshPlaylists", ids, now),
    );
  }

  /** Recompute BEHAVIORAL/activity cohorts (sessions_count / event / is_online /
   *  last_seen) — the ones whose membership moves with sessions or time. Every
   *  15 min (down from 5): attribute-only cohorts are no longer swept here, they
   *  are maintained incrementally by CohortsService.drainDirtyCohorts, so this
   *  only pays the aggregate cost for the cohorts that actually need it. Keyset
   *  over DISTINCT workspaceIds owning ≥1 cohort (Cohort @@index([workspaceId])).
   *  COHORT_REFRESH_CRON overrides the schedule. */
  @Cron(process.env.COHORT_REFRESH_CRON || "*/15 * * * *")
  async tickRefreshCohorts() {
    const now = Date.now();
    await this.drainDistinctWorkspaceIds("Cohort", (ids) =>
      this.enqueueKind("refreshCohorts", ids, now),
    );
  }

  // ---------------------------------------------------------------------
  // Private helpers — keyset drains + fan-out. (No free functions: these
  // are methods on the service per the repo's controller/service rule.)
  // ---------------------------------------------------------------------

  /** Rows per LIVE-sweep keyset page, and the most pages one tick walks. */
  private static readonly LIVE_SWEEP_PAGE = 1000;
  private static readonly LIVE_SWEEP_MAX_PAGES = 10;

  /** Where the LIVE sweep's walk stopped when its page budget ran out; the
   *  next tick resumes there. Null: start from the oldest row. Per process,
   *  so a restart (or a second cron process) just starts from the oldest. */
  private liveSweepCursor: { endedAt: Date; id: number } | null = null;

  /** Session.platform values of the native SDKs: the sessions that replay
   *  from a frames archive. React Native and Flutter report ios/android today;
   *  their own names are listed so a wrapper that reports itself is held too. */
  private static readonly NATIVE_PLATFORMS: ReadonlySet<string> = new Set([
    "ios",
    "android",
    "react_native",
    "flutter",
  ]);

  /**
   * The ids in one LIVE-sweep page that may be completed now: `plain` (every
   * non-native row, and the native rows past nativeSweepGraceMs with no
   * frames finalize to come) and `overdue` (native rows whose finalize is
   * overdue, completed with a fresh endedAt). The rest are held. Only the
   * native rows past the grace are checked in Redis (one pipelined
   * round-trip for the page, see FramesStreamService.pendingFinalize); one
   * still inside it (a platform the query's lowercase list misses) is held
   * without a lookup.
   */
  private async completableIds(
    rows: LiveSweepRow[],
    now: number,
    nativeCutoff: number,
  ): Promise<{ plain: number[]; overdue: number[] }> {
    const pastGrace = rows.filter(
      (r) => this.isNative(r) && r.endedAt.getTime() < nativeCutoff,
    );
    const states = await this.frames.pendingFinalize(
      pastGrace.map((r) => r.publicId),
      now,
    );
    const plain: number[] = [];
    const overdue: number[] = [];
    for (const r of rows) {
      if (!this.isNative(r)) plain.push(r.id);
      else if (r.endedAt.getTime() >= nativeCutoff) continue; // in the grace
      else if (states.pending.has(r.publicId)) continue; // finalize to come
      else if (states.overdue.has(r.publicId)) overdue.push(r.id);
      else plain.push(r.id); // no frames, or no score to go by
    }
    return { plain, overdue };
  }

  /** One set-based flip of a page's ids to COMPLETED (plus `data`), guarded
   *  so a row the finalizer completed, or that took a new batch, since the
   *  page was read is left alone. Returns the rows flipped. */
  private async completeLive(
    ids: number[],
    cutoff: Date,
    data: { endedAt?: Date },
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.pg.session.updateMany({
      where: { id: { in: ids }, status: "LIVE", endedAt: { lt: cutoff } },
      data: { status: "COMPLETED", ...data },
    });
    return res.count;
  }

  private isNative(row: LiveSweepRow): boolean {
    return (
      row.platform != null &&
      RetentionService.NATIVE_PLATFORMS.has(row.platform.toLowerCase())
    );
  }

  /** Bulk-enqueue one retention job of `kind` per workspace id in a page. */
  private enqueueKind(
    kind: RetentionJob["kind"],
    workspaceIds: number[],
    enqueuedAt: number,
  ): Promise<void> {
    return this.queue.enqueueRetentionBulk(
      workspaceIds.map((workspaceId) => ({ kind, workspaceId, enqueuedAt })),
    );
  }

  /**
   * Keyset-paginate WorkspaceStats by the PK `workspaceId`, applying an
   * extra `where` (e.g. sessionsTotal>0), and hand each page of ids to
   * `handle`. Returns the total rows drained.
   *
   * Each page is `WHERE workspaceId > cursor [AND extra] ORDER BY
   * workspaceId ASC LIMIT PAGE` — a PK index range-scan from the last id.
   * Bounded memory; O(pages) round trips; no OFFSET, no silent take cap.
   */
  private async drainWorkspaceStats(
    extraWhere: Record<string, unknown>,
    handle: (workspaceIds: number[]) => Promise<void>,
  ): Promise<number> {
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.pg.workspaceStats.findMany({
        where: { workspaceId: { gt: cursor }, ...extraWhere },
        select: { workspaceId: true },
        orderBy: { workspaceId: "asc" },
        take: PAGE,
      });
      if (rows.length === 0) break;
      await handle(rows.map((r) => r.workspaceId));
      total += rows.length;
      cursor = rows[rows.length - 1].workspaceId;
      if (rows.length < PAGE) break;
    }
    return total;
  }

  /**
   * Keyset-paginate the DISTINCT workspaceIds that own ≥1 row in `table`
   * (Playlist / Cohort), handing each page to `handle`. Returns the total
   * distinct workspaces drained.
   *
   * Raw SQL because Prisma's `distinct` is applied after `take` and so
   * can't be keyset-paginated safely. `SELECT DISTINCT "workspaceId" …
   * WHERE "workspaceId" > $1 ORDER BY "workspaceId" ASC LIMIT $2` is backed
   * by each table's @@index([workspaceId]) and pages by the same column.
   * `table` is a fixed internal literal (never user input) — safe to inline.
   */
  private async drainDistinctWorkspaceIds(
    table: "Playlist" | "Cohort",
    handle: (workspaceIds: number[]) => Promise<void>,
  ): Promise<number> {
    let cursor = 0;
    let total = 0;
    for (;;) {
      const rows = await this.pg.$queryRawUnsafe<Array<{ workspaceId: number }>>(
        `SELECT DISTINCT "workspaceId" FROM "${table}"
         WHERE "workspaceId" > $1
         ORDER BY "workspaceId" ASC
         LIMIT $2`,
        cursor,
        PAGE,
      );
      if (rows.length === 0) break;
      await handle(rows.map((r) => r.workspaceId));
      total += rows.length;
      cursor = rows[rows.length - 1].workspaceId;
      if (rows.length < PAGE) break;
    }
    return total;
  }

  /** A plan's advisory storage ceiling, derived from its SESSION allowance (see
   *  STORAGE_BYTES_PER_SESSION). null = uncapped (Enterprise, negotiated).
   *  resolvePlan() also folds the legacy PRO/TEAM rows onto current tiers, which
   *  is what the old hardcoded lookup was really doing — badly. */
  /** Enterprise has no session ceiling to derive storage from, but it DID have a
   *  working 5 TiB alert before the quota table was reconciled with the plan
   *  catalog — and "negotiated" is a reason not to derive a ceiling, not a
   *  reason for nobody to notice a 4 TB account. Keep an explicit floor for it
   *  so the 80% notification still fires; the number is the owner's to tune. */
  private static readonly ENTERPRISE_QUOTA_BYTES = 5 * 1024 ** 4;

  private planQuotaBytes(plan: string | null | undefined): number | null {
    const tier = resolvePlan(plan);
    if (tier.sessions == null)
      return tier.key === "ENTERPRISE"
        ? RetentionService.ENTERPRISE_QUOTA_BYTES
        : null;
    return tier.sessions * STORAGE_BYTES_PER_SESSION;
  }

  /**
   * Notify admins of the over-80% workspaces in one keyset page. The page
   * is pre-filtered to `storageBytes >= floor`; here we apply the exact
   * per-plan percentage, then issue ONE batched admins query for the whole
   * page (never one query per workspace).
   */
  private async notifyOverThreshold(
    rows: Array<{
      workspaceId: number;
      storageBytes: bigint;
      workspace: { name: string; plan: string } | null;
    }>,
  ): Promise<void> {
    const over = rows
      .flatMap((r) => {
        const used = Number(r.storageBytes ?? 0n);
        const plan = r.workspace?.plan ?? "FREE";
        const quota = this.planQuotaBytes(plan);
        // No derivable ceiling and no explicit one — nothing to be at 80% OF, so
        // drop rather than alert against someone else's number.
        if (quota == null) return [];
        return [
          {
            workspaceId: r.workspaceId,
            name: r.workspace?.name ?? "",
            plan,
            used,
            quota,
            pct: (used / quota) * 100,
          },
        ];
      })
      .filter((w) => w.pct >= 80);
    if (over.length === 0) return;

    // ONE query for every admin across this page's flagged workspaces.
    const wsIds = over.map((w) => w.workspaceId);
    const adminRows = await this.pg.workspaceMember.findMany({
      where: { workspaceId: { in: wsIds }, role: { in: ["OWNER", "ADMIN"] } },
      select: { workspaceId: true, userId: true },
    });
    const adminsByWs = new Map<number, number[]>();
    for (const a of adminRows) {
      const arr = adminsByWs.get(a.workspaceId);
      if (arr) arr.push(a.userId);
      else adminsByWs.set(a.workspaceId, [a.userId]);
    }

    // emitOnce dedupes per user within 24h, so concurrent calls are safe.
    await Promise.all(
      over.flatMap((ws) =>
        (adminsByWs.get(ws.workspaceId) ?? []).map((userId) =>
          this.notifications
            .emitOnce({
              workspaceId: ws.workspaceId,
              userId,
              kind: "STORAGE_THRESHOLD",
              payload: {
                workspaceName: ws.name,
                usedBytes: ws.used,
                quotaBytes: ws.quota,
                percent: Math.round(ws.pct),
                plan: ws.plan,
              },
              withinHours: 24,
            })
            .catch(() => undefined),
        ),
      ),
    );
  }
}
