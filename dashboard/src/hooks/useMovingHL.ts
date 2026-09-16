import { type MouseEvent as ReactMouseEvent, type RefObject, useRef, useState } from "react";

export type HL = { top: number; left: number; width: number; height: number } | null;

/** A single highlight pill that slides behind whichever list item is hovered
 *  (chart-tooltip feel). Spread `ref` on the container, `onEnter/onLeave` on
 *  each item, and position an absolutely-placed pill from `hl`. */
export function useMovingHL<T extends HTMLElement>(): {
  ref: RefObject<T>;
  hl: HL;
  onEnter: (e: ReactMouseEvent<HTMLElement>) => void;
  onLeave: () => void;
} {
  const ref = useRef<T>(null);
  const [hl, setHl] = useState<HL>(null);
  const onEnter = (e: ReactMouseEvent<HTMLElement>) => {
    if (!ref.current) return;
    const c = ref.current;
    const w = c.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    // The pill is absolutely positioned INSIDE this container, so measure the item
    // against the container's CONTENT box, not its viewport rect. When the container
    // is itself the scroller (.fn-ac-list / .fn-ep-list are max-height + overflow-y:auto
    // with the pill inside), a plain rect-diff drops scrollTop and the pill lags a row
    // behind the cursor / sticks on an upper row. scrollTop|Left are 0 for containers
    // that don't scroll (e.g. CoValueInput, whose list scrolls on an OUTER element), so
    // every other caller is unaffected.
    setHl({
      top: r.top - w.top + c.scrollTop,
      left: r.left - w.left + c.scrollLeft,
      width: r.width,
      height: r.height,
    });
  };
  const onLeave = () => setHl(null);
  return { ref, hl, onEnter, onLeave };
}
