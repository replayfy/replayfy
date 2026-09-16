/* ============================================================================
   events.data.ts — shapes + formatters for the Events lexicon (the event &
   property catalogue behind Trends).

   The catalogue is LIVE: EventsExplorer reads it from /v1/analytics/events and
   /v1/analytics/properties (sparklines are the real per-day occurrence trend and
   value shares are the real distribution). This module only declares the row
   shapes the responses are cast to plus the presentation helpers.
   ========================================================================== */

export type EvKind = "system" | "interaction" | "conversion" | "error";
export type PropType = "string" | "number" | "boolean";

/** One sample property attached to an event (name + a few observed values). */
export type EvSampleProp = { name: string; values: string[] };

export type EvEvent = {
  key: string; // the captured event key, shown mono — "$pageview", "add_to_cart"
  name: string; // friendly label — "Pageview"
  kind: EvKind;
  volume: number; // 30-day occurrences
  minutesAgo: number; // last-seen
  seenPct: number; // seen on N% of sessions
  desc: string;
  topProps: EvSampleProp[];
  trend: number[]; // real daily-occurrence sparkline over the window
};

export type EvProp = {
  key: string; // property key, shown mono — "browser", "$current_url"
  name: string; // friendly label — "Browser"
  type: PropType;
  volume: number; // 30-day occurrences carrying this property
  minutesAgo: number;
  eventCount: number; // seen on N events
  desc: string;
  values: string[]; // observed values, most-common first
  valueShares: { label: string; pct: number }[]; // real value distribution (fraction 0..1)
};

/* Series palette — the real design tokens' hues (indigo accent first). Kept as
   literals per the palette rule; the only raw hex allowed on this screen. */
export const ANL_COLORS = ["#5b5ceb", "#c08a3e", "#3f9468", "#c2599f", "#3b76b0", "#d2576a", "#8b72d6", "#7a8aa6"];


/* ---- Formatting -------------------------------------------------------- */
export function fmtK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
  return Math.round(v).toString();
}

/** Compact relative-time from a minutes-ago offset ("2h ago", "3d ago"). */
export function fmtAgo(min: number): string {
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)}m ago`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export const kindLabel = (k: EvKind): string =>
  k === "system" ? "System" : k === "interaction" ? "Interaction" : k === "conversion" ? "Conversion" : "Error";
export const typeLabel = (t: PropType): string => (t === "string" ? "String" : t === "number" ? "Number" : "Boolean");

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);


/** First-quarter vs last-quarter change of a series, as a signed percentage. */
export function sparkDelta(v: number[]): number {
  const q = Math.max(1, Math.floor(v.length / 4));
  const first = mean(v.slice(0, q));
  const last = mean(v.slice(-q));
  return first > 0 ? ((last - first) / first) * 100 : 0;
}

