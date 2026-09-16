import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/primitives";
import { EvidenceList, storyEvidence } from "./EvidenceList";
import { SkAttRows, SkStoryBody, SkText } from "./OverviewSkeletons";
import { segmentText, type OverviewStoryline } from "../overview.api";
import type { Signal } from "../overview.data";

/* ============================================================================
   OverviewStory — the featured card in the top band's freed space.
     • AI on  → the analyst Storyline: a Replayfy-AI pill, confidence chip
       (ⓘ → reasoning drawer), a headline whose emphasized delta reveals the
       supporting evidence, the cause paragraph, and a "View signals" action
       that opens the signals drawer.
     • AI off → a deterministic "Needs attention" card: the top thresholded
       signals and a "View all" into the same drawer.
   ========================================================================== */

type OverviewStoryProps = {
  ai: boolean;
  story: OverviewStoryline;
  /** The AI-authored storyline headline (intelligence pass). When present it is
   *  the lead the model chose and takes precedence over the deterministic `story`;
   *  null falls back to `story` (AI off or a degraded pass). */
  aiStory?: string | null;
  confPct: number | null;
  signals: Signal[];
  count: number;
  onConfidence: () => void;
  onAllSignals: () => void;
  onAct: (s: Signal) => void;
  /** The card's body source (/overview) hasn't landed — shimmer the story or
   *  the attention rows rather than showing the design fixture as findings. */
  loading?: boolean;
  /** The confidence chip's own source (/intelligence) is still in flight. It
   *  resolves separately from the story, so it shimmers on its own. */
  confLoading?: boolean;
};

export function OverviewStory({ ai, story, aiStory, confPct, signals, count, onConfidence, onAllSignals, onAct, loading, confLoading }: OverviewStoryProps) {
  const [evOpen, setEvOpen] = useState(false);
  const evRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!evOpen) return;
    const h = (e: PointerEvent) => { if (evRef.current && !evRef.current.contains(e.target as Node)) setEvOpen(false); };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [evOpen]);

  if (!ai) {
    return (
      <div className="ox-story2 det">
        <div className="ox-story2-k">
          <span className="ox-att-chip"><Icon name="warn" size={12} /> Needs attention</span>
          {/* the count is counted from the read — never a fixture's length */}
          <span className="k-sub ox-num">{loading ? <SkText w={96} /> : `${count} above threshold`}</span>
          <span className="sp" />
          <button className="ox-story2-all" onClick={onAllSignals}>View all <Icon name="arrowR" size={11} /></button>
        </div>
        {loading ? (
          <SkAttRows />
        ) : (
          <div className="ox-att-list">
            {signals.slice(0, 3).map((s, i) => (
              <button className="ox-att-row" key={i} onClick={() => onAct(s)}>
                <span className={`dot ${s.sev}`} />
                <span className="ox-att-t">{s.t}</span>
                <span className="ox-att-time">{s.time}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Emphasis polarity: a POSITIVE storyline's delta is a win (green), not a
  // regression (red). Without a storyline there is nothing to emphasize.
  const bad = story ? story.polarity !== "POSITIVE" : true;
  const emCls = bad ? "em-bad" : "em-good";

  // Real supporting evidence for THIS storyline's facts. Empty → the emphasized
  // delta renders as plain emphasis with no popover (never a fixture list).
  const evRows = storyEvidence(story);

  const evidence = (label: string) => (
    <span ref={evRef} className={`${emCls} ev-trigger` + (evOpen ? " open" : "")} role="button" tabIndex={0}
      aria-haspopup="true" aria-expanded={evOpen} aria-label={`${label} — supporting evidence`}
      onMouseEnter={() => setEvOpen(true)} onFocus={() => setEvOpen(true)} onClick={() => setEvOpen((o) => !o)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEvOpen((o) => !o); } else if (e.key === "Escape") setEvOpen(false); }}>
      {label}
      <span className="ev-listpop" aria-hidden={!evOpen}>
        <span className="elp-h"><Icon name="spark" size={11} /> Supporting evidence</span>
        <EvidenceList rows={evRows} />
      </span>
    </span>
  );

  const renderHeadline = (title: string) => {
    let emUsed = false;
    return segmentText(title).map((seg, i) => {
      // Only the first emphasized delta becomes an evidence trigger, and only
      // when there is real evidence to show — otherwise it's plain emphasis.
      if (seg.kind === "em" && !emUsed && evRows.length) { emUsed = true; return <Fragment key={i}>{evidence(seg.s)}</Fragment>; }
      if (seg.kind === "em") return <span key={i} className={emCls}>{seg.s}</span>;
      if (seg.kind === "mono") return <span key={i} className="mono">{seg.s}</span>;
      return <span key={i}>{seg.s}</span>;
    });
  };
  const renderCause = (text: string) => segmentText(text).map((seg, i) =>
    seg.kind === "em" ? <b key={i}>{seg.s}</b> : seg.kind === "mono" ? <span key={i} className="mono">{seg.s}</span> : <span key={i}>{seg.s}</span>);

  const cause = story ? (story.causeText || story.factsText) : null;

  // Split the AI storyline into a headline (first sentence) + supporting detail so
  // it fits the existing headline/paragraph structure without any restyle.
  const aiParts = aiStory ? aiStory.split(/(?<=[.!?])\s+/) : [];
  const aiHead = aiParts[0] ?? aiStory ?? "";
  const aiRest = aiParts.slice(1).join(" ");

  return (
    <div className="ox-story2" data-tour="storyline">
      <div className="ox-story2-k">
        <span className="ox-ai-chip2"><Icon name="spark" size={10} fill /> Replayfy AI</span>
        <span className="k-label">Storyline</span>
        {/* The confidence chip only appears with a real, model-scored storyline —
            no fixture 93%. Its separator rides with it so nothing dangles. */}
        {confLoading ? (
          <><span className="k-dot">·</span><span className="ox-conf2"><SkText w={82} h={9} /></span></>
        ) : confPct != null ? (
          <><span className="k-dot">·</span>
          <button className="ox-conf2" onClick={onConfidence} title="Why this confidence — see the reasoning">
            {confPct}% confidence <Icon name="chip" size={11} />
          </button></>
        ) : null}
        <span className="sp" />
        <button className="ox-story2-all" onClick={onAllSignals}>View signals <Icon name="arrowR" size={11} /></button>
      </div>
      {/* Hold the storyline on its skeleton while the AI pass is still in flight —
          don't paint the fast deterministic /overview storyline first and then
          swap it for the AI lead (the "flash"). Once the pass lands we show the
          AI story; if it finishes with no AI headline (AI off / degraded),
          confLoading is false and we fall through to the deterministic story. */}
      {loading || (confLoading && !aiStory) ? (
        <SkStoryBody />
      ) : aiStory ? (
        // The AI-authored lead. Plain prose (the model writes no markup), so it
        // renders as-is — no emphasis/evidence segmentation.
        <>
          <h2 className="ox-story2-h">{aiHead}</h2>
          {aiRest && <p className="ox-story2-p">{aiRest}</p>}
        </>
      ) : story ? (
        <>
          <h2 className="ox-story2-h">{renderHeadline(story.title)}</h2>
          {cause && <p className="ox-story2-p">{renderCause(cause)}</p>}
        </>
      ) : signals.length ? (
        // AI is on but hasn't authored a storyline for this window yet — surface
        // the measured signals rather than inventing a narrative.
        <div className="ox-att-list">
          {signals.slice(0, 3).map((s, i) => (
            <button className="ox-att-row" key={i} onClick={() => onAct(s)}>
              <span className={`dot ${s.sev}`} />
              <span className="ox-att-t">{s.t}</span>
              <span className="ox-att-time">{s.time}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="ox-story2-p ox-dim">No storyline yet — not enough signal in this window to call a lead.</p>
      )}
    </div>
  );
}
