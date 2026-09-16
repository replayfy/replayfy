import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/primitives";
import type { Signal } from "../overview.data";
import type { AiState } from "./SignalInvestigation";

/* ============================================================================
   SignalsWorkspace — the Signals drawer as ONE expanding investigation surface.

   Not a drawer stacked on a drawer. The surface is right-anchored, so growing
   its width moves its LEFT edge outward: the signals panel visibly slides left
   while the investigation panel is revealed on the right, as one continuous
   workspace. The signals panel keeps a fixed pixel width throughout, so its
   content never reflows — there is no layout jump, only the container growing.

   Master-detail semantics:
     - row / Investigate  → opens the investigation panel (expand)
     - View sessions      → leaves for Recordings (handled by the caller)
     - investigation close→ collapses back to the full-width signals list,
                            scroll position and selection intact
     - signals close      → dismisses the whole workspace

   All styling lives in the self-contained public/styles/signals-workspace.css.
   ========================================================================== */

/** The signals panel never reflows — it holds this width in both states. */
const SIGNALS_W = 520;
/** Expanded workspace ≈ 80% of the viewport, with a sane cap on wide screens. */
const EXPANDED_FRACTION = 0.8;
const EXPANDED_MAX = 1440;

/** ~200ms spring: deep enough to feel physical, short enough to feel instant. */
const SPRING = { type: "spring" as const, stiffness: 520, damping: 44, mass: 0.9 };
/** How long the exit animation is given before the node is dropped. */
const EXIT_MS = 240;

function useViewportWidth(): number {
  const [w, setW] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

const CLOSE_ICON = <Icon name="x" size={15} />;

/* Triage order — the reading order of the list. */
const SEVERITY: Array<{ sev: Signal["sev"]; one: string; many: string }> = [
  { sev: "bad", one: "Critical", many: "Critical" },
  { sev: "warn", one: "Warning", many: "Warnings" },
  { sev: "good", one: "Opportunity", many: "Opportunities" },
  { sev: "info", one: "Trend", many: "Trends" },
];

/** Metadata is typed: a release, a code locus and a plain label are different
 *  things and must not read the same. */
function badgeKind(t: string): "rel" | "code" | "plain" {
  if (/^(deploy|release|build|v?\d+\.\d+)/i.test(t) || /\d+\.\d+(\.\d+)?/.test(t))
    return "rel";
  if (/^[/#.]/.test(t) || t.includes("/") || /_/.test(t)) return "code";
  return "plain";
}

/** Users scan: the first sentence explains, the rest recedes. */
function splitLead(d: string): [string, string] {
  const m = /^(.{20,}?[.!?])\s+(.+)$/s.exec(d.trim());
  return m ? [m[1], m[2]] : [d, ""];
}

const CONF_TIER = (c: number) => (c >= 90 ? "hi" : c >= 65 ? "md" : "");

/* ---- one signal row ----------------------------------------------------- */
/* An inbox row, not a card. Three deliberate levels: headline (with the
   severity pip), one explaining sentence, then a metadata band. The action
   lives at the end of that band and owns the row on hover. */
function SignalRow({
  s,
  ai,
  selected,
  busyFunnel,
  onOpen,
  onAct,
  onCreateAlert,
}: {
  s: Signal;
  ai: boolean;
  selected: boolean;
  /** This row's create-funnel request is in flight — spin its action button. */
  busyFunnel: boolean;
  onOpen: (s: Signal) => void;
  onAct: (s: Signal) => void;
  onCreateAlert: (s: Signal) => void;
}) {
  // Only signals backed by a real incident or issue can be watched.
  const canAlert = s.incidentId != null || s.issueId != null;
  const delta = s.deltaPct;
  const [lead, rest] = s.d ? splitLead(s.d) : ["", ""];
  return (
    <div
      className={`sigw-row sev-${s.sev}${selected ? " is-sel" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(s)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(s);
        }
      }}
    >
      <div className="sigw-t-row">
        <span className={`sigw-pip sev-${s.sev}`} />
        <span className="sigw-t">{s.t}</span>
      </div>

      {lead && (
        <div className="sigw-d">
          {lead}
          {rest && <span className="rest"> {rest}</span>}
        </div>
      )}

      <div className="sigw-meta">
        {ai && s.conf > 0 && (
          <span className={`sigw-conf ${CONF_TIER(s.conf)}`}>
            <span className="meter">
              <i style={{ width: s.conf + "%" }} />
            </span>
            <b>{s.conf}%</b> confidence
          </span>
        )}
        {s.sessions != null && (
          <span className="sigw-stat">
            <b>{s.sessions.toLocaleString()}</b> sessions
          </span>
        )}
        {s.users != null && (
          <span className="sigw-stat">
            <b>{s.users.toLocaleString()}</b> users
          </span>
        )}
        {delta != null && delta !== 0 && (
          <span className={`sigw-stat ${delta > 0 ? "up" : "down"}`}>
            <b>
              {delta > 0 ? "+" : ""}
              {delta}%
            </b>
          </span>
        )}
        {s.tags.slice(0, 2).map((t) => (
          <span key={t} className={`sigw-badge ${badgeKind(t)}`}>
            {t}
          </span>
        ))}
        {s.recent && (
          <span
            className="sigw-badge live"
            title={`+${s.recent.count} new occurrence${s.recent.count === 1 ? "" : "s"} to ${s.recent.users} ${s.recent.users === 1 ? "user" : "users"} in the last ${s.recent.windowMins / 60} hour`}
          >
            +{s.recent.count} new
          </span>
        )}
        <span className="sigw-time">{s.time}</span>
        <span className="sigw-spacer" />
        {canAlert && (
          <button
            className="sigw-act ghost"
            title="Create an alert for this signal — notify me when it recurs"
            onClick={(e) => {
              e.stopPropagation();
              onCreateAlert(s);
            }}
          >
            <Icon name="bell" size={12} /> Alert
          </button>
        )}
        <button
          className="sigw-act"
          disabled={busyFunnel}
          onClick={(e) => {
            e.stopPropagation();
            if (!busyFunnel) onAct(s);
          }}
        >
          {busyFunnel ? (
            <>
              <span className="sigw-act-spin" /> Creating…
            </>
          ) : (
            <>
              {s.act} <span className="ar">→</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export function SignalsWorkspace({
  open,
  onClose,
  signals,
  ai = true,
  onAct,
  onCreateAlert,
  busyFunnelId,
  renderInvestigation,
}: {
  open: boolean;
  onClose: () => void;
  signals: Signal[];
  ai?: boolean;
  /** The row's own recommended action (View sessions, Create funnel, …). */
  onAct: (s: Signal) => void;
  /** Bind a recurrence alert to the signal's backing incident/issue. */
  onCreateAlert: (s: Signal) => void;
  /** The incident id whose funnel is mid-creation, so that row's button spins. */
  busyFunnelId?: number | null;
  /** The investigation panel's body. `ai` drives the in-panel deeper pass —
   *  "Investigate with AI" never leaves this workspace for a chat. */
  renderInvestigation: (
    s: Signal,
    ai: {
      state: AiState;
      setState: (v: AiState) => void;
      openIncident?: (incidentId: number) => void;
      act?: (s: Signal) => void;
    },
  ) => React.ReactNode;
}) {
  const [sel, setSel] = useState<Signal | null>(null);
  // The deeper AI pass runs INSIDE the investigation panel; this is its state,
  // held here because the trigger lives in the panel header.
  const [aiState, setAiState] = useState<AiState>("idle");
  const reduce = useReducedMotion();
  const vw = useViewportWidth();

  // A new signal is a new investigation — never carry a prior AI run into it.
  useEffect(() => {
    setAiState("idle");
  }, [sel]);

  // Partition by severity so triage order IS the reading order. Empty bands are
  // dropped, so the header only ever claims states that actually exist.
  const groups = SEVERITY.map((g) => ({
    ...g,
    items: signals.filter((s) => s.sev === g.sev),
  })).filter((g) => g.items.length > 0);

  const expandedW = Math.min(vw * EXPANDED_FRACTION, EXPANDED_MAX);
  // Never wider than the viewport on small screens.
  const width = sel ? Math.min(expandedW, vw) : Math.min(SIGNALS_W, vw);

  const closeDetail = useCallback(() => setSel(null), []);

  // A correlated signal swaps the investigation in place — the user stays in the
  // same workspace rather than bouncing out and back in.
  const openIncident = useCallback(
    (incidentId: number) => {
      const match = signals.find((x) => x.incidentId === incidentId);
      if (match) setSel(match);
    },
    [signals],
  );

  // "Investigate" is the deterministic first step — it opens this workspace's
  // own investigation panel, never the AI. Every other action (View sessions,
  // Open crash, Create funnel) leaves for its surface via the caller.
  const handleAct = useCallback(
    (s: Signal) => {
      if (!s.actionKind || s.actionKind === "investigate") {
        setSel(s);
        return;
      }
      onAct(s);
    },
    [onAct],
  );

  // Escape steps BACK out of the investigation before dismissing the workspace,
  // so it mirrors the visual depth the user just moved through.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (sel) closeDetail();
      else onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, sel, closeDetail, onClose]);

  /* Exit without AnimatePresence. This app has already been burned by it twice
     (see PlaylistsFlyout): it strands nodes that were meant to unmount, and a
     Fragment child makes it lose presence entirely — children then sit pinned
     at their `initial` value and never animate in at all. So we do what
     V3Drawer does: keep rendering through the exit behind a flag and drop the
     node on a timer. `detail` trails `sel` the same way, so the investigation
     panel stays mounted while the surface springs back to list width instead of
     vanishing a frame early. */
  const [render, setRender] = useState(open);
  const [detail, setDetail] = useState<Signal | null>(null);

  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    const t = setTimeout(() => {
      setRender(false);
      setSel(null);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (sel) {
      setDetail(sel);
      return;
    }
    const t = setTimeout(() => setDetail(null), EXIT_MS);
    return () => clearTimeout(t);
  }, [sel]);

  const transition = reduce ? { duration: 0 } : SPRING;

  if (!render) return null;

  return (
    <>
      <motion.div
        className="sigw-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: reduce ? 0 : 0.18 }}
        onClick={onClose}
      />
      <motion.aside
        className="sigw"
        role="dialog"
        aria-label="Signals"
        /* x in PIXELS, never "100%": a percentage resolves against the element's
           own width, and we animate that width too — so the target keeps moving
           and the spring never converges. */
        initial={reduce ? { width } : { x: width, width }}
        animate={{ x: open ? 0 : width, width }}
        transition={transition}
      >
            {/* ---- signals panel (fixed width — never reflows) ---- */}
            <div
              className="sigw-panel sigw-signals"
              style={{ width: Math.min(SIGNALS_W, vw) }}
            >
              <div className="sigw-head">
                <div className="sigw-head-main">
                  <div className="sigw-head-t">Signals</div>
                  {/* The header states the product's CONDITION, not a bare count. */}
                  <div className="sigw-comp">
                    {groups.map((g) => (
                      <span className="sigw-comp-i" key={g.sev}>
                        <span className={`sigw-pip sev-${g.sev}`} />
                        <b>{g.items.length}</b>{" "}
                        {g.items.length === 1 ? g.one : g.many}
                      </span>
                    ))}
                  </div>
                  <div className="sigw-head-s">
                    Continuously updated by Replayfy AI
                  </div>
                </div>
                <button className="sigw-x" onClick={onClose} aria-label="Close signals">
                  {CLOSE_ICON}
                </button>
              </div>
              <div className="sigw-body">
                {groups.map((g) => (
                  <section className="sigw-group" key={g.sev}>
                    <div className="sigw-group-h">
                      <span className={`sigw-pip sev-${g.sev}`} />
                      <span className="sigw-group-t">
                        {g.items.length === 1 ? g.one : g.many}
                      </span>
                      <span className="sigw-group-n">{g.items.length}</span>
                      <span className="sigw-group-rule" />
                    </div>
                    {g.items.map((s, i) => (
                      <SignalRow
                        key={s.id ?? `${g.sev}-${i}`}
                        s={s}
                        ai={ai}
                        selected={!!sel && sel === s}
                        busyFunnel={
                          s.actionKind === "create_funnel" &&
                          s.incidentId != null &&
                          s.incidentId === busyFunnelId
                        }
                        onOpen={setSel}
                        onAct={handleAct}
                        onCreateAlert={onCreateAlert}
                      />
                    ))}
                  </section>
                ))}
              </div>
            </div>

            {/* ---- investigation panel (sibling, brighter surface) ---- */}
            {detail && (
                <motion.div
                  className="sigw-panel sigw-detail"
                  initial={reduce ? { opacity: 1 } : { opacity: 0, x: 18 }}
                  animate={{ opacity: sel ? 1 : 0, x: sel ? 0 : 18 }}
                  transition={transition}
                >
                  <div className="sigw-head">
                    <div className="sigw-head-main">
                      <div className="sigw-head-t">
                        {detail.titleText ?? detail.t ?? "Investigation"}
                      </div>
                      <div className="sigw-head-s">
                        Replayfy investigated this signal across your sessions
                      </div>
                    </div>
                    {/* The AI report is INCIDENT-only, by design rather than by
                        omission. An incident is a behavioural cluster, so "why"
                        is inferential and worth a model; an issue is a
                        fingerprint group whose evidence — release boundary,
                        reach, the sessions themselves — is read off directly.
                        Offering the button on an issue and then answering "no
                        incident behind it to investigate" is the dead end this
                        replaces: say so up front instead. */}
                    {detail.incidentId != null ? (
                      <button
                        className="sigw-ai"
                        onClick={() => setAiState("running")}
                        disabled={aiState === "running"}
                      >
                        <Icon name="spark" size={11} fill />{" "}
                        {aiState === "running"
                          ? "Investigating…"
                          : aiState === "done"
                            ? "Re-run AI investigation"
                            : "Investigate with AI"}
                      </button>
                    ) : (
                      <span className="sigw-ai-na" title="AI investigation reasons about behavioural incidents. This signal is a grouped error, so its evidence is reported directly.">
                        Evidence-based signal
                      </span>
                    )}
                    <button
                      className="sigw-x"
                      onClick={closeDetail}
                      aria-label="Close investigation"
                    >
                      {CLOSE_ICON}
                    </button>
                  </div>
                  <div className="sigw-body">
                    {renderInvestigation(detail, {
                      state: aiState,
                      setState: setAiState,
                      openIncident,
                      act: onAct,
                    })}
                  </div>
                </motion.div>
              )}
          </motion.aside>
    </>
  );
}
