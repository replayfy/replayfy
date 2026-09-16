import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useInView } from "motion/react";
import NumberFlow from "@number-flow/react";
import { Icon, Select } from "@/components/primitives";
import { FnBars, FnTime } from "@/routes/funnels/charts";
import { useApi } from "@/api/useApi";
import { Funnels } from "@/api/endpoints";
import {
  adaptComputeSteps,
  type ApiFunnelCompute,
  type ApiFunnelTimeline,
  type FnStep,
} from "@/routes/funnels/funnels.data";
import { FUNNEL } from "../overview.data";
import { SkConversionBody, SkText } from "./OverviewSkeletons";

/* ============================================================================
   ConversionSection — bound to the funnel the user PINNED on the Funnels
   page, rendered with the funnel product's own charts: the retention bars
   (FnBars), conversion over time, or just the metric — switched from a View
   dropdown. The funnel name links into its detail page.
   ========================================================================== */

type ViewKind = "steps" | "time" | "metric";

/** Same fade mask PulseBand puts on the numbers at the top of this page, so the
 *  metric reads as one family with them rather than a second kind of roll. */
const NF_MASK = { "--number-flow-mask-height": "0.28em" } as CSSProperties;

/* NumberFlow only animates a CHANGE in value, so mounting it with the final
   number already set renders it static — switching to Metric showed the answer
   with no roll. Mount at 0, then step to the real value on the next frame so
   there IS a transition to play. Keyed by the caller on the view, so this
   re-runs on every switch back rather than once per page load. */
function RollingPct({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return (
    <NumberFlow
      value={shown}
      format={{ maximumFractionDigits: 1 }}
      suffix="%"
      style={NF_MASK}
    />
  );
}

/** Design fixture → builder steps (used until the funnels list resolves). */
const FIXTURE_STEPS: FnStep[] = FUNNEL.map((s) => ({
  kind: "event",
  matchType: "equals",
  value: s.ev,
  cur: s.cnt,
}));
const FIXTURE_PREV: number[] = [100, 65.1, 40.4, 22.6, 11.2].map((p) =>
  Math.round((FUNNEL[0].cnt * p) / 100),
);

type ConversionSectionProps = {
  periodNote: string;
  conv: {
    pct: string;
    deltaPt: string;
    dir: "up" | "down";
    prev: string;
  } | null;
  funnel: ApiFunnelCompute | null;
  funnelsReady: boolean;
  hasPinned: boolean;
  /** Either the pinned-funnel lookup or its compute is still in flight, so we
   *  don't yet know WHICH funnel this section tracks — let alone its numbers.
   *  Until then the fixture below claims a "purchase funnel" the workspace may
   *  not even have. */
  loading?: boolean;
  onOpenFunnels: (id?: number | null) => void;
};

export function ConversionSection({
  periodNote,
  conv,
  funnel,
  funnelsReady,
  hasPinned,
  loading,
  onOpenFunnels,
}: ConversionSectionProps) {
  const navigate = useNavigate();
  const [view, setView] = useState<ViewKind>("steps");
  const [sel, setSel] = useState(0);
  const live = !!funnel;

  /* The charts animate on MOUNT, and this section sits well below the fold — so
     the bars grew and the metric rolled while nobody was looking, and you
     scrolled down to an already-finished animation. Hold the render until the
     section is actually on screen. `once` keeps it from replaying every time it
     scrolls past; the -80px margin starts it just before the top edge, so it
     reads as playing on arrival rather than starting late. */
  const secRef = useRef<HTMLElement>(null);
  const inView = useInView(secRef, { once: true, margin: "-80px" });

  // Conversion over time for the pinned funnel — one POST /v1/funnels/timeline,
  // fired only while that view is open (and never for the design fixture).
  // Sent by `funnelId`, not by steps+range like the builder: the builder's
  // funnel may be unsaved, but a pinned funnel is persisted, so the endpoint
  // resolves its stored steps AND its own windowDays. That keeps the chart on
  // the window the header names — a `range` token would override the window
  // server-side, and the overview's today/24h tokens aren't in the endpoint's
  // range map, so they'd silently fall back to 7d.
  const { data: tl } = useApi<ApiFunnelTimeline>(
    () => Funnels.timeline<ApiFunnelTimeline>({ funnelId: funnel!.funnelId }),
    [funnel?.funnelId],
    { enabled: view === "time" && !!funnel?.funnelId },
  );
  const noPin = funnelsReady && !hasPinned;
  const steps: FnStep[] = live ? adaptComputeSteps(funnel) : FIXTURE_STEPS;
  const prev = live ? undefined : FIXTURE_PREV;
  const started = live ? funnel.startedFunnel : FUNNEL[0].cnt;
  const overall = live
    ? `${Math.round(funnel.overallConversionPct * 10) / 10}%`
    : conv
      ? conv.pct
      : "8.5%";
  // The metric view rolls this with NumberFlow, which needs it numeric. Parsed
  // off the same string the conv line renders rather than re-derived, so the two
  // readings of the same number can never disagree.
  const overallNum = parseFloat(overall);

  /* Step drill-down — the same navigation the funnels page does, off the same
     compute we already hold (dropOffSessionIds), so it costs no extra request.
     Passing it is also what makes FnBars render its View button at all: the prop
     is optional and gates the button, so without it the row hover had nothing to
     swap the count for. Fixture rows have no real ids, hence live-only. */
  const viewStepSessions =
    live && funnel.dropOffSessionIds
      ? (i: number) => {
          const ids = funnel.dropOffSessionIds?.[i] ?? [];
          const label = steps[i]?.value ?? "";
          const p = new URLSearchParams();
          if (ids.length) p.set("sessionIds", ids.join(","));
          if (label) p.set("fnstep", label);
          const qs = p.toString();
          navigate("/recordings" + (qs ? `?${qs}` : ""));
        }
      : undefined;

  // Biggest adjacent drop — same derivation the funnel page uses.
  let worstIdx = -1,
    worstDrop = 0;
  steps.forEach((s, i) => {
    if (i === 0 || !steps[i - 1].cur) return;
    const d = (steps[i - 1].cur - s.cur) / steps[i - 1].cur;
    if (d > worstDrop) {
      worstDrop = d;
      worstIdx = i;
    }
  });
  const worst = worstIdx > 0 ? steps[worstIdx] : null;

  return (
    <section className="ox-sec" aria-label="Conversion" ref={secRef}>
      <div className="ox-sec-h">
        <span className="t">Conversion</span>
        <span className="m">
          {loading ? (
            <SkText w={210} />
          ) : live ? (
            <>
              <button
                className="ox-fnl-name"
                onClick={() => onOpenFunnels(funnel.funnelId)}
                title="Open this funnel"
              >
                {funnel.name}
              </button>{" "}
              · pinned funnel · {funnel.windowDays}d window · by {funnel.metric}
            </>
          ) : (
            "purchase funnel · all platforms"
          )}
        </span>
        <span className="sp" />
        <Select
          value={view}
          width={196}
          label="View"
          options={[
            { value: "steps", label: "Funnel steps" },
            { value: "time", label: "Conversion over time" },
            { value: "metric", label: "Metric only" },
          ]}
          onChange={(v) => setView(v as ViewKind)}
        />
      </div>

      {/* Ahead of the no-pin guard: `noPin` needs `funnelsReady` to mean
          anything, and until the list resolves "nothing is pinned" and "we
          haven't looked yet" are the same state on screen. */}
      {loading ? (
        <SkConversionBody />
      ) : noPin ? (
        <div className="ox-none" style={{ padding: "var(--sp-24) var(--sp-2)" }}>
          <Icon name="funnel" size={15} />
          <span style={{ flex: 1, minWidth: 0 }}>
            No funnel is pinned to the overview. Pin one from the Funnels page
            and its live conversion will track here.
          </span>
          <button className="btn sm" onClick={() => onOpenFunnels(null)}>
            <Icon name="funnel" size={12} /> Choose a funnel
          </button>
        </div>
      ) : (
        <>
          <div className="ox-conv-line">
            <span className="big">{overall}</span>
            {!live && (
              <span
                className={`ox-tr ${conv ? conv.dir : "down"}`}
                style={{ fontSize: "var(--text-sm)" }}
              >
                <span className="ar">
                  {conv && conv.dir === "up" ? "▲" : "▼"}
                </span>
                {conv ? conv.deltaPt : "2.7pt"}
              </span>
            )}
            <span className="lbl">end-to-end conversion</span>
            <span className="prev">
              {started.toLocaleString()} sessions entered · {periodNote}
            </span>
          </div>

          {view === "steps" &&
            (live && started === 0 ? (
              <div className="ox-none">
                <Icon name="clock" size={14} /> No sessions entered this funnel
                in the selected period.
              </div>
            ) : (
              /* Keyed on the per-step counts so a resolving/changing funnel
                 remounts FnBars and replays its grow-in (initial→animate only
                 fires on mount) — same reason the funnels page keys it. */
              /* Keyed on inView as well as the counts: the key flip is what
                 remounts FnBars the moment the section arrives, so its grow-in
                 plays on arrival instead of having finished off-screen. It still
                 renders while out of view (at its final size), so the rows hold
                 their space and nothing below shifts.

                 `animateIn={inView}` is what makes that last sentence TRUE, and
                 without it the bars grew TWICE. The grow-in is initial→animate,
                 which fires on mount wherever the element is — including off
                 screen — and useInView reports false for the first render and
                 flips true only once the observer has run. So the mount played
                 it, the key flip remounted and played it again, and if this
                 section happened to be on screen already you watched both. The
                 out-of-view mount is now silent; the arrival remount is the one
                 and only performance. */
              <FnBars
                key={`${inView ? "v" : "h"}:${live ? "l" : "f"}:${steps.map((s) => s.cur).join("-")}`}
                animateIn={inView}
                steps={steps}
                sel={sel}
                onSel={setSel}
                compare={!live}
                prev={prev}
                onViewSessions={viewStepSessions}
              />
            ))}
          {/* null → "Computing…", [] → FnTime's own empty state. Never a fixture. */}
          {view === "time" && <FnTime points={tl?.points ?? null} />}
          {view === "metric" && (
            <div className="ox-conv-only ox-num">
              {/* Keyed on the value so switching back to Metric remounts and the
                  roll replays. maximumFractionDigits mirrors `overall`'s own
                  Math.round(x*10)/10 exactly — a minimumFractionDigits would
                  print 100 as "100.0" here while the conv line above still read
                  "100%". */}
              <span className="giant">
                <RollingPct
                  key={`${inView ? "v" : "h"}:${overallNum}`}
                  value={inView ? overallNum : 0}
                />
              </span>
              <span className="ctx">
                of sessions that entered{" "}
                <b>{live ? funnel.name : "the purchase funnel"}</b> completed
                every step · {periodNote}
              </span>
            </div>
          )}

          {view === "steps" && worst && (started > 0 || !live) && (
            <div className="ox-fnl-note">
              <Icon name="warn" size={13} className="ic" />
              <span style={{ flex: 1, minWidth: 0 }}>
                Biggest leak: <b>{worst.value}</b> —{" "}
                {Math.round(worstDrop * 100)}% of sessions drop at this step ·{" "}
                <span className="ox-num">
                  {(steps[worstIdx - 1].cur - worst.cur).toLocaleString()}
                </span>{" "}
                lost.
              </span>
              <button
                className="ox-link"
                onClick={() => viewStepSessions?.(worstIdx - 1)}
              >
                {/* dropOffSessionIds[i] = the (200-capped) sessions that REACHED
                    step i. The leak is the drop INTO worstIdx, so worstIdx-1 opens
                    the sessions that were AT the leak — the drop-offs plus the few
                    who converted through (worstIdx would wrongly open only the
                    converters). This mirrors the funnel page's reached-set "View
                    sessions" drill-down; an exact server-side drop-off scope is a
                    follow-up. */}
                <Icon name="play" size={11} fill /> Replay drop-offs
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
