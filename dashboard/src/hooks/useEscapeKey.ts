import { useEffect, useRef } from "react";

/** Calls `handler` on Escape while `active`. Handler ref keeps the listener
 *  stable across renders (no rebind churn). */
export function useEscapeKey(handler: () => void, active = true): void {
  const cb = useRef(handler);
  cb.current = handler;
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [active]);
}
