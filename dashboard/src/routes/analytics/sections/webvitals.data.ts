/* ============================================================================
   webvitals.data.ts — shapes + web.dev thresholds/formatters for the Web Vitals
   screen (#6). Per-page Core Web Vitals, WEB ONLY.

   The cards + table are built from LIVE RUM via
   `useApi(() => Analytics.webVitals(...))`. This module only declares the metric
   catalogue (thresholds), the model the response is cast to, and the rating +
   formatting helpers — no fixtures, no generator.
   ========================================================================== */

export type WvMetricKey = "lcp" | "inp" | "cls" | "fcp" | "ttfb";
export type WvRating = "good" | "needs" | "poor";
export type WvDevice = "all" | "desktop" | "mobile";

export type WvMetricDef = {
  key: WvMetricKey;
  label: string;   // compact axis label — "LCP"
  name: string;    // full name — "Largest Contentful Paint"
  unit: "ms" | "score";
  /** Typical healthy p75 in base units (ms for time metrics, raw for CLS). */
  center: number;
  /** web.dev thresholds — good when value <= goodMax, poor when value > poorMin. */
  goodMax: number;
  poorMin: number;
};

/* Canonical order across the whole screen: cards row + table columns. */
export const WV_METRICS: WvMetricDef[] = [
  { key: "lcp",  label: "LCP",  name: "Largest Contentful Paint",  unit: "ms",    center: 2150, goodMax: 2500, poorMin: 4000 },
  { key: "inp",  label: "INP",  name: "Interaction to Next Paint", unit: "ms",    center: 165,  goodMax: 200,  poorMin: 500 },
  { key: "cls",  label: "CLS",  name: "Cumulative Layout Shift",   unit: "score", center: 0.07, goodMax: 0.1,  poorMin: 0.25 },
  { key: "fcp",  label: "FCP",  name: "First Contentful Paint",    unit: "ms",    center: 1450, goodMax: 1800, poorMin: 3000 },
  { key: "ttfb", label: "TTFB", name: "Time to First Byte",        unit: "ms",    center: 600,  goodMax: 800,  poorMin: 1800 },
];

/* ---- Built shapes the cards + table consume --------------------------- */
export type WvCell = { value: number; rating: WvRating };
export type WvPageVitals = {
  path: string;
  pageviews: number;
  metrics: Record<WvMetricKey, WvCell>;
};
export type WvSummary = {
  key: WvMetricKey;
  label: string;
  name: string;
  value: number;
  rating: WvRating;
  /** Good / Needs-work / Poor share of pageviews (each 0..1, sums to 1). */
  dist: [number, number, number];
};
export type WvModel = {
  pages: WvPageVitals[];      // worst-first (by LCP rating, then LCP value)
  summary: WvSummary[];       // WV_METRICS order
  totalPageviews: number;
};

/* ---- Rating + formatting (web.dev thresholds) ------------------------- */
export function wvRating(key: WvMetricKey, v: number): WvRating {
  const m = WV_METRICS.find((x) => x.key === key)!;
  if (v <= m.goodMax) return "good";
  if (v > m.poorMin) return "poor";
  return "needs";
}
export function ratingLabel(r: WvRating): string {
  return r === "good" ? "Good" : r === "needs" ? "Needs work" : "Poor";
}
/** LCP/FCP/TTFB render s (>=1000ms) or ms; INP always ms; CLS a 2-dp score. */
export function fmtVital(key: WvMetricKey, v: number): string {
  if (key === "cls") return v.toFixed(2);
  return v >= 1000 ? (v / 1000).toFixed(2) + " s" : Math.round(v) + " ms";
}
/** Compact integer (pageviews / totals): 12.6k, 1.8M. */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return Math.round(v).toString();
}
