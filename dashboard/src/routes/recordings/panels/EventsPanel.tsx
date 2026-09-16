import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { EvGlyph } from "../glyphs";
import { SkRows } from "./RvSkeletons";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import {
  adaptEvents,
  type ApiTimeline,
  type RvEvent,
} from "../recordings.data";
import { setHoverKey, useHoverKey } from "../player/hoverSync";

type EventsPanelProps = {
  publicId: string;
  pos: number;
  durSec: number;
  setPos: Dispatch<SetStateAction<number>>;
  evOpen: number | null;
  setEvOpen: Dispatch<SetStateAction<number | null>>;
};

/* Activity log — wired to GET /v1/sessions/:id/timeline (structured event
   stream). Falls back to the fixture only while the fetch is unresolved. */
export function EventsPanel({
  publicId,
  pos,
  durSec,
  setPos,
  evOpen,
  setEvOpen,
}: EventsPanelProps) {
  // Shared cache key with the scrubber-ticks read in Recordings.tsx: same
  // `session-timeline:<id>` key + same dep means React Query serves both from
  // ONE fetch instead of two (the scrubber already warmed it), so opening a
  // recording no longer double-hits /timeline.
  const { data, loading, stale } = useApi<ApiTimeline>(
    () => Sessions.timeline<ApiTimeline>(publicId),
    [publicId],
    { key: `session-timeline:${publicId}` },
  );
  // `stale` = still the PREVIOUS session's timeline (keepPreviousData).
  const busy = loading || stale;
  // No fixture fallback: the skeleton covers loading, so RV_EVENTS only ever
  // rendered when the fetch had FAILED — quietly presenting a scripted demo
  // timeline as this session's real one.
  const events: RvEvent[] = data && !busy ? adaptEvents(data.events) : [];

  // The event this row is cross-highlighting (a timeline marker or a row here).
  const hoverKey = useHoverKey();
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll a row to the VERTICAL CENTRE of the list, clamped to the scroll range.
  // Centring (not block:"nearest") keeps the active event in the middle so the
  // eye doesn't chase it down to the bottom edge. The clamp means the tail events
  // — which can't centre without overscrolling — settle as high as the list
  // allows ("brought up a bit") instead of pinned to the floor.
  const centerRow = (el: HTMLElement | null | undefined) => {
    const list = listRef.current;
    if (!list || !el) return;
    const rowCenter =
      el.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop +
      el.offsetHeight / 2;
    const max = list.scrollHeight - list.clientHeight;
    const top = Math.max(0, Math.min(rowCenter - list.clientHeight / 2, max));
    list.scrollTo({ top, behavior: "smooth" });
  };

  // "now" row from the playhead: the last event at or before the current second.
  const eSec = (e: RvEvent) => {
    const [m, sc] = e.t.split(":").map(Number);
    return m * 60 + sc;
  };
  const curSec = (pos / 100) * durSec;
  let curIdx = 0;
  events.forEach((e, k) => {
    if (eSec(e) <= curSec) curIdx = k;
  });

  // Playback → list: glide the active row into view as the playhead advances —
  // only when it's actually off-screen (block:"nearest" no-ops otherwise) and
  // never while hovering, so it can't fight a manual scroll or a hover-scroll.
  const lastNow = useRef(-1);
  useEffect(() => {
    if (!events.length || hoverKey != null) return;
    if (curIdx === lastNow.current) return;
    lastNow.current = curIdx;
    centerRow(
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${curIdx}"]`),
    );
  }, [curIdx, hoverKey, events.length]);

  // Timeline → list: when a MARKER is hovered, glide its matching row into view.
  useEffect(() => {
    if (hoverKey == null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${hoverKey}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [hoverKey]);

  if (busy) return <SkRows n={8} />;
  if (!events.length)
    return (
      <div className="rv-panel rv-dbg">
        <div className="rv-dbg-empty">No events in this session.</div>
      </div>
    );
  return (
    <div className="rv-panel rv-evlog" ref={listRef}>
      {events.map((e, i) => {
        const open = evOpen === i;
        const temporal = i < curIdx ? "done" : i === curIdx ? "now" : "future";
        const hot = e.key != null && e.key === hoverKey;
        return (
          <div key={i}>
            <div
              className={`rv-ev2 ${e.kind} ${e.flag || ""} ${temporal} ${open ? "open" : ""} ${hot ? "hot" : ""}`}
              data-idx={i}
              data-key={e.key}
              tabIndex={0}
              onMouseEnter={() => setHoverKey(e.key ?? null)}
              onMouseLeave={() => setHoverKey(null)}
              onClick={() => {
                setEvOpen(open ? null : i);
                const [mm, ss] = e.t.split(":").map(Number);
                setPos(
                  Math.max(0, Math.min(100, ((mm * 60 + ss) / durSec) * 100)),
                );
              }}
              onKeyDown={(ke) => {
                if (ke.key === "Enter" || ke.key === " ") {
                  ke.preventDefault();
                  setEvOpen(open ? null : i);
                }
              }}
            >
              <span className="ti">{e.t}</span>
              <span className="gl">
                <EvGlyph kind={e.kind} flag={e.flag} />
              </span>
              <span className="msg">
                <span className="v">{e.ev}</span>{" "}
                <span className="tg">{e.target}</span>
              </span>
              {e.res && <span className="res">{e.res}</span>}
            </div>
            {open && (
              <div className="rv-ev2-x">
                {e.stack && <div className="stack">{e.stack}</div>}
                {e.d &&
                  e.d.map(([k, v]) => (
                    <div className="kv" key={k}>
                      <span className="k">{k}</span>
                      <span className="vv">{v}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
