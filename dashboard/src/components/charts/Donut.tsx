export type DonutSegment = {
  v: number;
  color: string;
};

export type DonutProps = {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
};

/* ---------- Donut (platform share) ---------- */
export function Donut({ segments, size = 96, thickness = 13 }: DonutProps) {
  const r = (size - thickness) / 2, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth={thickness} />
      {segments.map((s, i) => {
        const len = (s.v / 100) * c, off = c - acc; acc += len;
        return <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
          strokeDasharray={`${len} ${c - len}`} strokeDashoffset={off} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="butt" />;
      })}
    </svg>
  );
}
