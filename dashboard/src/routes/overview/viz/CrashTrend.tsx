import { useState } from "react";
import { useElementWidth } from "@/hooks";

/* ============================================================================
   CrashTrend — the Crashlytics trend as a STACKED-by-category density chart.
   One bar per day, summed to the header's own events number and split into the
   four category colours (crashes · exceptions · freezes · errors), over a faint
   crash-red baseline wash. A vertical crosshair + dark tooltip read out every
   category (and the day's total) on hover; the latest day is emphasised with its
   printed total; release first-seen days are pinned as dashed markers.

   Sibling to DayBars (Overview's density strip) — kept separate so this richer,
   colour-encoded chart can't regress the homepage strip. Reuses the shared
   .ox-chart / .ox-axis / .ox-mk / .ox-tip.dark styles (overview-v4.css); no new
   stylesheet. Fed by the metric-row sparks already fetched on the page, so it
   adds NO crash query of its own.
   ========================================================================== */

export type TrendCat = { name: string; color: string; data: number[] };

type CrashTrendProps = {
  /** Category series in stack order, base → top (severity-first). */
  cats: TrendCat[];
  labels: string[];
  deploys?: { i: number; v: string }[];
  height?: number;
};

export function CrashTrend({
  cats,
  labels,
  deploys = [],
  height = 196,
}: CrashTrendProps) {
  const [ref, W] = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const H = height,
    padL = 42,
    padR = 8,
    padT = 24,
    padB = 24;
  const n = labels.length;
  const iW = Math.max(10, W - padL - padR),
    iH = H - padT - padB;
  // Stacked total per day drives the y-scale — a 1-crash day and a 400-crash day
  // read differently in height AND colour mix, not one lone gray bar.
  const totals = labels.map((_, i) =>
    cats.reduce((s, c) => s + (c.data[i] || 0), 0),
  );
  const mx = Math.max(...totals) * 1.08 || 1;
  const slot = iW / Math.max(1, n);
  const bw = Math.max(3, Math.min(14, slot - 3));
  const Xc = (i: number) => padL + slot * (i + 0.5);
  const base = padT + iH; // baseline (value 0)
  const Yv = (v: number) => padT + (1 - v / mx) * iH; // y of a value from 0
  const px = (v: number) => (v / mx) * iH; // pixel height of value v
  const xTicks = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <div
      className="ox-chart"
      ref={ref}
      role="img"
      aria-label="Crashes per day by category"
    >
      {W > 0 && (
        <svg width={W} height={H} onMouseLeave={() => setHi(null)}>
          <defs>
            <linearGradient id="cr2-wash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--red)" stopOpacity="0.06" />
              <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* faint baseline wash — empty days read as a surface, not blank paper */}
          <rect
            x={padL}
            y={padT}
            width={Math.max(0, W - padL - padR)}
            height={iH}
            fill="url(#cr2-wash)"
          />
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
                y2={base}
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
          {/* stacked category bars — one per day, severity base → top */}
          {labels.map((_, i) => {
            let topCat = -1;
            for (let c = 0; c < cats.length; c++)
              if ((cats[c].data[i] || 0) > 0) topCat = c;
            let acc = 0;
            return (
              <g
                key={i}
                opacity={hi === null || hi === i ? 1 : 0.5}
                style={{ transition: "opacity .1s" }}
              >
                {cats.map((c, ci) => {
                  const v = c.data[i] || 0;
                  if (v <= 0) return null;
                  const h = Math.max(1, px(v));
                  const y = base - px(acc) - h;
                  acc += v;
                  return (
                    <rect
                      key={ci}
                      x={Xc(i) - bw / 2}
                      y={y}
                      width={bw}
                      height={h}
                      fill={c.color}
                      rx={ci === topCat ? 2 : 0}
                      opacity={0.92}
                    />
                  );
                })}
              </g>
            );
          })}
          {/* emphasised latest day — its total printed above the bar */}
          {n > 0 && totals[n - 1] > 0 && (
            <text
              className="ox-mk"
              x={Xc(n - 1)}
              y={Yv(totals[n - 1]) - 6}
              textAnchor="middle"
              style={{ fill: "var(--red)" }}
            >
              {Math.round(totals[n - 1])}
            </text>
          )}
          {/* wide hover targets */}
          {labels.map((_, i) => (
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
          {hi != null && (
            <line
              x1={Xc(hi)}
              y1={padT - 3}
              x2={Xc(hi)}
              y2={base}
              stroke="var(--line-strong)"
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}
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
            {deploys.some((d) => d.i === hi)
              ? ` · release ${deploys.find((d) => d.i === hi)!.v}`
              : ""}
          </div>
          {cats.map((c) => (
            <div className="r" key={c.name}>
              <span className="sw" style={{ background: c.color }} />
              <span className="k">{c.name}</span>
              <span className="v">{Math.round(c.data[hi] || 0)}</span>
            </div>
          ))}
          <div
            className="r"
            style={{
              marginTop: 6,
              paddingTop: 6,
              borderTop: "1px solid rgba(255,255,255,.08)",
            }}
          >
            <span className="sw" style={{ background: "transparent" }} />
            <span className="k">Total</span>
            <span className="v">{Math.round(totals[hi])}</span>
          </div>
        </div>
      )}
    </div>
  );
}
