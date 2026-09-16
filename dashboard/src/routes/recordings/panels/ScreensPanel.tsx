import type { Dispatch, SetStateAction } from "react";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { adaptScreens, type ApiScreen } from "../recordings.data";
import { SkRows } from "./RvSkeletons";

type ScreensPanelProps = {
  publicId: string;
  pos: number;
  durSec: number;
  setPos: Dispatch<SetStateAction<number>>;
};

/* Screens tab — wired to GET /v1/sessions/:id/screens (mobile nav flow).
   Falls back to the fixture only while the fetch is unresolved. */
export function ScreensPanel({
  publicId,
  pos,
  durSec,
  setPos,
}: ScreensPanelProps) {
  const { data, loading, stale } = useApi<ApiScreen[]>(
    () => Sessions.screens<ApiScreen[]>(publicId),
    [publicId],
  );
  /* This panel had no loading gate at all, so `data ? … : RV_SCREENS` showed
     the fixture during the fetch AND on failure — and while offline, where
     TanStack pauses the query and `data` never arrives, it would have sat on
     four invented screens indefinitely. Skeleton while busy, honest empty
     otherwise; `stale` also keeps the previous session's screens off this one. */
  const busy = loading || stale;
  const screens = data && !busy ? adaptScreens(data, durSec * 1000) : [];
  if (busy) return <SkRows n={6} />;
  if (!screens.length)
    return (
      <div className="rv-panel rv-dbg">
        <div className="rv-dbg-empty">No screens in this session.</div>
      </div>
    );
  return (
    <div className="rv-panel rv-scrns">
      {screens.map(([path, start, dur], i) => {
        const [m, sc] = start.split(":").map(Number);
        const startPct = ((m * 60 + sc) / durSec) * 100;
        const nx = screens[i + 1];
        const nextPct = nx
          ? (() => {
              const [a, b] = nx[1].split(":").map(Number);
              return ((a * 60 + b) / durSec) * 100;
            })()
          : 101;
        const active = pos >= startPct && pos < nextPct;
        return (
          <button
            key={i}
            className={`rv-scrn ${active ? "on" : ""}`}
            onClick={() => setPos(Math.min(100, +startPct.toFixed(2)))}
          >
            <span className="ic">
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3.5 11.5c0-2.2 1.6-2.5 4.5-2.5s4.5-.3 4.5-2.5M3.5 6 6 4M3.5 6 6 8" />
              </svg>
            </span>
            <div className="b">
              <div className="p">{path}</div>
              <div className="m">
                {start} <span className="ar">→</span> {dur}
              </div>
            </div>
            <span className="n">#{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
