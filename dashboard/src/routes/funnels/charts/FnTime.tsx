import {
  type MouseEvent as ReactMouseEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type ApiFunnelTimelinePoint } from "../funnels.data";

type FnTimeProps = { points: ApiFunnelTimelinePoint[] | null };

/** "Conversion over time" tab — a real line chart over the daily-bucketed
 *  conversion series from POST /v1/funnels/timeline (no fixtures). Owns its
 *  smoothed-line + hover mechanics, scaled to the actual
 *  points and reads conversionPct/started/converted off each bucket. Stays
 *  inside the frozen `.fntrend` container/classNames. */
export function FnTime({ points }: FnTimeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  // The `.fntrend` ref container only mounts once `points` resolves to a
  // non-empty array (it sits below the loading/empty early returns). Key the
  // width measurement on that transition so the chart measures + paints the
  // first time it becomes visible — otherwise the effect runs once while the
  // ref is still null and W stays 0 until a tab round-trip remounts us.
  const hasChart = points != null && points.length > 0;
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => {
      const w = Math.round(e[0].contentRect.width);
      setW((p) => (Math.abs(p - w) < 1 ? p : w));
    });
    ro.observe(ref.current);
    setW(Math.round(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [hasChart]);

  if (points == null) {
    return (
      <div
        className="fn-viz-empty"
        style={{
          marginTop: "var(--sp-16)",
          padding: "var(--sp-40) var(--sp-24)",
          textAlign: "center",
          color: "var(--t3)",
          fontSize: "var(--text-sm)",
        }}
      >
        Computing conversion over time…
      </div>
    );
  }
  if (points.length === 0) {
    return (
      <div
        className="fn-viz-empty"
        style={{
          marginTop: "var(--sp-16)",
          padding: "var(--sp-40) var(--sp-24)",
          textAlign: "center",
          color: "var(--t3)",
          fontSize: "var(--text-sm)",
        }}
      >
        No conversion data for this window yet.
      </div>
    );
  }

  const cur = points.map((p) => p.conversionPct);
  const N = cur.length;
  const H = 300,
    pT = 26,
    pB = 30,
    pL = 8,
    pR = 46;
  // Pad the domain a touch above/below the observed range so the line breathes.
  const rawMax = Math.max(...cur, 1),
    rawMin = Math.min(...cur);
  const span = Math.max(1, rawMax - rawMin);
  const max = rawMax + span * 0.15,
    min = Math.max(0, rawMin - span * 0.15);
  const iW = Math.max(10, W - pL - pR),
    iH = H - pT - pB;
  const x = (i: number) => pL + (N <= 1 ? 0.5 : i / (N - 1)) * iW;
  const y = (v: number) => pT + (1 - (v - min) / (max - min || 1)) * iH;
  const sm = (arr: number[]) => {
    const p = arr.map((v, i) => [x(i), y(v)]);
    if (p.length === 1) return `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
    let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i],
        p1 = p[i],
        p2 = p[i + 1],
        p3 = p[i + 2] || p2;
      d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const avg = cur.reduce((a, b) => a + b, 0) / N;
  const hiIdx = cur.indexOf(Math.max(...cur)),
    loIdx = cur.indexOf(Math.min(...cur));
  const dates = points.map((p) =>
    new Date(p.ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  );
  // Gridlines at 5 evenly-spaced conversion levels across the padded domain.
  const grid = Array.from({ length: 5 }, (_, k) => min + (k / 4) * (max - min));
  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(
      Math.max(
        0,
        Math.min(N - 1, Math.round(((e.clientX - r.left - pL) / iW) * (N - 1))),
      ),
    );
  };
  const curLine = W ? sm(cur) : "";
  const xticks =
    N <= 1
      ? [0]
      : [0, Math.floor((N - 1) / 3), Math.floor((2 * (N - 1)) / 3), N - 1];

  return (
    <div className="fntrend" ref={ref} style={{ position: "relative" }}>
      {W > 0 && (
        <svg
          width={W}
          height={H}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            <linearGradient id="fntca" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.20" />
              <stop offset="0.7" stopColor="var(--accent)" stopOpacity="0.03" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <filter id="fntcsh" x="-5%" y="-40%" width="110%" height="200%">
              <feDropShadow
                dx="0"
                dy="2"
                stdDeviation="3"
                floodColor="var(--accent)"
                floodOpacity="0.22"
              />
            </filter>
          </defs>
          {grid.map((v) => (
            <g key={v}>
              <line
                x1={pL}
                y1={y(v)}
                x2={W - pR}
                y2={y(v)}
                stroke="var(--line)"
                strokeDasharray="1 7"
              />
              <text
                x={W - pR + 5}
                y={y(v) + 3}
                fontSize="10"
                fontFamily="var(--mono)"
                fill="var(--t4)"
              >
                {v.toFixed(0)}%
              </text>
            </g>
          ))}
          <line
            x1={pL}
            y1={y(avg)}
            x2={W - pR}
            y2={y(avg)}
            stroke="var(--t4)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.6"
          />
          <text
            x={pL + 2}
            y={y(avg) - 5}
            fontSize="9.5"
            fontFamily="var(--mono)"
            fill="var(--t3)"
          >
            avg {avg.toFixed(1)}%
          </text>
          {N > 1 && (
            <path
              d={`${curLine} L${x(N - 1).toFixed(1)},${H - pB} L${pL},${H - pB} Z`}
              fill="url(#fntca)"
              className="fade-area"
            />
          )}
          <path
            d={curLine}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.6"
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#fntcsh)"
            pathLength="1"
            className="draw-line"
          />
          {N > 1 &&
            (
              [
                ["▲", hiIdx, "var(--green)"],
                ["▼", loIdx, "var(--red)"],
              ] as [string, number, string][]
            ).map(([, idx, col]) => (
              <g key={idx}>
                <circle
                  cx={x(idx)}
                  cy={y(cur[idx])}
                  r="3.4"
                  fill={col}
                  stroke="#fff"
                  strokeWidth="1.4"
                />
                <text
                  x={x(idx)}
                  y={y(cur[idx]) - 11}
                  textAnchor="middle"
                  fontSize="9.5"
                  fontFamily="var(--mono)"
                  fontWeight="600"
                  fill={col}
                >
                  {cur[idx].toFixed(1)}%
                </text>
              </g>
            ))}
          {hover != null && (
            <>
              <line
                x1={x(hover)}
                y1={pT - 6}
                x2={x(hover)}
                y2={H - pB}
                stroke="var(--accent)"
                strokeWidth="1"
                opacity="0.35"
              />
              <circle
                cx={x(hover)}
                cy={y(cur[hover])}
                r="8"
                fill="var(--accent)"
                opacity="0.14"
              />
              <circle
                cx={x(hover)}
                cy={y(cur[hover])}
                r="4.2"
                fill="var(--accent)"
                stroke="#fff"
                strokeWidth="1.6"
              />
            </>
          )}
          {xticks.map((i, k) => (
            <text
              key={k}
              x={Math.max(pL + 12, Math.min(W - pR - 12, x(i)))}
              y={H - 8}
              fontSize="10"
              fontFamily="var(--mono)"
              fill="var(--t4)"
              textAnchor={
                k === 0 ? "start" : k === xticks.length - 1 ? "end" : "middle"
              }
            >
              {dates[i]}
            </text>
          ))}
        </svg>
      )}
      {hover != null && W > 0 && (
        <div
          className="fnt-tip"
          style={{ left: Math.max(70, Math.min(W - 70, x(hover))) }}
        >
          <div className="tt-date">{dates[hover]}</div>
          <div className="tt-row">
            <span className="tt-dot" style={{ background: "var(--accent)" }} />
            <span className="tt-k">Conversion</span>
            <span className="tt-v">{cur[hover].toFixed(1)}%</span>
          </div>
          <div className="tt-row">
            <span className="tt-dot" style={{ background: "transparent" }} />
            <span className="tt-k">Started</span>
            <span className="tt-v">
              {points[hover].started.toLocaleString("en-US")}
            </span>
          </div>
          <div className="tt-row">
            <span className="tt-dot" style={{ background: "transparent" }} />
            <span className="tt-k">Converted</span>
            <span className="tt-v">
              {points[hover].converted.toLocaleString("en-US")}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
