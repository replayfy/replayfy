import { smoothPath, type Point } from "@/lib/format";

/* ============================================================================
   Spark — the small-multiple trace. Draws in currentColor so the parent
   controls state (rest: gray, focused: accent). Terminal dot marks "now".
   ========================================================================== */
export function Spark({
  data,
  w = 104,
  h = 26,
}: {
  data: number[];
  w?: number;
  h?: number;
}) {
  if (data.length < 2) return <svg width={w} height={h} />;
  const mn = Math.min(...data),
    mx = Math.max(...data),
    r = mx - mn || 1;
  const pts = data.map(
    (v, i): Point => [
      1 + (i / (data.length - 1)) * (w - 5),
      h - 2.5 - ((v - mn) / r) * (h - 5),
    ],
  );
  const last = pts[pts.length - 1];
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={smoothPath(pts)}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.2" fill="currentColor" />
    </svg>
  );
}
