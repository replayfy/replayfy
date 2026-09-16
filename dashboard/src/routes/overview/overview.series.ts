/* ============================================================================
   overview.series.ts — deterministic series generators + granularity config
   for Overview V3. Story: Health → Engagement → Signals → Conversion →
   Crashlytics → Platform → Ask Loop.  Design-only, mock data.
   ========================================================================== */

export type Granularity = "day" | "week" | "month" | "hours";

export type MetricDef = {
  key: string;
  label: string;
  sub: string;
  color: string;
  unit: string;
  display: string;
  delta: string;
  dir: "up" | "down";
  lo: number;
  hi: number;
  curve: (t: number) => number;
  seed: number;
};

export type MaterializedMetric = MetricDef & {
  series: number[];
  prev: number[];
  fmt: (v: number) => string;
};

/* ---- deterministic series generator ------------------------------------ */
export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
export function mkSeries(
  n: number,
  lo: number,
  hi: number,
  curve: (t: number) => number,
  seed: number,
  noise: number,
) {
  const rnd = lcg(seed),
    out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    out.push((lo + (hi - lo) * curve(t)) * (1 + (rnd() - 0.5) * noise));
  }
  return out;
}
/* date label helpers (anchored to Jun 25 2026) */
export const ANCHOR = new Date(2026, 5, 25);
export function dayLabels(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ANCHOR);
    d.setDate(d.getDate() - (n - 1 - i));
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
}
export function weekLabels(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ANCHOR);
    d.setDate(d.getDate() - (n - 1 - i) * 7);
    return (
      "w/" + d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    );
  });
}
export function monthLabels(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ANCHOR);
    d.setMonth(d.getMonth() - (n - 1 - i));
    return d.toLocaleDateString("en-US", { month: "short" });
  });
}

export const RISE = (t: number) => Math.pow(t, 0.9);
export const STEADY = (t: number) => 0.2 + 0.8 * t;
export const SWELL = (t: number) => Math.pow(t, 0.75);
export const LATE = (t: number) => Math.min(1, t * 1.12);
export const dcol = (s: string) =>
  String(s).startsWith("+")
    ? "var(--green)"
    : String(s).startsWith("−")
      ? "var(--red)"
      : "var(--t4)";

export function hourLabels(): string[] {
  return Array.from({ length: 24 }, (_, h) =>
    h === 0 ? "12am" : h < 12 ? h + "am" : h === 12 ? "12pm" : h - 12 + "pm",
  );
}
export const GRAN: Record<
  Granularity,
  { n: number; noise: number; labels: string[] }
> = {
  day: { n: 30, noise: 0.05, labels: dayLabels(30) },
  week: { n: 12, noise: 0.03, labels: weekLabels(12) },
  month: { n: 12, noise: 0.02, labels: monthLabels(12) },
  hours: { n: 24, noise: 0.07, labels: hourLabels() },
};
export const DEPLOYS: Record<Granularity, { i: number; v: string }[]> = {
  day: [
    { i: 8, v: "1.6.0" },
    { i: 16, v: "1.6.1" },
    { i: 24, v: "1.6.2" },
  ],
  week: [
    { i: 6, v: "1.6.1" },
    { i: 10, v: "1.6.2" },
  ],
  month: [{ i: 9, v: "1.6" }],
  hours: [],
};
export const INCIDENT: Record<Granularity, number | null> = {
  day: 25,
  week: 10,
  month: 11,
  hours: null,
};
/** Diurnal activity shape for the hours-of-day view — quiet nights, a late-
 *  morning shoulder and an evening peak (t is hour/23). */
export const DIURNAL = (t: number) => {
  const h = t * 23;
  const morning = Math.exp(-Math.pow(h - 10.5, 2) / 14);
  const evening = Math.exp(-Math.pow(h - 19.5, 2) / 9);
  return 0.08 + 0.55 * morning + 0.9 * evening;
};

export function fmtCount(v: number) {
  return v >= 1000
    ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k"
    : Math.round(v).toLocaleString();
}
export function materialize(
  def: MetricDef,
  gran: Granularity,
): MaterializedMetric {
  const g = GRAN[gran];
  const dFrac = def.unit === "%" ? 0 : parseFloat(def.delta) / 100;
  // Hours view: the diurnal histogram of a typical day in the range — volumes
  // become per-hour (scaled down); rate metrics keep their own scale.
  const hourly = gran === "hours";
  const lo = hourly && def.unit !== "%" ? def.lo / 24 : def.lo;
  const hi = hourly && def.unit !== "%" ? def.hi / 9 : def.hi;
  const series = mkSeries(
    g.n,
    lo,
    hi,
    hourly ? DIURNAL : def.curve,
    def.seed,
    g.noise,
  );
  const prev =
    def.unit === "%"
      ? series.map((v, i) => v - 3.1 * (0.9 + 0.2 * (i / g.n)))
      : series.map((v) => v / (1 + dFrac));
  return {
    ...def,
    series,
    prev,
    fmt: def.unit === "%" ? (v: number) => v.toFixed(1) : fmtCount,
  };
}
