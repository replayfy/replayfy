import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { SkRows } from "./RvSkeletons";
import {
  adaptAnr,
  adaptCrashes,
  type ApiAnrOccurrence,
  type ApiLog,
  type RvCrash,
} from "../recordings.data";

type CrashesPanelProps = {
  publicId: string;
  appVersion?: string | null;
  appBuild?: string | null;
  /** Session start (epoch ms) — offsets absolute ANR timestamps onto the clock. */
  startMs?: number;
  crashOpen: Record<number, boolean>;
  setCrashOpen: Dispatch<SetStateAction<Record<number, boolean>>>;
};

/* Crashes tab (mobile only) — GET /v1/sessions/:id/errors, the kind="error"
   rows. Both TODOs that pinned this to a fixture are resolved:

   1. The rows really are generic — { message, stack, error, offsetMs } — but
      `error` is the crash-KIND discriminator ("uncaught" | "signal" |
      "promise"), which is enough to label a crash. The signal number and
      faulting thread the fixture showed are absent from the SDK's wire type,
      not merely from the projection, so they are dropped (see RvCrash). App
      version is real but per-session, so it arrives as a prop.
   2. `publicId` is now passed by Recordings.tsx, as for Console / Network.

   No fixture fallback: real rows or an honest empty state. */
export function CrashesPanel({
  publicId,
  appVersion,
  appBuild,
  startMs,
  crashOpen,
  setCrashOpen,
}: CrashesPanelProps) {
  const { data, loading, stale } = useApi<ApiLog[]>(
    () => Sessions.errors<ApiLog[]>(publicId),
    [publicId],
  );
  // UI freezes / ANR live in the performance projection (not the error stream),
  // so pull them separately and merge. Secondary to the crashes fetch — the
  // panel renders crashes as soon as they land and folds freezes in after.
  const { data: perf } = useApi<{ anrOccurrences?: ApiAnrOccurrence[] }>(
    () => Sessions.performance<{ anrOccurrences?: ApiAnrOccurrence[] }>(publicId),
    [publicId],
  );
  // `stale` = data is still the PREVIOUS session's (keepPreviousData), which
  // would flash another recording's crashes under this one's id.
  const busy = loading || stale;

  // crashOpen is index-keyed and owned by the parent, so it outlives a session
  // switch. Harmless with the old 1-row fixture; with real rows a stale index
  // would pre-expand an unrelated crash. Reset when the session changes.
  useEffect(() => {
    setCrashOpen({});
  }, [publicId, setCrashOpen]);

  if (busy) return <SkRows n={3} />;

  // Crashes + handled exceptions (from /errors) and UI freezes (from
  // /performance) merged into one time-ordered list.
  const crashes = data ? adaptCrashes(data) : [];
  const freezes =
    startMs && perf?.anrOccurrences?.length
      ? adaptAnr(perf.anrOccurrences, startMs)
      : [];
  const rows: RvCrash[] = [...crashes, ...freezes].sort(
    (a, b) => a.atMs - b.atMs,
  );
  const ver = appVersion
    ? appBuild
      ? `${appVersion} (${appBuild})`
      : appVersion
    : "";

  return (
    <div className="rv-panel rv-dbg rv-crashes">
      {rows.length ? (
        rows.map((c, i) => {
          const frames = c.stack ? c.stack.split("\n").filter(Boolean) : [];
          return (
            <div key={i} className={`rv-crash cat-${c.cat}`}>
              <div className="rv-crash-h">
                <span className="dot" />
                <span className="ty">{c.type}</span>
                <span className="t">{c.t}</span>
              </div>
              <div className="rv-crash-msg">{c.msg}</div>
              {/* thread/signal are not in the API; app version is session-scoped
                  and only rendered when the session actually reports one. */}
              {ver && <div className="rv-crash-meta">app {ver}</div>}
              {frames.length > 0 && (
                <>
                  <button
                    className={`rv-crash-toggle ${crashOpen[i] ? "on" : ""}`}
                    onClick={() => setCrashOpen((o) => ({ ...o, [i]: !o[i] }))}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 10 10"
                      className="tri"
                    >
                      <path d="M3 2l4 3-4 3z" fill="currentColor" />
                    </svg>
                    Stack trace
                    <span className="ct">{frames.length} frames</span>
                  </button>
                  {crashOpen[i] && (
                    <pre className="rv-crash-stack">{frames.join("\n")}</pre>
                  )}
                </>
              )}
            </div>
          );
        })
      ) : (
        <div className="rv-dbg-empty">
          No crashes, exceptions or freezes in this session
        </div>
      )}
    </div>
  );
}
