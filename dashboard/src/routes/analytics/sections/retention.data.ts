/* ============================================================================
   retention.data.ts — shapes + presentation helpers for the Retention cohort
   triangle (#3).

   The grid is built entirely from LIVE data via
   `useApi(() => Analytics.retention(...))`; this module only declares the model
   the response is cast to and the constants the heat cells render through.
   ========================================================================== */

export type RetGran = "day" | "week" | "month";

/* The indigo accent (--accent #5b5ceb) as raw channels so the heat cells (inline
   rgba, per the heat spec) and the CSS legend gradient scale opacity off the
   SAME colour. This is the one sanctioned literal — the accent with a live alpha
   there is no design token for. */
export const RET_ACCENT_RGB = "91, 92, 235";

/* ---- Built shapes the screen consumes --------------------------------- */
export type RetMilestone = {
  key: string;
  label: string;          // "Day 7" / "Week 4" / "Month 3"
  pct: number;            // average retention %, 0..100
  trend: number[];        // per-cohort retention % at this offset, oldest → newest
  deltaPct: number;       // newest vs oldest cohort, relative %
};

export type RetCohort = {
  key: string;
  label: string;          // "Week of Aug 4"
  size: number;           // cohort size (users)
  cells: (number | null)[]; // retention % per offset; null past the triangle edge
};

export type RetModel = {
  gran: RetGran;
  unit: string;           // "Day" | "Week" | "Month"
  unitPlural: string;     // "days" | "weeks" | "months"
  cols: number;
  cohorts: RetCohort[];   // newest first (top row)
  milestones: RetMilestone[];
  totalUsers: number;
  avgReturn: number;      // overall avg offset-1 retention %, for the caption
};

/** Grouped-thousands integer, for cohort sizes / user totals. */
export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString("en-US");
}
