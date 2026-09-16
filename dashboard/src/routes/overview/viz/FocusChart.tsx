import { useMemo, useState, type MouseEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useElementWidth } from "@/hooks";

/* ============================================================================
   FocusChart — the focused trend, drawn as a VOLUME-STYLE bar chart: thin bars
   grow from a baseline, horizontal gridlines carry right-aligned value ticks,
   releases tick along the top as dashed markers, and a light instrument tooltip
   anchors to the hovered bar. The comparison series (when on) draws as faint
   ghost bars behind. Bars grow in with a staggered scaleY on every metric /
   filter change.
   ========================================================================== */

export type ChartDeploy = { i: number; v: string };

type FocusChartProps = {
  /** Chart identity — includes any active filter, e.g. "Daily active · United States". */
  name: string;
  /** Label for the comparison trace, e.g. "Previous period" or a custom range. */
  compareLabel?: string;
  series: number[];
  prev: number[];
  labels: string[];
  deploys: ChartDeploy[];
  incident: number | null;
  showPrev: boolean;
  fmt: (v: number) => string;
  unit?: string;
  height?: number;
};

export function FocusChart({
  name,
  compareLabel = "Previous period",
  series,
  prev,
  labels,
  deploys,
  incident,
  showPrev,
  fmt,
  unit,
  height = 244,
}: FocusChartProps) {
  const [ref, W] = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const H = height,
    padL = 10,
    padR = 46, // room for the right-aligned value ticks
    padT = 24,
    padB = 26;
  const n = series.length;
  const iW = Math.max(10, W - padL - padR),
    iH = H - padT - padB;
  const baseline = padT + iH;

  // Volume bars grow from zero; headroom keeps the tallest bar off the ceiling.
  const all = showPrev ? series.concat(prev) : series;
  const mx = Math.max(1, ...all) * 1.12;

  const slot = iW / Math.max(1, n);
  const barW = Math.max(1.5, Math.min(slot * 0.6, 12));
  const barX = (i: number) => padL + i * slot + (slot - barW) / 2;
  const cx = (i: number) => padL + (i + 0.5) * slot; // bar centre (ticks/labels)
  const Y = (v: number) => padT + (1 - v / mx) * iH;
  const barH = (v: number) => Math.max(0, baseline - Y(v));

  const grid = [0, 0.5, 1];
  const xCount = 4;
  const xTicks = useMemo(
    () =>
      Array.from({ length: xCount }, (_, k) =>
        Math.round((k * (n - 1)) / (xCount - 1)),
      ),
    [n],
  );

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rc = e.currentTarget.getBoundingClientRect();
    setHi(
      Math.max(
        0,
        Math.min(n - 1, Math.floor((e.clientX - rc.left - padL) / slot)),
      ),
    );
  };

  const growT = (i: number) =>
    reduce
      ? { duration: 0 }
      : {
          duration: 0.5,
          ease: [0.23, 1, 0.32, 1] as const,
          delay: Math.min(i * 0.006, 0.4),
        };

  return (
    <div className="ox-chart" ref={ref} role="img" aria-label={`${name} trend`}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          onMouseMove={onMove}
          onMouseLeave={() => setHi(null)}
        >
          {/* horizontal grid + right-aligned value ticks */}
          {grid.map((g, k) => {
            const y = padT + g * iH,
              val = mx * (1 - g);
            return (
              <g key={k}>
                <line
                  x1={padL}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke={g === 1 ? "var(--line)" : "var(--line-2)"}
                />
                <text
                  className="ox-axis"
                  x={W - padR + 6}
                  y={y + 3}
                  textAnchor="start"
                >
                  {fmt(val)}
                </text>
              </g>
            );
          })}

          {/* release ticks */}
          {deploys.map((d) => (
            <g key={d.v}>
              <line
                x1={cx(d.i)}
                y1={padT - 3}
                x2={cx(d.i)}
                y2={baseline}
                stroke="var(--line-strong)"
                strokeDasharray="2 4"
              />
              <text
                className="ox-mk"
                x={cx(d.i)}
                y={padT - 9}
                textAnchor="middle"
              >
                {d.v}
              </text>
            </g>
          ))}

          {/* comparison ghost bars — behind the current series */}
          {showPrev && (
            <g key={"p_" + name + n}>
              {prev.map((v, i) => (
                <rect
                  key={i}
                  x={barX(i)}
                  y={Y(v)}
                  width={barW}
                  height={barH(v)}
                  rx={barW > 4 ? 1 : 0}
                  fill="var(--hue-slate)"
                  opacity="0.22"
                />
              ))}
            </g>
          )}

          {/* focused series — volume bars, grown in with a staggered scaleY */}
          <g key={name + n}>
            {series.map((v, i) => {
              const isIncident = incident === i;
              const isHot = hi === i;
              return (
                <motion.rect
                  key={i}
                  x={barX(i)}
                  y={Y(v)}
                  width={barW}
                  height={barH(v)}
                  rx={barW > 4 ? 1 : 0}
                  fill={isIncident ? "var(--red)" : "var(--accent)"}
                  opacity={isHot ? 1 : isIncident ? 0.9 : 0.62}
                  style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={growT(i)}
                />
              );
            })}
          </g>

          {/* crosshair marker on the hovered bar */}
          {hi != null && (
            <line
              x1={cx(hi)}
              y1={padT - 3}
              x2={cx(hi)}
              y2={baseline}
              stroke="var(--t3)"
              opacity="0.22"
            />
          )}

          {/* x labels */}
          {xTicks.map((i, k) => (
            <text
              key={k}
              className="ox-axis"
              x={Math.max(padL, Math.min(W - padR, cx(i)))}
              y={H - 6}
              textAnchor={
                k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"
              }
            >
              {labels[i]}
            </text>
          ))}
        </svg>
      )}
      {hi != null &&
        W > 0 &&
        (() => {
          const v = series[hi],
            p = prev[hi],
            dv = p ? ((v - p) / p) * 100 : 0;
          return (
            <div
              className="ox-tip"
              style={{
                left: Math.max(96, Math.min(W - 96, cx(hi))),
                top: Y(v),
              }}
            >
              <div className="d">
                {labels[hi]}
                {deploys.some((d) => d.i === hi)
                  ? ` · release ${deploys.find((d) => d.i === hi)!.v}`
                  : ""}
              </div>
              <div className="r">
                <span className="sw" style={{ background: "var(--accent)" }} />
                <span className="k">{name}</span>
                <span className="v">
                  {fmt(v)}
                  {unit === "%" ? "%" : ""}
                </span>
              </div>
              {showPrev && (
                <div className="r">
                  <span className="sw" style={{ background: "var(--t4)" }} />
                  <span className="k">{compareLabel}</span>
                  <span className="v" style={{ color: "var(--t2)" }}>
                    {fmt(p)}
                    {unit === "%" ? "%" : ""}
                  </span>
                </div>
              )}
              {showPrev && p > 0 && (
                <div className="r">
                  <span className="sw" style={{ background: "transparent" }} />
                  <span className="k">Change</span>
                  <span className={"v " + (dv >= 0 ? "up" : "down")}>
                    {dv >= 0 ? "+" : ""}
                    {dv.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
