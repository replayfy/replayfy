import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Sessions } from "@/api/endpoints";
import { RvCopyBlock } from "./RvCopy";
import { SkRows } from "./RvSkeletons";
import { useApiInfinite } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import {
  adaptConsole,
  rvClock,
  rvFmtArg,
  type ApiLog,
  type RvConsole,
} from "../recordings.data";

type ConsolePanelProps = {
  publicId: string;
  clevel: string;
  setClevel: Dispatch<SetStateAction<string>>;
  clOpen: number | null;
  setClOpen: Dispatch<SetStateAction<number | null>>;
};

/* Console tab — wired to GET /v1/sessions/:id/console. Every row expands: the
   expand used to be gated on the row carrying a stack, which the projection
   only sends for some errors, so most lines were inert on click. */
export function ConsolePanel({
  publicId,
  clevel,
  setClevel,
  clOpen,
  setClOpen,
}: ConsolePanelProps) {
  const { items, loading, stale, loadingMore, hasMore, fetchMore } =
    useApiInfinite<ApiLog>(
      (cursor) =>
        Sessions.console<ApiLog[]>(publicId, { cursor: cursor ?? undefined }),
      [publicId],
    );
  // Infinite scroll: sentinel observed inside the .rv-panel scroll container.
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), { root: panelEl });
  // `stale` = data is still the PREVIOUS session's (keepPreviousData); showing
  // it would flash the wrong recording's logs before swapping.
  const busy = loading || stale;
  /* No fixture fallback. The skeleton below covers loading and an API-empty
     console returns `[]` (truthy), so RV_CONSOLE only ever rendered when the
     fetch had FAILED — putting a scripted TypeError in pay.tsx:96 into a real
     session's console. The level filter below applies to LOADED pages. */
  const rows: RvConsole[] = !busy ? adaptConsole(items) : [];
  /* clOpen indexes `rows` (UNFILTERED), never the filtered slice: changing the
     level re-slices `shown`, so a stored slice index would point at a different
     row. Carry each row's origin index through the filter. */
  const shown = rows
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => clevel === "all" || c[0] === clevel);
  if (busy)
    return (
      <>
        <div className="rv-toolbar">
          {(
            [
              ["all", "All"],
              ["err", "Errors"],
              ["warn", "Warn"],
              ["info", "Info"],
              ["log", "Log"],
              ["debug", "Debug"],
            ] as [string, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              className={`rv-f ${clevel === k ? "on" : ""}`}
              onClick={() => setClevel(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <SkRows />
      </>
    );

  return (
    <>
      <div className="rv-toolbar">
        {(
          [
            ["all", "All"],
            ["err", "Errors"],
            ["warn", "Warn"],
            ["info", "Info"],
            ["log", "Log"],
            ["debug", "Debug"],
          ] as [string, string][]
        ).map(([k, l]) => (
          <button
            key={k}
            className={`rv-f ${clevel === k ? "on" : ""}`}
            onClick={() => setClevel(k)}
          >
            {l}
          </button>
        ))}
        <span className="sp" />
        <span className="rv-mini-in">{shown.length} lines</span>
      </div>
      <div className="rv-panel" ref={setPanelEl}>
        {shown.map(({ c, idx }) => {
          const g = (
            { log: "›", info: "›", warn: "⚠", err: "✕", debug: "◆" } as Record<
              string,
              string
            >
          )[c[0]];
          const open = clOpen === idx;
          const stack = c[4];
          const args: unknown[] = Array.isArray(c[5]) ? c[5] : [];
          const off = c[6];
          return (
            <div key={idx}>
              <div
                className={`rv-cl ${c[0]}`}
                onClick={() => setClOpen(open ? null : idx)}
                style={{ cursor: "pointer" }}
              >
                <span className="g">{g}</span>
                <span className="msg">
                  {c[1]}
                  {c[3] > 1 && <span className="rep">×{c[3]}</span>}
                </span>
                <span className="src">{c[2]}</span>
              </div>
              {open && (
                <div className="rv-cl-expand">
                  {stack && (
                    <RvCopyBlock value={stack} label="Stack copied to clipboard">
                      <div className="rv-cl-stack">{stack}</div>
                    </RvCopyBlock>
                  )}
                  {args.length > 0 && (
                    <div className="rv-cl-args">
                      {args.map((a, k) => {
                        const txt = rvFmtArg(a);
                        return (
                          <RvCopyBlock key={k} value={txt}>
                            <div className="rv-cl-arg">{txt}</div>
                          </RvCopyBlock>
                        );
                      })}
                    </div>
                  )}
                  {/* level is always present, so an expanded row is never an
                      empty box even for a bare log line. */}
                  <div className="rv-cl-meta">
                    <div className="rv-cl-kv">
                      <span className="k">level</span>
                      <span className="v">{c[0]}</span>
                    </div>
                    {c[2] && (
                      <div className="rv-cl-kv">
                        <span className="k">source</span>
                        <span className="v">{c[2]}</span>
                      </div>
                    )}
                    {off != null && (
                      <div className="rv-cl-kv">
                        <span className="k">at</span>
                        <span className="v">{rvClock(off)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {/* Infinite-scroll sentinel — always mounted so the observer stays
            attached; the end skeleton shows while the next page loads. */}
        <div ref={sentinelRef} aria-hidden={!hasMore}>
          {loadingMore && <SkRows n={2} />}
        </div>
      </div>
    </>
  );
}
