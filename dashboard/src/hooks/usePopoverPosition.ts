import { type RefObject, useLayoutEffect, useState } from "react";

export type PopPos = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  width?: number;
  maxHeight?: number;
};

type Align = "left" | "right";

/** Viewport-clamped placement for a fixed-position popover anchored to a trigger.
 *  Prefers opening downward but flips up (and caps maxHeight) so long menus never
 *  clip off-screen. Returns the position style + a matching transform-origin so
 *  the menu scales from the trigger corner (origin-aware, per emil-design-eng). */
export function usePopoverPosition(
  triggerRef: RefObject<HTMLElement>,
  open: boolean,
  align: Align = "left",
  width?: number | "trigger",
): { pos: PopPos | null; origin: string } {
  const [pos, setPos] = useState<PopPos | null>(null);
  const [origin, setOrigin] = useState("top left");

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setPos(null);
      return;
    }
    const r = triggerRef.current.getBoundingClientRect();
    const w = width === "trigger" ? r.width : typeof width === "number" ? width : 0;
    const gap = 5;
    const margin = 8;
    const desired = 340;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const p: PopPos = {};

    let vert: "top" | "bottom";
    if (below >= Math.min(desired, 160) || below >= above) {
      p.top = r.bottom + gap;
      p.maxHeight = Math.max(140, below);
      vert = "top";
    } else {
      p.bottom = window.innerHeight - r.top + gap;
      p.maxHeight = Math.max(140, above);
      vert = "bottom";
    }

    let horiz: "left" | "right";
    if (align === "right") {
      p.right = window.innerWidth - r.right;
      horiz = "right";
    } else {
      let left = r.left;
      if (w) left = Math.min(left, window.innerWidth - w - 8);
      p.left = Math.max(8, left);
      horiz = "left";
    }
    if (width) p.width = width === "trigger" ? r.width : width;

    setPos(p);
    setOrigin(`${vert} ${horiz}`);
  }, [open, align, width, triggerRef]);

  return { pos, origin };
}
