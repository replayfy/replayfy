import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Within this many px of the bottom counts as "at the bottom". */
const NEAR_BOTTOM_PX = 48;

/**
 * Stick-to-bottom scrolling with user override, for a streaming chat transcript
 * (a common streaming-chat pattern).
 *
 * While the viewer is pinned to the bottom, the scroll position FOLLOWS new
 * content — instantly, so it never lags behind fast token updates. The moment
 * they scroll up, following stops and `showJump` goes true, so the caller can
 * offer a "Latest" pill; `scrollToBottom(true)` smooth-scrolls down and re-pins.
 * Scrolling back to the bottom by hand re-pins as well.
 *
 * Height changes are watched with a ResizeObserver on the scroll element's first
 * child (the growing content), so streaming growth is caught regardless of cause
 * — tokens, a table reflowing, an image loading — not just React re-renders.
 * Scroll reads are rAF-throttled and the listener is passive, so this stays off
 * the critical path during a fast stream.
 *
 * `active` gates the observers to when a transcript is actually mounted; pass
 * `false` for the empty/welcome state so nothing observes the wrong node.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  { reduceMotion = false, active = true }: { reduceMotion?: boolean; active?: boolean } = {},
) {
  const [showJump, setShowJump] = useState(false);
  // autoScrollEnabled — begin pinned so the first answer is visible.
  const pinned = useRef(true);
  // True while OUR OWN smooth scroll-to-bottom animates. A smooth scroll reports
  // !bottom for its intermediate positions, which would otherwise flash the pill
  // on every send / "Latest" click; this suppresses that. Instant scrolls land
  // at the bottom in one frame, so they never need it.
  const suppress = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout>>();

  const scrollToBottom = useCallback(
    (smooth = false) => {
      const el = scrollRef.current;
      if (!el) return;
      pinned.current = true;
      setShowJump(false);
      const useSmooth = smooth && !reduceMotion;
      if (useSmooth) {
        suppress.current = true;
        clearTimeout(suppressTimer.current);
        // Cleared early when we actually reach the bottom (onScroll); this is the
        // backstop in case the smooth scroll is interrupted and never arrives.
        suppressTimer.current = setTimeout(() => {
          suppress.current = false;
        }, 500);
      }
      el.scrollTo({ top: el.scrollHeight, behavior: useSmooth ? "smooth" : "auto" });
    },
    [scrollRef, reduceMotion],
  );

  useEffect(() => {
    if (!active) {
      setShowJump(false);
      return;
    }
    const el = scrollRef.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;

    const nearBottom = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;

    // Content grew (a new turn, or tokens streaming in).
    let growRaf = 0;
    const onGrow = () => {
      if (growRaf) return;
      growRaf = requestAnimationFrame(() => {
        growRaf = 0;
        if (pinned.current) {
          el.scrollTop = el.scrollHeight; // instant — never trail the stream
        } else {
          setShowJump(true);
        }
      });
    };
    const ro = new ResizeObserver(onGrow);
    ro.observe(content);

    // The viewer scrolled — re-derive state SYNCHRONOUSLY. This must not be
    // deferred to rAF: scroll events run before rAF callbacks within a frame, so
    // setting `pinned` here (before the next `onGrow` rAF reads it) is what stops
    // a fast stream from yanking the view back to the bottom the instant the user
    // scrolls up. Deferring it lets a same-frame growth callback re-pin first.
    //
    // The pill shows whenever the view is away from the bottom — not only when
    // new content arrives — so it is a consistent "jump to latest" any time you
    // have scrolled up, during or after a stream (fixing "sometimes it doesn't
    // show"). `suppress` hides it for the app's own smooth scroll-to-bottom,
    // whose mid-flight positions momentarily read as !bottom. Any real user
    // scroll (wheel, keyboard, scrollbar, touch) fires this and shows the pill.
    const onScroll = () => {
      const bottom = nearBottom();
      pinned.current = bottom;
      if (bottom) {
        suppress.current = false;
        setShowJump(false);
      } else if (!suppress.current) {
        setShowJump(true);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      if (growRaf) cancelAnimationFrame(growRaf);
      clearTimeout(suppressTimer.current);
    };
  }, [scrollRef, active]);

  return { showJump, scrollToBottom };
}
