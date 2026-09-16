import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient, Prisma } from "@replay/db-postgres";

/** Counters used to compute a day's health score. */
interface HealthCounters {
  sessions: number;
  frustrated: number;
  backendFail: number;
  slowApi: number;
  formAbandon: number;
  navLoop: number;
  crashes: number;
}

/**
 * Maintains the daily semantic-signal rollup (WorkspaceSignalDaily) and serves
 * the Overview Pulse (doc 09 §5.3 / 10 Slice 2). ALWAYS an ABSOLUTE, idempotent
 * recompute from the authoritative Session + Signal tables — never an
 * incremental add (the old `bump()` incremented, so re-deriving a session on
 * finalize + retention sweep double-counted, inflating sessions/crashes):
 *   - `reconcileFinalize()` recomputes the touched workspace-days on the
 *     finalize path (keeps the Pulse fresh intraday),
 *   - `reconcileRecent()` recomputes the trailing window nightly across all
 *     workspaces (catches retention-swept / late finalizers),
 *   - both go through `reconcileScope()` — one set-based INSERT…SELECT that SETS
 *     (never adds), so running it any number of times yields the same row,
 *   - `pulse()` reads today + the past week and recomputes health live.
 *
 * Health weights (doc 09 §6.1) are duplicated between the SQL reconcile and the
 * JS `health()` read below — KEEP THEM IN SYNC. Sum of weights = 7.0.
 */
@Injectable()
export class WorkspaceSignalDailyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceSignalDailyService.name);

  /** Recompute this many trailing days each night (covers late finalizers,
   *  retention-swept sessions, and re-derives). */
  private static readonly RECONCILE_DAYS = 3;

  /**
   * Intraday finalize-path rollup update — called ONCE per finalize batch with
   * the touched workspaces + the oldest touched UTC day. Recomputes those
   * workspace-days ABSOLUTELY, so re-deriving a session (finalize + retention
   * sweep) can never double-count (the fault the old incremental bump had).
   * Best-effort: a failure only costs intraday Pulse freshness; nightly backstops.
   */
  async reconcileFinalize(
    workspaceIds: number[],
    sinceDay: Date,
  ): Promise<number> {
    if (workspaceIds.length === 0) return 0;
    return this.reconcileScope(sinceDay, workspaceIds);
  }

  /**
   * Absolute recompute from an ARBITRARY day forward, scoped to a set of
   * workspaces when given (else all). Public entry for callers that must keep
   * the rollup honest OUTSIDE the nightly trailing window:
   *   - the hard-delete paths (SessionReaperService.eraseMany) — a session
   *     erased older than RECONCILE_DAYS would otherwise leave its day's count
   *     inflated, the exact drift that made the Overview "Sessions" total exceed
   *     the live count;
   *   - the one-time historical backfill (deploy/reconcile-signal-daily.ts).
   * Idempotent (SETS, never adds) — the same indexed range read as
   * `reconcileFinalize`, just an operator-chosen `windowStart`.
   */
  async reconcileSince(
    windowStart: Date,
    workspaceIds?: number[],
  ): Promise<number> {
    return this.reconcileScope(windowStart, workspaceIds);
  }

  /**
   * BOUNDED absolute recompute + emptied-day reset for a SINGLE workspace over
   * exactly [fromDay, toDayExclusive). The hard-delete path (eraseMany) uses this
   * so a delete only recomputes the days it actually touched — never the whole
   * history forward — which keeps the work bounded even when GDPR-forget erases
   * page by page.
   */
  async reconcileRange(
    workspaceId: number,
    fromDay: Date,
    toDayExclusive: Date,
  ): Promise<number> {
    return this.reconcileScope(fromDay, [workspaceId], toDayExclusive);
  }

  /**
   * Nightly authoritative recompute of the trailing window across ALL
   * workspaces — catches retention-swept sessions + late finalizers.
   */
  @Cron("45 2 * * *")
  async reconcileRecent(): Promise<number> {
    const windowStart = new Date();
    windowStart.setUTCHours(0, 0, 0, 0);
    windowStart.setUTCDate(
      windowStart.getUTCDate() - (WorkspaceSignalDailyService.RECONCILE_DAYS - 1),
    );
    return this.reconcileScope(windowStart);
  }

  /**
   * The shared ABSOLUTE recompute. One set-based INSERT…SELECT…ON CONFLICT that
   * SETS (never adds) each touched (workspaceId, day): sessions = count(*) of
   * COMPLETED sessions that day (the rate denominator), per-type counts =
   * distinct-session counts in the Signal table, healthScore inline. Idempotent
   * by construction — running it any number of times yields the same row, so
   * finalize + retention sweep + nightly can all fire without double-counting.
   * Optionally scoped to a set of workspaces (finalize path); unscoped = all
   * (nightly). Access pattern: indexed range on endedAt/occurredAt (+ optional
   * workspaceId IN), bounded by the window — never a scan, never per-row.
   */
  private async reconcileScope(
    windowStart: Date,
    workspaceIds?: number[],
    windowEnd?: Date,
  ): Promise<number> {
    const hasWs = !!(workspaceIds && workspaceIds.length > 0);
    const wsFilter = hasWs
      ? Prisma.sql`AND "workspaceId" IN (${Prisma.join(workspaceIds!)})`
      : Prisma.empty;
    // Same scope, qualified with the DELETE's table alias `w`.
    const wsFilterW = hasWs
      ? Prisma.sql`AND w."workspaceId" IN (${Prisma.join(workspaceIds!)})`
      : Prisma.empty;
    // Optional UPPER bound (exclusive). The hard-delete path passes it so a
    // delete only recomputes the days it actually touched, not everything from
    // the oldest affected day to today. Unbounded (null) for the nightly + the
    // one-time backfill.
    const endSess = windowEnd
      ? Prisma.sql`AND "endedAt" < ${windowEnd}`
      : Prisma.empty;
    const endSig = windowEnd
      ? Prisma.sql`AND "occurredAt" < ${windowEnd}`
      : Prisma.empty;
    const endW = windowEnd
      ? Prisma.sql`AND w."day" < ${windowEnd}::date`
      : Prisma.empty;
    try {
      // 1) ABSOLUTE recompute of every day in-window that STILL has >=1 COMPLETED
      // session. (This alone can never RESET a day that lost all its sessions —
      // step 2 handles that.)
      const n = await this.db.$executeRaw`
        WITH sess AS (
          SELECT "workspaceId",
                 ("endedAt" AT TIME ZONE 'UTC')::date AS day,
                 count(*) AS sessions
          FROM "Session"
          WHERE "status" = 'COMPLETED' AND "endedAt" >= ${windowStart} ${endSess} ${wsFilter}
          GROUP BY 1, 2
        ),
        sig AS (
          SELECT "workspaceId",
                 ("occurredAt" AT TIME ZONE 'UTC')::date AS day,
                 count(DISTINCT CASE WHEN type='user_frustrated'    THEN "sessionId" END) AS frustrated,
                 count(DISTINCT CASE WHEN type='backend_failure'    THEN "sessionId" END) AS backend_fail,
                 count(DISTINCT CASE WHEN type='slow_api'           THEN "sessionId" END) AS slow_api,
                 count(DISTINCT CASE WHEN type='form_abandonment'   THEN "sessionId" END) AS form_abandon,
                 count(DISTINCT CASE WHEN type='navigation_loop'    THEN "sessionId" END) AS nav_loop,
                 count(DISTINCT CASE WHEN type='crash_detected'     THEN "sessionId" END) AS crashes,
                 count(DISTINCT CASE WHEN type='conversion_success' THEN "sessionId" END) AS conv_success,
                 count(DISTINCT CASE WHEN type='conversion_failure' THEN "sessionId" END) AS conv_failure
          FROM "Signal"
          WHERE "occurredAt" >= ${windowStart} ${endSig} ${wsFilter}
          GROUP BY 1, 2
        )
        INSERT INTO "WorkspaceSignalDaily" (
          "workspaceId","day","sessions","frustrated","backendFail","slowApi",
          "formAbandon","navLoop","crashes","convSuccess","convFailure","healthScore","updatedAt"
        )
        SELECT
          s."workspaceId", s.day, s.sessions,
          COALESCE(g.frustrated,0),  COALESCE(g.backend_fail,0), COALESCE(g.slow_api,0),
          COALESCE(g.form_abandon,0),COALESCE(g.nav_loop,0),     COALESCE(g.crashes,0),
          COALESCE(g.conv_success,0),COALESCE(g.conv_failure,0),
          GREATEST(0, round(100 * (1 - LEAST(1.0, (
                2.0 * LEAST(1.0, COALESCE(g.crashes,0)::float8      / NULLIF(s.sessions,0))
              + 1.5 * LEAST(1.0, COALESCE(g.backend_fail,0)::float8 / NULLIF(s.sessions,0))
              + 1.0 * LEAST(1.0, COALESCE(g.frustrated,0)::float8   / NULLIF(s.sessions,0))
              + 1.0 * LEAST(1.0, COALESCE(g.slow_api,0)::float8     / NULLIF(s.sessions,0))
              + 1.0 * LEAST(1.0, COALESCE(g.form_abandon,0)::float8 / NULLIF(s.sessions,0))
              + 0.5 * LEAST(1.0, COALESCE(g.nav_loop,0)::float8     / NULLIF(s.sessions,0))
            ) / 7.0)))) ::int,
          NOW()
        FROM sess s
        LEFT JOIN sig g ON g."workspaceId" = s."workspaceId" AND g.day = s.day
        ON CONFLICT ("workspaceId","day") DO UPDATE SET
          "sessions"    = EXCLUDED."sessions",
          "frustrated"  = EXCLUDED."frustrated",
          "backendFail" = EXCLUDED."backendFail",
          "slowApi"     = EXCLUDED."slowApi",
          "formAbandon" = EXCLUDED."formAbandon",
          "navLoop"     = EXCLUDED."navLoop",
          "crashes"     = EXCLUDED."crashes",
          "convSuccess" = EXCLUDED."convSuccess",
          "convFailure" = EXCLUDED."convFailure",
          "healthScore" = EXCLUDED."healthScore",
          "updatedAt"   = NOW()
      `;
      // 2) RESET days that lost ALL their sessions: an explicit delete can empty
      // an old day, which the INSERT above (driven by SURVIVING sessions) never
      // touches. Deleting the orphaned rollup row is correct — pulse/metrics read
      // a missing day as zero — and is what keeps the Overview "Sessions" total
      // from drifting ABOVE the live count. Bounded to the same window + scope;
      // `valid` re-derives the days that still have a completed session, then the
      // anti-join drops any in-window rollup row not among them.
      await this.db.$executeRaw`
        WITH valid AS (
          SELECT "workspaceId", ("endedAt" AT TIME ZONE 'UTC')::date AS day
          FROM "Session"
          WHERE "status" = 'COMPLETED' AND "endedAt" >= ${windowStart} ${endSess} ${wsFilter}
          GROUP BY 1, 2
        )
        DELETE FROM "WorkspaceSignalDaily" w
        WHERE w."day" >= ${windowStart}::date ${wsFilterW} ${endW}
          AND NOT EXISTS (
            SELECT 1 FROM valid v
            WHERE v."workspaceId" = w."workspaceId" AND v.day = w.day
          )
      `;
      this.logger.log(`signal-daily reconcile touched ${n} workspace-days`);
      return n;
    } catch (e) {
      this.logger.warn(`signal-daily reconcile failed: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * The Overview Pulse payload — health + signal totals over the trailing
   * `days` window (so it reflects real recent activity, not just an empty
   * calendar-today), the window-over-window delta, per-metric deltas for the
   * health cards, and a per-day health sparkline. One indexed range read.
   */
  async pulse(workspaceId: number, days = 7) {
    const today = WorkspaceSignalDailyService.toDay(new Date());
    const win = Math.max(1, days);
    const curStart = new Date(today);
    curStart.setUTCDate(curStart.getUTCDate() - (win - 1));
    const priorStart = new Date(today);
    priorStart.setUTCDate(priorStart.getUTCDate() - (2 * win - 1));

    const rows = await this.db.workspaceSignalDaily.findMany({
      where: { workspaceId, day: { gte: priorStart } },
      orderBy: { day: "asc" },
    });
    const byKey = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));

    const empty = () => ({
      sessions: 0,
      frustrated: 0,
      backendFail: 0,
      slowApi: 0,
      formAbandon: 0,
      navLoop: 0,
      crashes: 0,
      convSuccess: 0,
      convFailure: 0,
    });
    // Sum every counter over [from, today-window] — the current or prior window.
    const sumWindow = (offsetDays: number) => {
      const acc = empty();
      for (let i = 0; i < win; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - offsetDays - i);
        const row = byKey.get(d.toISOString().slice(0, 10));
        if (!row) continue;
        acc.sessions += row.sessions;
        acc.frustrated += row.frustrated;
        acc.backendFail += row.backendFail;
        acc.slowApi += row.slowApi;
        acc.formAbandon += row.formAbandon;
        acc.navLoop += row.navLoop;
        acc.crashes += row.crashes;
        acc.convSuccess += row.convSuccess;
        acc.convFailure += row.convFailure;
      }
      return acc;
    };

    const cur = sumWindow(0);
    const prev = sumWindow(win);
    const health = this.health(cur);
    const healthPrev = this.health(prev);

    // Per-day health sparkline across the current window (oldest → newest).
    // A day with no data is a GAP (null), not a 100: plotting absent days at the
    // top of the scale drew a flat perfect line for a workspace sending nothing,
    // which is precisely the shape a reader interprets as "all good".
    const spark: Array<number | null> = [];
    for (let i = win - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const row = byKey.get(d.toISOString().slice(0, 10));
      spark.push(row ? this.health(row) : null);
    }

    return {
      health,
      // A delta needs two measurable windows. Comparing against an unmeasurable
      // one produced invented movement — "health improved 8 points" when the
      // truth was that one of the two windows had no sessions in it at all.
      healthDelta:
        health !== null && healthPrev !== null ? health - healthPrev : null,
      sessions: cur.sessions,
      // Window totals + the prior window, so the cards can show deltas.
      signals: cur,
      signalsPrev: prev,
      // Transparent health breakdown (doc 09 §6.1): what's dragging health down.
      subScores: this.subScores(cur),
      spark,
    };
  }

  /**
   * Decompose health into the dimensions a founder reasons about (each 0–100):
   * Stability (crashes/backend), Performance (slow APIs), UX (frustration/
   * loops/form-abandon), Conversion (success vs failure/abandon).
   *
   * NULL when there were no sessions — same reasoning as health(). Previously
   * `rate()` resolved 0/0 to 0, so every penalty vanished and all four dimensions
   * read a perfect 100 off an empty window. Conversion did it twice over: with no
   * wins and no losses, `wins + losses === 0 ? 100` scored a product nobody used
   * as converting perfectly.
   */
  private subScores(
    c: HealthCounters & { convSuccess?: number; convFailure?: number },
  ): {
    stability: number;
    performance: number;
    ux: number;
    conversion: number;
  } | null {
    const s = c.sessions;
    if (!s || s <= 0) {
      return null;
    }
    const rate = (n: number) => Math.min(1, n / s);
    const pct = (penalty: number) => Math.max(0, Math.round(100 * (1 - Math.min(1, penalty))));
    const stability = pct((2 * rate(c.crashes) + 1.5 * rate(c.backendFail)) / 3.5);
    const performance = pct(rate(c.slowApi));
    const ux = pct(
      (rate(c.frustrated) + rate(c.formAbandon) + 0.5 * rate(c.navLoop)) / 2.5,
    );
    const wins = c.convSuccess ?? 0;
    const losses = (c.convFailure ?? 0) + c.formAbandon;
    const conversion =
      wins + losses === 0 ? 100 : Math.round((wins / (wins + losses)) * 100);
    return { stability, performance, ux, conversion };
  }

  /**
   * 0–100 health for a day (doc 09 §6.1). Penalised by the weighted, clamped
   * per-session issue rates. KEEP WEIGHTS IN SYNC with the reconcile SQL above
   * (sum = 7.0).
   *
   * NULL when there were no sessions — health is UNMEASURABLE, not perfect.
   *
   * This returned 100 for a day with no sessions, which is the strongest claim
   * the scale can make, derived from no evidence at all. Health is a rate: with
   * zero sessions every rate is 0/0, and we were resolving that to "flawless".
   * The visible result was a dashboard reading "Experience score 92/100,
   * crash-free 100%" for a workspace whose ingestion had been dead for six days
   * — the one situation where the product most needs to shout, rendered as its
   * best-ever score. An empty window is a fact about our data collection, never
   * a compliment about the customer's product.
   *
   * Callers must render null as "no data" (—), NOT coerce it: `health ?? 100`
   * reintroduces the exact bug, and `health ?? 0` invents an outage.
   *
   * NOT fixed here, and worth its own change: the persisted
   * `WorkspaceSignalDaily.healthScore` column is `Int @default(100)`, and
   * alerts.service reads THAT column directly in SQL rather than calling this.
   * So a dead pipeline still persists 100, and "alert me when health drops below
   * 80" still cannot fire for the outage it exists to catch. Fixing that needs a
   * nullable column + a migration + a decision on what an alert should do with
   * an unmeasurable day.
   */
  private health(c: HealthCounters): number | null {
    if (!c.sessions || c.sessions <= 0) {
      return null;
    }
    const rate = (n: number) => Math.min(1, n / c.sessions);
    const weighted =
      (2.0 * rate(c.crashes) +
        1.5 * rate(c.backendFail) +
        1.0 * rate(c.frustrated) +
        1.0 * rate(c.slowApi) +
        1.0 * rate(c.formAbandon) +
        0.5 * rate(c.navLoop)) /
      7.0;
    return Math.max(0, Math.round(100 * (1 - Math.min(1, weighted))));
  }

  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
