import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/primitives";
import { EvidenceList, storyEvidence } from "./EvidenceList";
import { ee } from "@ee";
import { segmentText, type OverviewStoryline } from "../overview.api";
import type { Signal } from "../overview.data";

/* ============================================================================
   SignalsSection — the ledger of what moved. Analytics-first: with AI off
   this is a complete deterministic surface (thresholded deltas, measured
   counts, timestamps). With AI on, the same ledger gains an analyst lead —
   one correlated finding with evidence and confidence — plus per-row
   confidence and the Ask instrument in the header. The layout never changes
   between modes; the annotation layer does.
   ========================================================================== */

type SignalsSectionProps = {
  ai: boolean;
  items: Signal[];
  count: number;
  story: OverviewStoryline;
  confPct: number | null;
  onConfidence: () => void;
  onAsk: (q?: string) => void;
  onAll: () => void;
  onAct: (s: Signal) => void;
};

export function SignalsSection({
  ai,
  items,
  count,
  story,
  confPct,
  onConfidence,
  onAsk,
  onAll,
  onAct,
}: SignalsSectionProps) {
  // Enterprise Edition: the inline Ask bar exists only in the cloud build; the
  // open-source build has no assistant (ee.AskBar is null), so the whole
  // "Ask Replayfy" header is omitted and Signals renders exactly as before.
  const AskBar = ee.AskBar;
  const [evOpen, setEvOpen] = useState(false);
  const evRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!evOpen) return;
    const h = (e: PointerEvent) => {
      if (evRef.current && !evRef.current.contains(e.target as Node))
        setEvOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [evOpen]);

  // Real supporting evidence for this lead's storyline — empty → plain emphasis.
  const evRows = storyEvidence(story);

  /* Emphasized token in the analyst lead carries the evidence popover. */
  const evidence = (label: string) => (
    <span
      ref={evRef}
      className={"em-bad ev-trigger" + (evOpen ? " open" : "")}
      tabIndex={0}
      onMouseEnter={() => setEvOpen(true)}
      onFocus={() => setEvOpen(true)}
      onClick={() => setEvOpen(true)}
    >
      {label}
      <span className="ev-listpop">
        <span className="elp-h">
          <Icon name="spark" size={11} /> Supporting evidence
        </span>
        <EvidenceList rows={evRows} />
      </span>
    </span>
  );
  const renderLead = (title: string, cause: string) => {
    let emUsed = false;
    const head = segmentText(title).map((seg, i) => {
      // First emphasized delta becomes an evidence trigger only when there is
      // real evidence to show; otherwise it renders as plain emphasis.
      if (seg.kind === "em" && !emUsed && evRows.length) {
        emUsed = true;
        return <Fragment key={i}>{evidence(seg.s)}</Fragment>;
      }
      if (seg.kind === "em")
        return (
          <span key={i} className="em-bad">
            {seg.s}
          </span>
        );
      if (seg.kind === "mono")
        return (
          <span key={i} className="mono">
            {seg.s}
          </span>
        );
      return <span key={i}>{seg.s}</span>;
    });
    // The API's facts text often restates the headline — don't say it twice.
    let rest = cause.trim();
    if (rest.toLowerCase().startsWith(title.trim().toLowerCase())) {
      rest = rest.slice(title.trim().length).replace(/^[\s—–·:,-]+/, "");
    }
    const body = segmentText(rest).map((seg, i) =>
      seg.kind === "em" ? (
        <b key={i}>{seg.s}</b>
      ) : seg.kind === "mono" ? (
        <span key={i} className="mono">
          {seg.s}
        </span>
      ) : (
        <span key={i}>{seg.s}</span>
      ),
    );
    return (
      <>
        {head}
        {rest ? " — " : ""}
        {body}
      </>
    );
  };

  return (
    <section className="ox-sec" aria-label={ai ? "Signals" : "Needs attention"}>
      {ai && AskBar && (
        <div className="ox-askbar" data-tour="ask">
          <h1 className="ox-askbar-l">
            Ask <span className="brand">Replayfy</span>
          </h1>
          <AskBar onSubmit={onAsk} />
        </div>
      )}

      <div className="ox-sec-h">
        <span className="t">{ai ? "Signals" : "Needs attention"}</span>
        <span className="m ox-num">
          {count} active ·{" "}
          {ai
            ? "correlated from sessions, funnels, crashes and deploys"
            : "thresholded against your trailing 30-day baseline"}
        </span>
        <span className="sp" />
        <button className="ox-link" onClick={onAll}>
          View all <Icon name="arrowR" size={11} />
        </button>
      </div>

      {ai && (
        <p className="ox-lead">
          <Icon
            name="spark"
            size={11}
            style={{
              color: "var(--accent)",
              display: "inline-block",
              verticalAlign: "-1px",
              marginRight: "var(--sp-8)",
            }}
          />
          {story && (story.causeText || story.factsText) ? (
            renderLead(story.title, story.causeText || story.factsText || "")
          ) : (
            <>
              Checkout conversion is {evidence("down 8.4%")} since{" "}
              <span className="mono">v1.6.2</span> — the drop correlates with{" "}
              <b>Release 1.6.2</b>: <b>Android</b> checkout latency rose{" "}
              <span className="mono">180ms → 2.4s</span> and 3,180 sessions
              abandoned at payment. iOS and Web are unaffected.
            </>
          )}{" "}
          <button
            className="ox-conf"
            onClick={onConfidence}
            title="Why this confidence — see the reasoning"
          >
            {confPct ?? 93}% confidence
          </button>
        </p>
      )}

      <div className="ox-sigs">
        {items.slice(0, ai ? 4 : 5).map((f, i) => (
          <button className="ox-sig" key={i} onClick={() => onAct(f)}>
            <span className={`ox-sig-ic ${f.sev}`}>
              <Icon name={f.ic} size={14} />
            </span>
            <span className="ox-sig-t">{f.t}</span>
            <span className="ox-sig-side">
              {ai && f.conf > 0 && (
                <span title={`Model confidence ${f.conf}%`}>{f.conf}%</span>
              )}
              <span>{f.time}</span>
              <span className="ox-sig-go">{f.act} →</span>
            </span>
            {f.d && <span className="ox-sig-d">{f.d}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
