import { type RefObject, useEffect, useRef } from "react";

/** Fires `handler` on a mousedown outside every provided ref, while `active`. */
export function useOutsideClick(
  refs: RefObject<HTMLElement> | Array<RefObject<HTMLElement>>,
  handler: () => void,
  active = true,
): void {
  const cb = useRef(handler);
  cb.current = handler;
  useEffect(() => {
    if (!active) return;
    const list = Array.isArray(refs) ? refs : [refs];
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (list.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
