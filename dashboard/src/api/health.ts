import { useSyncExternalStore } from "react";

/* ============================================================================
   Can we reach the backend?

   TWO signals, because neither alone is sufficient:

   1. REAL REQUEST OUTCOMES, reported by client.ts. This is the only thing that
      can catch "the network is fine but our API is down":
        · fetch REJECTS  → the request never landed (DNS, refused, CORS
                           preflight) → unreachable.
        · fetch RESOLVES → the server answered. ANY status counts, including
                           500: a server returning an error is a reachable
                           server, and this store must not claim otherwise.

   2. THE BROWSER'S OFFLINE EVENT — and this one is NOT optional, which cost us
      a bug. TanStack's networkMode defaults to 'online', so when
      navigator.onLine is false it PAUSES every query: the queryFn never runs,
      fetch is never called, and signal 1 never fires. Detection built on
      request outcomes alone is therefore blind to the most common outage there
      is — the user actually being offline — and the app just sits there.

   navigator.onLine is only trustworthy in ONE direction, so that is the only
   way it is used here:
     · onLine === false → treat as unreachable, but only after the same grace
                          period a failed request gets. The browser is not
                          guessing about the interface, but it fires this on
                          transient blips too, and a blip must not paint a
                          full-screen error.
     · onLine === true  → proves nothing (it is true behind a captive portal and
                          true when our API is down). It can only CANCEL a
                          pending grace period; reachability is re-established
                          solely by a real response via signal 1.
   ========================================================================== */

type Listener = () => void;

let online = typeof navigator === "undefined" ? true : navigator.onLine;
let confirming: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

/* A single dropped request is usually a blip. Flipping the whole page to the
   error state on the first failure would blank the app and then snap back —
   worse than the failure itself. So the first miss only ARMS a grace period;
   ANY sign of life inside the window disarms it and resets the counter.

   6s is derived, not picked. The app's own recovery attempt is React Query's
   retry, and queryClient.ts sets `retry: 1` with the default exponential
   backoff — the retry does not even START until ~1000ms. The previous 1200ms
   window therefore left the retry ~200ms to complete a full round-trip, so any
   endpoint slower than that (e.g. an uncached /dashboard/counts) lost the race
   and flashed the error screen, only for the retry to land at ~1400ms and clear
   it again. That flash WAS the system self-healing 200ms too late.

   6s = the ~1s retry delay + a full 5s for the slowest p99 round-trip. Below
   ~3s the retry has no room and the flash returns; much above ~8s a genuine
   outage starts to feel unhandled. */
const CONFIRM_MS = 6000;

function emit(): void {
  listeners.forEach((l) => l());
}

export function isBackendReachable(): boolean {
  return online;
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Start the grace period, or leave a running one alone. Only when it expires
 *  un-disarmed do we actually claim the backend is unreachable. */
function arm(): void {
  if (!online || confirming) return;
  confirming = setTimeout(() => {
    confirming = null;
    online = false;
    emit();
  }, CONFIRM_MS);
}

/** Cancel a running grace period — the counter resets, and the next failure
 *  starts a fresh full window rather than resuming a nearly-expired one. */
function disarm(): void {
  if (!confirming) return;
  clearTimeout(confirming);
  confirming = null;
}

/** A request never reached the server. Arms the offline state (debounced). */
export function reportUnreachable(): void {
  arm();
}

/** The server answered, at any status. Disarms/clears the offline state. */
export function reportReachable(): void {
  disarm();
  if (online) return;
  online = true;
  emit();
}

/* Signal 2 (see header). The `offline` event is the ONLY reason this file
   listens to the browser at all: without it, TanStack pauses every query while
   offline and no request ever runs to report the outage.

   It goes through the SAME grace period as a failed request, and that is the
   whole point. Chrome on macOS emits spurious offline→online pairs on Wi-Fi
   power-save, VPN/interface changes and sleep/wake — exactly the "sat on a page
   for a few seconds" profile. This listener used to flip the state
   synchronously, so every one of those blips painted the full-screen error.

   The `online` listener exists only to DISARM: coming back does not prove the
   backend is reachable, so it never sets `online = true` on its own. If
   connectivity returns inside the window we simply never show the screen; if we
   already showed it, a real response still has to clear it (NetworkError probes
   on this same event, and that probe landing is what calls reportReachable). */
if (typeof window !== "undefined") {
  window.addEventListener("offline", arm);
  window.addEventListener("online", disarm);
}

/** `true` while the backend is reachable. */
export function useBackendReachable(): boolean {
  return useSyncExternalStore(subscribe, isBackendReachable, isBackendReachable);
}
