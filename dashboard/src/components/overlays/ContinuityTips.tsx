/* ============================================================================
   ContinuityTips.tsx — shared "continuity" hover primitive.
   Matches the chart-tooltip feel: ONE floating element that SLIDES between
   triggers instead of each trigger fading its own popover.
     • ContinuityTips — one dark tooltip that glides across a group of triggers
   (useMovingHL lives in @/hooks.)
   ========================================================================== */
import { type MouseEvent as ReactMouseEvent, type ReactNode, useRef, useState } from "react";

type ContinuityItem = { node: ReactNode; tip: ReactNode };

type ContinuityTipsProps = {
  items: ContinuityItem[];
  className?: string;
  width?: number;
  gap?: number;
  tone?: string;
};

export function ContinuityTips({ items, className = '', width = 250, gap = 10, tone = 'dark' }: ContinuityTipsProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [act, setAct] = useState<number | null>(null);
  const [top, setTop] = useState(0);
  const clampX = (x: number) => {
    const ww = wrapRef.current ? wrapRef.current.offsetWidth : 9999;
    return Math.max(width / 2 + 2, Math.min(ww - width / 2 - 2, x));
  };
  const track = (i: number, e: ReactMouseEvent<HTMLDivElement>) => {
    const w = wrapRef.current!.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    if (tipRef.current) tipRef.current.style.left = clampX(e.clientX - w.left) + 'px'; // x tracks cursor 1:1
    const nt = r.top - w.top;
    setAct((p) => (p === i ? p : i));
    setTop((p) => (Math.abs(p - nt) < 0.5 ? p : nt));
  };
  return (
    <div className={`ct-wrap ${className}`} ref={wrapRef} onMouseLeave={() => setAct(null)}>
      {items.map((it, i) => (
        <div className="ct-item" key={i} onMouseEnter={(e) => track(i, e)} onMouseMove={(e) => track(i, e)}>{it.node}</div>
      ))}
      <div ref={tipRef} className={`ct-tip ${tone} ${act != null ? 'on' : ''}`}
        style={{ top, transform: `translate(-50%, calc(-100% - ${gap}px))`, width }}>
        {act != null && items[act].tip}
      </div>
    </div>
  );
}
