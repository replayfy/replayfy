import { useState } from "react";
import { RCOLS } from "../overview.data";

/* ============================================================================
   DistBar — a segmented distribution band with its legend rows. Each row
   reads share-of-sessions and the absolute session count behind it.
   Hovering a row isolates its segment in the band. When `onOpen` is given the
   band + rows become a button that opens the full breakdown for the dimension,
   surfacing a "Click to show breakdown" hint on hover.
   ========================================================================== */

export type DistRow = {
  label: string;
  v: number;
  d: string;
  flag?: string;
  /** The raw filter value behind the label (ISO code for country, "web" for a
   *  humanised platform). Falls back to `label` when the two are the same. */
  raw?: string;
  /** Exact session count from the backend. The breakdown drawer shows this
   *  verbatim; the compact band still derives its count from share × total. */
  sessions?: number;
};

export function DistBar({
  title,
  rows,
  totalSessions,
  onOpen,
  onRowOpen,
}: {
  title: string;
  rows: DistRow[];
  totalSessions: number;
  /** Open the full breakdown for this dimension. Omit → band is inert. */
  onOpen?: () => void;
  /** Deep-link a single legend row (e.g. "web" → filtered recordings). When
   *  set, a row click calls this instead of the breakdown; the band still
   *  opens the breakdown. */
  onRowOpen?: (row: DistRow, i: number) => void;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const total = rows.reduce((a, r) => a + r.v, 0) || 100;
  const clickable = !!onOpen;
  const rowClickable = !!onRowOpen || !!onOpen;
  return (
    <div className="ox-dist">
      <div className="hd">
        {title}
        <span className="sp" />
      </div>
      <div
        className={"ox-dist-bandwrap" + (clickable ? " clickable" : "")}
        onClick={onOpen}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? `Show ${title} breakdown` : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen?.();
                }
              }
            : undefined
        }
      >
        <div
          className={"ox-dist-band" + (hi != null ? " dim" : "")}
          aria-hidden="true"
        >
          {rows.map((r, i) => (
            <i
              key={r.label}
              className={hi === i ? "on" : ""}
              style={{
                width: (r.v / total) * 100 + "%",
                background: RCOLS[i] || RCOLS[RCOLS.length - 1],
              }}
              onMouseEnter={() => setHi(i)}
              onMouseLeave={() => setHi(null)}
            />
          ))}
        </div>
        {clickable && (
          <span className="ox-dist-tip" aria-hidden="true">
            Click to show breakdown
          </span>
        )}
      </div>
      <div className="ox-dist-rows">
        {rows.map((r, i) => (
          <div
            className={"ox-dist-row" + (rowClickable ? " clickable" : "")}
            key={r.label}
            title={onRowOpen ? `Show ${r.label} recordings` : undefined}
            onMouseEnter={() => setHi(i)}
            onMouseLeave={() => setHi(null)}
            onClick={(e) => {
              if (onRowOpen) {
                e.stopPropagation();
                onRowOpen(r, i);
              } else {
                onOpen?.();
              }
            }}
          >
            <span
              className="sw"
              style={{ background: RCOLS[i] || RCOLS[RCOLS.length - 1] }}
            />
            <span className="n">
              {r.flag && <span className="flag">{r.flag}</span>}
              {r.label}
            </span>
            <span className="pc">{r.v}%</span>
            <span className="sess">
              {Math.round((totalSessions * r.v) / 100).toLocaleString()}{" "}
              sessions
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
