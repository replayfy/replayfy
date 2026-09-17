import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { resolveRange } from "../common/range";

@Injectable()
export class InsightsService {
  private readonly db = getPostgresClient();

  async kpis(workspaceId: number, range = "7d") {
    // Shared range resolver — "today" is midnight-anchored, not rolling.
    const win = resolveRange(range);
    const since = win.since;
    const prior = win.priorSince;

    const [count, durAvg, rage, prevCount, errorAgg] = await Promise.all([
      this.db.session.count({
        where: { workspaceId, startedAt: { gte: since } },
      }),
      this.db.session.aggregate({
        where: { workspaceId, startedAt: { gte: since } },
        _avg: { durationMs: true },
      }),
      this.db.session.aggregate({
        where: { workspaceId, startedAt: { gte: since } },
        _sum: { rageCount: true, clickCount: true },
      }),
      this.db.session.count({
        where: { workspaceId, startedAt: { gte: prior, lt: since } },
      }),
      this.db.session.aggregate({
        where: { workspaceId, startedAt: { gte: since } },
        _sum: { errorCount: true },
      }),
    ]);

    const delta = prevCount > 0 ? ((count - prevCount) / prevCount) * 100 : 0;
    const rageRate =
      (rage._sum.clickCount ?? 0) > 0
        ? ((rage._sum.rageCount ?? 0) / (rage._sum.clickCount as number)) * 100
        : 0;

    // Daily sparklines for each KPI — replaces the hardcoded shapes the
    // previous build was showing on the cards.
    const series = await this.daySeries(workspaceId, since);
    return [
      {
        key: "sessions_recorded",
        label: "Sessions recorded",
        value: count,
        deltaPct: delta,
        spark: series.sessions,
      },
      {
        key: "avg_duration_ms",
        label: "Avg session length",
        value: Math.round(durAvg._avg.durationMs ?? 0),
        spark: series.avgDurationMs,
      },
      {
        key: "rage_click_rate",
        label: "Rage click rate",
        value: Number(rageRate.toFixed(2)),
        spark: series.rage,
      },
      {
        key: "errors_total",
        label: "Total errors",
        value: errorAgg._sum.errorCount ?? 0,
        spark: series.errors,
      },
    ];
  }

  /**
   * Per-day series used by sparklines on the Insights KPI cards.
   *
   * Was: pull every Session row in the window, JS-bucket. Now: a single
   * SQL aggregate keyed on date_trunc — returns one row per bucket
   * regardless of session count. Capped at ~14 buckets so the
   * sparkline density matches across ranges.
   */
  private async daySeries(workspaceId: number, since: Date) {
    const spanMs = Date.now() - since.getTime();
    const useDay = spanMs > 36 * 3_600_000;
    const bucketMs = useDay ? 86_400_000 : 3_600_000;
    const trunc = useDay ? "day" : "hour";
    const steps = Math.min(14, Math.ceil(spanMs / bucketMs));

    const rows = await this.db.$queryRawUnsafe<
      Array<{
        ts: Date;
        count: bigint;
        duration_sum: bigint | null;
        rage_sum: bigint | null;
        error_sum: bigint | null;
      }>
    >(
      `SELECT date_trunc('${trunc}', "startedAt" AT TIME ZONE 'UTC') AS ts,
              COUNT(*)::bigint AS count,
              SUM("durationMs")::bigint AS duration_sum,
              SUM("rageCount")::bigint AS rage_sum,
              SUM("errorCount")::bigint AS error_sum
         FROM "Session"
        WHERE "workspaceId" = $1 AND "startedAt" >= $2
        GROUP BY ts`,
      workspaceId,
      since,
    );
    type B = { count: number; durSum: number; rage: number; errors: number };
    const map = new Map<number, B>();
    const now = new Date();
    if (useDay) now.setUTCHours(0, 0, 0, 0);
    else now.setUTCMinutes(0, 0, 0);
    for (let i = steps - 1; i >= 0; i--) {
      map.set(now.getTime() - i * bucketMs, { count: 0, durSum: 0, rage: 0, errors: 0 });
    }
    for (const r of rows) {
      const b = map.get(r.ts.getTime());
      if (!b) continue;
      b.count = Number(r.count);
      b.durSum = Number(r.duration_sum ?? 0n);
      b.rage = Number(r.rage_sum ?? 0n);
      b.errors = Number(r.error_sum ?? 0n);
    }
    const ordered = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    return {
      sessions: ordered.map((b) => b.count),
      avgDurationMs: ordered.map((b) =>
        b.count > 0 ? Math.round(b.durSum / b.count) : 0,
      ),
      rage: ordered.map((b) => b.rage),
      errors: ordered.map((b) => b.errors),
    };
  }

  /**
   * Funnel only returns rows when the caller passes explicit `steps`. Without
   * steps we return [] so the dashboard renders an EmptyState instead of a
   * fabricated checkout shape.
   */
  async funnel(workspaceId: number, range = "7d", steps?: string) {
    const since = resolveRange(range).since;
    const stepUrls = (steps ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (stepUrls.length === 0) return [];

    // One indexed count per step, fired in parallel. The DB does N
    // index scans concurrently; the API does ONE round-trip's wall-time
    // work instead of N sequential awaits.
    const counts = await Promise.all(
      stepUrls.map((url) =>
        this.db.session.count({
          where: {
            workspaceId,
            startedAt: { gte: since },
            paths: { some: { url: { contains: url } } },
          },
        }),
      ),
    );
    const first = counts[0] || 1;
    return stepUrls.map((url, i) => ({
      name: url,
      count: counts[i],
      pct: Number(((counts[i] / first) * 100).toFixed(1)),
    }));
  }

  async topErrors(
    workspaceId: number,
    range = "7d",
    cursor?: string,
    limit?: string,
  ) {
    const since = resolveRange(range).since;
    const lim = Math.min(Math.max(Number(limit ?? 10) || 10, 1), 50);
    const rows = await this.db.session.groupBy({
      by: ["startUrl"],
      where: { workspaceId, startedAt: { gte: since }, errorCount: { gt: 0 } },
      _sum: { errorCount: true },
      orderBy: { _sum: { errorCount: "desc" } },
      take: lim,
    });
    return rows.map((r) => ({
      url: r.startUrl ?? "(unknown)",
      count: r._sum.errorCount ?? 0,
      trend: "flat",
    }));
  }

  async frictionByPage(workspaceId: number, range = "7d", limit?: string) {
    const since = resolveRange(range).since;
    const lim = Math.min(Math.max(Number(limit ?? 10) || 10, 1), 50);
    const rows = await this.db.session.groupBy({
      by: ["startUrl"],
      where: { workspaceId, startedAt: { gte: since } },
      _sum: { rageCount: true, deadCount: true },
      _count: { _all: true },
      orderBy: { _sum: { rageCount: "desc" } },
      take: lim,
    });
    return rows.map((r) => ({
      path: r.startUrl ?? "(unknown)",
      rage: r._sum.rageCount ?? 0,
      dead: r._sum.deadCount ?? 0,
      sessions: r._count._all,
    }));
  }

  /**
   * Top URLs by median LCP, plus per-URL medians for every other Core
   * Web Vital we capture (INP, CLS, FCP, TTFB). Single SQL aggregate —
   * percentile_cont per startUrl, filtered per-metric so nulls don't
   * poison the percentile. Ordered by median LCP DESC (worst-first);
   * URLs without LCP rank below those with LCP via NULLS LAST.
   *
   * MIN_SAMPLES is intentionally 1: at early-workspace scale the
   * 3-sample gate hides all data. The response includes sampleCount so
   * the frontend can render a confidence signal for low-sample URLs.
   *
   * Rating follows web.dev cutoffs per vital:
   *   LCP   < 2500 / < 4000   → good / ni / poor
   *   INP   < 200  / < 500    → good / ni / poor
   *   CLS   < 0.1  / < 0.25   → good / ni / poor (stored ×1000)
   *   FCP   < 1800 / < 3000   → good / ni / poor
   *   TTFB  < 800  / < 1800   → good / ni / poor
   */
  async slowPages(workspaceId: number, range = "7d", limit?: string) {
    const since = resolveRange(range).since;
    const lim = Math.min(Math.max(Number(limit ?? 10) || 10, 1), 50);

    const rows = await this.db.$queryRawUnsafe<
      Array<{
        path: string;
        sample_count: bigint;
        median_lcp: number | null;
        p75_lcp: number | null;
        median_inp: number | null;
        median_cls_x1000: number | null;
        median_fcp: number | null;
        median_ttfb: number | null;
        lcp_samples: bigint;
        inp_samples: bigint;
        cls_samples: bigint;
        fcp_samples: bigint;
        ttfb_samples: bigint;
      }>
    >(
      `SELECT "startUrl" AS path,
              COUNT(*)::bigint AS sample_count,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY "worstLcp")
                FILTER (WHERE "worstLcp" IS NOT NULL AND "worstLcp" > 0)::float8 AS median_lcp,
              percentile_cont(0.75) WITHIN GROUP (ORDER BY "worstLcp")
                FILTER (WHERE "worstLcp" IS NOT NULL AND "worstLcp" > 0)::float8 AS p75_lcp,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY "worstInp")
                FILTER (WHERE "worstInp" IS NOT NULL)::float8 AS median_inp,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY "worstClsX1000")
                FILTER (WHERE "worstClsX1000" IS NOT NULL)::float8 AS median_cls_x1000,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY "worstFcp")
                FILTER (WHERE "worstFcp" IS NOT NULL)::float8 AS median_fcp,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY "worstTtfb")
                FILTER (WHERE "worstTtfb" IS NOT NULL)::float8 AS median_ttfb,
              COUNT(*) FILTER (WHERE "worstLcp"      IS NOT NULL AND "worstLcp" > 0)::bigint AS lcp_samples,
              COUNT(*) FILTER (WHERE "worstInp"      IS NOT NULL)::bigint AS inp_samples,
              COUNT(*) FILTER (WHERE "worstClsX1000" IS NOT NULL)::bigint AS cls_samples,
              COUNT(*) FILTER (WHERE "worstFcp"      IS NOT NULL)::bigint AS fcp_samples,
              COUNT(*) FILTER (WHERE "worstTtfb"     IS NOT NULL)::bigint AS ttfb_samples
         FROM "Session"
        WHERE "workspaceId" = $1
          AND "startedAt" >= $2
          AND "startUrl" IS NOT NULL
          AND (
                ("worstLcp" IS NOT NULL AND "worstLcp" > 0)
             OR  "worstInp" IS NOT NULL
             OR  "worstClsX1000" IS NOT NULL
             OR  "worstFcp" IS NOT NULL
             OR  "worstTtfb" IS NOT NULL
          )
        GROUP BY "startUrl"
        ORDER BY median_lcp DESC NULLS LAST,
                 median_inp DESC NULLS LAST,
                 sample_count DESC
        LIMIT $3`,
      workspaceId,
      since,
      lim,
    );

    const rate = (
      ms: number | null,
      good: number,
      ni: number,
    ): "good" | "needs-improvement" | "poor" | null => {
      if (ms == null) return null;
      if (ms < good) return "good";
      if (ms < ni) return "needs-improvement";
      return "poor";
    };

    const items = rows.map((r) => {
      const medianLcp = r.median_lcp == null ? null : Math.round(r.median_lcp);
      const medianInp = r.median_inp == null ? null : Math.round(r.median_inp);
      const medianCls =
        r.median_cls_x1000 == null
          ? null
          : Number((r.median_cls_x1000 / 1000).toFixed(3));
      const medianFcp = r.median_fcp == null ? null : Math.round(r.median_fcp);
      const medianTtfb =
        r.median_ttfb == null ? null : Math.round(r.median_ttfb);
      return {
        path: r.path,
        sampleCount: Number(r.sample_count),
        // LCP (kept at top-level for backwards compat with existing UI)
        medianLcpMs: medianLcp,
        p75LcpMs: r.p75_lcp == null ? null : Math.round(r.p75_lcp),
        rating: rate(medianLcp, 2500, 4000),
        lcpSamples: Number(r.lcp_samples),
        // INP
        medianInpMs: medianInp,
        inpRating: rate(medianInp, 200, 500),
        inpSamples: Number(r.inp_samples),
        // CLS (unitless, presented to 3 decimals)
        medianCls,
        clsRating: rate(
          r.median_cls_x1000 == null ? null : r.median_cls_x1000,
          100,
          250,
        ),
        clsSamples: Number(r.cls_samples),
        // FCP
        medianFcpMs: medianFcp,
        fcpRating: rate(medianFcp, 1800, 3000),
        fcpSamples: Number(r.fcp_samples),
        // TTFB
        medianTtfbMs: medianTtfb,
        ttfbRating: rate(medianTtfb, 800, 1800),
        ttfbSamples: Number(r.ttfb_samples),
      };
    });
    return { items };
  }
}
