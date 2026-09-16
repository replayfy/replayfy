import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";
import {
  overviewUserMetrics,
  activityDimSeries,
  sessionSegments,
  type ActivityDimMetric,
} from "@replay/db-clickhouse";
import { PresenceService } from "../presence/presence.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { WorkspaceSignalDailyService } from "../workspace-signal-daily/workspace-signal-daily.service";
import { WorkspaceHealthService } from "../workspace-health/workspace-health.service";
import { IntelService } from "../intel/intel.service";
import { suggestedActionsForSignal } from "../signals/signal.constants";

// Template-first recommended action per signal type (no LLM — always shown so
// every incident card is actionable; the on-demand "Investigate" fetches a
// richer LLM hypothesis on top).
const INCIDENT_ACTION: Record<string, string> = {
  user_frustrated:
    "Watch the affected sessions and check that element's responsiveness + validation.",
  backend_failure:
    "Check the failing endpoint's error logs and recent deploys.",
  slow_api: "Profile the endpoint and review recent changes to it.",
  crash_detected:
    "Open a crashed session, symbolicate the stack, and check the latest release.",
  form_abandonment: "Review the form's required fields + validation messaging.",
  navigation_loop:
    "Review the navigation / information architecture on these screens.",
  conversion_success: "Find what's driving these wins and amplify it.",
  conversion_failure: "Open the drop-off step and review the flow.",
  unmet_demand:
    "Users keep trying to get here — consider building or surfacing this path.",
};

// How far back a "resurfacing" tag looks ("+12 new occurrences to 6 users in the
// last hour"). Kept short so the tag means "happening right now", not "ever".
const RECENT_WINDOW_MINS = 60;

@Injectable()
export class DashboardService {
  private readonly db = getPostgresClient();

  /** Redis TTL for the activity-series read-through cache. Sized against the
   *  bucket width, not the poll: at the default day/week granularity only the
   *  trailing PARTIAL bucket can move inside 2 minutes, so this is invisible on
   *  screen while still collapsing repeat loads and every concurrent viewer of
   *  the same chart onto one ClickHouse scan. */
  private static readonly ACTIVITY_CACHE_TTL_SEC = 120;

  constructor(
    private readonly presence: PresenceService,
    private readonly stats: WorkspaceStatsService,
    private readonly signalDaily: WorkspaceSignalDailyService,
    private readonly health: WorkspaceHealthService,
    private readonly intel: IntelService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Force an AI intelligence pass NOW (the dashboard's "regenerate insights"
   * action). No-op when AI is off. Makes TWO LLM calls (intel + intel-storyline,
   * in parallel) costing ~1,206 credits — the per-plan daily rate limit lives in
   * ManualAiThrottleGuard on the route, which rejects before this ever runs, so
   * this method just checks aiEnabled and runs the pass. It deliberately does NOT
   * short-circuit "facts unchanged": the user pressed regenerate, and
   * computeFactsFingerprint is a coarse proxy that misses whole fact classes
   * (issues, health magnitude), so running the pass is the honest response and
   * the guard already bounds how often it can happen.
   */
  async recomputeIntel(workspaceId: number) {
    // Access pattern: one row by PRIMARY KEY on a user-triggered click.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiEnabled: true },
    });
    if (ws?.aiEnabled === false) return { aiEnabled: false as const };
    const res = await this.intel.runPass(workspaceId);
    return {
      aiEnabled: true as const,
      insights: res.insights,
      storyline: res.storyline,
    };
  }

  /**
   * The AI intelligence layer for the Overview — GATED by the per-workspace
   * aiEnabled toggle. When AI is OFF this returns { aiEnabled: false } and the
   * dashboard renders only the classic/deterministic analytics; the classic
   * endpoints (overview/metrics) are unaffected in BOTH modes.
   *
   * When ON: the deterministic hybrid health score (0b) + the AI storyline &
   * health-explanation prose (from WorkspaceSnapshot, null until the Phase-3 intel
   * pass) + the ranked insights (WorkspaceInsight rows, [] until Phase 3). The
   * numbers are always fresh (5-min sweep); the prose is material-gated.
   */
  async intelligence(workspaceId: number, range = "30d") {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiEnabled: true },
    });
    if (ws?.aiEnabled === false) {
      return { aiEnabled: false as const };
    }
    const days =
      {
        today: 1,
        "24h": 1,
        "7d": 7,
        "14d": 14,
        "30d": 30,
        "90d": 90,
        "365d": 365,
      }[range] ?? 30;
    const [health, snap, insights] = await Promise.all([
      this.health.experienceHealth(workspaceId, days),
      this.db.workspaceSnapshot.findUnique({
        where: { workspaceId },
        select: {
          storylineText: true,
          storylineConfidence: true,
          storylineCitations: true,
          storylineAt: true,
          healthExplanations: true,
        },
      }),
      // Flat "All insights" list, ranked. Numbers on each row are refreshed by
      // the 5-min sweep (fresh + lane-consistent); [] until the Phase-3 pass writes them.
      this.db.workspaceInsight.findMany({
        where: { workspaceId },
        orderBy: { rank: "desc" },
        take: 30,
      }),
    ]);
    // Resurfacing tags: how much each insight's source has fired in the last
    // window ("+12 new occurrences to 6 users in the last hour"). Computed here
    // so it is live rather than as stale as the last AI pass.
    const recent = await this.recentOccurrences(workspaceId, insights);
    return {
      aiEnabled: true as const,
      health,
      storyline: snap?.storylineText
        ? {
            text: snap.storylineText,
            confidence: snap.storylineConfidence,
            citations: snap.storylineCitations ?? [],
            generatedAt: snap.storylineAt,
          }
        : null,
      healthExplanations: snap?.healthExplanations ?? null,
      insights: insights.map((i) => ({
        ...i,
        recent:
          recent.get(`${i.sourceIncidentId ?? ""}:${i.sourceIssueId ?? ""}`) ??
          null,
      })),
    };
  }

  /**
   * Recent-activity ("resurfacing") counts for a page of insights, keyed
   * `<incidentId>:<issueId>`. Two WINDOW-BOUNDED grouped scans for the whole
   * page — never one query per insight:
   *   - behavioural incidents: `Signal` grouped by its cluster key
   *     (type, screen, element) over `WHERE workspaceId=? AND occurredAt >= ?`,
   *     index-served by @@index([workspaceId, type, screen, occurredAt]). Matched
   *     to incidents by that same key because `Signal.incidentId` is not
   *     backfilled by the clusterer (all-null in practice).
   *   - crash/error issues: `IssueOccurrence` grouped by fingerprint over
   *     `WHERE workspaceId=? AND occurredAt >= ?`, index-served by
   *     @@index([workspaceId, fingerprint]) whose documented shape includes the
   *     occurredAt range. Mapped back to issue ids via the page's fingerprints.
   * Both scans are bounded by the window (not by table size), and the two id
   * lookups are bounded by the page (<=30 insights).
   */
  private async recentOccurrences(
    workspaceId: number,
    insights: Array<{
      sourceIncidentId: number | null;
      sourceIssueId: number | null;
    }>,
  ): Promise<
    Map<string, { count: number; users: number; windowMins: number }>
  > {
    const out = new Map<
      string,
      { count: number; users: number; windowMins: number }
    >();
    const incidentIds = [
      ...new Set(
        insights
          .map((i) => i.sourceIncidentId)
          .filter((v): v is number => v != null),
      ),
    ];
    const issueIds = [
      ...new Set(
        insights
          .map((i) => i.sourceIssueId)
          .filter((v): v is number => v != null),
      ),
    ];
    if (incidentIds.length === 0 && issueIds.length === 0) return out;
    const since = new Date(Date.now() - RECENT_WINDOW_MINS * 60_000);

    const [incidents, issues] = await Promise.all([
      incidentIds.length > 0
        ? this.db.incident.findMany({
            where: { workspaceId, id: { in: incidentIds } },
            select: { id: true, signalType: true, screen: true, element: true },
          })
        : Promise.resolve([]),
      issueIds.length > 0
        ? this.db.issue.findMany({
            where: { workspaceId, id: { in: issueIds } },
            select: { id: true, fingerprint: true },
          })
        : Promise.resolve([]),
    ]);

    if (incidents.length > 0) {
      // `weight` is the per-row occurrence count (see Signal.weight).
      const rows = await this.db.$queryRaw<
        Array<{
          type: string;
          screen: string;
          element: string;
          occ: number;
          users: number;
        }>
      >`
        SELECT sig.type,
               COALESCE(sig.screen, '') AS screen,
               COALESCE(sig.element, '') AS element,
               COALESCE(SUM(sig.weight), 0)::int AS occ,
               COUNT(DISTINCT s."endUserId")::int AS users
        FROM "Signal" sig
        JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."workspaceId" = ${workspaceId}
          AND sig."occurredAt" >= ${since}
        GROUP BY 1, 2, 3`;
      const byKey = new Map(
        rows.map((r) => [`${r.type}|${r.screen}|${r.element}`, r]),
      );
      for (const inc of incidents) {
        const r = byKey.get(`${inc.signalType}|${inc.screen}|${inc.element}`);
        if (r && r.occ > 0) {
          out.set(`${inc.id}:`, {
            count: r.occ,
            users: r.users,
            windowMins: RECENT_WINDOW_MINS,
          });
        }
      }
    }

    if (issues.length > 0) {
      // `count` holds repeats of a fingerprint within one session.
      const rows = await this.db.$queryRaw<
        Array<{ fingerprint: string; occ: number; users: number }>
      >`
        SELECT o.fingerprint,
               COALESCE(SUM(o."count"), 0)::int AS occ,
               COUNT(DISTINCT o."endUserId")::int AS users
        FROM "IssueOccurrence" o
        WHERE o."workspaceId" = ${workspaceId}
          AND o."occurredAt" >= ${since}
        GROUP BY 1`;
      const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
      for (const is of issues) {
        const r = byFp.get(is.fingerprint);
        if (r && r.occ > 0) {
          out.set(`:${is.id}`, {
            count: r.occ,
            users: r.users,
            windowMins: RECENT_WINDOW_MINS,
          });
        }
      }
    }
    return out;
  }

  /** All-time recorded-session total, read from the real-time WorkspaceStats
   *  counter — the SAME number the sidebar `counts.recordings` and the Recordings
   *  header unfiltered total read, so the three surfaces agree. One PK lookup on
   *  the hot path; reconcile() only on a missing/stale (>5min) cached row. Public
   *  so the controller can overlay a FRESH total onto the (cadence-stale) overview
   *  snapshot it serves on the fast path. */
  async sessionsTotalOf(workspaceId: number): Promise<number> {
    const cached = await this.stats.read(workspaceId);
    if (cached) return cached.sessionsTotal;
    const fresh = await this.stats.reconcile(workspaceId);
    return fresh.sessionsTotal;
  }

  async overview(
    workspaceId: number,
    range = "7d",
    fromTs?: number,
    toTs?: number,
  ) {
    // This endpoint feeds ONLY the v2 Overview: the health Pulse, Storyline of
    // the day, the ranked Problems/Opportunities incident lanes, and the Health
    // zone (top failed journeys + worst sessions). Nothing else is computed or
    // returned — legacy KPI / recent-sessions / online / checklist payloads were
    // removed because the Overview no longer renders them.
    const days =
      fromTs && toTs
        ? Math.max(1, Math.round((toTs - fromTs) / 86_400_000))
        : ({
            today: 1,
            "24h": 1,
            "7d": 7,
            "14d": 14,
            "30d": 30,
            "90d": 90,
            "365d": 365,
          }[range] ?? 7);
    const [
      incidents,
      pulse,
      storyline,
      topFailedJourneys,
      topSuccessfulJourneys,
      worstSessions,
      sessionsTotal,
    ] = await Promise.all([
      this.incidentLanes(workspaceId),
      this.signalDaily.pulse(workspaceId, days),
      this.storylineOfDay(workspaceId),
      this.topFailedJourneys(workspaceId),
      this.topSuccessfulJourneys(workspaceId),
      this.worstSessions(
        workspaceId,
        fromTs && toTs ? fromTs : Date.now() - days * 86_400_000,
      ),
      // All-time session total — matches the Recordings header + sidebar (real-
      // time counter), NOT the windowed `pulse.sessions`, so the "total sessions"
      // figure is consistent across the app.
      this.sessionsTotalOf(workspaceId),
    ]);
    return {
      range,
      pulse,
      storyline,
      incidents,
      topFailedJourneys,
      topSuccessfulJourneys,
      worstSessions,
      sessionsTotal,
    };
  }

  /**
   * Level-1 business-health metrics for the Overview's metric strip — DAU/WAU/
   * MAU, active users, sessions, avg session duration, conversion rate,
   * returning-user rate, and crashes. Each carries a value, the prior-period
   * value, a delta %, and (where meaningful) a daily sparkline series.
   *
   * Two sources, each authoritative for its metrics: user-centric numbers
   * (DAU/WAU/MAU, duration, returning) come from ClickHouse `replay.sessions`
   * in one grouped scan; sessions/crashes/conversion come from the existing
   * `WorkspaceSignalDaily` rollup (one indexed range read on
   * (workspaceId, day)). No per-row loops — both scale.
   */
  async metrics(
    workspaceId: number,
    range = "7d",
    fromTs?: number,
    toTs?: number,
  ) {
    const dayMs = 86_400_000;
    const nowMs = Date.now();
    const useCustom = !!(fromTs && toTs && toTs > fromTs);
    const untilMs = useCustom ? toTs! : nowMs;
    const days = useCustom
      ? Math.max(1, Math.round((toTs! - fromTs!) / dayMs))
      : ({
          today: 1,
          "24h": 1,
          "7d": 7,
          "14d": 14,
          "30d": 30,
          "90d": 90,
          "365d": 365,
        }[range] ?? 7);
    const sinceMs = useCustom ? fromTs! : untilMs - days * dayMs;
    const prevStart = sinceMs - (untilMs - sinceMs);

    // user-centric metrics (ClickHouse) + daily rollups (Postgres) in parallel.
    const [um, rows, mobRows] = await Promise.all([
      overviewUserMetrics({ workspaceId, sinceMs, untilMs, nowMs }),
      this.db.workspaceSignalDaily.findMany({
        where: { workspaceId, day: { gte: new Date(prevStart) } },
        orderBy: { day: "asc" },
        select: {
          day: true,
          sessions: true,
          crashes: true,
          convSuccess: true,
          // Secondary stability signals for the density-strip chart.
          frustrated: true,
          slowApi: true,
          backendFail: true,
        },
      }),
      // Mobile ANR rollup — same keyset shape (workspaceId, day >= prevStart),
      // rides @@index([workspaceId, day desc]); one bounded per-day scan, never a
      // session scan. Only the ANR-rate metric reads it (mobile-only workspaces).
      this.db.workspaceMobilePerfDaily.findMany({
        where: { workspaceId, day: { gte: new Date(prevStart) } },
        orderBy: { day: "asc" },
        select: { day: true, mobileSessions: true, anrSessions: true },
      }),
    ]);

    // Split the daily rollup into the current vs preceding window + sparklines.
    const cur = rows.filter(
      (r) => r.day.getTime() >= sinceMs && r.day.getTime() < untilMs,
    );
    const prev = rows.filter(
      (r) => r.day.getTime() >= prevStart && r.day.getTime() < sinceMs,
    );
    const sum = (rs: typeof rows, k: "sessions" | "crashes" | "convSuccess") =>
      rs.reduce((a, r) => a + r[k], 0);
    const sessCur = sum(cur, "sessions");
    const sessPrev = sum(prev, "sessions");
    const convCur = sum(cur, "convSuccess");
    const convPrev = sum(prev, "convSuccess");

    // Mobile ANR rate = anrSessions / mobileSessions, current vs preceding
    // window, with a per-day spark. Surfaced ONLY when the current window has
    // mobile sessions — a web-only workspace shows no ANR tile rather than 0%.
    const mobCurRows = mobRows.filter(
      (r) => r.day.getTime() >= sinceMs && r.day.getTime() < untilMs,
    );
    const mobPrevRows = mobRows.filter(
      (r) => r.day.getTime() >= prevStart && r.day.getTime() < sinceMs,
    );
    const mobSum = (rs: typeof mobRows, k: "mobileSessions" | "anrSessions") =>
      rs.reduce((a, r) => a + r[k], 0);
    const anrRateOf = (rs: typeof mobRows) => {
      const m = mobSum(rs, "mobileSessions");
      return m > 0
        ? Math.round((mobSum(rs, "anrSessions") / m) * 1000) / 10
        : 0;
    };
    const mobCurTotal = mobSum(mobCurRows, "mobileSessions");
    const anrRateCur = anrRateOf(mobCurRows);
    const anrRatePrev = anrRateOf(mobPrevRows);
    const anrSpark = mobCurRows.map((r) =>
      r.mobileSessions > 0
        ? Math.round((r.anrSessions / r.mobileSessions) * 1000) / 10
        : 0,
    );
    const rate = (c: number, s: number) =>
      s > 0 ? Math.round((c / s) * 1000) / 10 : 0;

    const deltaPct = (v: number, p: number) =>
      p > 0 ? Math.round(((v - p) / p) * 100) : v > 0 ? 100 : 0;
    const m = (
      key: string,
      label: string,
      value: number,
      prevValue: number,
      opts: {
        format?: "int" | "duration" | "pct";
        goodDir?: "up" | "down";
        spark?: number[];
      } = {},
    ) => ({
      key,
      label,
      value,
      prev: prevValue,
      deltaPct: deltaPct(value, prevValue),
      format: opts.format ?? "int",
      goodDir: opts.goodDir ?? "up",
      spark: opts.spark ?? [],
    });

    // Day-aligned daily series for the trends chart — merge CH (active users,
    // sessions) with the PG rollup (conversion %, crashes) keyed by day.
    const byDay = new Map<
      number,
      {
        day: number;
        activeUsers: number;
        sessions: number;
        conversionRate: number;
        crashes: number;
        // Secondary stability signals, for the Stability density-strip chart.
        frustrated: number;
        slowApi: number;
        backendFail: number;
      }
    >();
    for (const s of um.spark) {
      byDay.set(s.day, {
        day: s.day,
        activeUsers: s.activeUsers,
        sessions: s.sessions,
        conversionRate: 0,
        crashes: 0,
        frustrated: 0,
        slowApi: 0,
        backendFail: 0,
      });
    }
    for (const r of cur) {
      const d = r.day.getTime();
      const e = byDay.get(d) ?? {
        day: d,
        activeUsers: 0,
        sessions: r.sessions,
        conversionRate: 0,
        crashes: 0,
        frustrated: 0,
        slowApi: 0,
        backendFail: 0,
      };
      e.conversionRate = rate(r.convSuccess, r.sessions);
      e.crashes = r.crashes;
      e.frustrated = r.frustrated;
      e.slowApi = r.slowApi;
      e.backendFail = r.backendFail;
      if (!e.sessions) e.sessions = r.sessions;
      byDay.set(d, e);
    }
    const series = [...byDay.values()].sort((a, b) => a.day - b.day);

    return {
      range,
      series,
      metrics: [
        m("dau", "DAU", um.dau[0], um.dau[1], {
          spark: um.spark.map((s) => s.activeUsers),
        }),
        m("wau", "WAU", um.wau[0], um.wau[1], { spark: um.wauSpark }),
        m("mau", "MAU", um.mau[0], um.mau[1], { spark: um.mauSpark }),
        m("activeUsers", "Active users", um.activeUsers[0], um.activeUsers[1], {
          spark: um.spark.map((s) => s.activeUsers),
        }),
        m("sessions", "Sessions", sessCur, sessPrev, {
          spark: cur.map((r) => r.sessions),
        }),
        m(
          "avgDuration",
          "Avg. session",
          um.avgDurationMs[0],
          um.avgDurationMs[1],
          { format: "duration", spark: um.spark.map((s) => s.avgDurationMs) },
        ),
        m(
          "conversionRate",
          "Conversion",
          rate(convCur, sessCur),
          rate(convPrev, sessPrev),
          {
            format: "pct",
            spark: cur.map((r) => rate(r.convSuccess, r.sessions)),
          },
        ),
        m("retention", "Returning", um.returningPct[0], um.returningPct[1], {
          format: "pct",
        }),
        // New vs returning USER COUNTS (distinct people) for the engagement
        // tiles — new = first seen inside the window, returning = first seen
        // before it. Both fall out of the same single grouped CH scan above.
        m("newUsers", "New users", um.newUsers[0], um.newUsers[1], {
          spark: um.spark.map((s) => s.newUsers),
        }),
        m(
          "returningUsers",
          "Returning users",
          um.returningUsers[0],
          um.returningUsers[1],
          { spark: um.spark.map((s) => s.returningUsers) },
        ),
        m("crashes", "Crashes", sum(cur, "crashes"), sum(prev, "crashes"), {
          goodDir: "down",
          spark: cur.map((r) => r.crashes),
        }),
        // ANR rate — mobile only. Present iff the window has mobile sessions, so
        // the frontend surfaces the tile exactly when it's meaningful.
        ...(mobCurTotal > 0
          ? [
              m("anrRate", "ANR rate", anrRateCur, anrRatePrev, {
                format: "pct" as const,
                goodDir: "down" as const,
                spark: anrSpark,
              }),
            ]
          : []),
      ],
    };
  }

  /* ------------------------------------------------------------------------
     Activity chart — REAL per-dimension/per-bucket series. Maps the frontend
     query vocabulary onto the ClickHouse `activityDimSeries` scan, then
     gap-fills to a dense bucket axis so the stacked chart lines up. The whole
     Filter (breakdown / granularity / compare / segment / rule-filters) is now
     backed by real data — the client-side synthesis is gone.
     ---------------------------------------------------------------------- */
  private static readonly ACT_METRIC_MAP: Record<string, ActivityDimMetric> = {
    activeUsers: "activeUsers",
    dau: "activeUsers",
    wau: "activeUsers",
    mau: "activeUsers",
    users: "activeUsers",
    sessions: "sessions",
    newUsers: "newUsers",
    newu: "newUsers",
    new: "newUsers",
    returningUsers: "returningUsers",
    returning: "returningUsers",
    ret: "returningUsers",
    avgDuration: "avgDuration",
    duration: "avgDuration",
  };
  // Frontend dimension key → the canonical key activityDimSeries whitelists.
  private static readonly ACT_DIM_MAP: Record<string, string> = {
    platform: "platform",
    browser: "browser",
    os: "os",
    osVersion: "osVersion",
    country: "country",
    device: "device",
    deviceModel: "deviceModel",
    release: "release",
    version: "release",
    plan: "plan",
    page: "page",
    screen: "page",
  };
  // Only fixed-width buckets (no calendar months) so the CH `intDiv` bucket and
  // the JS axis align exactly with zero timezone math.
  private static readonly ACT_GRAN_MS: Record<string, number> = {
    "5m": 300_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    // Fixed 30-day bucket (NOT a calendar month) so the CH `intDiv` bucket still
    // aligns with the JS axis with zero timezone math — same rule as the others.
    // Drives the MAU cadence: activeUsers counted unique per 30-day bucket.
    month: 30 * 86_400_000,
  };

  async activitySeries(
    workspaceId: number,
    opts: {
      metric?: string;
      dimension?: string;
      range: string;
      fromTs?: number;
      toTs?: number;
      gran?: string;
      segment?: string;
      compare?: boolean;
      topN?: number;
      rules?: string[];
    },
  ) {
    const dayMs = 86_400_000;
    const nowMs = Date.now();
    const useCustom = !!(opts.fromTs && opts.toTs && opts.toTs > opts.fromTs);
    const untilMs = useCustom ? opts.toTs! : nowMs;
    const days = useCustom
      ? Math.max(1, Math.round((opts.toTs! - opts.fromTs!) / dayMs))
      : ({
          today: 1,
          "1h": 1,
          "24h": 1,
          "7d": 7,
          "14d": 14,
          "30d": 30,
          "90d": 90,
          "365d": 365,
        }[opts.range] ?? 30);
    // Sub-day ranges keep their real width (1h / 24h) rather than snapping to a
    // whole day, so a "last hour" 5-minute view spans exactly an hour.
    const spanMs =
      opts.range === "1h"
        ? 3_600_000
        : opts.range === "24h" || opts.range === "today"
          ? dayMs
          : days * dayMs;
    const sinceMs = useCustom ? opts.fromTs! : untilMs - spanMs;
    const prevStart = sinceMs - (untilMs - sinceMs);

    const bucketMs = DashboardService.ACT_GRAN_MS[opts.gran ?? "day"] ?? dayMs;
    // MAU cadence → real CALENDAR months (activityDimSeries' toStartOfMonth path),
    // not a fixed 30-day bucket anchored to the epoch. Epoch-aligned 30-day
    // buckets make the newest bar span only [last-boundary, now) — a partial
    // window plotted as a full "monthly" point, which reads as a phantom cliff
    // and can dip below the DAU shown on the same page. Calendar months make the
    // trailing bucket the current month-to-date (an expected, understood partial).
    const monthly = (opts.gran ?? "day") === "month";
    const metric =
      DashboardService.ACT_METRIC_MAP[opts.metric ?? "activeUsers"] ??
      "activeUsers";
    const dimension =
      opts.dimension && opts.dimension !== "none"
        ? (DashboardService.ACT_DIM_MAP[opts.dimension] ?? null)
        : null;
    const rules = (opts.rules ?? [])
      .map((r) => {
        const i = r.indexOf(":");
        if (i < 0) return null;
        const dim = DashboardService.ACT_DIM_MAP[r.slice(0, i)] ?? null;
        const value = r.slice(i + 1);
        return dim && value ? { dim, value } : null;
      })
      .filter((r): r is { dim: string; value: string } => r !== null);
    const segment =
      opts.segment && opts.segment !== "all" ? opts.segment : null;
    const topN = opts.topN ?? 6;

    /* Read-through cache. This endpoint is an uncached ClickHouse FINAL scan on
       every cold dashboard load AND every filter change, so repeat views of the
       same chart (and every concurrent viewer of it) each paid a full scan.
       Precompute is not an option here: the reachable query space is ~3,444
       rule-free combinations per workspace and genuinely unbounded once
       `rule=dim:value` filters stack, so this is keyed-TTL or nothing.

       The key is built from the NORMALIZED values above, never the raw query
       string — that is both correctness (aliases like dau/wau/users all resolve
       to activeUsers and legitimately share one answer) and cardinality control
       (keying raw would mint several keys for one payload).

       EVERY parameter that changes the result is in the key. The dangerous ones
       are the two the frontend does not always send: `compare` adds a whole
       extra series block that becomes the overlay AND deltaPct, so serving a
       compare=1 request from a compare=0 entry would silently render "0% vs
       previous period"; and `topN` decides the band set and therefore what folds
       into "Other". Rules are ANDed, so they are sorted before hashing — the two
       orderings of the same filter pair are one query and must be one key.

       The WINDOW is keyed by its REQUEST form, not the resolved timestamps: a
       relative range resolves to now-Nd..now, so keying the resolved ms would
       embed Date.now() and guarantee a 0% hit rate. Custom windows carry their
       explicit bounds, which are already stable. Within the short TTL the only
       drift this admits is the trailing partial bucket. */
    const cacheKey = [
      // v2: `totalByBand` changed meaning — it is now the true per-band unique
      // over the window instead of a sum of the per-bucket uniques. Same shape,
      // different numbers, so entries written by v1 must not be served.
      "dash:activity:v2",
      workspaceId,
      metric,
      dimension ?? "none",
      useCustom ? `c:${opts.fromTs}:${opts.toTs}` : `r:${opts.range}`,
      bucketMs,
      segment ?? "all",
      opts.compare ? "cmp1" : "cmp0",
      topN,
      rules.length
        ? rules
            .map((r) => `${r.dim}=${r.value}`)
            .sort()
            .join(",")
        : "-",
    ].join(":");
    try {
      const hit = await this.redis.get(cacheKey);
      if (hit) {
        return JSON.parse(hit) as {
          metric: string;
          dimension: string;
          bands: string[];
          buckets: number[];
          series: { label: string; values: number[] }[];
          totalByBand: { label: string; value: number }[];
          windowTotal: number;
          compareWindowTotal?: number;
          compare?: {
            buckets: number[];
            series: { label: string; values: number[] }[];
          };
        };
      }
    } catch {
      /* cache is an optimisation — fall through to the live compute */
    }

    const cur = await activityDimSeries({
      workspaceId,
      sinceMs,
      untilMs,
      bucketMs,
      monthly,
      dimension,
      metric,
      topN,
      segment,
      rules,
    });
    const buckets = this.bucketAxis(sinceMs, untilMs, bucketMs, monthly);
    const series = this.densifyBands(cur, buckets);

    let compare:
      | { buckets: number[]; series: { label: string; values: number[] }[] }
      | undefined;
    // Prior window's union, for the "vs previous period" delta. Same reasoning
    // as windowTotal: a delta computed from summed columns compares two wrong
    // numbers, and the error does not cancel because the two windows have
    // different return-visit patterns.
    let prevGrandTotal: number | undefined;
    if (opts.compare) {
      // Same-length window immediately before, bound to the current window's
      // bands so the overlay lines up band-for-band.
      const prev = await activityDimSeries({
        workspaceId,
        sinceMs: prevStart,
        untilMs: sinceMs,
        bucketMs,
        monthly,
        dimension,
        metric,
        topN,
        segment,
        rules,
        bands: cur.bands,
      });
      const prevBuckets = this.bucketAxis(prevStart, sinceMs, bucketMs, monthly);
      compare = {
        buckets: prevBuckets,
        series: this.densifyBands(prev, prevBuckets),
      };
      prevGrandTotal = prev.grandTotal;
    }

    // Straight from the query's window-wide GROUPING SET — NOT a sum of the
    // per-bucket values. Summing was only ever right for `sessions`; for
    // activeUsers/newUsers/returningUsers it counted each person once per bucket
    // they showed up in, so the chart footer claimed ~2.4× (and on a busier
    // workspace ~4.3×) more people than exist, while /metrics printed the true
    // unique count a few pixels away on the same page.
    const totalOf = new Map(cur.totals.map((t) => [t.band, t.value]));
    const totalByBand = cur.bands.map((label) => ({
      label,
      value: totalOf.get(label) ?? 0,
    }));

    const payload = {
      metric,
      dimension: dimension ?? "none",
      bands: cur.bands,
      buckets,
      series,
      totalByBand,
      // The headline figure under the chart. Separate from totalByBand because
      // it is NOT their sum: the bands overlap (one person on two browsers is
      // one user), so only a query-side union is right. The frontend used to
      // add up the plotted columns, which compounded both errors at once.
      windowTotal: cur.grandTotal,
      compareWindowTotal: prevGrandTotal,
      compare,
    };
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(payload),
        "EX",
        DashboardService.ACTIVITY_CACHE_TTL_SEC,
      );
    } catch {
      /* serving the fresh payload matters more than caching it */
    }
    return payload;
  }

  /** Dense, ascending bucket-floor axis for [sinceMs, untilMs) at bucketMs. The
   *  CH bucket is `intDiv(datetime, bucketMs) * bucketMs`, so flooring `sinceMs`
   *  the same way makes the two align with no timezone math. Capped so a
   *  mispaired range+granularity can't materialise an unbounded array. */
  private bucketAxis(
    sinceMs: number,
    untilMs: number,
    bucketMs: number,
    // MAU cadence: step by CALENDAR month (UTC), matching the CH `toStartOfMonth`
    // bucket so the axis floors line up with the aggregated rows (bucketMs is
    // ignored in this mode). Fixed-width flooring would drift off the month grid.
    monthly = false,
  ): number[] {
    const out: number[] = [];
    if (monthly) {
      const d = new Date(sinceMs);
      let y = d.getUTCFullYear();
      let m = d.getUTCMonth();
      for (let i = 0; i < 2000; i++) {
        const b = Date.UTC(y, m, 1);
        if (b >= untilMs) break;
        out.push(b);
        if (++m > 11) {
          m = 0;
          y++;
        }
      }
      return out;
    }
    const start = Math.floor(sinceMs / bucketMs) * bucketMs;
    for (let b = start; b < untilMs && out.length < 2000; b += bucketMs) {
      out.push(b);
    }
    return out;
  }

  /** Pivot the (bucket, band, value) rows into one dense, bucket-aligned array
   *  per band (missing bucket → 0), in the result's band order. */
  private densifyBands(
    res: {
      bands: string[];
      rows: { bucket: number; band: string; value: number }[];
    },
    buckets: number[],
  ): { label: string; values: number[] }[] {
    const at = new Map<string, number>();
    for (const r of res.rows) at.set(`${r.band}\x1f${r.bucket}`, r.value);
    return res.bands.map((label) => ({
      label,
      values: buckets.map((b) => at.get(`${label}\x1f${b}`) ?? 0),
    }));
  }

  private async incidentLanes(workspaceId: number) {
    const select = {
      id: true,
      title: true,
      signalType: true,
      polarity: true,
      screen: true,
      element: true,
      rank: true,
      sessionCount: true,
      userCount: true,
      deltaPctX100: true,
      impactCents: true,
      firstSeenAt: true,
      lastSeenAt: true,
    } as const;
    const [problems, opportunities] = await Promise.all([
      this.db.incident.findMany({
        where: { workspaceId, status: "OPEN", polarity: "NEGATIVE" },
        orderBy: { rank: "desc" },
        take: 6,
        select,
      }),
      this.db.incident.findMany({
        where: { workspaceId, status: "OPEN", polarity: "POSITIVE" },
        orderBy: { rank: "desc" },
        take: 6,
        select,
      }),
    ]);
    const ids = [...problems, ...opportunities].map((i) => i.id);

    // Per-incident signal-type breakdown (the card's signal chips) — ONE
    // grouped read over the lane incidents, not per-incident.
    const breakdownByIncident = new Map<
      number,
      { type: string; count: number }[]
    >();
    if (ids.length > 0) {
      const rows = await this.db.signal.groupBy({
        by: ["incidentId", "type"],
        where: { incidentId: { in: ids } },
        _count: { _all: true },
      });
      for (const r of rows) {
        if (r.incidentId == null) continue;
        const arr = breakdownByIncident.get(r.incidentId) ?? [];
        arr.push({ type: r.type, count: r._count._all });
        breakdownByIncident.set(r.incidentId, arr);
      }
    }

    // Worst-affected sessions per incident (top 3 by score) — ONE window-function
    // query across all lane incidents, not a per-incident loop.
    const sessByIncident = new Map<number, unknown[]>();
    if (ids.length > 0) {
      const rows = await this.db.$queryRaw<
        Array<{
          incidentId: number;
          publicId: string;
          sessionScore: number;
          platform: string | null;
          name: string | null;
          email: string | null;
        }>
      >`
        SELECT t."incidentId", t."publicId", t."sessionScore", t.platform, t.name, t.email
        FROM (
          SELECT sig."incidentId", s."publicId", s."sessionScore", s.platform,
                 eu.name, eu.email,
                 row_number() OVER (PARTITION BY sig."incidentId" ORDER BY s."sessionScore" ASC) AS rn
          FROM "Signal" sig
          JOIN "Session" s ON s.id = sig."sessionId"
          LEFT JOIN "EndUser" eu ON eu.id = s."endUserId"
          WHERE sig."incidentId" IN (${Prisma.join(ids)})
        ) t
        WHERE t.rn <= 3`;
      for (const r of rows) {
        const arr = sessByIncident.get(r.incidentId) ?? [];
        arr.push({
          publicId: r.publicId,
          score: r.sessionScore,
          platform: r.platform,
          userName: r.name,
          userEmail: r.email,
        });
        sessByIncident.set(r.incidentId, arr);
      }
    }

    // Dominant platform + release per incident (the "Android · since 1.4.2"
    // attribution) — one window query, top-1 of each per incident.
    const attrByIncident = new Map<
      number,
      { platform: string | null; release: string | null }
    >();
    if (ids.length > 0) {
      const rows = await this.db.$queryRaw<
        Array<{ incidentId: number; kind: string; val: string }>
      >`
        SELECT t."incidentId", t.kind, t.val FROM (
          SELECT sig."incidentId", 'platform' AS kind, s.platform AS val,
                 row_number() OVER (PARTITION BY sig."incidentId" ORDER BY count(*) DESC) AS rn
          FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
          WHERE sig."incidentId" IN (${Prisma.join(ids)}) AND COALESCE(s.platform, '') <> ''
          GROUP BY sig."incidentId", s.platform
          UNION ALL
          SELECT sig."incidentId", 'release' AS kind,
                 COALESCE(NULLIF(s."appVersion", ''), NULLIF(s."revId", ''), NULLIF(s."appBuild", '')) AS val,
                 row_number() OVER (PARTITION BY sig."incidentId" ORDER BY count(*) DESC) AS rn
          FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
          WHERE sig."incidentId" IN (${Prisma.join(ids)})
            AND COALESCE(NULLIF(s."appVersion", ''), NULLIF(s."revId", ''), NULLIF(s."appBuild", '')) IS NOT NULL
          GROUP BY sig."incidentId", COALESCE(NULLIF(s."appVersion", ''), NULLIF(s."revId", ''), NULLIF(s."appBuild", ''))
        ) t
        WHERE t.rn = 1`;
      for (const r of rows) {
        const cur = attrByIncident.get(r.incidentId) ?? {
          platform: null,
          release: null,
        };
        if (r.kind === "platform") cur.platform = r.val;
        else cur.release = r.val;
        attrByIncident.set(r.incidentId, cur);
      }
    }

    // Crash incidents → their crashlytics Issue (the "Open crash" target).
    // For each crash_detected incident, the dominant CRASH Issue among its
    // member sessions. One windowed query + one Issue resolve — never per
    // incident. Non-crash incidents get no link (they use Investigate instead).
    const crashIds = [...problems, ...opportunities]
      .filter((i) => i.signalType === "crash_detected")
      .map((i) => i.id);
    const issueByIncident = new Map<
      number,
      {
        id: number;
        fingerprint: string;
        title: string;
        occurrences: number;
        users: number;
        sessions: number;
        recording: string | null;
      }
    >();
    if (crashIds.length > 0) {
      const fpRows = await this.db.$queryRaw<
        Array<{ incidentId: number; fingerprint: string }>
      >`
        SELECT t."incidentId", t.fingerprint FROM (
          SELECT sig."incidentId", io.fingerprint,
                 row_number() OVER (
                   PARTITION BY sig."incidentId"
                   ORDER BY count(DISTINCT io."sessionId") DESC
                 ) AS rn
          FROM "Signal" sig
          JOIN "IssueOccurrence" io ON io."sessionId" = sig."sessionId"
          WHERE sig."incidentId" IN (${Prisma.join(crashIds)})
            AND io."isCrash" = true
          GROUP BY sig."incidentId", io.fingerprint
        ) t WHERE t.rn = 1`;
      const fps = [...new Set(fpRows.map((r) => r.fingerprint))];
      if (fps.length > 0) {
        const issues = await this.db.issue.findMany({
          where: { workspaceId, fingerprint: { in: fps } },
          select: {
            id: true,
            fingerprint: true,
            title: true,
            occurrenceCount: true,
            userCount: true,
            sessionCount: true,
            lastPublicId: true,
          },
        });
        const byFp = new Map(issues.map((is) => [is.fingerprint, is]));
        for (const r of fpRows) {
          const is = byFp.get(r.fingerprint);
          if (is) {
            issueByIncident.set(r.incidentId, {
              id: is.id,
              fingerprint: is.fingerprint,
              title: is.title,
              occurrences: is.occurrenceCount,
              users: is.userCount,
              sessions: is.sessionCount,
              recording: is.lastPublicId,
            });
          }
        }
      }
    }

    const severityOf = (i: (typeof problems)[number]) =>
      i.polarity === "POSITIVE"
        ? "opportunity"
        : ["crash_detected", "backend_failure", "conversion_failure"].includes(
              i.signalType,
            ) || i.deltaPctX100 >= 3000
          ? "critical"
          : "high";

    const shape = (i: (typeof problems)[number]) => ({
      id: i.id,
      title: i.title,
      signalType: i.signalType,
      polarity: i.polarity,
      severity: severityOf(i),
      screen: i.screen || null,
      rank: i.rank,
      sessionCount: i.sessionCount,
      userCount: i.userCount,
      deltaPctX100: i.deltaPctX100,
      impactCents: i.impactCents,
      firstSeenAt: i.firstSeenAt.toISOString(),
      lastSeenAt: i.lastSeenAt.toISOString(),
      element: i.element || null,
      // "Android · since 1.4.2" attribution — the dominant platform + release
      // among the incident's affected sessions.
      platform: attrByIncident.get(i.id)?.platform ?? null,
      release: attrByIncident.get(i.id)?.release ?? null,
      // Template-first root-cause + recommended action — always present (no
      // LLM), so every card is actionable; the on-demand "Investigate" still
      // fetches a richer LLM hypothesis.
      likelyCause: DashboardService.likelyCause(
        i.signalType,
        i.element,
        i.screen,
      ),
      recommendedAction:
        INCIDENT_ACTION[i.signalType] ??
        "Open the affected sessions and investigate.",
      // Deterministic, tailored action affordances the dashboard renders as
      // buttons (Open crash / Create funnel / View sessions / …). No LLM — the
      // user drives each one; "Create funnel" only appears where it makes sense.
      suggestedActions: suggestedActionsForSignal(i.signalType),
      // For a crash incident, the crashlytics Issue behind it (drives "Open
      // crash" → the grouped recordings). Null for non-crash incidents.
      linkedIssue: issueByIncident.get(i.id) ?? null,
      // Signal chips: the real type breakdown, falling back to the dominant type.
      signals: breakdownByIncident.get(i.id) ?? [
        { type: i.signalType, count: i.sessionCount },
      ],
      topSessions: sessByIncident.get(i.id) ?? [],
    });
    return {
      problems: problems.map(shape),
      opportunities: opportunities.map(shape),
    };
  }

  /**
   * "Storyline of the day" — the single highest-rank OPEN incident plus its
   * template facts (and any LLM cause, Slice 7). Incidents-per-workspace is a
   * small bounded set, so the top-1-by-rank read is cheap; factsText rides the
   * incident→storyline relation in the same query. Null when there are no open
   * incidents (or the clusterer hasn't run yet).
   */
  private async storylineOfDay(workspaceId: number) {
    const top = await this.db.incident.findFirst({
      where: { workspaceId, status: "OPEN" },
      orderBy: { rank: "desc" },
      select: {
        id: true,
        title: true,
        signalType: true,
        polarity: true,
        screen: true,
        sessionCount: true,
        userCount: true,
        deltaPctX100: true,
        storyline: { select: { factsText: true, causeText: true } },
      },
    });
    if (!top) {
      return null;
    }
    return {
      incidentId: top.id,
      title: top.title,
      signalType: top.signalType,
      polarity: top.polarity,
      screen: top.screen || null,
      sessionCount: top.sessionCount,
      userCount: top.userCount,
      deltaPctX100: top.deltaPctX100,
      // Deterministic facts (always present once the clusterer has run) +
      // optional LLM "likely cause" (null until Slice 7).
      factsText: top.storyline?.factsText ?? null,
      causeText: top.storyline?.causeText ?? null,
    };
  }

  /**
   * "Top failed journeys" health widget — the worst-failing recent journey
   * clusters, deduped by path (keep the worst day per path). Reads a bounded
   * recent slice of the small JourneyCluster table, then takes the top 5.
   */
  private async topFailedJourneys(workspaceId: number) {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const rows = await this.db.journeyCluster.findMany({
      where: { workspaceId, day: { gte: weekAgo }, failRate: { gt: 0 } },
      orderBy: [{ failRate: "desc" }, { sessionCount: "desc" }],
      take: 20,
      select: {
        pathKey: true,
        label: true,
        sessionCount: true,
        failCount: true,
        failRate: true,
        exampleSessionId: true,
      },
    });
    const seen = new Set<string>();
    const out: Array<{
      label: string;
      sessionCount: number;
      failCount: number;
      failRate: number;
      exampleSessionId: number | null;
    }> = [];
    for (const r of rows) {
      if (seen.has(r.pathKey)) continue;
      seen.add(r.pathKey);
      out.push({
        label: r.label,
        sessionCount: r.sessionCount,
        failCount: r.failCount,
        failRate: r.failRate,
        exampleSessionId: r.exampleSessionId,
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  /**
   * "Top successful journeys" — the highest-converting recent journey clusters,
   * deduped by path. Same bounded read as the failed-journeys widget, ordered
   * by successRate. Answers "how are users actually succeeding?".
   */
  private async topSuccessfulJourneys(workspaceId: number) {
    const weekAgo = new Date();
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    const rows = await this.db.journeyCluster.findMany({
      where: { workspaceId, day: { gte: weekAgo }, successRate: { gt: 0 } },
      orderBy: [{ successRate: "desc" }, { sessionCount: "desc" }],
      take: 20,
      select: {
        pathKey: true,
        label: true,
        sessionCount: true,
        successCount: true,
        successRate: true,
        exampleSuccessSessionId: true,
      },
    });
    const seen = new Set<string>();
    const out: Array<{
      label: string;
      sessionCount: number;
      successCount: number;
      successRate: number;
      exampleSessionId: number | null;
    }> = [];
    for (const r of rows) {
      if (seen.has(r.pathKey)) continue;
      seen.add(r.pathKey);
      out.push({
        label: r.label,
        sessionCount: r.sessionCount,
        successCount: r.successCount,
        successRate: r.successRate,
        exampleSessionId: r.exampleSuccessSessionId,
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  /**
   * "Worst sessions" health widget — lowest-scoring recent sessions. Served by
   * the (workspaceId, sessionScore) index: `WHERE workspaceId ORDER BY
   * sessionScore ASC` with the score/excluded predicates applied during the
   * scan, stopping after one short page.
   */
  private async worstSessions(workspaceId: number, sinceMs: number) {
    // "Worth watching" = the worst-experience sessions IN THE SELECTED WINDOW.
    // ACCESS PATTERN: workspace-scoped, ordered by the persisted sessionScore
    // (served by @@index([workspaceId, sessionScore])), startedAt filters
    // in-scan, capped at 8. Bounded by the workspace, never a table scan.
    // The startedAt bound is the fix for "last 30 days" previously returning the
    // worst sessions of ALL TIME — worstSessions used to ignore the window.
    const rows = await this.db.session.findMany({
      where: {
        workspaceId,
        excludedShort: false,
        sessionScore: { lt: 100 },
        startedAt: { gte: new Date(sinceMs) },
      },
      // Secondary sort so equal scores are deterministic AND recency-biased —
      // a fresh bad session ranks above a stale one at the same score.
      orderBy: [{ sessionScore: "asc" }, { startedAt: "desc" }],
      take: 8,
      select: {
        publicId: true,
        sessionScore: true,
        rageCount: true,
        errorCount: true,
        deadCount: true,
        startUrl: true,
        platform: true,
        // Session-own device + geo, so the row reads "iOS 26 · iPhone 17 · 🇳🇬"
        // exactly like the recordings list — and works for anonymous mobile
        // sessions, which carry no EndUser row.
        browser: true,
        os: true,
        osVersion: true,
        device: true,
        deviceModel: true,
        country: true,
        flag: true,
        endUser: { select: { name: true, initials: true } },
      },
    });
    return rows.map((s) => ({
      publicId: s.publicId,
      sessionScore: s.sessionScore,
      rageCount: s.rageCount,
      errorCount: s.errorCount,
      deadCount: s.deadCount,
      startUrl: s.startUrl,
      platform: s.platform,
      browser: s.browser,
      os: s.os,
      osVersion: s.osVersion,
      device: s.device,
      deviceModel: s.deviceModel,
      country: s.country,
      flag: s.flag,
      userName: s.endUser?.name ?? null,
      userInitials: s.endUser?.initials ?? null,
    }));
  }

  /**
   * Segments — "where sessions come from", as real distributions over the
   * window: platform, browser, country. Replaces the demo fixture the Overview
   * shipped with.
   *
   * ACCESS PATTERN: ONE set-based statement — a single window scan of Session
   * grouped by GROUPING SETS ((platform),(browser),(country)), so all three
   * dimensions come back from one pass (served by
   * @@index([workspaceId, startedAt])). No per-dimension query, no per-row loop,
   * never a whole-table load — it only ever reads the workspace's rows in the
   * selected window. Shaping (share %, top-N + "Other", drop all-Unknown dims)
   * is pure in-memory folding of that one result.
   */
  async segments(
    workspaceId: number,
    range = "7d",
    fromTs?: number,
    toTs?: number,
    // `full` → the breakdown drawer's COMPLETE ranked list (every label, no
    // top-N cap, no "Other" roll-up). Default false keeps the compact band the
    // 30s Overview poll reads. Same single ClickHouse scan either way — only the
    // in-memory shaping differs.
    full = false,
  ) {
    const now = Date.now();
    const days =
      fromTs && toTs
        ? Math.max(1, Math.round((toTs - fromTs) / 86_400_000))
        : ({
            today: 1,
            "24h": 1,
            "7d": 7,
            "14d": 14,
            "30d": 30,
            "90d": 90,
            "365d": 365,
          }[range] ?? 7);
    const from = fromTs && toTs ? fromTs : now - days * 86_400_000;
    const to = fromTs && toTs ? toTs : now;

    /* Dimension aggregation → ClickHouse (replay.sessions), never a parallel
       Postgres GROUP BY. This used to be a `GROUP BY GROUPING SETS` over
       "Session": on a 500k-session workspace at the 30d default it measured
       181-223ms and ~273MB of shared-buffer traffic PER REQUEST (34,112 heap
       blocks — platform/browser/country aren't in the (workspaceId, startedAt)
       index, so every row in the window was a heap fetch), and the Overview
       polls it every 30s per open tab. The page churn on the OLTP primary was
       the real damage. The ClickHouse equivalent is 21-33ms with zero impact on
       the primary and returns byte-identical numbers (verified against the
       Postgres query on the 500k set: same totals, same per-label breakdown). */
    const rows = await sessionSegments({
      workspaceId,
      fromMs: from,
      toMs: to,
    });

    // platform is grouped for EVERY session (NULL → 'Unknown'), so its total is
    // the window's session count.
    const total = rows
      .filter((r) => r.dim === "platform")
      .reduce((a, r) => a + r.sessions, 0);

    return {
      totalSessions: total,
      platform: this.shapeSegmentDim(rows, "platform", total, full),
      browser: this.shapeSegmentDim(rows, "browser", total, full),
      country: this.shapeSegmentDim(rows, "country", total, full),
      // Traffic sources — where the session CAME FROM. Same single scan as the
      // device dims above (sessionSegments folds all seven into one pass); each
      // is share-of-all-sessions, so with no referrer/utm tagging the dimension
      // is empty (shapeSegmentDim drops all-Unknown) and the panel hides it.
      referrer: this.shapeSegmentDim(rows, "referrer", total, full, true),
      source: this.shapeSegmentDim(rows, "source", total, full, true),
      medium: this.shapeSegmentDim(rows, "medium", total, full, true),
      campaign: this.shapeSegmentDim(rows, "campaign", total, full, true),
    };
  }

  /** Fold one dimension's grouped rows into ranked share bands: sort by count,
   *  keep the top 6 and roll the rest into "Other", and drop the whole
   *  dimension when it carries no real signal (every session is Unknown).
   *  `full` (the breakdown drawer) returns EVERY label instead — no top-N cap,
   *  no "Other" — so the drawer shows the complete distribution. */
  private shapeSegmentDim(
    rows: Array<{ dim: string; label: string; sessions: number }>,
    dim: string,
    total: number,
    full = false,
    // Traffic-source dims (referrer/source/medium/campaign): the empty/'Unknown'
    // bucket is "no referrer / not utm-tagged" — noise in a "where did they come
    // from" list, and usually the majority, so it would sit at the top. Drop it
    // and rank only the KNOWN values (their long tail still folds into "Other").
    // Device dims (platform/browser/country) keep 'Unknown' as a real observed
    // value.
    dropUnknown = false,
  ): Array<{ label: string; sessions: number; share: number }> {
    if (total === 0) return [];
    const mine = rows
      .filter((r) => r.dim === dim)
      .sort((a, b) => b.sessions - a.sessions);
    const known = mine.filter((r) => r.label !== "Unknown");
    if (known.length === 0) return []; // e.g. no geo data → hide the Country band
    const base = dropUnknown ? known : mine;
    const share = (n: number) => Math.round((n / total) * 1000) / 10;
    // Drawer: the entire ranked list, one row per label, exact counts.
    if (full) {
      return base.map((r) => ({
        label: r.label,
        sessions: r.sessions,
        share: share(r.sessions),
      }));
    }
    const TOP = 6;
    const head = base.slice(0, TOP);
    const tail = base.slice(TOP);
    const out = head.map((r) => ({
      label: r.label,
      sessions: r.sessions,
      share: share(r.sessions),
    }));
    if (tail.length) {
      const rest = tail.reduce((a, r) => a + r.sessions, 0);
      out.push({ label: "Other", sessions: rest, share: share(rest) });
    }
    return out;
  }

  /**
   * Build the setup checklist with real state — each item flips to `done`
   * as the workspace satisfies it. Fetching is parallelised so the whole
   * overview response doesn't slow down for these checks.
   */
  async liveCount(workspaceId: number) {
    // "People using your app right now" — distinct online end-USERS in the
    // presence window, read from Redis (node-local-state-free, correct across
    // ingest nodes). Was the in-memory socket presence map, which counted
    // sessions and only saw one process's slice. `count` stays the field name
    // so existing callers keep working; it now counts people, not sockets.
    const now = Date.now();
    const count = await this.presence.onlineUserCount(workspaceId, now);
    return { count };
  }

  /** Richer live-presence read for the Overview "online now" tile: distinct
   *  online people AND the number of live sessions (a person may have several).
   *  Backed by the same Redis window as `liveCount`. */
  async onlinePresence(workspaceId: number) {
    const now = Date.now();
    const [onlineUsers, liveSessions] = await Promise.all([
      this.presence.onlineUserCount(workspaceId, now),
      this.presence.liveSessionCount(workspaceId, now),
    ]);
    return { onlineUsers, liveSessions };
  }

  async counts(workspaceId: number) {
    // Try the cached counter row first. The dashboard polls this every
    // 15s; a single PK lookup beats five `.count()` scans by orders of
    // magnitude at scale.
    const cached = await this.stats.read(workspaceId);
    // Live presence + last-seen session are real-time and don't make
    // sense to cache, so they always run regardless of cache state.
    // `live` is now distinct online PEOPLE (Redis presence window), matching
    // the /live endpoint — not the old in-memory socket-session count.
    // `crashlytics` = number of crash/issue GROUPS (not events). Issue rows are
    // aggregates — a handful per workspace, indexed by (workspaceId, …) — so a
    // scoped COUNT is index-cheap and runs alongside the live queries. It powers
    // the same 0-vs-nonzero gate the dashboard uses to skip a page fetch and go
    // straight to the empty-state illustration (no fetch→skeleton→illo flash).
    const [liveNow, lastSession, crashlyticsTotal, alertsTotal] =
      await Promise.all([
        this.presence.onlineUserCount(workspaceId, Date.now()),
        // Most-recent session, for the "last activity" indicator. Ordered by
        // startedAt so it rides the existing @@index([workspaceId, startedAt desc])
        // — one index seek + a single heap row. It used to order by endedAt, which
        // has NO index, so on a large workspace it sorted the entire (500k+‑row)
        // Session partition and made /counts ~3s. startedAt is also the better
        // "last activity" signal (a just-started session is current) and, unlike
        // endedAt, is not rewritten on every heartbeat — so the index it uses stays
        // write-cheap on the hot ingest path.
        this.db.session.findFirst({
          where: { workspaceId },
          orderBy: { startedAt: "desc" },
          select: { startedAt: true, startUrl: true },
        }),
        this.db.issue.count({ where: { workspaceId } }),
        // Alerts count — powers the SAME 0-vs-nonzero gate the Alerts page uses
        // to skip its fetch→skeleton→illustration flash. Small per-workspace
        // table, workspaceId-indexed, so it runs cheaply alongside the others.
        this.db.alert.count({ where: { workspaceId } }),
      ]);

    if (cached) {
      return {
        recordings: cached.sessionsTotal,
        playlists: cached.playlistsTotal,
        funnels: cached.funnelsTotal,
        users: cached.usersTotal,
        cohorts: cached.cohortsTotal,
        comments: cached.commentsTotal,
        crashlytics: crashlyticsTotal,
        alerts: alertsTotal,
        live: liveNow,
        lastEventAt: lastSession?.startedAt?.toISOString() ?? null,
        lastEventDomain: lastSession?.startUrl
          ? DashboardService.safeDomain(lastSession.startUrl)
          : null,
      };
    }

    // Cache miss or stale row → reconcile (which also returns the
    // computed counts in one round-trip, so we don't pay the read
    // cost twice).
    const fresh = await this.stats.reconcile(workspaceId);
    return {
      recordings: fresh.sessionsTotal,
      playlists: fresh.playlistsTotal,
      funnels: fresh.funnelsTotal,
      users: fresh.usersTotal,
      cohorts: fresh.cohortsTotal,
      comments: fresh.commentsTotal,
      crashlytics: crashlyticsTotal,
      live: liveNow,
      lastEventAt: lastSession?.startedAt?.toISOString() ?? null,
      lastEventDomain: lastSession?.startUrl
        ? DashboardService.safeDomain(lastSession.startUrl)
        : null,
    };
  }

  /** Template-first likely cause (no LLM), element-aware for frustration. */
  private static likelyCause(
    type: string,
    element: string,
    screen: string,
  ): string {
    const where = screen ? ` on ${screen}` : "";
    switch (type) {
      case "user_frustrated":
        return element
          ? `Users repeatedly rage-clicked the ${element}${where} — it may be unresponsive or its requirements unclear.`
          : `Users are repeatedly clicking elements that don't respond as expected${where}.`;
      case "backend_failure":
        return `A backend dependency is returning errors${where}.`;
      case "slow_api":
        return `This endpoint's response time has degraded${where}.`;
      case "crash_detected":
        return `The app is crashing for users${where} — likely tied to a recent release.`;
      case "form_abandonment":
        return `Users start this form but don't finish${where} — likely friction or unclear validation.`;
      case "navigation_loop":
        return `Users are bouncing between the same screens without progressing${where}.`;
      case "conversion_success":
        return `A growing number of users are completing this conversion${where}.`;
      case "conversion_failure":
        return `Users enter this flow but drop before completing${where}.`;
      case "unmet_demand":
        return `Users repeatedly visited${where} without converting — likely unmet demand or a missing path forward.`;
      default:
        return `Pattern detected${where}.`;
    }
  }

  /** Hostname of a URL, or null if it doesn't parse. Used by counts(). */
  private static safeDomain(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }
}
