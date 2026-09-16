import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/** Observes an element's width (rounded device px) via ResizeObserver so charts
 *  render at true pixel width and markers stay perfectly circular. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const nw = Math.round(entries[0].contentRect.width);
      setW((prev) => (Math.abs(prev - nw) < 1 ? prev : nw));
    });
    ro.observe(ref.current);
    setW(Math.round(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
