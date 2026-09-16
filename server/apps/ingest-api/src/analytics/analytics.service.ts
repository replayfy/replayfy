import { BadRequestException, Injectable } from "@nestjs/common";
import { resolveRange } from "../common/range";
import {
  analyticsBreakdown,
  analyticsEventCatalog,
  analyticsProperties,
  analyticsRetention,
  analyticsSeries,
  analyticsWebVitals,
  ANALYTICS_BREAKDOWN_DIMENSIONS,
  ANALYTICS_FILTER_KEYS,
  ANALYTICS_NUMERIC_PROPS,
  type AnalyticsBreakdownMeasure,
  type AnalyticsEventCatalogRow,
  type AnalyticsSeriesFilter,
  type AnalyticsSeriesMetric,
  type AnalyticsSeriesRow,
  type AnalyticsSeriesSource,
} from "@replay/db-clickhouse";

const DAY_MS = 86_400_000;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Canonical Web-Vitals order + display metadata (thresholds live on the FE).
const WV_ORDER = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
const WV_META: Record<string, { label: string; name: string }> = {
  lcp: { label: "LCP", name: "Largest Contentful Paint" },
  inp: { label: "INP", name: "Interaction to Next Paint" },
  cls: { label: "CLS", name: "Cumulative Layout Shift" },
  fcp: { label: "FCP", name: "First Contentful Paint" },
  ttfb: { label: "TTFB", name: "Time to First Byte" },
};

// Human labels for dimensions / properties / numeric props (presentation only).
const FIELD_LABELS: Record<string, string> = {
  browser: "Browser",
  country: "Country",
  device: "Device",
  deviceModel: "Device model",
  os: "OS",
  osVersion: "OS version",
  platform: "Platform",
  plan: "Plan",
  release: "Release",
  path: "URL path",
  urlPath: "URL path",
  referrer: "Referrer",
  referrerDomain: "Referring domain",
  channel: "Channel",
  utmSource: "UTM source",
  utmMedium: "UTM medium",
  utmCampaign: "UTM campaign",
  duration: "Session duration",
  pages: "Pages per session",
  errors: "Errors per session",
  rage: "Rage clicks",
  dead: "Dead clicks",
};
const NUM_PROP_UNITS: Record<string, string> = {
  duration: "ms",
  pages: "count",
  errors: "count",
  rage: "count",
  dead: "count",
};
const AUTO_EVENT_META: Record<string, { key: string; label: string }> = {
  screen: { key: "$pageview", label: "Pageviews" },
  tap: { key: "$click", label: "Clicks" },
  network: { key: "$network", label: "Network requests" },
  error: { key: "$error", label: "Errors" },
  console: { key: "$console", label: "Console logs" },
};

type BreakdownParams = {
  dimension?: string;
  measure?: string;
  range?: string;
  from?: string;
  to?: string;
};
type BdRow = { key: string; count: number; share: number; deltaPct: number };
type BdModel = {
  dimension: string;
  measure: AnalyticsBreakdownMeasure;
  total: number;
  rows: BdRow[];
  maxShare: number;
};

type SeriesReq = { id?: string; event?: string; measure?: string; numProp?: string };
type TrendsBody = {
  series?: unknown[];
  breakdown?: string | null;
  range?: string;
  from?: number | string;
  to?: number | string;
  granularity?: string;
  compare?: boolean;
  filters?: unknown;
};
type BuiltSeries = {
  label: string;
  values: number[];
  total: number;
  avg: number;
  deltaPct: number;
};
type BuiltChart = {
  labels: string[];
  gran: "day" | "week" | "month";
  kind: string;
  series: BuiltSeries[];
  prev?: number[];
};

type RetGran = "day" | "week" | "month";
type RetCohort = {
  key: string;
  label: string;
  size: number;
  cells: (number | null)[];
};
type RetMilestone = {
  key: string;
  label: string;
  pct: number;
  trend: number[];
  deltaPct: number;
};
type RetModel = {
  gran: RetGran;
  unit: string;
  unitPlural: string;
  cols: number;
  cohorts: RetCohort[];
  milestones: RetMilestone[];
  totalUsers: number;
  avgReturn: number;
};

type WvRating = "good" | "needs" | "poor";
type WvCell = { value: number; rating: WvRating };
type WvPageVitals = {
  path: string;
  pageviews: number;
  metrics: Record<string, WvCell>;
};
type WvSummary = {
  key: string;
  label: string;
  name: string;
  value: number;
  rating: WvRating;
  dist: [number, number, number];
};
type WvModel = {
  pages: WvPageVitals[];
  summary: WvSummary[];
  totalPageviews: number;
};

type EvKind = "system" | "interaction" | "conversion" | "error";
type EvEvent = {
  key: string;
  name: string;
  kind: EvKind;
  volume: number;
  minutesAgo: number;
  seenPct: number;
  desc: string;
  topProps: { name: string; values: string[] }[];
  /** Real daily-occurrence sparkline over the window. */
  trend: number[];
};
type EvProp = {
  key: string;
  name: string;
  type: "string" | "number" | "boolean";
  volume: number;
  minutesAgo: number;
  eventCount: number;
  desc: string;
  values: string[];
  /** Real value distribution (share of the property's sessions), desc. */
  valueShares: { label: string; pct: number }[];
};
type SchemaModel = {
  events: { value: string; label: string; volume: number }[];
  dimensions: { value: string; label: string; buckets: string[] }[];
  numProps: { value: string; label: string; unit: string }[];
  measures: { value: string; label: string }[];
};

@Injectable()
export class AnalyticsService {
  /**
   * Breakdowns section: one dimension's distribution over the window, ranked
   * desc, with a period-over-period delta per bucket. All aggregation happens in
   * one partition-pruned ClickHouse pass (see analyticsBreakdown); the service
   * only shapes the result to the FE BdModel contract.
   */
  async breakdown(
    workspaceId: number,
    params: BreakdownParams,
  ): Promise<BdModel> {
    const dimension = params.dimension || "browser";
    if (!ANALYTICS_BREAKDOWN_DIMENSIONS.includes(dimension)) {
      throw new BadRequestException(`Unknown breakdown dimension: ${dimension}`);
    }
    const measure: AnalyticsBreakdownMeasure =
      params.measure === "users" ? "users" : "sessions";
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const untilMs = (win.until ?? new Date()).getTime();

    const rows = await analyticsBreakdown({
      workspaceId,
      dimension,
      measure,
      sinceMs: win.since.getTime(),
      untilMs,
      priorSinceMs: win.priorSince.getTime(),
      priorUntilMs: win.priorUntil.getTime(),
    });

    // total = sum of the returned bucket counts, so the table always adds to
    // 100%; share is each bucket vs that total (the FE BdModel contract). The
    // FE adapter fills the display label + colour (presentation only).
    const total = rows.reduce((sum, r) => sum + r.count, 0);
    const out: BdRow[] = rows.map((r) => ({
      key: r.key,
      count: r.count,
      share: total > 0 ? r.count / total : 0,
      deltaPct: this.delta(r.count, r.prev),
    }));
    return {
      dimension,
      measure,
      total,
      rows: out,
      maxShare: out.length ? out[0].share : 0,
    };
  }

  /**
   * Trends section: one BuiltChart per request. Each requested series is a
   * time-bucketed grouped scan (analyticsSeries); `breakdown` splits the FIRST
   * series into its top bands instead; `compare` adds the first series' prior
   * window as the reference line. Series run concurrently (Promise.all — never a
   * sequential await loop), each a partition-pruned tenant-bounded pass.
   */
  async series(workspaceId: number, body: TrendsBody): Promise<BuiltChart> {
    const reqSeries = (
      Array.isArray(body.series) ? body.series.slice(0, 6) : []
    ) as SeriesReq[];
    const gran: "day" | "week" | "month" =
      body.granularity === "week" || body.granularity === "month"
        ? body.granularity
        : "day";
    const monthly = gran === "month";
    const bucketMs = gran === "week" ? 7 * DAY_MS : DAY_MS;
    const win = resolveRange(
      body.range,
      this.toNum(body.from),
      this.toNum(body.to),
    );
    const sinceMs = win.since.getTime();
    const untilMs = (win.until ?? new Date()).getTime();
    const priorSince = win.priorSince.getTime();
    const priorUntil = win.priorUntil.getTime();
    const filters = this.compileFilters(body.filters);
    const breakdown =
      typeof body.breakdown === "string" &&
      ANALYTICS_BREAKDOWN_DIMENSIONS.includes(body.breakdown)
        ? body.breakdown
        : null;
    const compare = !!body.compare;

    if (reqSeries.length === 0) {
      return { labels: [], gran, kind: "count", series: [] };
    }

    // --- breakdown mode: one output series per top band of the FIRST series ---
    if (breakdown) {
      const s0 = reqSeries[0];
      const cur = await analyticsSeries({
        workspaceId,
        ...this.spec(s0),
        sinceMs,
        untilMs,
        bucketMs,
        monthly,
        filters,
        breakdown,
      });
      const prior = await analyticsSeries({
        workspaceId,
        ...this.spec(s0),
        sinceMs: priorSince,
        untilMs: priorUntil,
        bucketMs,
        monthly,
        filters,
        breakdown,
        bands: cur.bands,
      });
      const labelMs = this.labelSet(sinceMs, untilMs, bucketMs, monthly, cur.rows);
      const priorTotals = this.totalsByBand(prior.rows);
      const curTotals = this.totalsByBand(cur.rows);
      const curByBand = this.bucketsByBand(cur.rows);
      const bands = [...curTotals.keys()].sort(
        (a, b) => (curTotals.get(b) ?? 0) - (curTotals.get(a) ?? 0),
      );
      const outSeries: BuiltSeries[] = bands.map((band) => {
        const bm = curByBand.get(band) ?? new Map<number, number>();
        const values = labelMs.map((t) => bm.get(t) ?? 0);
        const total = curTotals.get(band) ?? 0;
        return {
          label: band,
          values,
          total,
          avg: this.avg(total, labelMs.length),
          deltaPct: this.delta(total, priorTotals.get(band) ?? 0),
        };
      });
      return {
        labels: labelMs.map((t) => this.fmtLabel(t, gran)),
        gran,
        kind: this.kindOf(s0),
        series: outSeries,
      };
    }

    // --- multi-series mode: each series independent; compare → prev line -------
    const computed = await Promise.all(
      reqSeries.map(async (s) => {
        const [cur, prior] = await Promise.all([
          analyticsSeries({
            workspaceId,
            ...this.spec(s),
            sinceMs,
            untilMs,
            bucketMs,
            monthly,
            filters,
          }),
          analyticsSeries({
            workspaceId,
            ...this.spec(s),
            sinceMs: priorSince,
            untilMs: priorUntil,
            bucketMs,
            monthly,
            filters,
          }),
        ]);
        return { s, cur, prior };
      }),
    );

    const labelMs = this.labelSet(
      sinceMs,
      untilMs,
      bucketMs,
      monthly,
      computed.flatMap((c) => c.cur.rows),
    );
    const outSeries: BuiltSeries[] = computed.map(({ s, cur, prior }) => {
      const bm = this.totalBandBuckets(cur.rows);
      const total = this.totalBandTotal(cur.rows);
      const priorTotal = this.totalBandTotal(prior.rows);
      const values = labelMs.map((t) => bm.get(t) ?? 0);
      return {
        label: this.seriesLabel(s),
        values,
        total,
        avg: this.avg(total, labelMs.length),
        deltaPct: this.delta(total, priorTotal),
      };
    });

    let prev: number[] | undefined;
    if (compare && computed[0]) {
      const pm = this.totalBandBuckets(computed[0].prior.rows);
      const priorBuckets = this.labelSet(
        priorSince,
        priorUntil,
        bucketMs,
        monthly,
        computed[0].prior.rows,
      );
      const arr = priorBuckets.map((t) => pm.get(t) ?? 0);
      // index-aligned to the current axis so the overlay lines up bucket-for-bucket
      prev = labelMs.map((_, i) => arr[i] ?? 0);
    }

    return {
      labels: labelMs.map((t) => this.fmtLabel(t, gran)),
      gran,
      kind: this.kindOf(reqSeries[0]),
      series: outSeries,
      ...(prev ? { prev } : {}),
    };
  }

  /**
   * Retention section: a cohort × return-offset grid. analyticsRetention does
   * the two set-based ClickHouse passes; the service assembles the triangle
   * (null past a cohort's observed age), the milestone summaries and the totals.
   * v1 measures "any activity" retention; the `action` param is reserved.
   */
  async retention(
    workspaceId: number,
    params: { action?: string; granularity?: string; range?: string; from?: string; to?: string },
  ): Promise<RetModel> {
    const gran: RetGran =
      params.granularity === "day" || params.granularity === "month"
        ? params.granularity
        : "week";
    const cols = 8;
    const monthly = gran === "month";
    const periodMs = gran === "week" ? 7 * DAY_MS : DAY_MS;
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const sinceMs = win.since.getTime();
    const untilMs = (win.until ?? new Date()).getTime();

    const { sizes, cells } = await analyticsRetention({
      workspaceId,
      sinceMs,
      untilMs,
      gran,
      cols,
      action: params.action, // "any" (default) or a custom event name
    });

    const cellMap = new Map<number, Map<number, number>>();
    for (const c of cells) {
      if (!cellMap.has(c.cohort)) cellMap.set(c.cohort, new Map());
      cellMap.get(c.cohort)!.set(c.offset, c.users);
    }

    // offset k is observable only once its period has begun before the window end
    const observable = (cohortMs: number, k: number): boolean =>
      monthly
        ? this.monthIdx(untilMs) >= this.monthIdx(cohortMs) + k
        : cohortMs + k * periodMs < untilMs;

    const cohortRows = sizes
      .filter((s) => s.size > 0)
      .sort((a, b) => b.cohort - a.cohort)
      .slice(0, 30); // newest-first, cap the visible triangle

    const cohorts: RetCohort[] = cohortRows.map((s) => {
      const off = cellMap.get(s.cohort) ?? new Map<number, number>();
      const cellPcts: (number | null)[] = [];
      for (let k = 0; k < cols; k++) {
        if (!observable(s.cohort, k)) {
          cellPcts.push(null);
          continue;
        }
        const u = off.get(k) ?? 0;
        cellPcts.push(s.size > 0 ? Math.round((u / s.size) * 100) : 0);
      }
      return {
        key: String(s.cohort),
        label: this.cohortLabel(s.cohort, gran),
        size: s.size,
        cells: cellPcts,
      };
    });

    const oldestFirst = [...cohorts].reverse();
    const milestones: RetMilestone[] = [1, 3, 7]
      .filter((o) => o < cols)
      .map((o) => {
        const trend: number[] = [];
        for (const c of oldestFirst) {
          const v = c.cells[o];
          if (v != null) trend.push(v);
        }
        const pct = trend.length
          ? Math.round(trend.reduce((a, b) => a + b, 0) / trend.length)
          : 0;
        const deltaPct =
          trend.length > 1 && trend[0] > 0
            ? Math.round(((trend[trend.length - 1] - trend[0]) / trend[0]) * 1000) /
              10
            : 0;
        return { key: `m${o}`, label: `${this.unitCap(gran)} ${o}`, pct, trend, deltaPct };
      });

    const totalUsers = sizes.reduce((a, s) => a + s.size, 0);
    const ret1 = cohorts.map((c) => c.cells[1]).filter((v): v is number => v != null);
    const avgReturn = ret1.length
      ? Math.round(ret1.reduce((a, b) => a + b, 0) / ret1.length)
      : 0;

    return {
      gran,
      unit: this.unitCap(gran),
      unitPlural: this.unitPlural(gran),
      cols,
      cohorts,
      milestones,
      totalUsers,
      avgReturn,
    };
  }

  /**
   * Web Vitals section: per-page LCP/INP/CLS/FCP/TTFB. analyticsWebVitals does
   * the CH-native perf scan; the service derives each cell's rating + the metric
   * distribution (CRUX-style: a metric is "good" when ≥75% of samples are good)
   * and sorts pages worst-LCP-first.
   */
  async webVitals(
    workspaceId: number,
    params: { device?: string; range?: string; from?: string; to?: string },
  ): Promise<WvModel> {
    const device =
      params.device === "desktop" || params.device === "mobile"
        ? params.device
        : "all";
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const untilMs = (win.until ?? new Date()).getTime();
    const rows = await analyticsWebVitals({
      workspaceId,
      sinceMs: win.since.getTime(),
      untilMs,
      device,
    });

    const totalRow = rows.find((r) => r.isTotal === 1);
    const summary: WvSummary[] = WV_ORDER.map((k) => {
      const c = totalRow?.metrics[k];
      const n = c?.n ?? 0;
      const good = c?.good ?? 0;
      const poor = c?.poor ?? 0;
      return {
        key: k,
        label: WV_META[k].label,
        name: WV_META[k].name,
        value: c?.value ?? 0,
        rating: this.wvRating(good, poor, n),
        dist: this.wvDist(good, poor, n),
      };
    });

    const rank: Record<WvRating, number> = { poor: 0, needs: 1, good: 2 };
    const pages: WvPageVitals[] = rows
      .filter((r) => r.isTotal === 0)
      .map((r) => {
        const metrics: Record<string, WvCell> = {};
        for (const k of WV_ORDER) {
          const c = r.metrics[k];
          metrics[k] = { value: c.value, rating: this.wvRating(c.good, c.poor, c.n) };
        }
        const pv =
          r.metrics.lcp.n ||
          Math.max(...WV_ORDER.map((k) => r.metrics[k].n), 0);
        return { path: r.path || "(unknown)", pageviews: pv, metrics };
      })
      .sort((a, b) => {
        const ra = rank[a.metrics.lcp.rating];
        const rb = rank[b.metrics.lcp.rating];
        if (ra !== rb) return ra - rb;
        return b.metrics.lcp.value - a.metrics.lcp.value;
      });

    const totalPageviews =
      totalRow?.metrics.lcp.n || pages.reduce((s, p) => s + p.pageviews, 0);
    return { pages, summary, totalPageviews };
  }

  private wvRating(good: number, poor: number, n: number): WvRating {
    if (n <= 0) return "good";
    if (good / n >= 0.75) return "good";
    if (poor / n >= 0.25) return "poor";
    return "needs";
  }
  private wvDist(good: number, poor: number, n: number): [number, number, number] {
    if (n <= 0) return [1, 0, 0];
    const g = good / n;
    const p = poor / n;
    return [g, Math.max(0, 1 - g - p), p];
  }

  /**
   * Events catalogue: named custom events + autocaptured kinds, ranked by
   * volume, with distinct-session reach and last-seen. Per-event volume trend
   * (drawer sparkline) is served on demand by the /series endpoint, not inlined.
   */
  async events(
    workspaceId: number,
    params: { range?: string; from?: string; to?: string },
  ): Promise<EvEvent[]> {
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const untilMs = (win.until ?? new Date()).getTime();
    const { events, totalSessions } = await analyticsEventCatalog({
      workspaceId,
      sinceMs: win.since.getTime(),
      untilMs,
    });
    const now = Date.now();
    return events
      .map((e) => this.toEvEvent(e, totalSessions, now))
      .sort((a, b) => b.volume - a.volume);
  }

  /**
   * Property catalogue: whitelisted session/person properties with reach + top
   * values. All enumeration is set-based per property (analyticsProperties).
   */
  async properties(
    workspaceId: number,
    params: { range?: string; from?: string; to?: string },
  ): Promise<EvProp[]> {
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const untilMs = (win.until ?? new Date()).getTime();
    const props = await analyticsProperties({
      workspaceId,
      sinceMs: win.since.getTime(),
      untilMs,
    });
    const now = Date.now();
    return props
      .filter((p) => p.volume > 0)
      .map((p) => ({
        key: p.key,
        name: FIELD_LABELS[p.key] ?? p.key,
        type: "string" as const,
        volume: p.volume,
        minutesAgo: this.minsAgo(p.lastSeen, now),
        eventCount: 0,
        desc: "",
        values: p.values.map((v) => v.value),
        valueShares: p.values.map((v) => ({
          label: v.value,
          pct: p.volume > 0 ? v.count / p.volume : 0,
        })),
      }))
      .sort((a, b) => b.volume - a.volume);
  }

  /**
   * Schema for the Trends rail selects: events (pseudo + top custom),
   * breakdown dimensions, numeric props and the measure list — all sourced from
   * the same whitelists the query engine enforces, so the UI only offers what
   * the backend can actually compute.
   */
  async schema(
    workspaceId: number,
    params: { range?: string; from?: string; to?: string },
  ): Promise<SchemaModel> {
    const win = resolveRange(
      params.range,
      this.toNum(params.from),
      this.toNum(params.to),
    );
    const untilMs = (win.until ?? new Date()).getTime();
    const { events, totalSessions } = await analyticsEventCatalog({
      workspaceId,
      sinceMs: win.since.getTime(),
      untilMs,
      limit: 50,
    });
    const autoVol = new Map<string, number>();
    for (const e of events) {
      if (e.grp === "auto") {
        const meta = AUTO_EVENT_META[e.name];
        if (meta) autoVol.set(meta.key, e.occ);
      }
    }
    const pseudo = [
      { value: "$sessions", label: "Sessions", volume: totalSessions },
      { value: "$pageview", label: "Pageviews", volume: autoVol.get("$pageview") ?? 0 },
      { value: "$click", label: "Clicks", volume: autoVol.get("$click") ?? 0 },
      { value: "$error", label: "Errors", volume: autoVol.get("$error") ?? 0 },
      { value: "$network", label: "Network requests", volume: autoVol.get("$network") ?? 0 },
    ];
    const customEvents = events
      .filter((e) => e.grp === "custom")
      .map((e) => ({ value: e.name, label: e.name, volume: e.occ }));

    return {
      events: [...pseudo, ...customEvents],
      dimensions: ANALYTICS_BREAKDOWN_DIMENSIONS.map((d) => ({
        value: d,
        label: FIELD_LABELS[d] ?? d,
        buckets: [],
      })),
      numProps: ANALYTICS_NUMERIC_PROPS.map((p) => ({
        value: p,
        label: FIELD_LABELS[p] ?? p,
        unit: NUM_PROP_UNITS[p] ?? "count",
      })),
      measures: [
        { value: "count", label: "Count" },
        { value: "uniqueUsers", label: "Unique users" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "median", label: "Median" },
        { value: "p95", label: "P95" },
      ],
    };
  }

  private toEvEvent(
    e: AnalyticsEventCatalogRow,
    totalSessions: number,
    now: number,
  ): EvEvent {
    const auto = e.grp === "auto";
    const meta = auto ? AUTO_EVENT_META[e.name] : undefined;
    const key = meta ? meta.key : e.name;
    const name = meta ? meta.label : e.name;
    return {
      key,
      name,
      kind: this.classifyEvent(e.name, auto),
      volume: e.occ,
      minutesAgo: this.minsAgo(e.last, now),
      seenPct: totalSessions > 0 ? Math.round((e.sess / totalSessions) * 100) : 0,
      desc: "",
      topProps: [],
      trend: e.trend,
    };
  }

  /**
   * Best-effort TYPE for an event. This is a name heuristic, not something the
   * SDK reports — the autocaptured kinds are known exactly, but a custom
   * `replay.track(name)` event can only be guessed from its name.
   *
   * Autocaptured events map to their true nature (console/network → system,
   * tap → interaction, error → error). Custom events are matched against
   * conversion / error / interaction keyword nets; anything unmatched defaults
   * to `interaction` (NOT `system`) — a custom event is a deliberate user or
   * business action the developer chose to record, so "system" (which means
   * infrastructure/auto noise) is the wrong default. This is why e.g.
   * `add_to_cart` and `move` read as Interaction rather than System.
   */
  private classifyEvent(name: string, auto: boolean): EvKind {
    if (auto) {
      if (name === "error") return "error";
      if (name === "tap") return "interaction";
      return "system";
    }
    if (/error|exception|crash|fail/i.test(name)) return "error";
    if (/purchase|checkout|order|signup|complete|convert|subscribe|payment|paid|upgrade/i.test(name))
      return "conversion";
    return "interaction";
  }

  private minsAgo(lastMs: number, now: number): number {
    return lastMs > 0 ? Math.max(0, Math.round((now - lastMs) / 60000)) : 0;
  }

  private cohortLabel(ms: number, gran: RetGran): string {
    const d = new Date(ms);
    if (gran === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return gran === "week" ? `Week of ${base}` : base;
  }
  private unitCap(gran: RetGran): string {
    return gran === "day" ? "Day" : gran === "week" ? "Week" : "Month";
  }
  private unitPlural(gran: RetGran): string {
    return gran === "day" ? "days" : gran === "week" ? "weeks" : "months";
  }
  private monthIdx(ms: number): number {
    const d = new Date(ms);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }

  // ---- series spec mapping --------------------------------------------------

  private spec(s: SeriesReq): {
    source: AnalyticsSeriesSource;
    metric: AnalyticsSeriesMetric;
  } {
    return { source: this.source(s.event), metric: this.metric(s.measure, s.numProp) };
  }

  private source(event: string | undefined): AnalyticsSeriesSource {
    switch (event) {
      case undefined:
      case "":
      case "$sessions":
        return { kind: "session" };
      case "$pageview":
        return { kind: "autoEvent", chKind: "screen" };
      case "$click":
        return { kind: "autoEvent", chKind: "tap" };
      case "$network":
        return { kind: "autoEvent", chKind: "network" };
      case "$error":
        return { kind: "autoEvent", chKind: "error" };
      case "$console":
        return { kind: "autoEvent", chKind: "console" };
      default:
        return { kind: "event", name: event };
    }
  }

  private metric(
    measure: string | undefined,
    numProp: string | undefined,
  ): AnalyticsSeriesMetric {
    if (measure === "uniqueUsers") return { agg: "uniqueUsers" };
    if (
      (measure === "sum" ||
        measure === "avg" ||
        measure === "median" ||
        measure === "p95") &&
      numProp &&
      ANALYTICS_NUMERIC_PROPS.includes(numProp)
    ) {
      return { agg: measure, prop: numProp };
    }
    return { agg: "count" };
  }

  private kindOf(s: SeriesReq): string {
    if (s.measure === "uniqueUsers") return "users";
    if (
      (s.measure === "sum" ||
        s.measure === "avg" ||
        s.measure === "median" ||
        s.measure === "p95") &&
      s.numProp
    ) {
      return s.numProp === "duration" ? "ms" : "count";
    }
    return "count";
  }

  private seriesLabel(s: SeriesReq): string {
    const map: Record<string, string> = {
      $sessions: "Sessions",
      $pageview: "Pageviews",
      $click: "Clicks",
      $network: "Network requests",
      $error: "Errors",
      $console: "Console logs",
    };
    return map[s.event ?? "$sessions"] ?? s.event ?? "Sessions";
  }

  // ---- row helpers ----------------------------------------------------------

  private totalsByBand(rows: AnalyticsSeriesRow[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of rows) if (r.isTotal === 1) m.set(r.band, r.value);
    return m;
  }
  private bucketsByBand(rows: AnalyticsSeriesRow[]): Map<string, Map<number, number>> {
    const m = new Map<string, Map<number, number>>();
    for (const r of rows) {
      if (r.isTotal === 1) continue;
      if (!m.has(r.band)) m.set(r.band, new Map());
      m.get(r.band)!.set(r.bucket, r.value);
    }
    return m;
  }
  private totalBandTotal(rows: AnalyticsSeriesRow[]): number {
    for (const r of rows) if (r.isTotal === 1 && r.band === "total") return r.value;
    return 0;
  }
  private totalBandBuckets(rows: AnalyticsSeriesRow[]): Map<number, number> {
    const m = new Map<number, number>();
    for (const r of rows) if (r.isTotal === 0) m.set(r.bucket, r.value);
    return m;
  }

  private labelSet(
    sinceMs: number,
    untilMs: number,
    bucketMs: number,
    monthly: boolean,
    rows: AnalyticsSeriesRow[],
  ): number[] {
    const set = new Set<number>();
    if (monthly) {
      let d = new Date(sinceMs);
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      while (d.getTime() < untilMs) {
        set.add(d.getTime());
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      }
    } else {
      let b = Math.floor(sinceMs / bucketMs) * bucketMs;
      for (; b < untilMs; b += bucketMs) set.add(b);
    }
    for (const r of rows) if (r.isTotal === 0) set.add(r.bucket);
    return [...set].sort((a, b) => a - b);
  }

  private fmtLabel(ms: number, gran: string): string {
    const d = new Date(ms);
    if (gran === "month") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  private compileFilters(raw: unknown): AnalyticsSeriesFilter[] {
    if (!Array.isArray(raw)) return [];
    const out: AnalyticsSeriesFilter[] = [];
    for (const f of raw) {
      if (!f || typeof f !== "object") continue;
      const key = String((f as { key?: unknown }).key ?? "");
      if (!ANALYTICS_FILTER_KEYS.includes(key)) continue;
      out.push({
        key,
        op: String((f as { op?: unknown }).op ?? "is"),
        val: String((f as { val?: unknown }).val ?? ""),
      });
    }
    return out;
  }

  private avg(total: number, n: number): number {
    return n > 0 ? Math.round(total / n) : 0;
  }

  /** Signed period-over-period change as a percentage; 0 when there is no prior
   *  baseline (avoids Infinity for a brand-new bucket). */
  private delta(cur: number, prev: number): number {
    if (prev <= 0) return 0;
    return Math.round(((cur - prev) / prev) * 1000) / 10;
  }

  private toNum(v: string | number | undefined): number | undefined {
    if (v == null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}
