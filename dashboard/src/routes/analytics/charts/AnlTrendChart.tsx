import { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltChart, ChartType } from "../analytics.data";
import { fmtVal, fmtN } from "../analytics.data";

/* ============================================================================
   AnlTrendChart — the Analytics time-series canvas (line / area / bar).

   Hand-rolled SVG in the app's viz idiom (see overview/viz/ActivityTrend): a
   measured-width responsive chart with nice-rounded y gridlines, smoothed
   (cardinal) line paths, per-series area gradients, grouped bars, and a shared
   crosshair tooltip. `number` mode is handled by the parent, not here.
   ========================================================================== */

type Props = {
  chart: BuiltChart;
  type: Exclude<ChartType, "number">;
  hidden: Set<string>;
  showPrev: boolean;
};

const H = 360;
const PAD = { l: 46, r: 14, t: 16, b: 30 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  // Finer ladder so a peak like 1.05k rounds to 1.2k (not 2k) — bars/lines fill
  // the plot instead of leaving ~half the height empty above the data.
  const step =
    n <= 1 ? 1 : n <= 1.2 ? 1.2 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 8 ? 8 : 10;
  return step * p;
}

/** Cardinal spline through points → a smooth cubic path. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

export function AnlTrendChart({ chart, type, hidden, showPrev }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vis = useMemo(() => chart.series.filter((s) => !hidden.has(s.key)), [chart.series, hidden]);
  const n = chart.labels.length;
  const plotW = Math.max(10, w - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;

  const yMax = useMemo(() => {
    let m = 0;
    for (const s of vis) for (const v of s.values) if (v > m) m = v;
    if (showPrev && chart.prev) for (const v of chart.prev) if (v > m) m = v;
    return niceMax(m * 1.08);
  }, [vis, showPrev, chart.prev]);

  const xFor = (i: number) => PAD.l + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yFor = (v: number) => PAD.t + plotH * (1 - v / yMax);
  const bandX = (i: number) => PAD.l + (plotW * i) / n; // left edge of a bar band

  const gridSteps = 4;
  const grid = Array.from({ length: gridSteps + 1 }, (_, i) => (yMax * i) / gridSteps);
  const tickEvery = Math.max(1, Math.ceil(n / 7));

  const isBar = type === "bar";

  return (
    <div className="anl-chart-wrap" ref={wrapRef}>
      <svg className="anl-svg" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Trend chart">
        <defs>
          {vis.map((s) => (
            <linearGradient key={s.key} id={`anlg-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.45} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.14} />
            </linearGradient>
          ))}
        </defs>

        {/* y gridlines + labels */}
        {grid.map((g, i) => (
          <g key={i}>
            <line className="anl-grid-line" x1={PAD.l} y1={yFor(g)} x2={w - PAD.r} y2={yFor(g)} />
            <text className="anl-grid-lbl" x={PAD.l - 8} y={yFor(g) + 3} textAnchor="end">{fmtN(g)}</text>
          </g>
        ))}

        {/* x labels */}
        {chart.labels.map((lb, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text key={i} className="anl-x-lbl" x={isBar ? bandX(i) + plotW / n / 2 : xFor(i)} y={H - 9} textAnchor="middle">{lb}</text>
          ) : null,
        )}

        {/* previous-period reference (compare) */}
        {showPrev && chart.prev && !isBar && (
          <path className="anl-prev" d={smoothPath(chart.prev.map((v, i) => ({ x: xFor(i), y: yFor(v) })))} />
        )}

        {/* series */}
        {isBar
          ? vis.map((s, si) => {
              const bw = (plotW / n) * 0.72;
              const each = bw / Math.max(1, vis.length);
              return (
                <g key={s.key}>
                  {s.values.map((v, i) => {
                    const x = bandX(i) + (plotW / n - bw) / 2 + si * each;
                    const y = yFor(v);
                    return <rect key={i} className="anl-bar" x={x} y={y} width={Math.max(1, each - 1)} height={Math.max(0, yFor(0) - y)} fill={s.color} style={{ animationDelay: `${i * 8}ms` }} />;
                  })}
                </g>
              );
            })
          : vis.map((s) => {
              const pts = s.values.map((v, i) => ({ x: xFor(i), y: yFor(v) }));
              const d = smoothPath(pts);
              return (
                <g key={s.key}>
                  {type === "area" && <path className="anl-area" d={`${d} L${xFor(n - 1)},${yFor(0)} L${xFor(0)},${yFor(0)} Z`} fill={`url(#anlg-${s.key})`} />}
                  <path className="anl-line" d={d} stroke={s.color} pathLength={1} />
                  {/* emphasized endpoint — the "now" value reads at a glance */}
                  {n > 0 && hover == null && <circle className="anl-endpt" cx={xFor(n - 1)} cy={yFor(s.values[n - 1])} r={3.4} fill={s.color} />}
                </g>
              );
            })}

        {/* crosshair + hover dots */}
        {hover != null && !isBar && (
          <g>
            <line className="anl-cross" x1={xFor(hover)} y1={PAD.t} x2={xFor(hover)} y2={PAD.t + plotH} />
            {vis.map((s) => (
              <circle key={s.key} className="anl-dot-pt" cx={xFor(hover)} cy={yFor(s.values[hover])} r={3.5} stroke={s.color} />
            ))}
          </g>
        )}

        {/* hover capture */}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={plotW}
          height={plotH}
          fill="transparent"
          onMouseMove={(e) => {
            const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const rel = ((e.clientX - rect.left) * (w / rect.width) - PAD.l) / plotW;
            setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
          }}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {hover != null && (
        <div
          className="anl-tip"
          style={{ left: Math.min(Math.max(xFor(hover), 70), w - 70) }}
        >
          <div className="anl-tip-h">{chart.labels[hover]}</div>
          {vis.map((s) => (
            <div key={s.key} className="anl-tip-row">
              <span className="anl-tip-dot" style={{ background: s.color }} />
              <span className="anl-tip-lbl">{s.label}</span>
              <span className="anl-tip-val">{fmtVal(s.values[hover], chart.kind)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
