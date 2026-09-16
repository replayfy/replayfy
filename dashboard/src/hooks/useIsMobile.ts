import { useEffect, useState } from "react";

/**
 * True while the viewport is at or below `bp` px (default 768 — the single
 * mobile breakpoint used throughout responsive-v2.css). Reads matchMedia so the
 * JS branch and the CSS media queries flip at the EXACT same width, and updates
 * live on resize / device rotation. Window-safe (returns false with no window).
 *
 * Used to swap desktop-only surfaces (side drawers) for a mobile bottom sheet
 * and to drive the mobile app-shell nav — never to restyle desktop.
 */
export function useIsMobile(bp = 768): boolean {
  const query = `(max-width: ${bp}px)`;
  const [mobile, setMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMobile(mql.matches);
    onChange();
    // addEventListener is the modern API; addListener is the Safari<14 fallback.
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return mobile;
}
