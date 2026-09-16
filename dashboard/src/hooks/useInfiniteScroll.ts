import { type RefObject, useEffect, useRef } from "react";

/** Calls `onMore` whenever the sentinel scrolls into view (IntersectionObserver). */
export function useInfiniteScroll(
  sentinelRef: RefObject<HTMLElement>,
  onMore: () => void,
  opts?: { root?: Element | null; rootMargin?: string },
): void {
  const cb = useRef(onMore);
  cb.current = onMore;
  const root = opts?.root ?? null;
  const rootMargin = opts?.rootMargin ?? "200px";
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) cb.current();
      },
      { root, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sentinelRef, root, rootMargin]);
}
