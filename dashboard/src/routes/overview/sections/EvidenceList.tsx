import { Icon } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import type { OverviewStoryline } from "../overview.api";

/** One supporting-evidence row — built from measured facts (never a fixture).
 *  `big` is the headline figure, `d` the one-line detail, `col` the accent. */
export type EvRow = { ic: string; label: string; big: string; d: string; col: string };

/** Supporting-evidence rows built ONLY from a storyline's measured facts
 *  (sessions/users affected, the size of the move, the screen). No fixture —
 *  an empty result means the caller renders plain emphasis, no popover. Shared
 *  by every surface that shows the analyst lead (OverviewStory + SignalsSection). */
export function storyEvidence(story: OverviewStoryline): EvRow[] {
  if (!story) return [];
  const bad = story.polarity !== "POSITIVE";
  const col = bad ? "var(--red)" : "var(--green)";
  const rows: EvRow[] = [];
  if (story.sessionCount)
    rows.push({
      ic: "rec",
      label: "Replay",
      big: `${story.sessionCount.toLocaleString()} sessions`,
      d: story.screen ? `Concentrated on ${story.screen}` : "Sessions in this incident",
      col,
    });
  if (story.userCount)
    rows.push({
      ic: "cursor",
      label: "Users",
      big: `${story.userCount.toLocaleString()} users`,
      d: "Distinct users affected in this window",
      col,
    });
  const pct = story.deltaPctX100 / 100;
  if (pct)
    rows.push({
      ic: "funnel",
      label: "Change",
      big: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`,
      d: "vs the previous period",
      col,
    });
  return rows;
}

/* Supporting-evidence list with continuity (sliding) highlight between rows.
   Rows are supplied by the caller from real storyline facts; an empty list
   renders nothing (the caller gates the trigger on `rows.length`). */
export function EvidenceList({ rows }: { rows: EvRow[] }) {
  const hl = useMovingHL<HTMLSpanElement>();
  return (
    <span className="elp-list" ref={hl.ref} onMouseLeave={hl.onLeave}>
      <span
        className={`elp-hl ${hl.hl ? "on" : ""}`}
        style={
          hl.hl
            ? { transform: `translateY(${hl.hl.top}px)`, height: hl.hl.height }
            : { height: 0 }
        }
      />
      {rows.map((e, i) => (
        <span className="elp-row" key={i} onMouseEnter={hl.onEnter}>
          <span className="elp-ic" style={{ color: e.col }}>
            <Icon name={e.ic} size={13} />
          </span>
          <span className="elp-txt">
            <span className="elp-top">
              <span className="elp-l">{e.label}</span>
              <span className="elp-big" style={{ color: e.col }}>
                {e.big}
              </span>
            </span>
            <span className="elp-d">{e.d}</span>
          </span>
        </span>
      ))}
    </span>
  );
}
