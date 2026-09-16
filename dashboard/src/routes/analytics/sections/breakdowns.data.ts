/* ============================================================================
   breakdowns.data.ts — shapes + presentation vocabulary for the Breakdowns
   screen (#8): rank any bucket of a dimension by a measure.

   The ranked table + viz are built from LIVE data via
   `useApi(() => Analytics.breakdown(...))`. This module only declares which
   dimensions/measures can be ranked, the palette, and the model the response is
   cast to — no fixtures, no generator.
   ========================================================================== */

export type BdMeasure = "sessions" | "users";

export type BdDimensionDef = { value: string; label: string; icon: string };

/* ---- Catalogues: the dimensions you can rank by ------------------------ */
export const BD_DIMENSIONS: BdDimensionDef[] = [
  { value: "browser", label: "Browser", icon: "browser" },
  { value: "country", label: "Country", icon: "globe" },
  { value: "device", label: "Device type", icon: "device" },
  { value: "os", label: "OS", icon: "monitor" },
  { value: "path", label: "URL path", icon: "pages" },
  { value: "referrer", label: "Referrer", icon: "link" },
  { value: "channel", label: "Channel", icon: "funnel" },
  { value: "referrerDomain", label: "Referring domain", icon: "globe" },
  { value: "utmSource", label: "UTM source", icon: "mega" },
  { value: "utmMedium", label: "UTM medium", icon: "mega" },
  { value: "utmCampaign", label: "UTM campaign", icon: "mega" },
];

export const BD_MEASURES: { value: BdMeasure; label: string; icon: string }[] = [
  { value: "sessions", label: "Sessions", icon: "recPlay" },
  { value: "users", label: "Users", icon: "users" },
];

/* Series/bucket palette — the real design tokens' hues (indigo accent first).
   Reused verbatim from analytics.data.ts so ranked colours match the Trends
   breakdown split; the literal lives here to keep this module self-contained. */
export const ANL_COLORS = ["#5b5ceb", "#c08a3e", "#3f9468", "#c2599f", "#3b76b0", "#d2576a", "#8b72d6", "#7a8aa6"];

/* ---- Built shapes the table + viz consume ------------------------------ */
export type BdRow = {
  key: string;
  label: string;
  color: string;
  count: number;
  /** Fraction of the period total, 0..1. */
  share: number;
  /** vs previous period, percent (can be negative). */
  deltaPct: number;
};
export type BdModel = {
  dimension: string;
  dimensionLabel: string;
  measure: BdMeasure;
  measureLabel: string;
  total: number;
  /** Sorted descending by count; colours assigned by final rank. */
  rows: BdRow[];
  /** Top bucket's share — the in-row bars scale against this so #1 fills. */
  maxShare: number;
};

/* ---- Lookups ----------------------------------------------------------- */
export const bdDimDef = (v: string): BdDimensionDef => BD_DIMENSIONS.find((d) => d.value === v) || BD_DIMENSIONS[0];

/* ---- Formatting -------------------------------------------------------- */
export function fmtN(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return Math.round(v).toString();
}
