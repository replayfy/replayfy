import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { QueueService } from "../queue/queue.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { RetentionJob } from "../queue/queue.types";
import { BILLING_SERVICE, type BillingPort } from "../billing/billing.port";
import { SignalsService } from "../signals/signals.service";
import { PLAN_TIERS, resolvePlan } from "../billing/plan-catalog";

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
// Same window the LIVE→COMPLETED session sweep uses, so a session and its user
// transition offline together.
const PRESENCE_STALE_MS = 60_000;

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

  /** Per-minute LIVE → COMPLETED sweep — single Postgres UPDATE, doesn't
   *  need to go through the queue. After flipping, re-evaluate the
   *  minimum-duration recording setting against the freshly-completed
   *  sessions. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepLiveSessions() {
    const cutoff = new Date(Date.now() - 60_000);
    // Select the ids first (bounded) so we can BOTH flip them to COMPLETED AND
    // derive their signals/Issues. The inline finalize hooks (web
    // replay-persistence, native frames finalizer) only fire for sessions that
    // self-finalize; an event-only mobile session (a crash with no captured
    // frames) never enters the frames ZSET, so this sweep is the ONLY place it
    // reaches COMPLETED. Without deriving here, its crash waits for the nightly
    // backfill. Access pattern: index-served on (status, endedAt); a bounded
    // `take` drains any backlog across the per-minute ticks (each flipped row
    // leaves the LIVE set, so no cursor is needed) — never a whole-table load.
    const stale = await this.pg.session.findMany({
      where: { status: "LIVE", endedAt: { lt: cutoff } },
      select: { id: true },
      take: 1000,
    });
    if (stale.length > 0) {
      const ids = stale.map((s) => s.id);
      await this.pg.session.updateMany({
        where: { id: { in: ids } },
        data: { status: "COMPLETED" },
      });
      this.logger.log(`Flipped ${ids.length} stale LIVE sessions to COMPLETED`);
      // Derive the freshly-completed sessions — one batched call (CH reads
      // grouped per workspace inside), fire-and-forget + idempotent, so a slow
      // or failing derive never blocks the sweep or billing settle below.
      void this.signals.deriveForSessions(ids);
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
