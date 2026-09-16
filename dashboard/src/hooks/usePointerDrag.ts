import { type PointerEvent as ReactPointerEvent, useRef } from "react";

export type DragStart = { x: number; y: number };

type DragOpts = {
  onStart?: (e: ReactPointerEvent) => void;
  onMove: (e: PointerEvent, start: DragStart) => void;
  onEnd?: (e: PointerEvent, start: DragStart) => void;
  /** Cursor to apply to <body> for the duration of the drag (e.g. "ew-resize"). */
  cursor?: string;
};

/** Generic pointer-drag: returns an onPointerDown handler that tracks move/up on
 *  document (so the drag continues outside the element) with multi-touch guard. */
export function usePointerDrag({ onStart, onMove, onEnd, cursor }: DragOpts) {
  const active = useRef(false);
  return (e: ReactPointerEvent) => {
    e.preventDefault();
    if (active.current) return; // ignore extra touch points mid-drag
    active.current = true;
    const start: DragStart = { x: e.clientX, y: e.clientY };
    onStart?.(e);
    if (cursor) document.body.style.cursor = cursor;
    const move = (ev: PointerEvent) => onMove(ev, start);
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (cursor) document.body.style.cursor = "";
      active.current = false;
      onEnd?.(ev, start);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
}
