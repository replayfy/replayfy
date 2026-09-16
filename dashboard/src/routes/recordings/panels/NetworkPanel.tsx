import {
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Sessions } from "@/api/endpoints";
import { useApiInfinite } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import { adaptNetwork, type ApiLog, type RvNet } from "../recordings.data";
import { RvJson } from "./RvJson";
import { RvCopyBlock } from "./RvCopy";
import { SkNet } from "./RvSkeletons";

/* ============================================================================
   Network tab — GET /v1/sessions/:id/network, shaped like the reference
   request inspector: status/method filter chips, a Time / Method / URL /
   Status / Duration table, and an inline request detail with
   Headers · Payload · Response · Timing.
   ========================================================================== */

const FILTERS = ["all", "errors", "GET", "POST", "PUT", "DELETE"] as const;
const DETAIL_TABS = ["Headers", "Payload", "Response", "Timing"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

const NONE_CAPTURED = "(none captured)";
const NO_BODY = "No body sent";

/** RvNet.start is offsetMs; the row clock is "m:ss" into the session. */
function netClock(ms: number): string {
  const secs = Math.max(0, Math.floor((ms || 0) / 1000));
  const p2 = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}

/** The row labels with the last path segment; the full URL
 *  lives in the Headers tab. RvNet.path is already `pathname+search`. */
function shortUrlLabel(path: string): string {
  if (!path) return "";
  const [p, q] = path.split("?");
  const parts = p.split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : "/";
  return q ? `${last}?${q}` : last;
}

/** st === 0 is this projection's "no response" encoding (adaptNetwork maps a
 *  missing statusCode to 0), so it counts as a failure alongside 4xx/5xx. */
function isErr(n: RvNet): boolean {
  return Boolean(n.err) || n.st === 0 || n.st >= 400;
}

type NetworkPanelProps = {
  publicId: string;
  netOpen: number;
  setNetOpen: Dispatch<SetStateAction<number>>;
  /** Row click parks the playhead on the request. */
  seek?: (secs: number) => void;
};

export function NetworkPanel({
  publicId,
  netOpen,
  setNetOpen,
  seek,
}: NetworkPanelProps) {
  const { items, loading, stale, loadingMore, hasMore, fetchMore } =
    useApiInfinite<ApiLog>(
      (cursor) =>
        Sessions.network<ApiLog[]>(publicId, { cursor: cursor ?? undefined }),
      [publicId],
    );
  // Infinite scroll: sentinel observed inside the .rv-panel scroll container.
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), { root: panelEl });
  // `stale` = still the PREVIOUS session's requests (keepPreviousData). The old
  // `loading &&` guard was dead on a switch: placeholder data means the query
  // reports success, so loading is false and the previous rows rendered.
  const busy = loading || stale;
  const [filter, setFilter] = useState<string>("all");

  // No fixture fallback: a session with no requests must read empty rather
  // than show invented traffic. The method/error filter applies to LOADED pages.
  const rows = useMemo<RvNet[]>(
    () => (!busy ? adaptNetwork(items) : []),
    [items, busy],
  );
  const shown = useMemo<RvNet[]>(() => {
    if (filter === "all") return rows;
    if (filter === "errors") return rows.filter(isErr);
    return rows.filter((n) => n.m.toUpperCase() === filter);
  }, [rows, filter]);

  return (
    <>
      <div className="rv-toolbar">
        {FILTERS.map((f) => (
          <button
            key={f}
            className={f === filter ? "rv-f on" : "rv-f"}
            onClick={() => {
              setFilter(f);
              // the open index addresses `shown`; refiltering would move it
              setNetOpen(-1);
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="rv-panel rv-dbg rv-net rv-netx" ref={setPanelEl}>
        <div className="rv-net-hd">
          <span>Time</span>
          <span>Method</span>
          <span>URL</span>
          <span className="r">Status</span>
          <span className="r">Duration</span>
          <span />
        </div>

        {shown.map((n, i) => {
          const fail = isErr(n);
          const stCls = fail ? "err" : n.st >= 300 ? "warn" : "ok";
          const open = netOpen === i;
          return (
            <div
              key={i}
              className={`rv-req ${open ? "open" : ""} ${fail ? "err" : ""}`}
            >
              <div
                className="rv-req-row"
                onClick={() => {
                  seek?.(n.start / 1000);
                  setNetOpen(open ? -1 : i);
                }}
              >
                <span className="rv-net-t">{netClock(n.start)}</span>
                <span className={`mth ${n.m.toLowerCase()}`}>{n.m}</span>
                <span className="u" title={n.url || n.host + n.path}>
                  {shortUrlLabel(n.path)}
                </span>
                <span className={`st ${stCls}`}>
                  <span className="dot" />
                  {n.err ? "ERR" : n.st || "—"}
                </span>
                <span className="dur">
                  {n.dur}
                  <i>ms</i>
                </span>
                <span className="rv-net-chev">{open ? "▾" : "▸"}</span>
              </div>
              {open && <RequestDetail n={n} />}
            </div>
          );
        })}

        {busy && <SkNet />}
        {!busy && shown.length === 0 && (
          <div className="rv-dbg-empty">No matching network events.</div>
        )}
        {/* Infinite-scroll sentinel — always mounted; end skeleton while the
            next page loads. */}
        <div ref={sentinelRef} aria-hidden={!hasMore}>
          {loadingMore && <SkNet n={2} />}
        </div>
      </div>
    </>
  );
}

/** The inline request detail: one tabbed pane per request. */
function RequestDetail({ n }: { n: RvNet }) {
  const [tab, setTab] = useState<DetailTab>("Headers");

  const general: [string, string][] = [
    ["Request URL", n.url || n.host + n.path],
    ["Request Method", n.m],
    ["Status Code", n.err ? `(failed) ${n.err}` : n.st ? String(n.st) : "—"],
  ];
  // Only rendered when the SDK actually captured NetworkInformation.
  if (n.connEff) {
    general.push([
      "Connection",
      `${n.connEff}${n.connRtt ? ` · ${n.connRtt}ms RTT` : ""}`,
    ]);
  }

  const timing: [string, string][] = [
    ["Started at", `${netClock(n.start)} into session`],
    ["Duration", `${n.dur} ms`],
  ];
  if (n.connRtt) timing.push(["Connection RTT", `${n.connRtt} ms`]);
  if (n.connEff) timing.push(["Effective type", n.connEff]);

  return (
    <div className="rv-req-x">
      <div className="rv-nx-tabs">
        {DETAIL_TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? "rv-nx-tab on" : "rv-nx-tab"}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Headers" && (
        <>
          <NetKv title="General" rows={general} />
          <NetKv title="Request Headers" rows={n.reqH} empty={NONE_CAPTURED} />
          <NetKv title="Response Headers" rows={n.resH} empty={NONE_CAPTURED} />
        </>
      )}
      {tab === "Payload" &&
        (n.reqBody ? (
          <RvCopyBlock value={n.reqBody} label="Payload copied to clipboard">
            <RvJson src={n.reqBody} />
          </RvCopyBlock>
        ) : (
          <div className="rv-rx-empty">{NO_BODY}</div>
        ))}
      {tab === "Response" &&
        (n.resBody ? (
          <RvCopyBlock value={n.resBody} label="Response copied to clipboard">
            <RvJson src={n.resBody} />
          </RvCopyBlock>
        ) : (
          <div className="rv-rx-empty">
            {n.resBody === "" ? "(empty response)" : NO_BODY}
          </div>
        ))}
      {tab === "Timing" && <NetKv title="Timing" rows={timing} />}
    </div>
  );
}

/** Section title + key/value table. `.rv-rx-h` uppercases the title in CSS, so
 *  "General" renders as GENERAL. */
function NetKv({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: [string, string][];
  empty?: string;
}) {
  return (
    <>
      <div className="rv-rx-h">{title}</div>
      {rows.length === 0 ? (
        <div className="rv-rx-empty">{empty ?? "—"}</div>
      ) : (
        <div className="rv-rx-kv">
          {rows.map(([k, v]) => (
            <div key={k} className="row">
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
