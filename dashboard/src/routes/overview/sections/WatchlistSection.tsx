import { Icon } from "@/components/primitives";
import type { Worst } from "../overview.data";
import { SkWatchRows } from "./OverviewSkeletons";

/* ============================================================================
   WatchlistSection — the sessions most worth replaying. Each row: who
   (avatar + identity + surface), what went wrong (severity-toned chips),
   how bad (score + meter — low is bad), and a "Watch replay" affordance
   that surfaces on hover. Rows open the replay directly.
   ========================================================================== */

export type WatchRow = Worst & { id?: string; initials?: string };

type WatchlistSectionProps = {
  rows: WatchRow[];
  /** The current window, e.g. "last 30 days". */
  windowLabel: string;
  /** /overview hasn't landed. The heading names the window (which the header
   *  already knows) — only the sessions themselves are unknown, so only the
   *  rows stand in. */
  loading?: boolean;
  onRow: (r: WatchRow) => void;
  onAll: () => void;
};

function initialsOf(r: WatchRow): string | null {
  if (r.initials) return r.initials.slice(0, 2).toUpperCase();
  if (!r.n || /^anonymous$/i.test(r.n)) return null;
  const base = r.n.includes("@") ? r.n.split("@")[0] : r.n;
  const parts = base.split(/[.\s_-]+/).filter(Boolean);
  const two = (
    parts.length > 1 ? parts[0][0] + parts[1][0] : base.slice(0, 2)
  ).toUpperCase();
  return two || null;
}

export function WatchlistSection({
  rows,
  windowLabel,
  loading,
  onRow,
  onAll,
}: WatchlistSectionProps) {
  return (
    <section className="ox-sec" aria-label="Sessions worth watching">
      <div className="ox-sec-h">
        <span className="t">Worth watching</span>
        <span className="m">lowest experience scores · {windowLabel}</span>
        <span className="sp" />
        <button className="ox-link" onClick={onAll}>
          Recordings <Icon name="arrowR" size={11} />
        </button>
      </div>
      <div>
        {loading && <SkWatchRows rows={8} />}
        {!loading && rows.slice(0, 8).map((w, i) => {
          const ini = initialsOf(w);
          const crit = w.s < 35;
          return (
            <button
              className="ox-watch"
              key={i}
              onClick={() => onRow(w)}
              title="Open replay"
            >
              <span className="ox-wav" aria-hidden="true">
                {ini || <Icon name="users" size={12} />}
              </span>
              <span className="who" style={{ minWidth: 0 }}>
                <span className="n" style={{ display: "block" }}>
                  {w.n}
                </span>
                <span className="p" style={{ display: "block" }}>
                  {w.p}
                </span>
              </span>
              <span className="wiss">
                {w.tags.map(([t, k], j) => (
                  <span key={t + j} className={`tag ${k}`}>
                    {t}
                  </span>
                ))}
              </span>
              <span
                className={"ox-wsc " + (crit ? "crit" : "warn")}
                title={`Experience score ${w.s} of 100 — lower is worse`}
              >
                <span className="num">{w.s}</span>
                <span className="meter" aria-hidden="true">
                  <i style={{ width: Math.max(4, Math.min(100, w.s)) + "%" }} />
                </span>
              </span>
              <span className="watch">
                <Icon name="play" size={11} fill />{" "}
                <span className="wtxt">Watch</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
