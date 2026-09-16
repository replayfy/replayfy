import { useState, type MouseEvent } from "react";
import { smoothPath, type Point } from "@/lib/format";
import { useElementWidth } from "@/hooks";

export type Spike = { i: number; label: string };

export type PerfChartProps = {
  p50: number[];
  p95: number[];
  incidentBand?: [number, number];
  deploy?: number | null;
  dates: string[];
  fmt?: (v: number) => string;
  names?: [string, string];
  deployLabel?: string;
  band?: boolean;
  prev?: number[];
  spike?: Spike;
};

/* ===========================================================================
   PerfChart — p50 / p95 latency, incident window band, deploy marker, crosshair
   =========================================================================== */
export function PerfChart({ p50, p95, incidentBand, deploy, dates, fmt, names = ['p95', 'p50'], deployLabel = '1.6.2', band, prev, spike }: PerfChartProps) {
  const [ref, W] = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const H = 250, padL = 8, padR = 42, padT = 26, padB = 26;
  const n = p95.length, iW = Math.max(10, W - padL - padR), iH = H - padT - padB;
  const mx = Math.max(...p95) * 1.16, mn = 0;
  const X = (i: number) => padL + (i / (n - 1)) * iW;
  const Y = (v: number) => padT + (1 - (v - mn) / (mx - mn)) * iH;
  const l95 = smoothPath(p95.map((v, i): Point => [X(i), Y(v)]));
  const l50 = smoothPath(p50.map((v, i): Point => [X(i), Y(v)]));
  const area95 = W ? `${l95} L${X(n - 1)},${padT + iH} L${X(0)},${padT + iH} Z` : '';
  const fmtMs = fmt || ((v: number) => v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms');
  // confidence band around p95 (±12%)
  const bandPath = (band && W) ? (() => {
    const up = p95.map((v, i): Point => [X(i), Y(v * 1.12)]);
    const lo = p95.map((v, i): Point => [X(i), Y(Math.max(0, v * 0.88))]);
    return smoothPath(up) + ' L' + lo.slice().reverse().map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') + ' Z';
  })() : null;
  const prevLine = (prev && W) ? smoothPath(prev.map((v, i): Point => [X(i), Y(v)])) : null;

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rc = e.currentTarget.getBoundingClientRect();
    setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rc.left) - padL) / iW * (n - 1)))));
  };
  return (
    <div className="term-chart" ref={ref} style={{ marginTop: 0 }}>
      {W > 0 && (
        <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
          <defs>
            <linearGradient id="perfg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--red)" stopOpacity="0.15" /><stop offset="1" stopColor="var(--red)" stopOpacity="0" />
            </linearGradient>
            <filter id="perfsh" x="-8%" y="-40%" width="116%" height="200%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" floodColor="var(--red)" floodOpacity="0.2" /></filter>
          </defs>
          {[0, 0.5, 1].map((g, k) => {
            const y = padT + g * iH;
            return <g key={k}><line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--line)" strokeDasharray="1 6" />
              <text className="term-axis" x={W - padR + 3} y={y + 3}>{fmtMs(mx - g * (mx - mn))}</text></g>;
          })}
          {/* incident window */}
          {incidentBand && <rect x={X(incidentBand[0])} y={padT} width={X(incidentBand[1]) - X(incidentBand[0])} height={iH} fill="var(--red)" opacity="0.06" />}
          {incidentBand && <text className="term-mk-lab" x={(X(incidentBand[0]) + X(incidentBand[1])) / 2} y={padT + 10} textAnchor="middle" style={{ fill: 'var(--red)', opacity: .7 }}>incident</text>}
          {deploy != null && <g><line x1={X(deploy)} y1={padT - 4} x2={X(deploy)} y2={padT + iH} stroke="var(--line-strong)" strokeDasharray="3 3" /><text className="term-mk-lab" x={X(deploy)} y={padT - 7} textAnchor="middle">{deployLabel}</text></g>}
          {/* confidence band */}
          {bandPath && <path d={bandPath} fill="var(--red)" opacity="0.07" />}
          <path d={area95} fill="url(#perfg)" />
          {/* previous-period comparison */}
          {prevLine && <path d={prevLine} fill="none" stroke="var(--t4)" strokeWidth="1.4" strokeDasharray="4 4" opacity="0.85" />}
          <path d={l50} fill="none" stroke="var(--t3)" strokeWidth="1.6" strokeLinejoin="round" pathLength="1" className="draw-line" />
          <path d={l95} fill="none" stroke="var(--red)" strokeWidth="2.3" strokeLinejoin="round" filter="url(#perfsh)" pathLength="1" className="draw-line d2" />
          {/* spike anomaly marker */}
          {spike && <g>
            <circle cx={X(spike.i)} cy={Y(p95[spike.i])} r="10" fill="var(--red)" opacity="0.12" />
            <circle cx={X(spike.i)} cy={Y(p95[spike.i])} r="4.5" fill="var(--red)" stroke="#fff" strokeWidth="1.5" />
          </g>}
          {hi != null && <g>
            <line x1={X(hi)} y1={padT - 4} x2={X(hi)} y2={padT + iH} stroke="var(--t3)" opacity="0.35" />
            <circle cx={X(hi)} cy={Y(p95[hi])} r="3.7" fill="var(--red)" stroke="#fff" strokeWidth="1.4" />
            <circle cx={X(hi)} cy={Y(p50[hi])} r="3" fill="var(--t3)" stroke="#fff" strokeWidth="1.4" />
          </g>}
          {/* x labels */}
          {[0, Math.floor((n - 1) / 2), n - 1].map((i, k) => (
            <text key={k} className="term-axis" x={Math.max(padL + 10, Math.min(W - padR - 10, X(i)))} y={H - 7}
              textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>{dates[i]}</text>
          ))}
        </svg>
      )}
      {spike && W > 0 && hi == null && (
        <div className="perf-annot" style={{ right: Math.max(6, W - X(spike.i) + 12), top: Y(p95[spike.i]) - 4 }}>
          <span className="pa-dot" />{spike.label}
        </div>
      )}
      {hi != null && W > 0 && (() => {
        const dv = prev ? ((p95[hi] - prev[hi]) / prev[hi]) * 100 : null;
        return (
          <div className="term-tip" style={{ left: Math.max(70, Math.min(W - 70, X(hi))) }}>
            <div className="tt-date">{dates[hi]}{hi === deploy ? ' · deploy ' + deployLabel : ''}</div>
            <div className="tt-row"><span className="tt-dot" style={{ background: 'var(--red)' }} /><span className="tt-k">{names[0]}</span><span className="tt-v">{fmtMs(p95[hi])}</span></div>
            <div className="tt-row"><span className="tt-dot" style={{ background: 'var(--t3)' }} /><span className="tt-k">{names[1]}</span><span className="tt-v">{fmtMs(p50[hi])}</span></div>
            {dv != null && <div className="tt-row"><span className="tt-dot" style={{ background: 'transparent' }} /><span className="tt-k">vs prev</span><span className="tt-v" style={{ color: dv >= 0 ? '#e79aa8' : '#7fd0a3' }}>{dv >= 0 ? '+' : ''}{dv.toFixed(0)}%</span></div>}
          </div>
        );
      })()}
    </div>
  );
}
