/* ============================================================================
   analytics.data.ts — shared types, measures, palette and formatters for the
   Analytics section.

   The section reads LIVE data from /v1/analytics/* (see endpoints.ts →
   `Analytics`); this module holds only the presentation-side vocabulary those
   responses are rendered through — no fixtures, no generators.
   ========================================================================== */

export type MeasureKind = "count" | "uniqueUsers" | "sum" | "avg" | "median" | "p95";
export type Gran = "day" | "week" | "month";
export type ChartType = "line" | "bar" | "area" | "number";

export type EventDef = { value: string; label: string; volume: number };
export type PropDef = { value: string; label: string; buckets: string[] };
export type NumPropDef = { value: string; label: string; unit: "count" | "ms" | "usd" | "sec" };

/** One configured graph series (event + how to measure it). */
export type Series = { id: string; event: string; measure: MeasureKind; numProp?: string };

export const MEASURES: { value: MeasureKind; label: string; needsProp?: boolean }[] = [
  { value: "count", label: "Total count" },
  { value: "uniqueUsers", label: "Unique users" },
  { value: "sum", label: "Sum of…", needsProp: true },
  { value: "avg", label: "Average of…", needsProp: true },
  { value: "median", label: "Median of…", needsProp: true },
  { value: "p95", label: "P95 of…", needsProp: true },
];

/* Series/breakdown palette — the real design tokens' hues (indigo accent first). */
/* Series/breakdown palette — the design tokens' hues, ORDERED so consecutive
   series land on contrasting hue families (indigo → amber → green → magenta →
   blue → red → purple → slate). A breakdown with only 2–3 bands then reads as
   clearly different colours instead of two adjacent purples. */
export const ANL_COLORS = ["#5b5ceb", "#c08a3e", "#3f9468", "#c2599f", "#3b76b0", "#d2576a", "#8b72d6", "#7a8aa6"];

/* ---- Built shapes the chart + table consume ---------------------------- */
export type BuiltSeries = {
  key: string;
  label: string;
  color: string;
  values: number[];
  total: number;
  avg: number;
  deltaPct: number;
};
export type BuiltChart = {
  labels: string[];
  gran: Gran;
  kind: "count" | "users" | "usd" | "ms" | "sec";
  series: BuiltSeries[];
  /** Aggregate previous-period reference line (compare mode). */
  prev?: number[];
};

/* ---- Formatting -------------------------------------------------------- */
export function fmtN(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return Math.round(v).toString();
}
export function fmtVal(v: number, kind: BuiltChart["kind"]): string {
  switch (kind) {
    case "usd": return "$" + fmtN(v);
    case "ms": return v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms";
    case "sec": return Math.round(v) + "s";
    default: return fmtN(v);
  }
}
export const granUnit = (g: Gran): string => (g === "week" ? "week" : g === "month" ? "month" : "day");

/* Section-level date-range presets (the range token is derived in overview.api). */
export const RANGE_PRESETS = ["Last 7 days", "Last 14 days", "Last 30 days", "Last 90 days"];
