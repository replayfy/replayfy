import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";

/** The counter deltas a caller can bump. Negative = decrement (delete paths). */
type StatDeltas = Partial<{
  sessionsTotal: number;
  playlistsTotal: number;
  usersTotal: number;
  cohortsTotal: number;
  commentsTotal: number;
  funnelsTotal: number;
  liveSessions: number;
  storageBytes: bigint;
}>;

/**
 * WorkspaceStats — the workspace-level counters table.
 *
 * Every place that creates / deletes a session / playlist / cohort /
 * comment / funnel calls into this service to keep the cached totals
 * accurate. The Dashboard counts endpoint reads from this table
 * instead of running five `.count()` queries per poll.
 *
 * Why this exists:
 *   - `db.session.count({ where: { workspaceId } })` is O(rows in table)
 *     even with the workspace index — at 10M sessions you're scanning a
 *     million index pages per poll, five times.
 *   - The dashboard polls counts every 15s. That's 5 full scans every
 *     15 seconds, per browser tab open against the workspace.
 *   - Maintaining a counter row reduces every read to a single PK
 *     lookup that returns in microseconds.
 *
 * Stale-counter safety:
 *   - Counters can drift if a write path forgets to call this service.
 *   - `reconcile(workspaceId)` recomputes from authoritative counts and
 *     resets the row. Cheap enough to run on a 5-minute cron.
 *   - The read path checks `updatedAt`; if older than 5 minutes, it
 *     refuses the cached row and falls back to live `.count()` queries,
 *     then schedules a reconcile.
 */
@Injectable()
export class WorkspaceStatsService {
  private readonly db = getPostgresClient();

  // ---- Bump coalescing --------------------------------------------------
  // Every ingested session bumps this table (sessionsTotal, storageBytes,
  // usersTotal, liveSessions). Each bump is an UPDATE on the SINGLE row for
  // that workspace, so under ingest load a hot ("whale") workspace serialises
  // every worker on ONE row lock — a measured throughput cap once the CH
  // insert stopped being the wall. Coalescing accumulates per-workspace deltas
  // in memory and flushes them as ONE upsert per workspace per short window,
  // collapsing O(sessions) UPDATEs into O(active-workspaces / window). Safe
  // because this table is explicitly best-effort: `reconcile` recomputes it
  // from authoritative counts every 30 min and the read path refuses rows
  // older than 5 min — so a ≤1s coalescing lag (or a handful of deltas lost to
  // a crash) is corrected automatically. WORKSPACE_STATS_COALESCE=0 restores
  // the original write-through-per-bump behavior exactly.
  private readonly coalesceBumps =
    (process.env.WORKSPACE_STATS_COALESCE ?? "1") === "1";
  private readonly bumpFlushMs = Number(
    process.env.WORKSPACE_STATS_FLUSH_MS ?? 1000,
  );
  private readonly pendingBumps = new Map<number, StatDeltas>();
  private bumpFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bump a set of counters. Pass negative numbers for decrement (delete
   * paths). Skips silently if the workspace has no stats row yet — the next
   * reconcile will create one. Coalesced by default (see above); the durable
   * write happens in `writeBump`.
   */
  async bump(workspaceId: number, deltas: StatDeltas): Promise<void> {
    if (!this.coalesceBumps) {
      await this.writeBump(workspaceId, deltas);
      return;
    }
    // Accumulate into this workspace's pending deltas (additive, so a
    // LIVE→COMPLETED liveSessions +1/-1 pair nets to 0 before it ever hits PG).
    const acc = (this.pendingBumps.get(workspaceId) ?? {}) as Record<
      string,
      number | bigint
    >;
    for (const [k, v] of Object.entries(deltas)) {
      if (typeof v === "number") {
        acc[k] = ((acc[k] as number | undefined) ?? 0) + v;
      } else if (typeof v === "bigint") {
        acc[k] = ((acc[k] as bigint | undefined) ?? 0n) + v;
      }
    }
    this.pendingBumps.set(workspaceId, acc as StatDeltas);
    if (this.bumpFlushTimer === null) {
      this.bumpFlushTimer = setTimeout(() => {
        void this.flushBumps();
      }, this.bumpFlushMs);
    }
  }

  /** Flush all accumulated per-workspace deltas as one upsert each. Drains the
   *  map synchronously so bumps arriving during the writes start a fresh
   *  window. Best-effort — a failed flush is logged; reconcile is the backstop.
   */
  private async flushBumps(): Promise<void> {
    this.bumpFlushTimer = null;
    if (this.pendingBumps.size === 0) return;
    const batch = [...this.pendingBumps.entries()];
    this.pendingBumps.clear();
    await Promise.all(
      batch.map(([workspaceId, deltas]) =>
        this.writeBump(workspaceId, deltas).catch((e) => {
          process.stderr.write(
            `[stats] coalesced bump flush failed for ws=${workspaceId}: ${(e as Error).message}\n`,
          );
        }),
      ),
    );
  }

  /** Flush pending bumps immediately (call on graceful shutdown so the last
   *  window's deltas aren't lost). No-op when coalescing is disabled. */
  async flushPendingBumps(): Promise<void> {
    if (this.bumpFlushTimer !== null) {
      clearTimeout(this.bumpFlushTimer);
      this.bumpFlushTimer = null;
    }
    await this.flushBumps();
  }

  /** The durable write — one upsert applying `deltas` as increments. This is
   *  the original `bump` body, unchanged, now shared by the direct and
   *  coalesced paths. */
  private async writeBump(
    workspaceId: number,
    deltas: StatDeltas,
  ): Promise<void> {
    const data: Record<string, { increment: number | bigint }> = {};
    for (const [k, v] of Object.entries(deltas)) {
      if (typeof v === "number" || typeof v === "bigint") {
        // A netted-to-zero delta would still touch the row (and updatedAt) for
        // no counter change — skip it so a churny workspace doesn't write a
        // no-op every window.
        if (v === 0 || v === 0n) continue;
        data[k] = { increment: v };
      }
    }
    if (Object.keys(data).length === 0) return;
    // Upsert so the first ever write creates the row instead of failing.
    // The `create` path uses Math.max(0, …) on every field so a delete
    // arriving before any create can't push us negative.
    const safeCreate: Record<string, number | bigint> = { workspaceId };
    for (const [k, v] of Object.entries(deltas)) {
      if (typeof v === "number") safeCreate[k] = Math.max(0, v);
      else if (typeof v === "bigint") safeCreate[k] = v < 0n ? 0n : v;
    }
    await this.db.workspaceStats.upsert({
      where: { workspaceId },
      create: safeCreate as never,
      update: data,
    });
  }

  /**
   * Read the cached counts. Returns null when the row is missing OR
   * older than `maxAgeMs` (default 5 min) — callers should fall back to
   * live `.count()` queries and trigger a reconcile in that case.
   */
  async read(workspaceId: number, maxAgeMs = 5 * 60_000) {
    const row = await this.db.workspaceStats.findUnique({
      where: { workspaceId },
    });
    if (!row) return null;
    if (Date.now() - row.updatedAt.getTime() > maxAgeMs) return null;
    return row;
  }

  /**
   * Recompute counters from authoritative tables and write them back.
   * Idempotent — safe to run repeatedly. Used by the read path's
   * fallback + as a cron job for drift correction.
   *
   * Runs the five counts in parallel; total cost is one indexed
   * count per table, same as the legacy `Dashboard.counts` endpoint.
   * The difference is this runs at most once per workspace per
   * 5 minutes, not once per dashboard poll.
   */
  async reconcile(workspaceId: number) {
    // Single-flight per workspace. `read()` returns null the moment the cached
    // row crosses maxAgeMs, so at that boundary EVERY concurrent /counts poll —
    // one per open dashboard tab, every ~15-30s — used to fire its own
    // reconcile, i.e. N x the eight COUNT/SUM queries below over the whole
    // workspace's sessions at the same instant. That thundering herd is what
    // made /counts the measured scaling wall (29 req/s, p95 9.6s at 1k
    // concurrent). Collapsing concurrent callers onto ONE shared promise turns
    // the herd into a single recompute; the losers await the same result rather
    // than queueing their own. Per-process (a multi-node deploy still allows one
    // reconcile per node — bounded and acceptable; a Redis lock would be the
    // next step if that ever shows up in practice).
    const inflight = this.reconcileInflight.get(workspaceId);
    if (inflight) return inflight;
    const run = this.reconcileNow(workspaceId).finally(() => {
      this.reconcileInflight.delete(workspaceId);
    });
    this.reconcileInflight.set(workspaceId, run);
    return run;
  }

  /** In-flight reconciles keyed by workspace — see reconcile() above. */
  private readonly reconcileInflight = new Map<
    number,
    Promise<{
      workspaceId: number;
      sessionsTotal: number;
      playlistsTotal: number;
      usersTotal: number;
      cohortsTotal: number;
      commentsTotal: number;
      funnelsTotal: number;
      liveSessions: number;
      storageBytes: bigint;
    }>
  >();

  private async reconcileNow(workspaceId: number) {
    const [
      sessionsTotal,
      playlistsTotal,
      usersTotal,
      cohortsTotal,
      commentsTotal,
      funnelsTotal,
      live,
      storageAgg,
    ] = await Promise.all([
      this.db.session.count({ where: { workspaceId } }),
      this.db.playlist.count({ where: { workspaceId } }),
      this.db.endUser.count({ where: { workspaceId } }),
      this.db.cohort.count({ where: { workspaceId } }),
      this.db.comment.count({ where: { workspaceId, deletedAt: null } }),
      this.db.funnel.count({ where: { workspaceId } }),
      this.db.session.count({ where: { workspaceId, status: "LIVE" } }),
      this.db.session.aggregate({
        where: { workspaceId },
        _sum: { dataSizeBytes: true },
      }),
    ]);
    const storageBytes = storageAgg._sum.dataSizeBytes ?? 0n;
    await this.db.workspaceStats.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        sessionsTotal,
        playlistsTotal,
        usersTotal,
        cohortsTotal,
        commentsTotal,
        funnelsTotal,
        liveSessions: live,
        storageBytes,
      },
      update: {
        sessionsTotal,
        playlistsTotal,
        usersTotal,
        cohortsTotal,
        commentsTotal,
        funnelsTotal,
        liveSessions: live,
        storageBytes,
      },
    });
    return {
      workspaceId,
      sessionsTotal,
      playlistsTotal,
      usersTotal,
      cohortsTotal,
      commentsTotal,
      funnelsTotal,
      liveSessions: live,
      storageBytes,
    };
  }

  /**
   * Every 30 minutes, reconcile every active workspace's counters.
   *
   * Access pattern (was: findMany ALL non-deleted workspaces into memory,
   * then 7 groupBys with a single giant `workspaceId IN (…)` over the whole
   * fleet + N parallel upserts — blows up at 1M workspaces: unbounded
   * memory, an `IN` list with a million ids, and a million concurrent
   * writes):
   *
   *   Keyset-paginate the WorkspaceStats PK in pages of `PAGE`. Rows exist
   *   in WorkspaceStats only for workspaces that have ever had activity
   *   (the `bump` upsert creates the row on the first session / playlist /
   *   cohort / comment / funnel), so this IS the active-workspace index —
   *   zero-activity workspaces are correctly skipped (nothing to reconcile).
   *   Each page runs the 7 authoritative aggregates scoped to JUST that
   *   page's ≤PAGE ids (each backed by the per-table workspaceId index) and
   *   upserts the page's rows. Bounded memory, a small `IN` list, and short
   *   per-row write locks — deliberately NOT one fleet-wide UPDATE, because
   *   the dashboard reads this table every 15s and must not block behind a
   *   long lock. Scales to millions: O(pages), not O(1 huge).
   *
   * Belt-and-suspenders against bumps that didn't land (network glitches,
   * server restarts mid-write).
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async reconcileAll(): Promise<void> {
    const PAGE = 500;
    let cursor = 0;
    for (;;) {
      const page = await this.db.workspaceStats.findMany({
        where: { workspaceId: { gt: cursor } },
        select: { workspaceId: true },
        orderBy: { workspaceId: "asc" },
        take: PAGE,
      });
      if (page.length === 0) break;
      const wsIds = page.map((w) => w.workspaceId);
      await this.reconcilePage(wsIds);
      cursor = wsIds[wsIds.length - 1];
      if (page.length < PAGE) break;
    }
  }

  /**
   * Recompute + upsert counters for one keyset page of workspace ids.
   * Seven aggregates scoped to `wsIds` (each an index scan grouped by the
   * workspace FK), then per-row upserts in parallel. Private method, not a
   * free function, per the repo's controller/service rule.
   */
  private async reconcilePage(wsIds: number[]): Promise<void> {
    if (wsIds.length === 0) return;

    const [
      sessionsByWs,
      playlistsByWs,
      usersByWs,
      cohortsByWs,
      commentsByWs,
      funnelsByWs,
      liveByWs,
      storageByWs,
    ] = await Promise.all([
      this.db.session.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _count: { _all: true },
      }),
      this.db.playlist.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _count: { _all: true },
      }),
      this.db.endUser.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _count: { _all: true },
      }),
      this.db.cohort.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _count: { _all: true },
      }),
      this.db.comment.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds }, deletedAt: null },
        _count: { _all: true },
      }),
      this.db.funnel.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _count: { _all: true },
      }),
      this.db.session.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds }, status: "LIVE" },
        _count: { _all: true },
      }),
      this.db.session.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { in: wsIds } },
        _sum: { dataSizeBytes: true },
      }),
    ]);

    // Build lookup maps once so the upsert loop is O(N) hash lookups,
    // not O(N²) array scans.
    const get = <T>(rows: Array<{ workspaceId: number } & T>) =>
      new Map(rows.map((r) => [r.workspaceId, r]));
    const m = {
      sessions: get(sessionsByWs),
      playlists: get(playlistsByWs),
      users: get(usersByWs),
      cohorts: get(cohortsByWs),
      comments: get(commentsByWs),
      funnels: get(funnelsByWs),
      live: get(liveByWs),
      storage: get(storageByWs),
    };

    // Parallel upserts. Each is a single PK lookup + write.
    await Promise.all(
      wsIds.map((id) => {
        const data = {
          sessionsTotal: m.sessions.get(id)?._count._all ?? 0,
          playlistsTotal: m.playlists.get(id)?._count._all ?? 0,
          usersTotal: m.users.get(id)?._count._all ?? 0,
          cohortsTotal: m.cohorts.get(id)?._count._all ?? 0,
          commentsTotal: m.comments.get(id)?._count._all ?? 0,
          funnelsTotal: m.funnels.get(id)?._count._all ?? 0,
          liveSessions: m.live.get(id)?._count._all ?? 0,
          storageBytes: m.storage.get(id)?._sum.dataSizeBytes ?? 0n,
        };
        return this.db.workspaceStats
          .upsert({
            where: { workspaceId: id },
            create: { workspaceId: id, ...data },
            update: data,
          })
          .catch((e) => {
            process.stderr.write(
              `[stats] reconcile upsert failed for ws=${id}: ${(e as Error).message}\n`,
            );
          });
      }),
    );
  }
}
