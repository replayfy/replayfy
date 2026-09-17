import {
  type ComponentProps,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { useStickToBottom } from "@/hooks";
import type { AskInvestigation as AskInvestigationComponent } from "../drawers/AskInvestigation";

/* AskInvestigation is the app's ONLY react-markdown consumer, and it drags in
   the whole remark-gfm + micromark tokenizer chain (~40KB gzip). It used to be a
   static import, and because AskProvider mounts this panel in AppLayout — the
   eager app shell — that chain shipped in the ENTRY chunk and was downloaded and
   parsed on every authenticated route (and, before route-splitting, on /login
   too) whether or not anyone opened Ask.

   The panel itself must stay eagerly mounted: it owns the floating FAB that has
   to be on screen everywhere. But the transcript below only renders once a
   conversation exists, so deferring THIS component moves the markdown stack out
   of the shell and loads it the first time a user actually gets an answer.

   The type-only import above is erased at compile time, so `AIProps` keeps its
   exact shape with no runtime cost. */
const AskInvestigation = lazy(() =>
  import("../drawers/AskInvestigation").then((m) => ({
    default: m.AskInvestigation,
  })),
);

type AIProps = ComponentProps<typeof AskInvestigationComponent>;

/* Quick-start prompts (ours) shown on the empty welcome screen. */
const QUICK: { icon: string; label: string }[] = [
  { icon: "funnel", label: "Why did conversion drop this week?" },
  { icon: "warn", label: "What's hurting stability right now?" },
  { icon: "spark", label: "Summarize my product health" },
  { icon: "users", label: "Which segment is churning fastest?" },
];

type Props = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /* False when no model provider is resolved (self-host with LLM_* unset, or a
     disabled workspace). The composer is swapped for a "set up AI" notice so a
     question never streams into a guaranteed failure. Defaults to true so a
     configured server never flashes the disabled state while the config loads. */
  aiReady?: boolean;
  /* Whether this member can reach Settings → AI to fix it themselves; when false
     the notice points them at a workspace admin instead of a dead link. */
  canConfigureAi?: boolean;
  session: AIProps["session"];
  onAsk: (q: string) => void;
  onNew: () => void;
  onConfirm: AIProps["onConfirm"];
  onClarify: AIProps["onClarify"];
  onAction: AIProps["onAction"];
  onCitation: AIProps["onCitation"];
};

/* ============================================================================
   AskPanel — a floating AI chat. A pill FAB in the bottom-right
   springs open (transform-origin: bottom right; scale/opacity 0→1) into a
   floating side panel that overlays the app without a heavy backdrop. It opens
   to an empty welcome state (no auto-asked message) with our own quick prompts,
   can be maximized, and collapses back into the FAB on close.
   ========================================================================== */
export function AskPanel({
  open,
  onOpen,
  onClose,
  aiReady = true,
  canConfigureAi = true,
  session,
  onAsk,
  onNew,
  onConfirm,
  onClarify,
  onAction,
  onCitation,
}: Props) {
  const reduce = useReducedMotion();
  const [max, setMax] = useState(false);
  const [text, setText] = useState("");

  // Stick-to-bottom scrolling with a "Latest" escape hatch. The scroll element
  // is .askp-body; the hook follows streaming content while pinned and reveals
  // the pill when the reader scrolls up. `active` only once a transcript exists.
  const bodyRef = useRef<HTMLDivElement>(null);
  const { showJump, scrollToBottom } = useStickToBottom(bodyRef, {
    reduceMotion: !!reduce,
    active: session.messages.length > 0,
  });

  /* Drives the welcome copy's staggered reveal (.t-stagger / .is-shown).
     TWO frames, not one: the first lets the browser paint the lines in their
     resting state (down 12px, blurred, transparent), the second flips
     .is-shown so the transition has something to animate FROM. Setting it in a
     single frame can batch with the initial paint, and the reveal silently
     never plays. Keyed on `open` because AskPanel itself stays mounted — only
     the panel body comes and goes — so a mount-once effect would fire for the
     FAB and never again. */
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    /* Fallback, and NOT optional. rAF is suspended entirely while the document
       is hidden — measured here: 0 frames in 700ms — so the double-rAF above
       can simply never complete, leaving every line parked at opacity 0. The
       copy would be permanently invisible, which is a far worse failure than a
       skipped animation. A timer still fires when hidden (throttled), so the
       text always arrives even if the reveal doesn't get to play. */
    const fallback = setTimeout(() => setShown(true), 120);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(fallback);
    };
  }, [open]);

  const send = () => {
    const q = text.trim();
    if (!q) return;
    setText("");
    onAsk(q);
    // Sending is an explicit intent to see the reply — always re-pin, even if the
    // reader had scrolled up. Instant (not smooth): the new turn should appear at
    // once and then stream in followed to the bottom, rather than smooth-scrolling
    // toward a target that the incoming content immediately moves.
    scrollToBottom(false);
  };

  // Spring open/close from the bottom-right (per the motion spec).
  const spring = reduce
    ? { duration: 0 }
    : { type: "spring" as const, duration: 0.24, bounce: 0.15 };

  /* Press feedback for the morphing control, in framer rather than CSS.
     `.askp-fab:active { transform: scale(.97) }` ships in the approved sheet
     and stopped working the moment this button gained a `layoutId`: framer
     writes an inline `transform` every frame, and inline beats a stylesheet
     rule, so the CSS press was silently dead. `whileTap` is composed WITH the
     layout transform instead of being overwritten by it. */
  const press = reduce ? undefined : { scale: 0.97 };
  const grow = reduce
    ? { initial: false as const, animate: {}, exit: {} }
    : {
        initial: { scale: 0.92, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        /* The collapse has to be SEEN arriving at the button, so opacity holds
           while the panel shrinks and is only cut at the end. Fading on the
           same curve as the scale — the old `exit: {scale:0, opacity:0}` — left
           the panel invisible long before it got small, which is what made it
           read as vanishing on the spot instead of going somewhere. */
        exit: {
          scale: 0,
          opacity: 0,
          transition: {
            scale: { type: "spring" as const, duration: 0.26, bounce: 0 },
            opacity: { duration: 0.12, delay: 0.14 },
          },
        },
      };

  const empty = session.messages.length === 0;

  return (
    <>
      {/* ONE control, two shapes. The shared `layoutId` is what makes framer
          morph the purple pill into the quiet text button parked beneath the
          open panel, instead of one popping out while the other pops in.

          No AnimatePresence: exactly one branch is mounted at all times, and a
          layoutId handoff between them IS the animation — wrapping it in
          enter/exit would fight the morph with a scale/fade it doesn't need.

          The label is deliberately unchanged across states. It stays "Ask AI"
          because it is still the Ask AI control; pressing it while open just
          puts it away. */}
      {!open ? (
        <motion.button
          layoutId="askp-morph"
          className="askp-fab"
          onClick={onOpen}
          aria-label="Ask AI"
          transition={spring}
          whileTap={press}
        >
          {/* layout="position" so the label slides rather than being stretched
              by the parent's box morph — scaling text looks like a smear. */}
          <motion.span className="askp-morph-l" layout="position">
            <Icon name="spark" size={16} fill /> Ask AI
          </motion.span>
        </motion.button>
      ) : (
        <motion.button
          layoutId="askp-morph"
          className="askp-dismiss"
          onClick={onClose}
          aria-label="Close Ask AI"
          transition={spring}
          whileTap={press}
        >
          <motion.span className="askp-morph-l" layout="position">
            <Icon name="spark" size={14} fill /> Ask AI
          </motion.span>
        </motion.button>
      )}

      {/* Panel — expanded state */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="askp"
            className={"askp" + (max ? " max" : "")}
            role="dialog"
            aria-label="Ask Replayfy AI"
            /* Grow out of, and collapse back into, the Ask AI button — not the
               panel's own corner. Measured: the button is 98×44 at
               right:24/bottom:24, so its centre lands 49px inside this panel's
               right edge and 20px BELOW its bottom edge (the panel is inset
               bottom:66 to clear the button). transform-origin is not clamped
               to the box, so it can address a point outside it. Anchored to the
               right edge, this holds for `.max` too.

               `bottom right` was the intent before, but never applied: the
               `layout` prop that used to be here made framer own
               transform-origin and overwrite it inline with 50% 50% — the panel
               scaled from its own middle and evaporated in place. `layout` is
               gone for that reason; maximize/restore now springs via a CSS
               width/height transition in motion-v2.css instead. */
            style={{ transformOrigin: "calc(100% - 49px) calc(100% + 20px)" }}
            transition={spring}
            {...grow}
          >
            <header className="askp-head">
              <span className="askp-title">
                <Icon name="spark" size={14} fill /> Ask Replayfy AI
              </span>
              <span style={{ flex: 1 }} />
              <button
                className="askp-icon"
                onClick={() => setMax((m) => !m)}
                title={max ? "Restore" : "Maximize"}
                aria-label={max ? "Restore" : "Maximize"}
              >
                {max ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 6.5H13M9.5 6.5V3M9.5 6.5 13.5 2.5M6.5 9.5H3M6.5 9.5V13M6.5 9.5 2.5 13.5" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2.5H13.5V6.5M6.5 13.5H2.5V9.5M13.5 2.5 9 7M2.5 13.5 7 9" />
                  </svg>
                )}
              </button>
              <button
                className="askp-icon"
                onClick={onClose}
                title="Minimize"
                aria-label="Minimize"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M3.5 8h9" />
                </svg>
              </button>
              <button
                className="askp-icon"
                onClick={onClose}
                title="Close"
                aria-label="Close"
              >
                <Icon name="x" size={15} />
              </button>
            </header>

            <div className="askp-body" ref={bodyRef}>
              {empty ? (
                <div className={`askp-welcome t-stagger ${shown ? "is-shown" : ""}`}>
                  <span className="askp-orb t-stagger-line t-stagger-line--1">
                    <Icon name="spark" size={22} fill />
                  </span>
                  <div className="askp-welcome-t t-stagger-line t-stagger-line--2">
                    Ask Replayfy AI
                  </div>
                  <div className="askp-welcome-d t-stagger-line t-stagger-line--3">
                    {aiReady
                      ? "Ask anything about your product — conversion, stability, segments, or a specific session."
                      : "Replayfy AI needs a model provider before it can answer."}
                  </div>
                  {/* The chips reveal as ONE line rather than four: they're a
                      menu of peers, not a sequence, and giving each its own
                      line would push the last one past 800ms. When AI has no
                      provider the prompts would only stream into a failure, so
                      they're replaced by the one action that fixes it. */}
                  <div className="askp-quick t-stagger-line t-stagger-line--4">
                    {aiReady ? (
                      QUICK.map((q) => (
                        <button
                          key={q.label}
                          className="askp-chip"
                          onClick={() => onAsk(q.label)}
                        >
                          <Icon name={q.icon} size={13} /> {q.label}
                        </button>
                      ))
                    ) : canConfigureAi ? (
                      <Link
                        to="/settings/ai"
                        className="askp-chip"
                        onClick={onClose}
                      >
                        <Icon name="settings" size={13} /> Set up AI in settings
                      </Link>
                    ) : (
                      <span className="askp-chip" aria-disabled="true">
                        <Icon name="settings" size={13} /> Ask an admin to set up
                        AI
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="askp-transcript">
                  {/* Fallback is deliberately empty: the chunk is small and the
                      panel is already on screen with its own streaming state, so
                      a spinner here would flash for a frame and read as jank. */}
                  <Suspense fallback={null}>
                    <AskInvestigation
                      session={session}
                      onConfirm={onConfirm}
                      onClarify={onClarify}
                      onAction={onAction}
                      onCitation={onCitation}
                    />
                  </Suspense>
                </div>
              )}
            </div>

            {/* "Latest" escape hatch — appears only when new content arrived
                while the reader was scrolled up. The wrapper does the centering
                so framer's y/opacity animation on the button doesn't fight a
                translateX (inline transform beats the stylesheet). */}
            <div className="askp-jump-wrap">
              <AnimatePresence>
                {showJump && (
                  <motion.button
                    key="jump"
                    className="askp-jump"
                    onClick={() => scrollToBottom(true)}
                    initial={reduce ? false : { y: 8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={reduce ? { opacity: 0 } : { y: 8, opacity: 0 }}
                    transition={{
                      duration: reduce ? 0 : 0.18,
                      ease: [0.23, 1, 0.32, 1],
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6.5 8 10.5l4-4" />
                    </svg>
                    Latest
                  </motion.button>
                )}
              </AnimatePresence>
            </div>

            <footer className="askp-foot">
              {aiReady ? (
                <>
                  <button
                    className="askp-new"
                    onClick={() => {
                      setText("");
                      onNew();
                    }}
                    data-tip="New chat"
                    aria-label="New chat"
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  <div className="askp-input">
                    <input
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") send();
                      }}
                      placeholder="Ask about a metric, funnel, or session…"
                    />
                  </div>
                  <button
                    className="askp-send"
                    onClick={send}
                    disabled={!text.trim()}
                    aria-label="Send"
                  >
                    <Icon name="arrowR" size={14} />
                  </button>
                </>
              ) : (
                /* No provider resolved: don't offer an input that can only
                   fail. A quiet, full-width notice takes the composer's place
                   and routes whoever can fix it to the right screen. */
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--sp-8)",
                    width: "100%",
                    padding: "var(--sp-6) var(--sp-8)",
                    fontSize: "var(--text-sm)",
                    lineHeight: 1.4,
                    color: "var(--text-2, #667085)",
                  }}
                >
                  <Icon name="spark" size={14} fill />
                  <span>
                    AI isn't set up yet.{" "}
                    {canConfigureAi ? (
                      <Link
                        to="/settings/ai"
                        onClick={onClose}
                        style={{ fontWeight: 600 }}
                      >
                        Add a provider key →
                      </Link>
                    ) : (
                      "Ask a workspace admin to add a provider key."
                    )}
                  </span>
                </div>
              )}
            </footer>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
