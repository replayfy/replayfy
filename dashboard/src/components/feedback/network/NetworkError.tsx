import { useCallback, useEffect, useRef, useState } from "react";
import { Auth } from "@/api/endpoints";
/* Inlined at build time, NOT <img src="/illustrations/…">. An offline state
   cannot fetch its own illustration: the browser blocks the request like any
   other, the img fails, and (being alt="" + aria-hidden) it collapses to
   nothing — the state rendered headline-and-buttons with a hole where the art
   should be. `?raw` bundles the file into the JS, so the art is already in
   memory by the time it's ever needed. The .svg stays the single source. */
import art from "./network-error.svg?raw";

/* ============================================================================
   Shown in the content region (the shell stays) when the backend is
   unreachable, instead of leaving the page stuck on skeletons forever.

   It heals itself. While mounted it probes every 5s and on the browser's
   `online` event; any answer from the server — even a 401 — makes client.ts
   report reachability, which flips the store, unmounts this, and remounts the
   real page. The page's queries then fire fresh, so the user lands on real
   data without touching anything. "Retry now" only shortcuts the same probe.
   ========================================================================== */

const PROBE_MS = 5000;

type NetworkErrorProps = {
  /** What to call to test reachability. Any request through the api client
   *  works — the reachability report is a side effect of the call, and the
   *  result is never inspected. Defaults to Auth.me for the authed app; the
   *  share viewer passes its own so a public page never calls /v1/me. */
  probe?: () => Promise<unknown>;
};

export function NetworkError({ probe: probeFn }: NetworkErrorProps = {}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /* Auth.me is the probe because it goes through the api client, so the
     reachability report is a side effect of the call — we don't interpret the
     result at all. A 401 is a perfectly good answer here: the server spoke. */
  const probe = useCallback(async () => {
    if (!alive.current) return;
    setBusy(true);
    try {
      await (probeFn ? probeFn() : Auth.me());
    } catch {
      /* still unreachable (or an auth error) — either way client.ts has
         already reported the truth; nothing to do but wait for the next tick */
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [probeFn]);

  useEffect(() => {
    const id = setInterval(() => void probe(), PROBE_MS);
    // Cheap hint, not a source of truth: the OS says an interface came back, so
    // it's worth probing NOW rather than waiting out the interval.
    const onOnline = () => void probe();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", onOnline);
    };
  }, [probe]);

  return (
    <div className="empty nx">
      <div>
        {/* Deliberately not `.empty-art`: that carries a heavy
            drop-shadow(0 18px 24px) + float, and this illustration is drawn to
            be crisp and architectural. */}
        <div
          className="nx-art"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: art }}
        />
        <div className="nx-head">
          <span className="nx-caret">&gt;</span>Connection lost
        </div>
        <p>
          We can't reach your workspace right now. Your data is safe — Replayfy
          keeps trying in the background and will reconnect on its own the
          moment the link is back.
        </p>
        <div className="empty-actions">
          <button
            className="btn primary"
            onClick={() => void probe()}
            disabled={busy}
          >
            {busy ? "Retrying…" : "Retry now"}
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </div>
    </div>
  );
}
