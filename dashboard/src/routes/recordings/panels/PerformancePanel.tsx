import type { Dispatch, SetStateAction } from "react";
import { RvSpark } from "../glyphs";
import { pct } from "../helpers";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import {
  adaptVitals,
  adaptLoading,
  adaptLongTasks,
  adaptWarnings,
  adaptMpeak,
  adaptMlanes,
  adaptNetwork,
  type ApiLog,
  type ApiPerformance,
  type RvSession,
} from "../recordings.data";

export type PerfHover = { px: number; frac: number };

type PerformancePanelProps = {
  publicId: string;
  isMobile: boolean;
  s: RvSession;
  perfHover: PerfHover | null;
  setPerfHover: Dispatch<SetStateAction<PerfHover | null>>;
  pos: number;
  fmtT: (p: number) => string;
};

/* Performance tab — wired to GET /v1/sessions/:id/performance. Real values for
   the web Core Web Vitals headline + long-task blocking summary. The vital
   sparklines, the runtime CPU/heap/frames lanes, and the mobile device panel
   have no per-metric time series in the projection, so those stay on fixtures
   (see TODO(api) markers below). */
export function PerformancePanel({
  publicId,
  isMobile,
  s,
  perfHover,
  setPerfHover,
  pos,
  fmtT,
}: PerformancePanelProps) {
  const { data: perf } = useApi<ApiPerformance>(
    () => Sessions.performance<ApiPerformance>(publicId),
    [publicId],
  );
  // Network summary (web) — Total requests uses the session's precomputed
  // networkCount (exact, unpaginated); the slowest request is derived from the
  // first page. Only fetched on the web Perf tab.
  const { data: netData } = useApi<ApiLog[]>(
    () => Sessions.network<ApiLog[]>(publicId),
    [publicId],
    { enabled: !isMobile },
  );
  const netRows = !isMobile && netData ? adaptNetwork(netData) : [];
  const slowestReq = netRows.length
    ? netRows.reduce((a, b) => (b.dur > a.dur ? b : a))
    : null;
  const totalReq = s.net || netRows.length;
  /* Every fixture fallback in this panel is gone. Nothing here renders until
     `perf` lands, and anything the projection doesn't carry says so rather
     than borrowing a number from the demo session. */
  const vitals = !isMobile && perf ? adaptVitals(perf) : [];
  // Mobile slow frames now read the real `warnings` projection (adaptWarnings)
  // instead of ignoring `perf` and returning RV_LT.mobile unconditionally.
  const lt = perf ? (isMobile ? adaptWarnings(perf) : adaptLongTasks(perf)) : null;

  /* Timeline lanes, real-only.
       mobile → nativeSeries (adaptMlanes)
       web    → memory.samples, the one web series the projection actually
                carries. It was declared and read by NOTHING while three
                invented lanes were drawn beside it. */
  const laneData: [string, string, number[], string, string][] = !perf
    ? []
    : isMobile
      ? adaptMlanes(perf)
      : (() => {
          const mb = (perf.memory?.samples ?? []).map((x) =>
            Math.round(x.bytes / 1048576),
          );
          if (!mb.length) return [];
          const peak = perf.memory?.peakBytes
            ? Math.round(perf.memory.peakBytes / 1048576)
            : Math.max(...mb);
          return [["JS heap", "MB", mb, "var(--rv-net)", `${peak} MB`]];
        })();
  return (
    <div className="rv-panel rv-dbg rv-perf">
      {!isMobile ? (
        <>
          <div className="rv-dbg-sec">
            Core Web Vitals
            <span className="sp" />
            <span className="rv-dbg-meta">page · {s.url}</span>
          </div>
          {vitals.map(([k, v, r, spark, note]) => (
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
              {/* No per-vital time series in the projection — the value and
                  rating beside it are real, so drawing a curve here would be
                  the only invented thing in the row. */}
              {spark.length > 0 && (
                <div className="rv-vlane-sp">
                  <RvSpark
                    data={spark}
                    color={
                      r === "poor"
                        ? "var(--rv-err)"
                        : r === "ni"
                          ? "var(--rv-warn)"
                          : "var(--rv-ok)"
                    }
                    h={18}
                  />
                </div>
              )}
            </div>
          ))}
          {/* Loading — FCP + TTFB. Captured by the SDK/backend (on
              ApiPerformance) but the panel previously rendered only the three
              Core Web Vitals, so these two were tracked-but-unshown. */}
          {perf && (
            <>
              <div className="rv-dbg-sec">
                Loading
                <span className="sp" />
              </div>
              {adaptLoading(perf).map(([k, v, r]) => (
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
          )}
        </>
      ) : (
        <>
          {/* Device vitals — real native scalars (mainThreadCpu / memoryRss /
            thermalState) via adaptMpeak; fixture only until the fetch resolves. */}
          <div className="rv-dbg-sec">
            Device vitals
            <span className="sp" />
            <span className="rv-dbg-meta">{s.os}</span>
          </div>
          <div className="rv-mpk">
            {(perf ? adaptMpeak(perf) : []).map(([k, v, r]) => (
              <div key={k} className="rv-mpk-i">
                <span className="ab">{k}</span>
                <span className={`val ${r}`}>{v}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="rv-dbg-sec">
        {isMobile ? "Resource timeline" : "Runtime"}
        <span className="sp" />
        <span className="rv-dbg-meta">
          {perfHover ? fmtT(perfHover.frac * 100) : `0:00 – ${fmtT(100)}`}
        </span>
      </div>
      <div
        className="rv-corr"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - r.left;
          const frac = Math.max(0, Math.min(1, (px - 14) / (r.width - 28)));
          setPerfHover({ px, frac });
        }}
        onMouseLeave={() => setPerfHover(null)}
      >
        {/* The perf marks are gone. They were hardcoded to fixed percentages —
            web sessions always flagged "Long task · 0:43" at 33% and "FPS drop
            · modal" at 71%, so a 20s session displayed a mark labelled past its
            own end, floating over whatever the real lanes below showed and
            inviting the user to correlate a real spike with a fabricated event.
            TODO(api): the timeline projection does carry perf events
            (kind==="perf"), already fetched as `timelineData` in Recordings.tsx
            — wire them through as a prop to bring these back for real. */}
        <div className="rv-corr-line" style={{ left: pct(pos) }}>
          <span>{fmtT(pos)}</span>
        </div>
        {perfHover && (
          <div className="rv-phover" style={{ left: perfHover.px + "px" }}>
            <span className="t">{fmtT(perfHover.frac * 100)}</span>
          </div>
        )}
        {/* Real lanes only. Mobile: the native series. Web: the JS-heap series
            from `memory.samples` — the CPU and Frames lanes are DELETED because
            the web projection carries no series for them. They were three
            invented trend lines with authoritative peak labels (CPU 92%, heap
            55 MB, Frames 14 fps) that were also hover-interactive, so the
            readout reported fixture values as live per-timestamp measurements
            of the user's real session. */}
        {(() => {
          if (!perf) return null;
          const lanes = laneData;
          if (lanes.length === 0)
            return (
              <div className="rv-perf-empty">
                {isMobile
                  ? "No device series captured for this session — the SDK samples CPU, memory and battery periodically once the app is foregrounded."
                  : "No runtime series captured for this session."}
              </div>
            );
          return null;
        })()}
        {laneData.map(([nm, unit, d, c, pk]) => {
          const idx = perfHover
            ? Math.round(perfHover.frac * (d.length - 1))
            : -1;
          const hv = idx >= 0 ? d[idx] : null;
          const mx = Math.max(...d);
          const dotTop =
            hv != null ? ((30 - 3 - (hv / mx) * (30 - 6)) / 30) * 100 : 0;
          return (
            <div key={nm} className="rv-mlane">
              <div className="rv-mlane-top">
                <span className="nm">{nm}</span>
                <span className={`pk ${hv != null ? "live" : ""}`}>
                  {hv != null ? <b>{hv}</b> : pk}
                  <i> {unit}</i>
                </span>
              </div>
              <div className="rv-spark-wrap">
                <RvSpark data={d} color={c} fill grid h={30} />
                {hv != null && (
                  <span
                    className="rv-dot"
                    style={{
                      left: pct(perfHover!.frac * 100),
                      top: dotTop + "%",
                      background: c,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
        {/* The thermal band is gone. RV_THERMAL was four hardcoded (state,
            width) pairs with no timestamps and no value axis, under a
            hardcoded "serious @ peak" label — a heat curve for a device that
            may have been idle, and the one fixture the audit could find no
            real source for anywhere. Nothing is lost: the genuine
            thermalState reading survives in the Device-vitals tile above. */}
      </div>

      <div className="rv-dbg-sec">
        {isMobile ? "Slow frames" : "Long tasks"}
        <span className="sp" />
        {lt && (
          <span className="rv-dbg-meta">
            {lt.tbt} {isMobile ? "" : "blocking"} · {lt.n}{" "}
            {isMobile ? "frames" : "tasks"}
          </span>
        )}
      </div>
      <div className="rv-lt">
        {lt?.rows.map(([ts, ms, file], k) => (
          <div key={k} className={`rv-lt-row ${k === 0 ? "slow" : ""}`}>
            <span className="t">{ts}</span>
            <span className="bar">
              <i style={{ width: Math.max(6, (ms / lt.max) * 100) + "%" }} />
            </span>
            <span className="d">
              {ms}
              <i>ms</i>
            </span>
            <span className="f">{file}</span>
          </div>
        ))}
        {/* The web header above is real (count + blocking time), but the
            per-task attribution behind it isn't captured — so the rows say so
            instead of inventing four call sites. */}
        {lt && lt.rows.length === 0 && (
          <div className="rv-perf-empty">
            {isMobile
              ? "No slow frames reported for this session."
              : lt.n > 0
                ? "Per-task attribution isn't captured for this session — only the blocking total above."
                : "No long tasks in this session."}
          </div>
        )}
      </div>

      {/* Network summary (web) — Total requests (exact, from the session's
          precomputed networkCount) + the slowest captured request. Mirrors the
          reference Perf panel's Network section. */}
      {!isMobile && (
        <>
          <div className="rv-dbg-sec">
            Network
            <span className="sp" />
            {slowestReq && (
              <span className="rv-dbg-meta">
                {slowestReq.m} {slowestReq.host}
                {slowestReq.path}
              </span>
            )}
          </div>
          <div className="rv-mpk">
            <div className="rv-mpk-i">
              <span className="ab">Total requests</span>
              <span className="val">{totalReq.toLocaleString()}</span>
            </div>
            <div className="rv-mpk-i">
              <span className="ab">Slowest request</span>
              <span
                className={`val ${slowestReq && slowestReq.dur >= 2000 ? "ni" : ""}`}
              >
                {slowestReq ? `${slowestReq.dur} ms` : "—"}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
