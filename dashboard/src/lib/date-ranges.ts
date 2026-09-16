/* ============================================================================
   Shared date-range resolver — the single source of truth for the named date
   presets used by BOTH the DatePicker chips and the funnel compute window.
   Keeping the label→[start,end] mapping here (instead of duplicating it in each
   component) guarantees the calendar highlight and the backend fromTs/toTs it
   drives can never drift out of sync. Pure, dependency-free date math.
   ========================================================================== */

export type ResolvedRange = { start: Date; end: Date };

const startOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date): Date => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
// Monday-based week start (matches how most product-analytics tools bucket weeks).
const startOfWeek = (d: Date): Date => {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  return addDays(x, -dow);
};

/** The preset labels offered by the funnel date filter, in display order.
 *  Rolling windows first, then fixed calendar periods (months → quarters →
 *  halves). The DatePicker also still supports an ad-hoc custom range. */
export const FN_DATE_PRESETS = [
  "Today",
  "Yesterday",
  "This week",
  "Last week",
  "Last 7 days",
  "Last 14 days",
  "Last 30 days",
  "1 month ago",
  "2 months ago",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "H1",
  "H2",
] as const;

/** Resolve a preset label to a concrete [start, end] range (inclusive of both
 *  endpoints). Returns null for labels this resolver doesn't own (e.g. a custom
 *  "Mon D → Mon D" range, which callers parse themselves). `now` is injectable
 *  for testing but defaults to the current instant. */
export function resolveDateRange(
  label: string,
  now: Date = new Date(),
): ResolvedRange | null {
  const today = startOfDay(now);
  const y = now.getFullYear();
  const mo = now.getMonth();
  switch (label) {
    case "Today":
      return { start: today, end: endOfDay(now) };
    case "Yesterday": {
      const yd = addDays(today, -1);
      return { start: yd, end: endOfDay(yd) };
    }
    case "This week":
      return { start: startOfWeek(now), end: endOfDay(now) };
    case "Last week": {
      const s = addDays(startOfWeek(now), -7);
      return { start: s, end: endOfDay(addDays(s, 6)) };
    }
    case "Last 7 days":
      return { start: addDays(today, -6), end: endOfDay(now) };
    case "Last 14 days":
      return { start: addDays(today, -13), end: endOfDay(now) };
    case "Last 30 days":
      return { start: addDays(today, -29), end: endOfDay(now) };
    case "Last 3 months":
      return { start: addDays(today, -90), end: endOfDay(now) };
    case "Last 12 months":
      return { start: addDays(today, -364), end: endOfDay(now) };
    // "N months ago" = that whole prior calendar month. JS Date normalises a
    // negative month index into the previous year, so January still works.
    case "1 month ago":
      return {
        start: startOfDay(new Date(y, mo - 1, 1)),
        end: endOfDay(new Date(y, mo, 0)),
      };
    case "2 months ago":
      return {
        start: startOfDay(new Date(y, mo - 2, 1)),
        end: endOfDay(new Date(y, mo - 1, 0)),
      };
    case "Q1":
      return { start: startOfDay(new Date(y, 0, 1)), end: endOfDay(new Date(y, 2, 31)) };
    case "Q2":
      return { start: startOfDay(new Date(y, 3, 1)), end: endOfDay(new Date(y, 5, 30)) };
    case "Q3":
      return { start: startOfDay(new Date(y, 6, 1)), end: endOfDay(new Date(y, 8, 30)) };
    case "Q4":
      return { start: startOfDay(new Date(y, 9, 1)), end: endOfDay(new Date(y, 11, 31)) };
    case "H1":
      return { start: startOfDay(new Date(y, 0, 1)), end: endOfDay(new Date(y, 5, 30)) };
    case "H2":
      return { start: startOfDay(new Date(y, 6, 1)), end: endOfDay(new Date(y, 11, 31)) };
    default:
      return null;
  }
}

/** Inclusive whole-day span of a range — used for the "compare to previous
 *  period" window length and the timeline endpoint's `range` param. */
export function rangeDayCount(r: ResolvedRange): number {
  const a = startOfDay(r.start).getTime();
  const b = startOfDay(r.end).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Parse a DatePicker CUSTOM range value → inclusive [from, to] epoch ms, or null
 *  when the label is a NAMED preset (callers resolve those via resolveDateRange).
 *  The picker emits the year ONLY when an endpoint isn't the current year
 *  ("Nov 3, 2025 → Nov 20, 2025"); a year-less form ("Jul 10 → Jul 15") is, by
 *  the picker's contract, the current year — so a prior-year or New-Year-crossing
 *  pick resolves to the right window instead of collapsing to this year. Shared
 *  by every surface that honours a custom range (funnels, overview, user detail).
 */
export function parseCustomRange(
  label: string,
  now: Date = new Date(),
): { from: number; to: number } | null {
  const withYear = label.match(/^(\w{3}) (\d+), (\d{4}) → (\w{3}) (\d+), (\d{4})$/);
  if (withYear) {
    const s = new Date(Number(withYear[3]), MON3.indexOf(withYear[1]), Number(withYear[2]));
    s.setHours(0, 0, 0, 0);
    const e = new Date(Number(withYear[6]), MON3.indexOf(withYear[4]), Number(withYear[5]));
    e.setHours(23, 59, 59, 999);
    return { from: s.getTime(), to: e.getTime() };
  }
  const inYear = label.match(/^(\w{3}) (\d+) → (\w{3}) (\d+)$/);
  if (inYear) {
    const y = now.getFullYear();
    const s = new Date(y, MON3.indexOf(inYear[1]), Number(inYear[2]));
    s.setHours(0, 0, 0, 0);
    const e = new Date(y, MON3.indexOf(inYear[3]), Number(inYear[4]));
    e.setHours(23, 59, 59, 999);
    return { from: s.getTime(), to: e.getTime() };
  }
  return null;
}
