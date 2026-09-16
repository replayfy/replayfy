import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Icon } from "./Icon";

type ModalProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Which view is on screen. Give this a NEW value whenever the modal's body
   *  changes to a different step, and the card morphs between them: the shell's
   *  height springs while the old view leaves and the new one crossfades in.
   *  Omit it and the modal renders exactly as before — no morph, no swap.
   *
   *  This is the "same living surface" idea: our two multi-step modals (share =
   *  configure→link, API key = form→reveal) used to swap their whole body in
   *  place, so the card's height JUMPED between steps. Now they expand. */
  viewKey?: string | number;
  /** Confirm style: a compact card with a tinted icon tile leading the header
   *  and no close-X (dismiss via Cancel / Esc / backdrop). Matches the shared
   *  destructive-confirm layout used across the app. */
  icon?: string;
  tone?: "danger";
  /** Leading icon tile in the DEFAULT header (keeps the close-X and subtitle).
   *  Accent by default; pass headerTone="ok" for the green success/reveal state.
   *  Distinct from `icon`, which switches to the compact confirm layout. */
  headerIcon?: string;
  headerTone?: "ok";
  /** Opt-in full-bleed header illustration: a URL under /illustrations, drawn
   *  edge-to-edge above the header. Omit it and the modal renders exactly as
   *  before — `.modal` has no padding of its own and already clips to its
   *  radius, so the band needs no bleed hack. Ignored by the `icon` variant. */
  illustration?: string;
};

/* ---------- Modal ---------- */
export function Modal({ title, subtitle, onClose, children, footer, width = 560, icon, tone, headerIcon, headerTone, illustration, viewKey }: ModalProps) {
  const reduce = useReducedMotion();
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);

  /* 320ms, mid-band of the brief's 280-380ms, with no bounce: the surface is
     carrying a form the user is reading, and overshoot on a block of text reads
     as a wobble rather than as physics. */
  const morph = reduce
    ? { duration: 0 }
    : { type: 'spring' as const, duration: 0.24, bounce: 0 };

  /* Measure the live view and animate the shell to its REAL height.
     This replaces `layout` on the card, which was the bug: framer's layout
     animations fake a size change with scaleX/scaleY, so every child got
     squashed and stretched through the morph — text visibly distorting. The
     reference animates true height (measured on it: 290→354px), and so does
     this. `popLayout` takes the outgoing view out of flow, so `scrollHeight`
     below is already the INCOMING view's height on the very first frame. */
  const measure = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el || viewKey === undefined) return;
    const read = () => setH(el.scrollHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewKey]);
  /* Leaving view slides UP and out, entering view rises IN — so the two never
     look like a crossfade of two stacked cards, they look like one surface
     changing its mind.

     The exit is DELIBERATELY quicker than the enter (asymmetric): when the two
     views differ a lot — share's 7-row config vs the minted-link artifact — a
     symmetric crossfade leaves both at ~50% opacity mid-morph and reads as a
     double-exposure. Clearing the old view fast, then rising the new one in on
     the spring, keeps it "one surface changing its mind" rather than a dissolve.
     Reduced motion keeps the opacity swap, drops the travel. */
  const swap = reduce
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: 0.1 } },
      }
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: {
          opacity: 0,
          y: -6,
          transition: { duration: 0.14, ease: "easeIn" as const },
        },
      };

  // Confirm variant — a self-contained card (uniform 22px padding, header
  // icon tile, footer right-aligned) so it isn't shaped by the default modal's
  // header/body/footer paddings and dividers.
  if (icon) {
    return createPortal(
      <div className="ov" style={{ background: 'rgba(17,17,20,.42)', padding: "var(--sp-20)" }} onClick={onClose}>
        <div style={{ width: '100%', maxWidth: Math.min(width, 424), background: 'var(--surface)', borderRadius: "var(--r-lg)", border: '1px solid var(--line)', boxShadow: '0 12px 28px rgba(17,17,20,.16), 0 32px 64px -22px rgba(17,17,20,.28)', padding: "var(--sp-20)", animation: 'pop .15s var(--ease-out)' }} onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
          <div style={{ display: 'flex', alignItems: 'center', gap: "var(--sp-10)", marginBottom: "var(--sp-10)" }}>
            <span style={{ width: 38, height: 38, flexShrink: 0, borderRadius: "var(--r-lg)", display: 'grid', placeItems: 'center', background: tone === 'danger' ? 'var(--red-weak)' : 'var(--accent-tint)', color: tone === 'danger' ? 'var(--red)' : 'var(--accent)' }}>
              <Icon name={icon} size={17} />
            </span>
            <h3 style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)", letterSpacing: '-.014em', lineHeight: "var(--lh-tight)" }}>{title}</h3>
          </div>
          {children}
          {footer && <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: "var(--sp-8)" }}>{footer}</div>}
        </div>
      </div>,
      document.body,
    );
  }

  /* Body + footer travel together as ONE view: the footer's buttons change with
     the step (Share→Copy link, Generate→Done), so leaving it outside the swap
     would strand yesterday's CTA under today's content mid-morph. */
  const view = (
    <>
      <div className="modal-b">{children}</div>
      {footer && <div className="modal-f">{footer}</div>}
    </>
  );

  return createPortal(
    <div className="ov" onClick={onClose}>
      {/* A PLAIN div, not motion.div: the card itself has no framer animation
          (its entrance is the CSS `modalIn`), and wrapping it in a motion
          component made framer flush the element's style on mount — a second
          synchronous paint of the shadowed card that read as the box-shadow
          "rendering twice" on open. Only the inner morph wrapper below needs
          framer. The shell's height comes from that morph viewport growing
          underneath it — no `layout` prop here (see the measure hook above). */}
      <div
        className="modal"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        {illustration && <div className="modal-illus" aria-hidden="true"><img src={illustration} alt="" /></div>}
        {/* Header and close button sit OUTSIDE the swap — they persist across
            the morph, so the title updates in place and the escape hatch never
            blinks out while the surface is reshaping. */}
        <div className="modal-h">{headerIcon && <span className={"modal-hic" + (headerTone === "ok" ? " ok" : "")} aria-hidden="true"><Icon name={headerIcon} size={17} /></span>}<div className="modal-htx"><h3>{title}</h3>{subtitle && <p className="modal-sub">{subtitle}</p>}</div><button className="modal-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button></div>
        {viewKey === undefined ? (
          view
        ) : (
          <motion.div
            className="modal-morph"
            animate={{ height: h }}
            transition={morph}
            /* The measured wrapper is position:relative so popLayout's absolute
               exiting view anchors to it rather than to the page. */
            style={{ position: 'relative' }}
          >
            <div ref={measure}>
              {/* popLayout pulls the leaving view OUT of flow immediately, so
                  the wrapper reports the INCOMING height on frame 1 and the
                  shell can start moving — without it the card holds the taller
                  view's height until the exit finishes, then jumps. */}
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={viewKey} transition={morph} {...swap}>
                  {view}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </div>
    </div>,
    document.body,
  );
}
