/* ===========================================================================
   Public share viewer — read-only inspector panels.

   These are read-only renders of the SAME frozen markup/CSS the authed
   Recordings panels use, but fed from the UNAUTHENTICATED Share.* streams the
   share hook already fetched (they can't reuse the authed panels directly —
   those fetch by publicId through the workspace-scoped Sessions client). Every
   value is real (adapted via the shared recordings.data adapters); nothing is
   fabricated — panels with no public projection show an honest empty state.
   ========================================================================== */
import { useEffect, useRef, useState } from "react";
import { EvGlyph } from "@/routes/recordings/glyphs";
import { midTrunc } from "@/routes/recordings/helpers";
import { RvJson } from "@/routes/recordings/panels/RvJson";
import {
  adaptEvents,
  adaptConsole,
  adaptNetwork,
  adaptScreens,
  adaptVitals,
  adaptMpeak,
  rvClock,
  RV_STTEXT,
  type ApiLog,
  type ApiScreen,
  type ApiTimeline,
  type ApiPerformance,
} from "@/routes/recordings/recordings.data";

type InspectorProps = {
  tab: string;
  isMobile: boolean;
  durSec: number;
  pos: number; // 0–100 %
  onSeekSec: (sec: number) => void;
  os: string;
  url: string;
  timeline: ApiTimeline | undefined;
  console: ApiLog[] | undefined;
  network: ApiLog[] | undefined;
  errors: ApiLog[] | undefined;
  screens: ApiScreen[] | undefined;
  performance: ApiPerformance | undefined;
};

/** Central dispatch — renders exactly one enabled panel, read-only. */
export function ShareInspector(p: InspectorProps) {
  switch (p.tab) {
    case "events":
      return (
        <ShEvents
          timeline={p.timeline}
          durSec={p.durSec}
          pos={p.pos}
          onSeekSec={p.onSeekSec}
        />
      );
    case "screens":
      return (
        <ShScreens
          screens={p.screens}
          durSec={p.durSec}
          pos={p.pos}
          onSeekSec={p.onSeekSec}
        />
      );
    case "console":
      return <ShConsole rows={p.console} onSeekSec={p.onSeekSec} />;
    case "network":
      return <ShNetwork rows={p.network} />;
    case "crashes":
      return <ShCrashes rows={p.errors} />;
    case "perf":
      return (
        <ShPerf
          performance={p.performance}
          isMobile={p.isMobile}
          os={p.os}
          url={p.url}
        />
      );
    case "comments":
      return (
        <div className="rv-panel">
          <div className="rv-dbg-empty">
            Comments aren’t shared on public links.
          </div>
        </div>
      );
    default:
      return null;
  }
}

/* seconds ← "m:ss" */
const toSec = (t: string) => {
  const [m, s] = t.split(":").map(Number);
  return (m || 0) * 60 + (s || 0);
};

/* ---------------------------------------------------------------- events */
function ShEvents({
  timeline,
  durSec,
  pos,
  onSeekSec,
}: {
  timeline: ApiTimeline | undefined;
  durSec: number;
  pos: number;
  onSeekSec: (s: number) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const events = timeline ? adaptEvents(timeline.events) : [];
  const curSec = (pos / 100) * durSec;
  let curIdx = 0;
  events.forEach((e, k) => {
    if (toSec(e.t) <= curSec) curIdx = k;
  });

  // Playback → list: glide the active event to the vertical centre of the list
  // as the playhead advances, so the shared viewer's Events tab follows the
  // recording exactly like the dashboard EventsPanel. Clamped so the tail events
  // settle as high as the list allows instead of pinned to the floor. Hooks run
  // before the empty-state early-return below so the order stays stable.
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
  const lastNow = useRef(-1);
  useEffect(() => {
    if (!events.length) return;
    if (curIdx === lastNow.current) return;
    lastNow.current = curIdx;
    centerRow(
      listRef.current?.querySelector<HTMLElement>(`[data-idx="${curIdx}"]`),
    );
  }, [curIdx, events.length]);

  if (!events.length)
    return (
      <div className="rv-panel">
        <div className="rv-dbg-empty">No timeline events captured</div>
      </div>
    );
  return (
    <div className="rv-panel rv-evlog" ref={listRef}>
      {events.map((e, i) => {
        const isOpen = open === i;
        const temporal = i < curIdx ? "done" : i === curIdx ? "now" : "future";
        return (
          <div key={i}>
            <div
              className={`rv-ev2 ${e.kind} ${e.flag || ""} ${temporal} ${isOpen ? "open" : ""}`}
              data-idx={i}
              tabIndex={0}
              onClick={() => {
                setOpen(isOpen ? null : i);
                onSeekSec(toSec(e.t));
              }}
              onKeyDown={(ke) => {
                if (ke.key === "Enter" || ke.key === " ") {
                  ke.preventDefault();
                  setOpen(isOpen ? null : i);
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
            {isOpen && (
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

/* ---------------------------------------------------------------- console */
function ShConsole({
  rows,
  onSeekSec,
}: {
  rows: ApiLog[] | undefined;
  onSeekSec: (s: number) => void;
}) {
  const [level, setLevel] = useState("all");
  const [open, setOpen] = useState<number | null>(null);
  const logs = rows ? adaptConsole(rows) : [];
  const offsets = rows
    ? rows.map((r) => Math.round((r.offsetMs ?? 0) / 1000))
    : [];
  const shown = logs
    .map((c, i) => [c, offsets[i] ?? 0] as const)
    .filter(([c]) => level === "all" || c[0] === level);
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
            className={`rv-f ${level === k ? "on" : ""}`}
            onClick={() => setLevel(k)}
          >
            {l}
          </button>
        ))}
        <span className="sp" />
        <span className="rv-mini-in">{shown.length} lines</span>
      </div>
      <div className="rv-panel">
        {!logs.length && (
          <div className="rv-dbg-empty">No console output captured</div>
        )}
        {shown.map(([c, sec], i) => {
          const g = (
            { log: "›", info: "›", warn: "⚠", err: "✕", debug: "◆" } as Record<
              string,
              string
            >
          )[c[0]];
          const isOpen = open === i;
          return (
            <div key={i}>
              <div
                className={`rv-cl ${c[0]}`}
                onClick={() => {
                  onSeekSec(sec);
                  if (c[4]) setOpen(isOpen ? null : i);
                }}
                style={{ cursor: "pointer" }}
              >
                <span className="g">{g}</span>
                <span className="msg">
                  {c[1]}
                  {c[3] > 1 && <span className="rep">×{c[3]}</span>}
                </span>
                <span className="src">{c[2]}</span>
              </div>
              {isOpen && c[4] && (
                <div className="rv-cl-expand">
                  <div className="rv-cl-stack">{c[4]}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- network */
function ShNetwork({ rows }: { rows: ApiLog[] | undefined }) {
  const [open, setOpen] = useState(-1);
  const reqs = rows ? adaptNetwork(rows) : [];
  const failedCount = reqs.filter((n) => n.st >= 500 || n.st === 0).length;
  return (
    <>
      <div className="rv-toolbar">
        <button className="rv-f on">All</button>
        <span className="sp" />
        <span className="rv-mini-in">
          {reqs.length} requests{failedCount ? ` · ${failedCount} failed` : ""}
        </span>
      </div>
      <div className="rv-panel rv-dbg rv-net">
        {!reqs.length && (
          <div className="rv-dbg-empty">No network requests captured</div>
        )}
        {reqs.map((n, i) => {
          const fail = n.st >= 500 || n.st === 0;
          const stCls = fail
            ? "err"
            : n.st >= 400
              ? "warn"
              : n.st === 304
                ? "idle"
                : "ok";
          const isOpen = open === i;
          const totalMs = n.timing.reduce((a, t) => a + t[1], 0);
          return (
            <div
              key={i}
              className={`rv-req ${isOpen ? "open" : ""} ${fail ? "err" : ""}`}
            >
              <div
                className="rv-req-row"
                onClick={() => setOpen(isOpen ? -1 : i)}
              >
                <span className={`mth ${n.m.toLowerCase()}`}>{n.m}</span>
                <span className="u" title={n.host + n.path}>
                  {midTrunc(n.path, 30)}
                </span>
                <span className={`st ${stCls}`}>
                  {n.st === 0 ? "timeout" : n.st}
                </span>
                <span className="dur">
                  {totalMs}
                  <i>ms</i>
                </span>
                <span className="sz">{n.size}</span>
              </div>
              {isOpen &&
                (() => {
                  let acc = 0;
                  return (
                    <div className="rv-req-x">
                      {fail && (
                        <div className="rv-rx-fail">
                          <span className="x">✕</span>
                          {n.st === 0
                            ? "Request timed out"
                            : `${n.st} ${RV_STTEXT[n.st] || ""}`}
                          {n.st === 0 && (
                            <span className="cause">
                              no response after 2000 ms
                            </span>
                          )}
                        </div>
                      )}
                      {totalMs > 0 && (
                        <>
                          <div className="rv-rx-h">
                            Timing<span className="m">{totalMs} ms</span>
                          </div>
                          <div className="rv-wf2">
                            {n.timing.map(([lbl, ms], k) => {
                              const off = (acc / totalMs) * 100,
                                w = (ms / totalMs) * 100;
                              acc += ms;
                              return (
                                <div key={k} className="seg">
                                  <span className="lb">{lbl}</span>
                                  <span className="track">
                                    <i
                                      style={{
                                        marginLeft: off + "%",
                                        width: Math.max(1.5, w) + "%",
                                      }}
                                    />
                                  </span>
                                  <span className="ms">
                                    {ms}
                                    <i>ms</i>
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                      <div className="rv-rx-h">Request</div>
                      {n.reqH.length ? (
                        <div className="rv-rx-kv">
                          {n.reqH.map(([k, v]) => (
                            <div key={k} className="row">
                              <span className="k">{k}</span>
                              <span className="v">{v}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rv-rx-empty">
                          No request headers captured
                        </div>
                      )}
                      <div className="rv-rx-h">
                        Response
                        {fail && (
                          <span className="tag">
                            {n.st === 0 ? "no response" : n.st}
                          </span>
                        )}
                      </div>
                      {n.resH.length ? (
                        <div className="rv-rx-kv">
                          {n.resH.map(([k, v]) => (
                            <div key={k} className="row">
                              <span className="k">{k}</span>
                              <span className="v">{v}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rv-rx-empty">
                          No response headers received
                        </div>
                      )}
                      {n.payload ? (
                        <RvJson src={n.payload} />
                      ) : (
                        <div className="rv-rx-empty">
                          Body not captured for this content type
                        </div>
                      )}
                    </div>
                  );
                })()}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- screens */
function ShScreens({
  screens,
  durSec,
  pos,
  onSeekSec,
}: {
  screens: ApiScreen[] | undefined;
  durSec: number;
  pos: number;
  onSeekSec: (s: number) => void;
}) {
  const rows = screens ? adaptScreens(screens, durSec * 1000) : [];
  if (!rows.length)
    return (
      <div className="rv-panel">
        <div className="rv-dbg-empty">No screens captured</div>
      </div>
    );
  return (
    <div className="rv-panel rv-scrns">
      {rows.map(([path, start, dur], i) => {
        const startPct = (toSec(start) / durSec) * 100;
        const nx = rows[i + 1];
        const nextPct = nx ? (toSec(nx[1]) / durSec) * 100 : 101;
        const active = pos >= startPct && pos < nextPct;
        return (
          <button
            key={i}
            className={`rv-scrn ${active ? "on" : ""}`}
            onClick={() => onSeekSec(toSec(start))}
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

/* ---------------------------------------------------------------- crashes
   Real error/crash rows from the public /errors projection (message + stack +
   offset). The rich native signal/thread/app-version shape isn't in the public
   projection, so those fields are omitted rather than fabricated. */
function ShCrashes({ rows }: { rows: ApiLog[] | undefined }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const crashes = rows ?? [];
  return (
    <div className="rv-panel rv-dbg rv-crashes">
      {!crashes.length && (
        <div className="rv-dbg-empty">No crashes in this session</div>
      )}
      {crashes.map((c, i) => {
        const stack = c.stack || c.error || "";
        const frames = stack ? stack.split("\n").length : 0;
        return (
          <div key={i} className="rv-crash">
            <div className="rv-crash-h">
              <span className="dot" />
              <span className="ty">{c.error || "Error"}</span>
              <span className="t">{rvClock(c.offsetMs ?? 0)}</span>
            </div>
            <div className="rv-crash-msg">{c.message || "(no message)"}</div>
            {stack && (
              <button
                className={`rv-crash-toggle ${open[i] ? "on" : ""}`}
                onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" className="tri">
                  <path d="M3 2l4 3-4 3z" fill="currentColor" />
                </svg>
                Stack trace<span className="ct">{frames} frames</span>
              </button>
            )}
            {open[i] && stack && <pre className="rv-crash-stack">{stack}</pre>}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- perf
   Compact, read-only headline: real Core Web Vitals (web) or device peaks
   (mobile). The correlated runtime lanes in the full dashboard need per-metric
   series the public projection doesn't expose, so they're omitted here. */
function ShPerf({
  performance,
  isMobile,
  os,
  url,
}: {
  performance: ApiPerformance | undefined;
  isMobile: boolean;
  os: string;
  url: string;
}) {
  if (!performance)
    return (
      <div className="rv-panel">
        <div className="rv-dbg-empty">No performance data captured</div>
      </div>
    );
  return (
    <div className="rv-panel rv-dbg rv-perf">
      {!isMobile ? (
        <>
          <div className="rv-dbg-sec">
            Core Web Vitals
            <span className="sp" />
            <span className="rv-dbg-meta">page · {url}</span>
          </div>
          {adaptVitals(performance).map(([k, v, r]) => (
            <div key={k} className="rv-vlane">
              <span className="ab">{k}</span>
              <span className={`val ${r}`}>{v}</span>
              <span className={`rate ${r}`}>
                {r === "good"
                  ? "Good"
                  : r === "ni"
                    ? "Needs improvement"
                    : "Poor"}
              </span>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="rv-dbg-sec">
            Device vitals
            <span className="sp" />
            <span className="rv-dbg-meta">{os}</span>
          </div>
          <div className="rv-mpk">
            {adaptMpeak(performance).map(([k, v, r]) => (
              <div key={k} className="rv-mpk-i">
                <span className="ab">{k}</span>
                <span className={`val ${r}`}>{v}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
