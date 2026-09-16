import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";

type MobileSheetProps = {
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the sheet surface (e.g. to cap height for a given drawer). */
  className?: string;
  /** Hide the grab handle. */
  noHandle?: boolean;
};

/**
 * Bottom sheet — the mobile (<=768px) treatment our side drawers adopt, in the
 * spirit of a native sheet: slides up from the bottom, rounded top, and a grab
 * handle you can drag down to dismiss (drag past ~110px or flick). Desktop never
 * renders this — callers gate on useIsMobile() and keep their original panel —
 * so it is a purely additive, mobile-only surface.
 *
 * Drag is armed ONLY from the grab handle (useDragControls + dragListener=false)
 * so the sheet body scrolls independently: no tug-of-war between the dismiss
 * gesture and scrolling long content. Enter AND exit both animate — an internal
 * `open` flag drives AnimatePresence and onExitComplete fires the caller's
 * onClose, so a backdrop tap / drag-dismiss / Escape slides the sheet out before
 * the caller unmounts it. (A programmatic close that unmounts us directly just
 * disappears, which is fine — the gesture dismissals are the ones users feel.)
 */
export function MobileSheet({ onClose, children, className, noHandle }: MobileSheetProps) {
  const reduce = useReducedMotion();
  const controls = useDragControls();
  const [open, setOpen] = useState(false);

  // Mount closed, flip open next frame so the slide-up transition runs.
  useEffect(() => {
    setOpen(true);
  }, []);

  // Ask to close: play the exit, then (onExitComplete) tell the caller.
  const requestClose = () => setOpen(false);

  // Lock the page behind the sheet while it's up.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape closes (animated).
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, []);

  const spring = reduce
    ? { duration: 0 }
    : { type: "spring" as const, damping: 36, stiffness: 360, mass: 0.9 };

  return createPortal(
    <AnimatePresence onExitComplete={onClose}>
      {open && (
        <motion.div
          className="msheet-ov"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={requestClose}
        >
          <motion.div
            className={"msheet" + (className ? " " + className : "")}
            onClick={(e) => e.stopPropagation()}
            drag="y"
            dragControls={controls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) requestClose();
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={spring}
            role="dialog"
            aria-modal="true"
          >
            {!noHandle && (
              <div
                className="msheet-grab"
                onPointerDown={(e) => controls.start(e)}
                aria-hidden="true"
              >
                <span />
              </div>
            )}
            <div className="msheet-scroll">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
