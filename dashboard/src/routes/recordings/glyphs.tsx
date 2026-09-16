/* ---- small presentational SVG glyphs / sparkline (verbatim from prototype) ---- */
import type { ReactNode } from "react";
import type { RvSession } from "./recordings.data";

const RV_PLAT: Record<string, string> = {
  web: "M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM2.7 8h10.6M8 2.5c1.6 1.5 1.6 9.5 0 11M8 2.5c-1.6 1.5-1.6 9.5 0 11",
  ios: "M8 4.2v7.6M4.2 8h7.6",
  android:
    "M4.5 6.5v4a.7.7 0 0 0 .7.7h5.6a.7.7 0 0 0 .7-.7v-4zM3 6.5v3.5M13 6.5v3.5M5 6.5c0-1.6 1.3-2.9 3-2.9s3 1.3 3 2.9",
  rn: "M8 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2M8 4.5c3.6 0 5.5 1.4 5.5 3.5S11.6 11.5 8 11.5 2.5 10.1 2.5 8 4.4 4.5 8 4.5",
};
export function RvGlyph({ p, size = 10 }: { p: string; size?: number }) {
  const d = RV_PLAT[p] || RV_PLAT.web;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d
        .split("M")
        .filter(Boolean)
        .map((s, i) => (
          <path key={i} d={"M" + s} />
        ))}
    </svg>
  );
}

/* frame-step glyph */
export function Step({ dir }: { dir: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor">
      {dir === "b" ? (
        <g>
          <rect x="2.4" y="3" width="1.6" height="8" rx="0.6" />
          <path d="M11.6 3 5.4 7l6.2 4z" />
        </g>
      ) : (
        <g>
          <path d="M2.4 3 8.6 7l-6.2 4z" />
          <rect x="10" y="3" width="1.6" height="8" rx="0.6" />
        </g>
      )}
    </svg>
  );
}

/* event-type glyphs (monochrome — type read through shape, not color) */
const EV_GLYPH: Record<string, string> = {
  nav: "M2.5 7h7.5M7 4 10 7l-3 3",
  pointer: "M3 2.4 11 6.2 6.9 7.3 5.6 11z",
  key: "M3 4.5h8v5H3zM5 7h.01M7 7h.01M9 7h.01",
  console: "M3 4 6 7l-3 3M7 10h4",
  network:
    "M4 2.5v6M4 8.5 2.3 6.8M4 8.5 5.7 6.8M10 11.5v-6M10 5.5 8.3 7.2M10 5.5 11.7 7.2",
  perf: "M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8M7 4.6V7l1.7 1",
  err: "M7 2.4 12.6 12H1.4zM7 6v2.7M7 10.3h.01",
  rage: "M7 2.5v2M7 9.5v2M2.5 7h2M9.5 7h2M3.8 3.8l1.4 1.4M8.8 8.8l1.4 1.4M10.2 3.8 8.8 5.2M5.2 8.8 3.8 10.2",
};
export function EvGlyph({ kind, flag }: { kind: string; flag?: string }) {
  const k =
    flag === "rage"
      ? "rage"
      : kind === "console" && flag === "err"
        ? "err"
        : kind;
  const d = EV_GLYPH[k] || EV_GLYPH.pointer;
  const fill = k === "pointer";
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d
        .split("M")
        .filter(Boolean)
        .map((s, i) => (
          <path key={i} d={"M" + s} />
        ))}
    </svg>
  );
}

/* investigation status: live (pulsing) / new (filled) / reviewed (hollow) */
export function RvStatus({ x }: { x: RvSession }) {
  const cls = x.live ? "live" : x.st === "new" ? "new" : "reviewed";
  const title = x.live
    ? "live now"
    : x.st === "new"
      ? "unreviewed"
      : x.st === "triaged"
        ? "triaged"
        : "reviewed";
  return (
    <span className={`rv-st ${cls}`} title={title}>
      <span className="d" />
    </span>
  );
}

/* ---- mini sparkline ---- */
export function RvSpark({
  data,
  color,
  fill,
  h = 30,
  max,
  grid,
}: {
  data: number[];
  color: string;
  fill?: boolean;
  h?: number;
  max?: number;
  grid?: boolean;
}) {
  const W = 100,
    mx = max ?? Math.max(...data);
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * W,
    h - 3 - (v / mx) * (h - 6),
  ]);
  const line = pts
    .map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1))
    .join(" ");
  const area = line + ` L${W} ${h} L0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">
      {grid &&
        [0.5].map((g) => (
          <line
            key={g}
            x1="0"
            x2={W}
            y1={h * g}
            y2={h * g}
            stroke="var(--rv-line-2)"
            strokeWidth="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      {fill && <path d={area} fill={color} opacity="0.07" />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* track row wrapper */
export function Track({
  label,
  color,
  children,
}: {
  label: ReactNode;
  color: string;
  children: ReactNode;
}) {
  return (
    <div className="rv-track">
      <span className="tlbl">
        <i style={{ background: color }} />
        {label}
      </span>
      <div className="rv-lane">{children}</div>
    </div>
  );
}
