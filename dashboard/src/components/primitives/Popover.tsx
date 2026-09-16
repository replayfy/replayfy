import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Pos = { top?: number; bottom?: number; left?: number; right?: number; width?: number; maxHeight?: number };

type PopoverProps = {
  trigger: ReactNode;
  children: ReactNode | ((args: { close: () => void }) => ReactNode);
  align?: "left" | "right";
  width?: number | "trigger";
  /** Extra class on the portaled menu panel — lets a caller theme its own
   *  dropdown (e.g. the dark install SDK selector) without affecting others. */
  menuClass?: string;
};

/* ---------- popover (portal-free, fixed) ----------
   Reveal is origin-aware: the menu scales from the trigger corner it opened
   out of. The open direction (below/above × left/right) is stamped on the panel
   as `data-side`, and the stylesheet maps it to the matching transform-origin.

   The old sliding "continuity" pill (a `.pop-hl` that chased the cursor between
   rows via elementFromPoint) is gone — rows now highlight with a plain hover
   background, one standard across every menu. */
export function Popover({ trigger, children, align = 'left', width, menuClass }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const w = width === 'trigger' ? r.width : (width || 0);
    // vertical: prefer opening downward, but flip up when downward can't fit a
    // full menu AND upward has more room — so a tall fixed-height panel (the date
    // picker) uses the roomier side instead of clipping to a short scroll window.
    // When neither side fits `desired`, we still pick the larger and cap+scroll.
    const gap = 5, margin = 8, desired = 340;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const p: Pos = {};
    if (below >= desired || below >= above) {
      p.top = r.bottom + gap;
      p.maxHeight = Math.max(140, below);
    } else {
      p.bottom = window.innerHeight - r.top + gap;
      p.maxHeight = Math.max(140, above);
    }
    // Clamp the right edge to the viewport: a trigger that sits at (or past) the
    // right edge — e.g. a wide toolbar's date picker — must not push a wide panel
    // off-screen. Never let `right` go below the margin.
    if (align === 'right') p.right = Math.max(margin, window.innerWidth - r.right);
    else {
      let left = r.left;
      // clamp within viewport so menus in a right-docked drawer don't clip off-screen
      if (w) left = Math.min(left, window.innerWidth - w - 8);
      p.left = Math.max(8, left);
    }
    if (width) p.width = width === 'trigger' ? r.width : width;
    setPos(p);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current?.contains(e.target as Node) || popRef.current?.contains(e.target as Node)) return; setOpen(false); };
    const onScroll = (e: Event) => { if (popRef.current?.contains(e.target as Node)) return; setOpen(false); };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);
  // Which corner did the menu open from? vertical (b/t = below/above the trigger)
  // + horizontal (l/r = aligned left/right). The stylesheet scales from the
  // matching corner so the reveal grows out of the trigger, flipped or not.
  const side = pos ? (pos.top !== undefined ? 'b' : 't') + (align === 'right' ? 'r' : 'l') : undefined;
  // Portal the menu to <body> so position:fixed resolves against the viewport,
  // not a transformed ancestor (e.g. the drag-transformed V3Drawer/share drawer).
  const menu = open && pos ? (
    <div className={menuClass ? `menu-pop ${menuClass}` : 'menu-pop'} data-side={side} ref={popRef} style={{ position: 'fixed', ...pos }} onClick={(e) => e.stopPropagation()}>
      {typeof children === 'function' ? children({ close: () => setOpen(false) }) : children}
    </div>
  ) : null;
  return (
    <span ref={ref} style={{ display: 'inline-flex' }}>
      <span className={open ? 'pop-tw open' : 'pop-tw'} onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {menu && createPortal(menu, document.body)}
    </span>
  );
}
