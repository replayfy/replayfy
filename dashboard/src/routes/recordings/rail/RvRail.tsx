/* ---------- Left rail: sessions list + investigation search ---------- */
import { useRef, useState } from "react";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from "react";
import { Icon, Toggle } from "@/components/primitives";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import {
  RECORDING_FALLBACK,
  type ApiRecording,
} from "../../settings/settings.data";
import { RvStatus } from "../glyphs";
import { RvSearch } from "../search/RvSearch";
import type { FilterToken } from "../search/search.data";
import type { RvSession, RvTotal } from "../recordings.data";
import { RvListSkeleton } from "./RvListSkeleton";

export type RvGroup = { t: string; live?: boolean; items: RvSession[] };

type RvRailProps = {
  railW: number;
  groups: RvGroup[];
  cur: string;
  setCur: (id: string) => void;
  tokens: FilterToken[];
  setTokens: Dispatch<SetStateAction<FilterToken[]>>;
  /** Refetching for a new filter. The LIST swaps to a skeleton; the player and
   *  inspector keep the recording that's open — re-filtering the rail is not a
   *  reason to tear down what the analyst is watching. */
  listBusy?: boolean;
  /** Sessions matching the current filter, server-counted. `null` = the envelope
   *  made no claim (not "zero") → the header states nothing. While `listBusy`
   *  this is still the PREVIOUS filter's total; see the header below. */
  total?: RvTotal | null;
  /** Tokens with no GET /v1/sessions param behind them. Named here rather than
   *  dropped: the list would otherwise come back wider than the chips claim. */
  unapplied?: FilterToken[];
  /** Right-click on a session row — the page owns the menu (and its modals). */
  onRowContextMenu?: (e: ReactMouseEvent, s: RvSession) => void;
  /** Infinite scroll: another page exists / a page is loading / load it. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
};

export function RvRail({
  railW,
  groups,
  cur,
  setCur,
  tokens,
  setTokens,
  listBusy,
  total,
  unapplied,
  onRowContextMenu,
  hasMore,
  loadingMore,
  onMore,
}: RvRailProps) {
  // State-backed scroll root (a plain ref stays null past the observer's first
  // run); the sentinel stays mounted so the observer never has to re-attach.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, () => onMore?.(), { root: listEl });
  // Shared "settings/recording" key so this rail toggle and the Settings
  // Recording panel read/write the same cached record and stay in sync.
  const { data, refetch } = useApi<ApiRecording>(
    () => Settings.recording.get<ApiRecording>(),
    [],
    { key: "settings/recording" },
  );
  const rec = data ?? RECORDING_FALLBACK;
  return (
    <section className="rv-rail" style={{ width: railW }}>
      <div className="rv-rail-top">
        <div className="rv-rail-title">
          <h2>Sessions</h2>
          {/* Sessions matching the CURRENT filter, counted server-side against
              the same predicate that selected the rows below — one query, one
              store, so the number and the list cannot contradict each other.

              `capped` renders the "+" and is not decoration: the server stops
              counting at 10,000, so the value is a FLOOR. Dropping the "+" for
              tidiness would turn a bounded truth back into a precise-looking
              wrong number — the exact failure being fixed here (this element was
              a hardcoded "1,284" that sat unchanged while a filtered list showed
              32 rows).

              While `listBusy`, this is the previous filter's total and is marked
              pending — dimmed, aria-busy, and `aria-hidden` so a screen reader
              isn't read a number that is about to change. It is HELD rather than
              blanked because the rail's rows are already a skeleton at this
              point: a stale figure over a skeleton list is visibly not a claim
              about those rows, whereas blanking it collapses the header and
              makes the count jump on every filter change. Held-but-dimmed keeps
              the layout still and still refuses to assert.

              `null` (no total in the envelope) renders NOTHING — silence is the
              honest state when nothing counted; a "0" would be a claim. */}
          {total && (
            <span
              className={`rv-count ${listBusy ? "pending" : ""}`}
              aria-busy={listBusy || undefined}
              aria-hidden={listBusy || undefined}
              title={
                total.capped
                  ? `More than ${total.value.toLocaleString()} sessions match this filter. The count stops at ${total.value.toLocaleString()} to stay fast.`
                  : undefined
              }
            >
              {total.value.toLocaleString()}
              {total.capped ? "+" : ""}
            </span>
          )}
        </div>
        <RvSearch tokens={tokens} setTokens={setTokens} />
        {unapplied && unapplied.length > 0 && (
          /* Says which chips the backend can't honour. The alternative — mapping
             what we can and staying quiet about the rest — returns a list that
             is WIDER than the filter bar describes, and nothing on screen would
             admit it. */
          <div className="rv-srch-note" role="status">
            Not applied yet:{" "}
            {unapplied.map((t) => `${t.key}${t.op}${t.value}`).join(", ")}
          </div>
        )}
      </div>

      <div className="rv-list" ref={setListEl}>
        {listBusy && <RvListSkeleton />}
        {/* Zero matches is a normal answer from the list, so the list is what
            says it — one quiet line, not a page-level illustration. The search
            bar above stays reachable, which is the actual way out. */}
        {!listBusy && !groups.length && (
          <div className="rv-none" role="status">
            No results
          </div>
        )}
        {!listBusy &&
          groups.map((g) => (
          <div key={g.t}>
            <div className="rv-grp">
              {g.live && <span className="pulse" />}
              <span className="l">{g.t}</span>
              <span className="rule" />
              <span className="n">{g.items.length}</span>
            </div>
            {g.items.map((x) => {
              const sev: [string, string][] = [];
              if (x.errs)
                sev.push(["err", `${x.errs} error${x.errs > 1 ? "s" : ""}`]);
              if (x.rage) sev.push(["rage", `${x.rage} rage clicks`]);
              return (
                <div
                  key={x.id}
                  className={`rv-ses ${x.id === cur ? "on" : ""}`}
                  onClick={() => setCur(x.id)}
                  onContextMenu={(e) => onRowContextMenu?.(e, x)}
                >
                  <RvStatus x={x} />
                  <div className="rv-ses-main">
                    <div className="rv-r1">
                      <span className={`nm ${x.anon ? "anon" : ""}`}>
                        {x.name}
                      </span>
                      <span className={`when ${x.live ? "live" : ""}`}>
                        {x.live ? "live" : x.when}
                      </span>
                    </div>
                    {/* The email, under the name. The API had always shipped it;
                        adaptSession threw it away, so this row could only ever
                        show a name. Absent when identify() gave no email, or
                        when the email IS the name line. */}
                    {x.sub && <div className="rv-rsub">{x.sub}</div>}
                    <div className="rv-r2">
                      <span className="meta">
                        {x.os}
                        {x.flag && (
                          <>
                            <span className="sep">·</span>
                            <span className="loc">{x.flag}</span>
                          </>
                        )}
                      </span>
                      <span className="dur">{x.dur}</span>
                    </div>
                    {sev.length > 0 && (
                      <div className="rv-r3">
                        {sev.map(([k, l], i) => (
                          <span key={i} className={`rv-sev ${k}`}>
                            <i />
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {/* Infinite-scroll sentinel — ALWAYS mounted (so the observer never has
            to re-attach), but onMore/fetchMore no-ops unless a page remains. The
            end-of-list skeleton shows while the next page is in flight. */}
        <div ref={sentinelRef} className="rv-more" aria-hidden={!hasMore}>
          {loadingMore && <RvListSkeleton rows={2} />}
        </div>
      </div>

      <div className="rv-rail-foot">
        <Icon name="play" size={12} fill /> Autoplay next
        <Toggle
          on={rec.autoplayNextRecording}
          onChange={async (v) => {
            await Settings.recording.set({ autoplayNextRecording: v });
            refetch();
          }}
        />
      </div>
    </section>
  );
}
