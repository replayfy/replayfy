import { useEffect, useRef } from "react";

/** Subscribe to a window event for the lifetime of the component. */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (e: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  const cb = useRef(handler);
  cb.current = handler;
  useEffect(() => {
    const fn = (e: WindowEventMap[K]) => cb.current(e);
    window.addEventListener(type, fn, options);
    return () => window.removeEventListener(type, fn, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
}
