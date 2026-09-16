import { useState } from "react";
import { useElementWidth } from "@/hooks";

/* ============================================================================
   DayBars — stability as a density strip: one flat bar per day, the incident
   window carried by color alone. Hovering a day reads out every tracked
   signal (crashes, rage taps, console errors, ANRs) in the shared tooltip.
   ========================================================================== */

export type DaySeries = { name: string; color: string; data: number[] };

type DayBarsProps = {
  primary: DaySeries; // drawn as bars
  secondary: DaySeries[]; // read out on hover
  labels: string[];
  incident?: [number, number]; // inclusive day range
  deploys?: { i: number; v: string }[];
  height?: number;
};

export function DayBars({
  primary,
  secondary,
  labels,
  incident,
  deploys = [],
  height = 148,
}: DayBarsProps) {
  const [ref, W] = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const H = height,
    padL = 42,
    padR = 8,
    padT = 24,
    padB = 24;
  const n = primary.data.length;
  const iW = Math.max(10, W - padL - padR),
    iH = H - padT - padB;
  const mx = Math.max(...primary.data) * 1.08 || 1;
  const slot = iW / n;
  const bw = Math.max(3, Math.min(14, slot - 3));
  const Xc = (i: number) => padL + slot * (i + 0.5);
  const Yv = (v: number) => padT + (1 - v / mx) * iH;
  const inIncident = (i: number) =>
    incident != null && i >= incident[0] && i <= incident[1];
  const xTicks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <div
      className="ox-chart"
      ref={ref}
      role="img"
      aria-label={`${primary.name} per day`}
    >
      {W > 0 && (
        <svg width={W} height={H} onMouseLeave={() => setHi(null)}>
          {[0, 0.5, 1].map((g, k) => {
            const y = padT + g * iH;
            return (
              <g key={k}>
                <line
                  x1={padL}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke={g === 1 ? "var(--line)" : "var(--line-2)"}
                />
                <text className="ox-axis" x={0} y={y + 3}>
                  {Math.round(mx - g * mx)}
                </text>
              </g>
            );
          })}
          {deploys.map((d) => (
            <g key={d.v}>
              <line
                x1={Xc(d.i)}
                y1={padT - 3}
                x2={Xc(d.i)}
                y2={padT + iH}
                stroke="var(--line-strong)"
                strokeDasharray="2 4"
              />
              <text
                className="ox-mk"
                x={Xc(d.i)}
                y={padT - 9}
                textAnchor="middle"
              >
                {d.v}
              </text>
            </g>
          ))}
          {primary.data.map((v, i) => (
            <rect
              key={i}
              x={Xc(i) - bw / 2}
              y={Yv(v)}
              width={bw}
              height={Math.max(1.5, padT + iH - Yv(v))}
              rx={1.5}
              fill={inIncident(i) ? "var(--red)" : "var(--t4)"}
              opacity={hi === i ? 1 : inIncident(i) ? 0.72 : 0.5}
              onMouseEnter={() => setHi(i)}
              style={{ transition: "opacity .1s" }}
            />
          ))}
          {/* wide hover targets */}
          {primary.data.map((_, i) => (
            <rect
              key={"h" + i}
              x={padL + slot * i}
              y={padT - 3}
              width={slot}
              height={iH + 3}
              fill="transparent"
              onMouseEnter={() => setHi(i)}
            />
          ))}
          {xTicks.map((i, k) => (
            <text
              key={k}
              className="ox-axis"
              x={Math.max(padL, Math.min(W - padR, Xc(i)))}
              y={H - 5}
              textAnchor={
                k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"
              }
            >
              {labels[i]}
            </text>
          ))}
        </svg>
      )}
      {hi != null && W > 0 && (
        <div
          className="ox-tip dark"
          style={{ left: Math.max(88, Math.min(W - 88, Xc(hi))) }}
        >
          <div className="d">
            {labels[hi]}
            {inIncident(hi) ? " · incident window" : ""}
            {deploys.some((d) => d.i === hi)
              ? ` · release ${deploys.find((d) => d.i === hi)!.v}`
              : ""}
          </div>
          <div className="r">
            <span
              className="sw"
              style={{ background: inIncident(hi) ? "var(--red)" : "#9aa0a8" }}
            />
            <span className="k">{primary.name}</span>
            <span className="v">{Math.round(primary.data[hi])}</span>
          </div>
          {secondary.map((s) => (
            <div className="r" key={s.name}>
              <span className="sw" style={{ background: s.color }} />
              <span className="k">{s.name}</span>
              <span className="v">{Math.round(s.data[hi])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
