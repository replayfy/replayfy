import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useElementWidth } from "@/hooks";
import type { ActivityData } from "../activity.query";

/* ============================================================================
   ActivityTrend — the Activity visualization, rebuilt as a trend-first chart.

   The story the eye should read in under two seconds is the TOTAL over time, so
   the total is a single smooth (monotone-cubic) line over a restrained area
   fill — growth, decline, spikes and drops are legible at a glance instead of
   being flattened into a wall of equal-weight columns.

   The breakdown is deliberately SECONDARY: every band's share sits in the
   legend, every band's value sits in the crosshair tooltip, and any band can be
   promoted to its own overlay line by clicking it — but nothing categorical
   competes with the trend by default. The comparison window is a quiet dashed
   line, the peak is ringed, and the latest bucket ("now") is anchored with a
   dot. Same ActivityData, same numbers — only the representation changed.

   Motion: the plot reveals left-to-right on a structure change (new range /
   granularity) via an animated clip; within a structure, paths morph to their
   new shape (~180ms ease-out). The crosshair tracks the cursor 1:1 with no
   transition; only its dot and the tooltip fade (120ms). All of it collapses
   to instant under prefers-reduced-motion.
   ========================================================================== */

const PLOT_H = 248;
const PAD_R = 46; // room for the right-aligned value ticks
const REVEAL = { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const };

type Props = {
  data: ActivityData;
  qhash: string;
  showPrev: boolean;
  /** The chart's own controls (the Filter button) — anchored in the toolbar. */
  toolbar?: ReactNode;
};

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Monotone-cubic path through points with strictly increasing x (Fritsch–
 *  Carlson tangents). Monotone, so the curve never overshoots below the
 *  baseline or above a local peak — essential for honest analytics. */
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${r1(pts[0].x)},${r1(pts[0].y)}`;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const t: number[] = new Array(n);
  t[0] = slope[0];
  t[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      t[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M${r1(pts[0].x)},${r1(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i].x + dx[i] / 3;
    const y1 = pts[i].y + (t[i] * dx[i]) / 3;
    const x2 = pts[i + 1].x - dx[i] / 3;
    const y2 = pts[i + 1].y - (t[i + 1] * dx[i]) / 3;
    d += `C${r1(x1)},${r1(y1)} ${r1(x2)},${r1(y2)} ${r1(pts[i + 1].x)},${r1(pts[i + 1].y)}`;
  }
  return d;
}

/** Crossfades when a rendered value changes — the resting numbers (axis ticks,
 *  meta line) never hard-swap on a filter change. */
function Num({ v, reduce }: { v: string; reduce: boolean }) {
  if (reduce) return <>{v}</>;
  return (
    <motion.span
      key={v}
      style={{ display: "inline-block" }}
      initial={{ opacity: 0, y: 3, filter: "blur(2px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: 0.16, ease: [0.23, 1, 0.32, 1] }}
    >
      {v}
    </motion.span>
  );
}

export function ActivityTrend({ data, qhash, showPrev, toolbar }: Props) {
  const [ref, W] = useElementWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  // Bands promoted to their own overlay line. Empty by default: the trend leads,
  // the breakdown is opt-in. (The former model HID bands from a stack; nothing
  // is hidden here — the total is always every band, so this only adds lines.)
  const [shown, setShown] = useState<Set<string>>(new Set());
  const reduce = !!useReducedMotion();
  const uid = useId().replace(/[:]/g, "");
  const gradId = `avg-${uid}`;

  const stackSig = data.stacks.map((s) => s.key).join("|");
  // New breakdown → new band keys; a stale overlay selection must not leak.
  useEffect(() => setShown(new Set()), [stackSig]);
  useEffect(() => setHi(null), [qhash]);

  const n = data.labels.length;
  const totals = data.totals;
  const prevOn = showPrev && data.prev.length === n && data.prev.some((v) => v > 0);
  const max = Math.max(1e-6, ...totals, ...(prevOn ? data.prev : [])) * 1.08;
  const allZero = totals.every((v) => v <= 0);

  const grandTotal = data.stacks.reduce((a, s) => a + s.total, 0);
  const peakIdx = Math.min(Math.max(0, data.peakIdx), Math.max(0, n - 1));

  const plotW = Math.max(0, W - PAD_R);
  const px = (i: number) => (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const py = (v: number) => (1 - v / max) * PLOT_H;

  // Structure key: the reveal replays only when the bucket grid itself changes
  // (new granularity / range), never on a filter tweak OR a resize. Width is
  // deliberately NOT keyed — the clip rect's animate={{width}} already tracks a
  // live resize without remounting, so keying width here would restart the wipe
  // on every pixel of a drag and clip the trend to nothing until it settled.
  const structKey = `${n}|${data.per}`;

  const geom = useMemo(() => {
    if (plotW <= 0 || n < 1) return null;
    const totalPts = totals.map((v, i) => ({ x: px(i), y: py(v) }));
    const line = monotonePath(totalPts);
    const area =
      n >= 2
        ? `${line}L${r1(px(n - 1))},${PLOT_H}L${r1(px(0))},${PLOT_H}Z`
        : "";
    const bands = data.stacks
      .filter((s) => shown.has(s.key))
      .map((s) => ({
        key: s.key,
        tone: s.tone,
        d: monotonePath(s.values.map((v, i) => ({ x: px(i), y: py(v) }))),
      }));
    const prev = prevOn ? monotonePath(data.prev.map((v, i) => ({ x: px(i), y: py(v) }))) : "";
    return { line, area, bands, prev };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, max, shown, plotW, n, prevOn]);

  const grid = [1, 2 / 3, 1 / 3]; // top → down; baseline drawn separately
  const xTickIdx = useMemo(() => {
    const count = Math.min(6, n);
    return Array.from({ length: count }, (_, k) =>
      Math.round((k * (n - 1)) / Math.max(1, count - 1)),
    );
  }, [n]);

  const toggle = (key: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    if (plotW <= 0 || n < 1) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const i = Math.min(n - 1, Math.max(0, Math.round((mx / plotW) * (n - 1))));
    setHi(i);
  };

  const hovered = hi != null && hi < n ? hi : null;
  // Smart flip: when the hovered point sits high on the plot, drop the tooltip
  // below it so it never clips off the top.
  const tipBelow = hovered != null && py(totals[hovered]) < PLOT_H * 0.42;

  return (
    <div className="av-wrap" ref={ref}>
      <div className="av-toolbar">
        {data.stacks.length > 1 && (
          <div className="av-legend" role="group" aria-label="Breakdown legend">
            {data.stacks.map((s) => {
              const on = shown.has(s.key);
              return (
                <button
                  key={s.key}
                  className={"av-leg" + (on ? " on" : "")}
                  onClick={() => toggle(s.key)}
                  title={on ? "Hide this line" : "Overlay this platform on the trend"}
                  aria-pressed={on}
                >
                  <span className={`av-dot av-t${s.tone}`} />
                  {s.label}
                  <span className="pc ox-num">
                    <Num
                      reduce={reduce}
                      v={grandTotal > 0 ? Math.round((s.total / grandTotal) * 100) + "%" : ""}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <span className="sp" />
        {toolbar}
      </div>

      <div
        className="av-plot"
        style={{ height: PLOT_H }}
        role="img"
        aria-label={
          n > 0
            ? `Activity trend — peak ${data.fmt(totals[peakIdx])} on ${data.labels[peakIdx]}`
            : "Activity trend — no data in this range"
        }
        onMouseMove={onMove}
        onMouseLeave={() => setHi(null)}
      >
        {grid.map((g, k) => (
          <div key={k}>
            <span className="av-grid" style={{ bottom: `${g * 100}%`, right: PAD_R }} />
            <span className="av-gval ox-num" style={{ bottom: `calc(${g * 100}% - 6px)` }}>
              <Num v={data.fmt(max * g)} reduce={reduce} />
            </span>
          </div>
        ))}
        <span className="av-grid base" style={{ right: PAD_R }} />

        {geom && !allZero && (
          <svg
            className="av-svg"
            width={plotW}
            height={PLOT_H}
            viewBox={`0 0 ${plotW} ${PLOT_H}`}
            preserveAspectRatio="none"
            shapeRendering="geometricPrecision"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.15" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* The area fades in and the total line draws left-to-right
                (pathLength). Both re-key on a STRUCTURE change so the reveal
                replays on a new range/granularity, but NOT on a resize
                (structKey carries no width) — so the reveal can never fight the
                resize-tracked geometry: a width change just reshapes the paths
                in place while the draw stays complete. */}
            {geom.area && (
              <motion.path
                key={`a-${structKey}`}
                className="av-area"
                d={geom.area}
                fill={`url(#${gradId})`}
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduce ? { duration: 0 } : { duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              />
            )}
            {geom.prev && <path className="av-ln prev" d={geom.prev} />}
            {geom.bands.map((b) => (
              <motion.path
                key={b.key}
                className={`av-ln band s${b.tone}`}
                d={b.d}
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduce ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}
            <motion.path
              key={`t-${structKey}`}
              className="av-ln total"
              d={geom.line}
              initial={reduce ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={reduce ? { duration: 0 } : REVEAL}
            />

            {/* Anchors drawn above the clip so they're always crisp/complete. */}
            {n >= 2 && peakIdx !== n - 1 && (
              <circle className="av-peak" cx={px(peakIdx)} cy={py(totals[peakIdx])} r="3.5" />
            )}
            {n >= 1 && (
              <circle className="av-now" cx={px(n - 1)} cy={py(totals[n - 1])} r="3" />
            )}

            {hovered != null && (
              <g className="av-cross" style={{ pointerEvents: "none" }}>
                <line x1={px(hovered)} x2={px(hovered)} y1="0" y2={PLOT_H} className="av-cx" />
                {geom.bands.map((b) => {
                  const s = data.stacks.find((x) => x.key === b.key)!;
                  return (
                    <circle
                      key={b.key}
                      className={`av-hd s${b.tone}`}
                      cx={px(hovered)}
                      cy={py(s.values[hovered])}
                      r="2.6"
                    />
                  );
                })}
                <circle className="av-hd total" cx={px(hovered)} cy={py(totals[hovered])} r="3.4" />
              </g>
            )}
          </svg>
        )}

        {allZero && (
          <div className="av-empty">No activity in this range</div>
        )}

        {xTickIdx.map((i, k) => (
          <span
            key={k}
            className="av-xlab"
            style={{
              left: Math.max(2, Math.min(plotW - 2, px(i))),
              transform:
                k === 0
                  ? "translateX(0)"
                  : k === xTickIdx.length - 1
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            <Num v={data.labels[i]} reduce={reduce} />
          </span>
        ))}

        {hovered != null && plotW > 0 && (
          <div
            className={"av-tip" + (tipBelow ? " below" : "")}
            style={{
              left: Math.max(112, Math.min(plotW - 112, px(hovered))),
              top: py(totals[hovered]) + (tipBelow ? 14 : -12),
            }}
          >
            <div className="d">{data.labels[hovered]}</div>
            {/* Per-DAY values: on a low-traffic day only the bands that were
                actually active that day carry a count — the rest are a genuine 0
                (the legend shows each band's WINDOW total, which is why they all
                appear there). In dimension mode, drop the "0 · 0%" rows so the
                tooltip lists only that day's active bands, not a wall of zeros. */}
            {data.stacks
              .filter((s) => data.stacks.length <= 1 || s.values[hovered] > 0)
              .map((s) => (
              <div className="r" key={s.key}>
                <span className={`sw av-t${s.tone}`} />
                <span className="k">{s.label}</span>
                <span className="v ox-num">
                  {data.fmt(s.values[hovered])}
                  {data.unit === "" && totals[hovered] > 0 && data.stacks.length > 1 && (
                    <i>{Math.round((s.values[hovered] / totals[hovered]) * 100)}%</i>
                  )}
                </span>
              </div>
            ))}
            {data.stacks.length > 1 && (
              <div className="r sum">
                <span className="sw none" />
                <span className="k">Total</span>
                <span className="v ox-num">{data.fmt(totals[hovered])}</span>
              </div>
            )}
            {prevOn && data.prev[hovered] > 0 && (
              <div className="r">
                <span className="sw none" />
                <span className="k">Previous</span>
                <span className="v prev ox-num">
                  {data.fmt(data.prev[hovered])}
                  <i className={totals[hovered] >= data.prev[hovered] === data.goodUp ? "up" : "down"}>
                    {totals[hovered] >= data.prev[hovered] ? "+" : "−"}
                    {Math.abs(((totals[hovered] - data.prev[hovered]) / data.prev[hovered]) * 100).toFixed(1)}%
                  </i>
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="av-meta">
        {n > 0 && (
          <span>
            Peak{" "}
            <b className="ox-num">
              <Num v={data.fmt(totals[peakIdx])} reduce={reduce} />
            </b>{" "}
            · <Num v={data.labels[peakIdx]} reduce={reduce} />
          </span>
        )}
        {prevOn && data.deltaPct !== 0 && (
          <span className={"av-delta " + (data.deltaPct >= 0 === data.goodUp ? "up" : "down")}>
            <Num v={`${data.deltaPct >= 0 ? "+" : "−"}${Math.abs(data.deltaPct)}% vs prev`} reduce={reduce} />
          </span>
        )}
        <span className="sp" />
        {data.unit === "" ? (
          <span>
            <b className="ox-num">
              <Num v={data.fmt(data.sum)} reduce={reduce} />
            </b>{" "}
            total ·{" "}
            <b className="ox-num">
              <Num v={data.fmt(data.avg)} reduce={reduce} />
            </b>{" "}
            / {data.per}
          </span>
        ) : (
          <span>
            <b className="ox-num">
              <Num v={data.fmt(data.avg)} reduce={reduce} />
            </b>{" "}
            average / {data.per}
          </span>
        )}
      </div>
    </div>
  );
}
