export type Point = readonly [number, number];

/** Catmull-Rom → cubic-bezier smooth path through points [[x,y], …]. */
export function smoothPath(pts: ReadonlyArray<Point>): string {
  if (!pts.length) return "";
  if (pts.length < 3) return "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L");
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

/** Compact number: 1234 → "1.2k", 3_400_000 → "3.4M", else grouped. */
export function fmtN(n: number, digits = 1): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return trim((n / 1e6).toFixed(digits)) + "M";
  if (abs >= 1e3) return trim((n / 1e3).toFixed(digits)) + "k";
  return n.toLocaleString("en-US");
}

/** 0.3076 → "30.8%" */
export function fmtPct(ratio: number, digits = 1): string {
  return (ratio * 100).toFixed(digits) + "%";
}

function trim(s: string): string {
  return s.replace(/\.0+$/, "");
}

/** ISO timestamp → "just now" / "8m ago" / "3h ago" / "2d ago". */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
