/* ============================================================================
   V3Drawer.tsx — shared right-side drawer for Overview V3.
   Reuses the EXACT recordings share-drawer shell (.rv-sd-* classes from
   recordings-v2.css): slide-in, soft backdrop, drag-to-dismiss, resize,
   sequenced entrance.
   ========================================================================== */
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon, MobileSheet } from "@/components/primitives";
import { useIsMobile } from "@/hooks";

/* The signals drawer's spring — deep enough to feel physical, short enough to
   feel instant (~230ms settle). Reused here so the cohort builder and the
   overview drawers share one smooth arrival curve instead of a flat CSS slide.
   Drag/resize still move the panel directly (spring bypassed). */
const SPRING = { type: "spring" as const, stiffness: 520, damping: 44, mass: 0.9 };

type V3DrawerProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
};

export function V3Drawer({ open, onClose, title, subtitle, width: initW = 480, children, footer }: V3DrawerProps) {
  const [render, setRender] = useState(open);
  const [inn, setInn] = useState(false);
  const [width, setWidth] = useState(initW);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const reduce = useReducedMotion();
  const isMobile = useIsMobile();

  useEffect(() => {
    if (open) { setRender(true); setDrag(0); const t = setTimeout(() => setInn(true), 24); return () => clearTimeout(t); }
    setInn(false);
  }, [open]);
  useEffect(() => { if (!open && render) { const t = setTimeout(() => setRender(false), 440); return () => clearTimeout(t); } }, [open, render]);
  useEffect(() => { if (!open || isMobile) return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [open, isMobile]);

  /* Mobile (<=768px): a drag-to-dismiss bottom sheet instead of the right-side
     panel. Reuses the SAME head/body/foot markup (rv-sd-* classes), minus the
     desktop-only resize + horizontal drag. MobileSheet owns its own slide/exit,
     so we render it straight off `open` and skip the desktop render/exit gate.
     Desktop rendering below is completely untouched. */
  if (isMobile) {
    return open ? (
      <MobileSheet onClose={onClose} className="msheet-v3">
        <div className="rv-sd-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="rv-sd-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>
        <div className="rv-sd-body">{children}</div>
        {footer && <div className="rv-sd-foot" style={{ display: 'flex', alignItems: 'center', gap: "var(--sp-10)" }}>{footer}</div>}
      </MobileSheet>
    ) : null;
  }

  if (!render) return null;

  const onHandleDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX; setDragging(true);
    const move = (ev: PointerEvent) => { let dx = ev.clientX - startX; if (dx < 0) dx = -Math.pow(-dx, 0.72); setDrag(dx); };
    const up = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      setDragging(false);
      const dx = ev.clientX - startX;
      if (dx > width * 0.35) onClose(); else setDrag(0);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };
  const onResizeDown = (e: ReactPointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const move = (ev: PointerEvent) => setWidth(Math.max(420, Math.min(660, window.innerWidth - ev.clientX)));
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  };

  // Off-screen target is the panel's own width + a little to clear the shadow.
  // Open → 0; closing → off; dragging → follow the finger (spring bypassed).
  const off = width + 40;
  const x = dragging ? drag : (open ? 0 : off);
  const backdropOp = inn && open ? Math.max(0, 1 - Math.max(0, drag) / width) : 0;

  return (
    <div className={`rv-sd-root v3dr ${inn && open ? 'in' : ''} ${dragging ? 'dragging' : ''}`}>
      {/* pointer-events must be set here: recordings-v2.css gates the backdrop on
          `.rv-sd-root:not(.sd-in)`, but this drawer marks itself open with `in`
          (see the note at pages.css:279 — the animation was ported to `in`, this
          gate wasn't). So :not(.sd-in) always matched, the backdrop was forever
          click-through, and onClose could never fire. Set inline rather than
          adding `sd-in`: that class also carries recordings-v2's own entrance
          delays, which load after pages.css at equal specificity and would
          silently restyle every drawer. Gated on `inn && open` so a drawer
          mid-exit can't swallow a click. */}
      <div
        className="rv-sd-backdrop"
        style={{
          opacity: backdropOp,
          pointerEvents: inn && open ? "auto" : "none",
        }}
        onClick={onClose}
      />
      <motion.aside
        className="rv-sd"
        style={{ width }}
        initial={{ x: reduce ? 0 : off }}
        animate={{ x }}
        transition={dragging || reduce ? { duration: 0 } : SPRING}
        role="dialog"
        aria-label={title}
      >
        <div className="rv-sd-resize" onPointerDown={onResizeDown} title="Drag to resize" />
        <div className="rv-sd-handle" onPointerDown={onHandleDown}><span /></div>
        <div className="rv-sd-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="rv-sd-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>
        <div className="rv-sd-body">{children}</div>
        {footer && <div className="rv-sd-foot" style={{ display: 'flex', alignItems: 'center', gap: "var(--sp-10)" }}>{footer}</div>}
      </motion.aside>
    </div>
  );
}
