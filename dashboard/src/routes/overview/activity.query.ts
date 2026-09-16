/* ============================================================================
   activity.query.ts — the Activity chart's query model + the REAL-data builder.
   One ActivityQuery drives the whole component: metric, breakdown, time range,
   granularity, comparison, segment and any number of dimension rules. The chart
   is fed by GET /v1/dashboard/activity-series (real ClickHouse per-band series);
   `buildActivityFromSeries` folds that payload into ActivityData. The former
   client-side synthesis is gone.
   ========================================================================== */
import { fmtCount } from "./overview.series";
import { countryName, flagEmoji } from "@/lib/device-format";

/** Human label for a dimension value. Country arrives as an ISO code (the value
 *  the backend filters on) — show "🇳🇬 Nigeria" instead of "NG". Reserved bands
 *  ("Other"/"Unknown"/"total") and every other dimension pass through unchanged. */
export function dimValueLabel(dim: string, value: string): string {
  if (
    dim === "country" &&
    value &&
    value !== "Other" &&
    value !== "Unknown" &&
    value !== "total"
  ) {
    const name = countryName(value) || value;
    const flag = flagEmoji(value);
    return flag ? `${flag} ${name}` : name;
  }
  return value;
}

/* ---- shared types ------------------------------------------------------- */
export type MetricUnit = "" | "%" | "s";

/* ---- time + granularity -------------------------------------------------- */
export type TimeKey = "h1" | "h24" | "d7" | "d30" | "d90";
export type GranKey = "5m" | "hour" | "day" | "week" | "month";

export const TIME_RANGES: { key: TimeKey; label: string; grans: GranKey[] }[] = [
  { key: "h1", label: "Last hour", grans: ["5m"] },
  { key: "h24", label: "Last 24 hours", grans: ["hour"] },
  { key: "d7", label: "Last 7 days", grans: ["day"] },
  { key: "d30", label: "Last 30 days", grans: ["day", "week"] },
  // `month` is a fixed 30-day bucket (not a calendar month), so it only makes
  // sense on the 90-day window (≈3 buckets); it drives the MAU cadence tile.
  { key: "d90", label: "Last 90 days", grans: ["day", "week", "month"] },
];
/** TimeKey → the `range` token the /activity-series endpoint accepts. */
export function timeToRange(t: TimeKey): string {
  return { h1: "1h", h24: "24h", d7: "7d", d30: "30d", d90: "90d" }[t] ?? "30d";
}

/** Header DatePicker label → the chart's TimeKey, so the home-page date filter
 *  ALSO drives the Activity chart (it was previously wired only to the overview
 *  + metric-strip reads, so changing the header date left the chart on d30 and
 *  the filter "did nothing" to the most prominent surface). There is no per-day
 *  "today"/"yesterday" chart bucket, so both map to the nearest 24-hour view. */
export function rangeLabelToTimeKey(label: string): TimeKey {
  switch (label) {
    case "Today":
    case "Yesterday":
      return "h24";
    case "Last 7 days":
      return "d7";
    case "Last 14 days":
      // No dedicated 14-day chart bucket; d30 (day granularity) covers it.
      return "d30";
    case "Last 30 days":
      return "d30";
    case "Last 3 months":
      return "d90";
    case "Last 12 months":
      // Chart maxes at a 90-day window; the overview/metric reads still use 365d.
      return "d90";
    default:
      return "d30";
  }
}

/** First (default) granularity valid for a TimeKey — used when the header
 *  changes the chart's time so its granularity stays valid for the new range. */
export function defaultGranFor(t: TimeKey): GranKey {
  return TIME_RANGES.find((r) => r.key === t)?.grans[0] ?? "day";
}
/** GranKey → the `gran` token + the fixed bucket width in ms. `month` is a fixed
 *  30-day bucket (NOT a calendar month), matching the backend, so the axis math
 *  stays timezone-free; it powers the MAU cadence. */
export const GRAN_MS: Record<string, number> = {
  "5m": 300_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};
export const GRAN_LABELS: Record<GranKey, string> = {
  "5m": "5 minutes",
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
};
export const COMPARE_MODES: { key: string; label: string }[] = [
  { key: "off", label: "No comparison" },
  { key: "prev", label: "Previous period" },
  // "Previous release" dropped: the real compare window is the preceding period
  // of equal length — a release-anchored window isn't a backend concept here.
];

/* ---- REAL chart vocabulary (what /activity-series can actually serve) -----
   Only these metrics/dimensions/segments have a real ClickHouse source, so the
   Filter offers exactly them — no option changes a caption without changing the
   data. */
export type ChartMetricDef = {
  key: string;
  label: string;
  short: string;
  unit: MetricUnit;
  goodUp: boolean;
};
export const CHART_METRICS: ChartMetricDef[] = [
  { key: "activeUsers", label: "Active users", short: "Active", unit: "", goodUp: true },
  { key: "sessions", label: "Sessions", short: "Sessions", unit: "", goodUp: true },
  { key: "newUsers", label: "New users", short: "New", unit: "", goodUp: true },
  { key: "returningUsers", label: "Returning users", short: "Returning", unit: "", goodUp: true },
  { key: "avgDuration", label: "Avg session", short: "Duration", unit: "s", goodUp: true },
];
export const chartMetricByKey = (k: string) =>
  CHART_METRICS.find((m) => m.key === k) ?? CHART_METRICS[0];

export type ChartDim = { key: string; label: string; suggest: string };
/** Breakdown/rule dimensions — `suggest` is the /v1/sessions/suggest group that
 *  feeds this dimension's REAL values into the rule-value picker. */
export const CHART_DIMS: ChartDim[] = [
  { key: "platform", label: "Platform", suggest: "platform" },
  { key: "browser", label: "Browser", suggest: "browser" },
  { key: "os", label: "OS", suggest: "os" },
  { key: "country", label: "Country", suggest: "country" },
  { key: "device", label: "Device", suggest: "device" },
  { key: "deviceModel", label: "Device model", suggest: "deviceModel" },
  { key: "release", label: "App version", suggest: "release" },
  { key: "plan", label: "Plan", suggest: "plan" },
  { key: "page", label: "Entry page", suggest: "page" },
];
export const chartDimByKey = (k: string) => CHART_DIMS.find((d) => d.key === k);

export const CHART_SEGMENTS: { key: string; label: string }[] = [
  { key: "all", label: "All users" },
  { key: "anon", label: "Anonymous" },
  { key: "logged", label: "Logged in" },
  { key: "paying", label: "Paying" },
  { key: "enterprise", label: "Enterprise" },
  { key: "power", label: "Power users (5+ sessions)" },
];

/** GET /v1/dashboard/activity-series response — real per-band, per-bucket series. */
export type ActivitySeriesResp = {
  metric: string;
  dimension: string;
  bands: string[];
  buckets: number[];
  series: { label: string; values: number[] }[];
  /** Per-band aggregate over the WHOLE window, from the query. For a unique
   *  metric this is not the sum of that band's plotted columns. */
  totalByBand: { label: string; value: number }[];
  /** The metric across all bands over the whole window. Not the sum of
   *  `totalByBand` either — the bands overlap (one person on two browsers is
   *  one user), so only the query can union them. */
  windowTotal: number;
  /** Same, for the compare window. Present only when compare is on. */
  compareWindowTotal?: number;
  compare?: { buckets: number[]; series: { label: string; values: number[] }[] };
};

/* ---- the query ----------------------------------------------------------- */
export type FilterRule = { dim: string; value: string };
export type ActivityQuery = {
  metric: string;
  breakdown: string; // dim key or "none"
  time: TimeKey;
  gran: GranKey;
  compare: string; // off | prev | release
  segment: string;
  rules: FilterRule[];
};
export const DEFAULT_QUERY: ActivityQuery = {
  // Real chart-metric key (maps 1:1 to the /activity-series metric). The chart
  // defaults to the platform breakdown — the real per-web/iOS/Android split,
  // now served from ClickHouse rather than synthesized.
  metric: "activeUsers",
  breakdown: "platform",
  // Matches the header's default range (Last 30 days) so the chart and the
  // metric strip describe the SAME window on first paint — see Overview.tsx.
  time: "d30",
  gran: "day",
  compare: "off",
  segment: "all",
  rules: [],
};

const hashStr = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 131 + s.charCodeAt(i)) >>> 0;
  return h;
};
export const queryHash = (q: ActivityQuery) =>
  [q.metric, q.breakdown, q.time, q.gran, q.compare, q.segment, ...q.rules.map((r) => r.dim + "=" + r.value)].join("|");

/* ---- build --------------------------------------------------------------- */
export type ActivityStack = { key: string; label: string; tone: number; values: number[]; total: number };
export type ActivityData = {
  labels: string[];
  per: string; // bucket noun for the meta line
  totals: number[];
  prev: number[];
  stacks: ActivityStack[];
  fmt: (v: number) => string;
  unit: MetricUnit;
  deltaPct: number;
  goodUp: boolean;
  peakIdx: number;
  sum: number;
  avg: number;
};

const fmtDuration = (v: number) => {
  const s = Math.max(0, Math.round(v));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/* ---- REAL build: /activity-series response → ActivityData ---------------- */

/** X-axis label for a bucket floor (ms) at the given granularity. */
function bucketLabel(ms: number, gran: GranKey): string {
  const d = new Date(ms);
  if (gran === "5m") return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (gran === "hour") return d.toLocaleTimeString([], { hour: "numeric" });
  if (gran === "week") return "w/" + d.toLocaleDateString([], { month: "short", day: "numeric" });
  // month buckets are calendar-month floors (UTC) — label them by month name so
  // they don't read as single days like the day granularity.
  if (gran === "month") return d.toLocaleDateString([], { month: "short", timeZone: "UTC" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
const GRAN_NOUN: Record<string, string> = {
  "5m": "5 min",
  hour: "hour",
  day: "day",
  week: "week",
  month: "month",
};
/** Tone ramp: top bands cycle 0..3, the residual bands get the muted tones. */
function bandTone(label: string, idx: number): number {
  if (label === "Other") return 4;
  if (label === "Unknown") return 4;
  if (label === "total") return 0;
  return idx % 4;
}

/** Convert the REAL per-band/per-bucket payload into the ActivityData the chart
 *  renders. Stacks come straight from `series` (band order preserved), the
 *  compare overlay is the whole-column sum of the prev window, and everything —
 *  labels, totals, delta — is measured, never synthesized. */
export function buildActivityFromSeries(
  resp: ActivitySeriesResp,
  gran: GranKey,
  compareOn: boolean,
): ActivityData {
  const meta = chartMetricByKey(resp.metric);
  const labels = resp.buckets.map((b) => bucketLabel(b, gran));
  const n = labels.length;
  const byLabel = new Map(resp.series.map((s) => [s.label, s.values]));
  const bandTotal = new Map(resp.totalByBand.map((t) => [t.label, t.value]));
  const stacks: ActivityStack[] = resp.bands.map((label, i) => {
    const raw = byLabel.get(label) ?? [];
    const values = Array.from({ length: n }, (_, k) => raw[k] ?? 0);
    return {
      // key stays the raw band (ISO for country) — stable across renders + the
      // hidden-set; only the DISPLAY label is humanised (e.g. "🇳🇬 Nigeria").
      key: label,
      label:
        label === "total" ? meta.short : dimValueLabel(resp.dimension, label),
      tone: bandTone(label, i),
      values,
      // From the response, NOT `values.reduce(...)`. Adding up the plotted
      // columns is only correct for `sessions`; for the unique metrics it counts
      // each person once per bucket they appeared in (measured on real data:
      // 154,064 vs a true 49,027), and for avgDuration it sums averages.
      total: bandTotal.get(label) ?? 0,
    };
  });
  const totals = Array.from({ length: n }, (_, i) =>
    stacks.reduce((a, s) => a + (s.values[i] ?? 0), 0),
  );

  // Compare overlay = whole-column sum of the prev window per bucket (aligned by
  // index; the prev window is the same length so the bucket counts match).
  let prev: number[] = [];
  if (compareOn && resp.compare) {
    const cs = resp.compare.series;
    prev = Array.from({ length: n }, (_, i) =>
      cs.reduce((a, s) => a + (s.values[i] ?? 0), 0),
    );
  }

  const isDur = meta.unit === "s";
  const fmtBig = (v: number) =>
    v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M" : fmtCount(v);
  // avgDuration arrives in ms; render as a duration.
  const fmt = isDur ? (v: number) => fmtDuration(v / 1000) : fmtBig;

  // The headline number under the chart is the window-wide figure the query
  // computed, not the sum of the columns. Those differ for every metric except
  // `sessions` — and the gap is large: on a 30-day window the old sum read
  // 154,064 "active users" against 49,027 real people, which also contradicted
  // the unique count the metric cards print on the same screen.
  const sum = resp.windowTotal;
  let peakIdx = 0;
  totals.forEach((v, i) => {
    if (v > totals[peakIdx]) peakIdx = i;
  });
  const prevSum = resp.compareWindowTotal ?? 0;
  const deltaPct =
    compareOn && prevSum > 0
      ? Math.round(((sum - prevSum) / prevSum) * 1000) / 10
      : 0;

  return {
    labels,
    per: GRAN_NOUN[gran] ?? "day",
    totals,
    prev,
    stacks,
    fmt,
    unit: meta.unit,
    deltaPct,
    goodUp: meta.goodUp,
    peakIdx,
    sum,
    // The mean of the plotted columns — "active users per day" — which is a
    // different question from `sum` and must NOT be derived from it: dividing a
    // window-wide unique by the bucket count answers nothing.
    avg: totals.reduce((a, b) => a + b, 0) / Math.max(1, n),
  };
}

/** "by platform · last 30 days · Chrome · Paying · vs previous period" — every
 *  bit reflects a filter that IS applied to the real data. */
export function querySummary(q: ActivityQuery): string {
  const bits: string[] = [];
  if (q.breakdown !== "none")
    bits.push("by " + (chartDimByKey(q.breakdown)?.label.toLowerCase() ?? q.breakdown));
  bits.push(TIME_RANGES.find((t) => t.key === q.time)?.label.toLowerCase() ?? "");
  for (const r of q.rules) bits.push(dimValueLabel(r.dim, r.value));
  const seg = CHART_SEGMENTS.find((s) => s.key === q.segment);
  if (seg && seg.key !== "all") bits.push(seg.label);
  if (q.compare !== "off") bits.push("vs previous period");
  return bits.filter(Boolean).join(" · ");
}
