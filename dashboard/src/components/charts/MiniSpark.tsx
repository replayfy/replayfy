import { smoothPath, type Point } from "@/lib/format";

export type MiniSparkProps = {
  // null entries are days with no data — drawn as GAPS, not as a value. Plain
  // number[] callers are unaffected (number[] is assignable here).
  data: Array<number | null>;
  color: string;
  w?: number;
  h?: number;
};

/* ---------- MiniSpark (rail sparkline) ---------- */
export function MiniSpark({ data, color, w = 54, h = 22 }: MiniSparkProps) {
  const nums = data.filter((v): v is number => v != null);
  const frame = (
    <svg className="tm-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" />
  );
  // Nothing measurable → an empty frame, never a flat fake line at some baseline.
  if (nums.length === 0) return frame;
  const mn = Math.min(...nums), mx = Math.max(...nums), r = (mx - mn) || 1;
  const denom = data.length > 1 ? data.length - 1 : 1;
  const y = (v: number) => h - 2 - ((v - mn) / r) * (h - 4);
  // Break the line at null days rather than interpolating through them: each
  // contiguous run of real points is its own stroke, so a gap reads as a gap.
  const segments: Point[][] = [];
  let cur: Point[] = [];
  data.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segments.push(cur);
      cur = [];
      return;
    }
    cur.push([(i / denom) * w, y(v)]);
  });
  if (cur.length) segments.push(cur);
  return (
    <svg className="tm-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none">
      {segments.map((seg, i) => (
        <path
          key={i}
          d={smoothPath(seg)}
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
