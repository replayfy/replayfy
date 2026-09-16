/* ===========================================================================
   Web session player — hosts rrweb's Replayer inside a fixed browser window
   that mirrors the reference PlayerStage EXACTLY.

   `batches` is the raw payload from GET /v1/sessions/:id/events; each
   batch.events[] carries data.rrwebEvent. We extract those, build the Replayer,
   and expose the imperative transport (play/pause/goto/setSpeed/getCurrentTime)
   the HUD bridges to.

   Rendering — matches the reference `.player-screen` verbatim: a FIXED window
   (`width: min(880px, 92%)`, `aspect-ratio: 16/10`, hairline border + the soft
   `--shadow-1`), a 28px browser chrome, and a `.stage-body` in which rrweb's own
   iframe (rendered at the recorded viewport) is CENTER-scaled to fit. Because
   the window is a fixed CSS size and only the inner iframe scales — with NO CSS
   transition — there is no "zoom-in" on first open: the frame is stable, the
   content simply appears at its fitted scale.
   ========================================================================== */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EventType, Replayer, type eventWithTime } from "rrweb";
import "rrweb/dist/style.css";
import type { ReplayBatch, RvPlayerHandle } from "./playerTypes";

// Bound a single rAF step so a backgrounded / stalled tab can't hand the master
// clock one huge delta and fast-forward the playhead to the end (mirrors
// RvMobilePlayer's accumulator, which uses the same guard).
const MAX_TICK_MS = 250;

type RvWebPlayerProps = {
  batches: ReplayBatch[] | undefined;
  playing: boolean;
  speed: number;
  focus: boolean; // theatre mode is styled by the frozen CSS on .rv-screen; unused here
  loading?: boolean;
  onDuration?: (sec: number) => void;
  /** Wall-clock session duration (ms). The rrweb stream only spans DOM-ACTIVITY
   *  time, so on an idle session its span is far shorter than the real session
   *  (e.g. 12s of activity in a 2:11 session). Report max(this, rrweb span) as
   *  the timeline total so the player agrees with the recordings list instead of
   *  stopping at the last DOM mutation. */
  sessionDurationMs?: number;
  /** Backend-confirmed web-replay availability (Session.hasFullSnapshot). When
   *  false, the session genuinely has no playable frames — show a definitive
   *  empty-state instead of implying it's still loading. Undefined for older
   *  sessions ingested before the flag existed. */
  sessionHasReplay?: boolean;
  /** True when a replay existed and was pruned by retention age-out — shows a
   *  "replay expired" empty-state distinct from "no replay was captured". */
  sessionReplayExpired?: boolean;
  /** "Skip inactivity" toggle (owned + persisted by RvStage's HUD). When on, the
   *  master clock fast-forwards over idle ranges — see computeSkipIntervals. */
  skipIdle?: boolean;
  /** Reports the idle ranges as 0..1 fractions of the padded timeline so the
   *  scrubber can dim them, mirroring the reference player's inactive regions. */
  onIdleRegions?: (regions: { from: number; to: number }[]) => void;
};

export const RvWebPlayer = forwardRef<RvPlayerHandle, RvWebPlayerProps>(
  function RvWebPlayer(
    {
      batches,
      playing,
      speed,
      loading,
      onDuration,
      sessionDurationMs,
      sessionHasReplay,
      sessionReplayExpired,
      skipIdle,
      onIdleRegions,
    },
    ref,
  ) {
    const stageBodyRef = useRef<HTMLDivElement>(null); // .stage-body — the fit target
    const frameRef = useRef<HTMLDivElement>(null); // the browser window itself
    const wrapperRef = useRef<HTMLDivElement>(null); // rrweb renders its iframe in here
    const replayerRef = useRef<Replayer | null>(null);
    // Holds a seek requested before the Replayer was constructed (deep-link);
    // drained the moment the build effect creates the Replayer.
    const pendingSeekRef = useRef<number | null>(null);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const [scale, setScale] = useState(1);
    // The Replayer build threw, or the payload had a full-snapshot but no usable
    // Meta viewport → this session can't be rendered. Flips the empty state to the
    // definitive "no replay" copy instead of spinning on "Loading replay…" forever
    // (a build failure would otherwise leave hasEvents=true + no viewport). Reset
    // per session via the component key; reset per event-list at the build effect.
    const [buildFailed, setBuildFailed] = useState(false);
    // (Address-bar URL is DERIVED below from the navigation timeline + the master
    // clock — not React state — so it can rewind when the user scrubs backward.)

    // ── Master clock (reference model) ───────────────────────────────────────
    // rrweb's Replayer clock only spans DOM-ACTIVITY time, so handing it the
    // timeline made playback STALL at the last mutation while the scrubber total
    // ran on to the padded wall-clock duration — the bar reached 1:00 but the
    // playhead froze at 0:33. The reference never lets its renderer own the clock:
    // it runs its OWN wall-clock Animator from 0 → session duration and feeds the
    // DOM as a passive follower (Animator.setTime → MessageManager.move); the last
    // frame simply holds while the clock finishes the idle tail. We do the same —
    // a self-driven `posMs` accumulator is the single authority (identical to
    // RvMobilePlayer) and the rrweb Replayer is slaved to it (see effects below).
    const [spanMs, setSpanMs] = useState(0); // rrweb content span, set at build
    const [posMs, setPosMs] = useState(0);
    const posRef = useRef(0);
    const speedRef = useRef(speed);
    const rrwebPlayingRef = useRef(false); // is rrweb currently in play (vs parked)
    useEffect(() => {
      speedRef.current = speed;
    }, [speed]);
    // (posRef is maintained directly by every posMs writer — the tick, goto, and
    // the pending-seek drain — so it needs no separate sync effect. A `posRef =
    // posMs` effect would only race those direct writes: a stale [posMs] passive
    // effect firing after a later tick would clobber posRef back one frame.)
    // The padded timeline total = max(content span, wall-clock session duration):
    // the reference's `endTime`. Playback and the scrubber both run to here.
    const totalMs = Math.max(spanMs, sessionDurationMs ?? 0);
    // Replay renderable? (viewport resolved from the Meta event at build.)
    const hasReplay = viewport.width > 0 && viewport.height > 0;
    // Report the padded total to RvStage REACTIVELY — not once at build:
    // sessionDurationMs can resolve AFTER the Replayer builds (it's a separate
    // fetch from the events), and totalMs is derived each render, so this keeps
    // RvStage's duration (its scrubber scale + end-detection) aligned with the
    // clock the player actually runs to. A one-shot report at build would strand
    // RvStage at the content span and end playback there prematurely — the very
    // stall this rework removes.
    useEffect(() => {
      if (hasReplay && totalMs > 0) onDuration?.(totalMs / 1000);
    }, [totalMs, hasReplay, onDuration]);

    const rrwebEvents = useExtractedRrwebEvents(batches);
    // Real rrweb replay present? Used to tell "still building the Replayer"
    // (show a loader) apart from "this session genuinely has no web replay".
    const hasEvents = useMemo(
      () => rrwebEvents.length > 0 && hasFullSnapshot(rrwebEvents),
      [rrwebEvents],
    );

    // ── Skip inactivity (reference ActivityManager) ──────────────────────────
    // Ranges the "Skip inactivity" HUD toggle fast-forwards over: stretches where
    // no MEANINGFUL rrweb activity happened for longer than 10% of the session —
    // including the trailing tail a page keeps "alive" by emitting only
    // background network/perf (the frameless-long-session the customer hit). Read
    // in the master-clock tick via refs so toggling doesn't re-subscribe it.
    const skipIntervals = useMemo(
      () => computeSkipIntervals(rrwebEvents, totalMs),
      [rrwebEvents, totalMs],
    );
    const skipIntervalsRef = useRef<IdleInterval[]>([]);
    const skipIdleRef = useRef(false);
    // Set by goto(): suppresses the skip-jump for the ONE tick right after a
    // seek/restart, so the follower gets a frame to observe the clock below the
    // end before we fast-forward. Without it, an idle range covering the restart
    // origin (a single early event then idle-to-end) would jump 0→end on the
    // first frame and wedge restart-from-end.
    const justSeekedRef = useRef(false);
    useEffect(() => {
      skipIntervalsRef.current = skipIntervals;
    }, [skipIntervals]);
    useEffect(() => {
      skipIdleRef.current = !!skipIdle;
    }, [skipIdle]);
    // Publish the idle ranges (as 0..1 fractions) up to RvStage's scrubber so it
    // can dim them — the reference paints inactive regions the same way.
    useEffect(() => {
      if (!onIdleRegions) return;
      // Gate on hasReplay (mirrors the onDuration effect): a session that renders
      // no replay — build failed, or events with no full snapshot — must not
      // paint idle bands on the scrubber. Reports [] until a real replay mounts.
      onIdleRegions(
        hasReplay && totalMs > 0
          ? skipIntervals.map((s) => ({
              from: s.start / totalMs,
              to: s.end / totalMs,
            }))
          : [],
      );
    }, [skipIntervals, totalMs, hasReplay, onIdleRegions]);

    // ── Address bar ──────────────────────────────────────────────────────────
    // rrweb's Meta event carries the page URL only ONCE (at recording start) and
    // never re-emits on SPA navigation, so it can't track the URL as the session
    // moves between pages. The SDK instead emits every page change as a top-level
    // `navigation` event (data.to = full, credential-redacted href) — which the
    // rrweb extractor drops. We pull those into a timeline and pick the latest one
    // at or before the playhead, so the bar updates as the replay navigates AND
    // rewinds correctly when the user scrubs backward. Before the first navigation
    // (or when a session has none) we fall back to the Meta href. Full URL,
    // protocol included — no scheme stripping.
    const navigations = useExtractedNavigations(batches);
    // Master-clock t=0 is the first rrweb event; navigation `ts` is on the same
    // wall clock, so (ts − start) is the navigation's position on the playhead.
    const startEpochMs = rrwebEvents.length ? rrwebEvents[0].timestamp : 0;
    const metaHref = useMemo(() => {
      const m = rrwebEvents.find((e) => e.type === EventType.Meta);
      return (m?.data as { href?: string } | undefined)?.href || "";
    }, [rrwebEvents]);
    // Derived, not state: `posMs` already re-renders this component every frame,
    // so recomputing here is free and never fights a setState writer.
    const currentURL = useMemo(() => {
      let url = metaHref;
      for (const n of navigations) {
        if (n.ts - startEpochMs <= posMs) url = n.url;
        else break; // navigations is time-sorted → the rest are in the future
      }
      return url;
    }, [navigations, startEpochMs, metaHref, posMs]);

    // (Re)build the Replayer when the rrweb event list changes.
    useEffect(() => {
      const root = wrapperRef.current;
      if (!root) return undefined;
      if (rrwebEvents.length === 0 || !hasFullSnapshot(rrwebEvents))
        return undefined;

      // Tear down any previous instance.
      if (replayerRef.current) {
        try {
          replayerRef.current.pause();
          replayerRef.current.destroy();
        } catch {
          /* ignore */
        }
        replayerRef.current = null;
      }
      root.innerHTML = "";
      // New event list → clear the failure latch before we try to build.
      setBuildFailed(false);

      // The Meta event carries the recorded viewport (our fit target) and the
      // recorded page URL. Check it BEFORE building the Replayer: a full-snapshot
      // with no usable viewport is unrenderable, and bailing here avoids building —
      // then leaking, since this early return provides no cleanup — a Replayer and
      // publishing a duration for a session the overlay will show as "no replay".
      const metaEv = rrwebEvents.find((e) => e.type === EventType.Meta);
      const md = metaEv?.data as
        | { width?: number; height?: number; href?: string }
        | undefined;
      if (!(md?.width && md?.height)) {
        setBuildFailed(true);
        return undefined;
      }

      let replayer: Replayer;
      let rrwebSpanMs: number;
      try {
        replayer = new Replayer(rrwebEvents, {
          root,
          speed,
          showWarning: false,
          // rrweb's built-in trail is a single uniform-opacity line that retracts
          // from its oldest end and pops out of existence. We paint our own comet
          // instead (attachFadingTrail, below): thick + opaque at the cursor,
          // tapering and fading to nothing along its length — so it reads as a
          // slow fade, not a disappearing line. Turned off here to avoid two trails.
          mouseTail: false,
          skipInactive: false,
          blockClass: "rr-block",
        });
        // meta.totalTime is only the rrweb DOM-ACTIVITY span; take the MAX with the
        // wall-clock session duration so an idle tail isn't dropped and the player
        // total matches the recordings list (was: stopped at the last DOM mutation).
        rrwebSpanMs =
          replayer.getMetaData().totalTime || getDurationFromEvents(rrwebEvents);
      } catch (err) {
        // A malformed snapshot (a stitched tail whose base never persisted, or an
        // Electron / alpha-rrweb payload rrweb rejects) throws here. Surface the
        // definitive empty state instead of hanging on "Loading replay…" forever.
        console.error("[replay] Replayer build failed", err);
        setBuildFailed(true);
        return undefined;
      }
      replayerRef.current = replayer;
      // A fresh Replayer starts PAUSED at t=0 — reset the play-latch so the slave
      // effect actually (re)starts it. Without this, a rebuild mid-playback
      // (batches streaming in for an in-flight session) leaves the latch stale-true
      // against a t=0 Replayer, and while posMs is still <200ms neither the start
      // nor the drift branch fires — rrweb would sit frozen on frame 0 while the
      // master clock advances.
      rrwebPlayingRef.current = false;

      setSpanMs(rrwebSpanMs);
      // onDuration is reported reactively (effect on totalMs, above), NOT here.

      setViewport({ width: md.width, height: md.height });
      // (The address bar is driven reactively from the navigation timeline — see
      // the `currentURL` derivation above — not seeded/updated from here.)

      // Our own cursor comet — reads the replayed pointer each animation frame
      // and paints a fading, tapering trail in our indigo. Torn down below.
      const detachTrail = attachFadingTrail(root, md.width || 1280, md.height || 800);

      // Drain a seek requested before the Replayer existed by seeding the master
      // clock; the slave-effect below positions rrweb from it. Playback itself is
      // driven by the `playing` prop → the master-clock effect, not from here.
      const pendingMs = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (pendingMs != null) {
        posRef.current = pendingMs;
        setPosMs(pendingMs);
      }

      return () => {
        detachTrail();
        try {
          replayer.pause();
          replayer.destroy();
        } catch {
          /* ignore */
        }
        replayerRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rrwebEvents]);

    useEffect(() => {
      if (!replayerRef.current) return;
      try {
        replayerRef.current.setConfig({ speed });
      } catch {
        /* ignore */
      }
    }, [speed]);

    // Master clock: while `playing`, advance `posMs` 0 → totalMs off wall-clock
    // (the exact accumulator RvMobilePlayer uses). THIS — not rrweb — is the
    // scrubber's authority, so the playhead reaches the padded end instead of
    // stalling at the last DOM mutation. End-detection + restart-from-end live in
    // RvStage's follower (it reads getCurrentTime() below), identical to mobile.
    useEffect(() => {
      if (!playing || !hasReplay || totalMs <= 0) return undefined;
      let raf = 0;
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        // Bounded (MAX_TICK_MS): a suspended rAF must not fast-forward to the end.
        const delta = Math.min(now - last, MAX_TICK_MS);
        last = now;
        let next = Math.min(posRef.current + delta * speedRef.current, totalMs);
        // Skip inactivity: when the toggle is on and the playhead lands inside an
        // idle range, jump straight to its end (reference Animator:
        // `if (skip && interval.contains(time)) time = interval.end`). Suppressed
        // for the first tick after a seek/restart (justSeekedRef) so the follower
        // can observe the clock before any jump — see justSeekedRef above.
        if (justSeekedRef.current) {
          justSeekedRef.current = false;
        } else if (skipIdleRef.current) {
          const iv = skipIntervalsRef.current.find(
            (s) => next > s.start && next < s.end,
          );
          if (iv) next = Math.min(iv.end, totalMs);
        }
        posRef.current = next;
        setPosMs(next);
        // Keep the loop alive even AT the end (clamped) — never self-stop. RvStage's
        // follower sees getCurrentTime() >= dur, flips `playing` off (→ this effect's
        // cleanup cancels the rAF) and fires onEnded; and on restart it calls
        // goto(0), which resets posRef so this still-running loop resumes from 0.
        // Self-stopping here would strand a restart-from-end (multi-click bug).
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, hasReplay, totalMs]);

    // Slave rrweb to the master clock. Inside the content span rrweb free-runs
    // (smooth mouse/DOM interpolation) — we (re)start it when play begins and only
    // re-seek if it drifts > 200ms. Once the playhead passes the content span we
    // park rrweb on its last frame (pause at spanMs) and the master clock alone
    // runs out the idle tail — so the frame HOLDS instead of the timeline stalling.
    // Restart-from-end is automatic: RvStage.goto(0) sets posMs 0 while playing, so
    // rrwebPlayingRef is false → we r.play(0). No stale rrweb 'finish' to fight.
    useEffect(() => {
      const r = replayerRef.current;
      if (!r) return;
      const target = Math.min(posMs, spanMs);
      try {
        if (playing && posMs < spanMs) {
          const cur = r.getCurrentTime();
          if (!rrwebPlayingRef.current || Math.abs(cur - target) > 200) {
            r.play(target);
            rrwebPlayingRef.current = true;
          }
        } else {
          // Paused, or in the idle tail → hold rrweb on the frame at `target`
          // (clamped to the last real frame at spanMs). Re-seek only when it isn't
          // already there, so we don't churn pause() every rAF tick in the tail.
          if (rrwebPlayingRef.current || Math.abs(r.getCurrentTime() - target) > 50) {
            r.pause(target);
            rrwebPlayingRef.current = false;
          }
        }
      } catch {
        /* ignore */
      }
    }, [posMs, playing, spanMs]);

    // Same contract as RvMobilePlayer: play/pause are driven by the `playing`
    // prop (→ master-clock effect), so they're no-ops here; goto seeds the master
    // clock (before build it parks in pendingSeekRef); getCurrentTime reports the
    // master clock, NOT rrweb's — that's what makes the scrubber run to the end.
    useImperativeHandle(
      ref,
      (): RvPlayerHandle => ({
        play: () => {},
        pause: () => {},
        goto: (sec) => {
          const ms = Math.max(0, sec * 1000);
          justSeekedRef.current = true; // don't skip-jump on the tick right after a seek
          if (!replayerRef.current) {
            pendingSeekRef.current = ms;
            return;
          }
          posRef.current = ms;
          setPosMs(ms);
        },
        setSpeed: (s) => {
          speedRef.current = s;
          replayerRef.current?.setConfig({ speed: s });
        },
        getCurrentTime: () => posMs / 1000,
      }),
      [posMs],
    );

    // Fit the recorded viewport into the .stage-body — exactly the reference's
    // `Math.min(innerW/vp.w, innerH/vp.h, 1)` against the stage-body rect (less a
    // 4px inner margin). No CSS transition rides the resulting transform, so the
    // content never animates its scale (the "zoom-in" the reference avoids).
    useLayoutEffect(() => {
      const body = stageBodyRef.current;
      if (!body || !viewport.width || !viewport.height) return undefined;
      const fit = () => {
        const rect = body.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const next = Math.min(
          (rect.width - 4) / viewport.width,
          (rect.height - 4) / viewport.height,
          1,
        );
        if (next > 0) setScale(next);
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(body);
      return () => ro.disconnect();
    }, [viewport.width, viewport.height]);

    /* ── Window size: the biggest 16:10 box that fits the stage ──────────────
       The window used to be `width:min(880px,92%)` + `aspect-ratio` +
       `maxHeight:100%`. That derives height from width ONLY, so the stage's
       vertical space was never used (measured: a 499×312 frame in a 542×809
       stage — 61% of the height wasted), and `maxHeight` was dead code: with a
       definite width, a max-height *breaks* the ratio instead of shrinking the
       box (min/max transfer only applies to an `auto` axis), so it could never
       contain the frame either.

       So compute the width here: `min(availW, availH·1.6)` contains the frame
       on BOTH axes. We measure .rv-stage's content box — it is `flex:1;
       min-height:0; overflow:hidden`, i.e. definite and immune to its content;
       .rv-canvas is NOT (it is a grid item in an auto track, so it grows with
       what it holds and feeds any fit that measures it back into itself). Width
       comes from .rv-screen so compare mode's 2-up split is respected. */
    const [frameW, setFrameW] = useState(0);
    /* Re-resolved on EVERY render, not captured once on mount. Entering focus
       re-renders the workspace and React hands us a different .rv-stage node;
       an observer bound to the mount-time element stays attached to the old,
       detached one, which never resizes again — so the frame kept its
       pre-focus width until a reload rebuilt the whole effect (measured:
       stage 440 -> 706 while the frame stayed at 584). Observing whatever the
       ref currently points at, and re-attaching when that node changes, is what
       makes the toggle live. */
    const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
    const [screenEl, setScreenEl] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => {
      const el = frameRef.current;
      const stage = (el?.closest(".rv-stage") as HTMLElement | null) ?? null;
      const screen = (el?.closest(".rv-screen") as HTMLElement | null) ?? null;
      setStageEl((prev) => (prev === stage ? prev : stage));
      setScreenEl((prev) => (prev === screen ? prev : screen));
    });
    useLayoutEffect(() => {
      if (!stageEl) return undefined;
      const fit = () => {
        const cs = getComputedStyle(stageEl);
        const availH =
          stageEl.clientHeight -
          parseFloat(cs.paddingTop || "0") -
          parseFloat(cs.paddingBottom || "0");
        const availW =
          (screenEl?.clientWidth ?? 0) ||
          stageEl.clientWidth -
            parseFloat(cs.paddingLeft || "0") -
            parseFloat(cs.paddingRight || "0");
        if (availW <= 0 || availH <= 0) return;
        const next = Math.round(Math.min(availW, availH * (16 / 10), 1600));
        setFrameW((prev) => (Math.abs(prev - next) < 1 ? prev : next));
      };
      fit();
      // The stage carries the padding we subtract, so observe its border box:
      // a padding-only change (theatre's taller HUD lane) leaves the content
      // box alone and would otherwise never fire.
      const ro = new ResizeObserver(fit);
      ro.observe(stageEl, { box: "border-box" });
      if (screenEl && screenEl !== stageEl) ro.observe(screenEl);
      return () => ro.disconnect();
    }, [stageEl, screenEl]);

    return (
      // The browser window: a 16:10 frame sized to the largest box that fits the
      // stage on BOTH axes (see the fit above), hairline border + soft shadow.
      <div
        ref={frameRef}
        style={{
          position: "relative",
          // px once measured; the CSS fallback covers the first paint only.
          width: frameW ? frameW : "min(1600px, 100%)",
          aspectRatio: "16 / 10",
          background: "#fff",
          borderRadius: "var(--r-md)",
          border: "1px solid #e8e8eb",
          boxShadow: "0 1px 2px rgb(18 19 24 / 0.05)",
          overflow: "hidden",
          flex: "0 0 auto",
        }}
      >
        {/* Browser chrome: traffic-light dots + recorded address bar (28px). */}
        <div
          style={{
            height: 28,
            background: "#ebedf0",
            borderBottom: "1px solid #d4d7dd",
            display: "flex",
            alignItems: "center",
            padding: "0 var(--sp-8)",
            gap: "var(--sp-6)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#ff5c5c",
            }}
          />
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#ffbd2e",
            }}
          />
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#28c940",
            }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              background: "#fff",
              borderRadius: "var(--r-md)",
              padding: "var(--sp-2) var(--sp-10)",
              fontSize: "var(--text-2xs)",
              color: "#4b5563",
              fontFamily: "var(--mono)",
              border: "1px solid #d4d7dd",
              textAlign: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentURL || "—"}
          </span>
        </div>

        {/* .stage-body — fills below the chrome; hosts the center-scaled iframe. */}
        <div
          ref={stageBodyRef}
          style={{
            position: "absolute",
            top: 28,
            left: 0,
            right: 0,
            bottom: 0,
            background: "#fff",
            overflow: "hidden",
          }}
        >
          {!hasReplay && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                padding: "var(--sp-24)",
                textAlign: "center",
                color: "var(--t3)",
                fontSize: "var(--text-sm)",
                zIndex: 1,
                pointerEvents: "none",
              }}
            >
              {/* "Loading replay…" only while the fetch is in flight OR a
                  buildable full-snapshot is mid-mount (and didn't fail to build) —
                  never a perpetual spinner. Once it settles: a FAILED build, or a
                  session the backend confirms has no snapshot, gets the definitive
                  "No replay was captured". Only when the backend flag says a
                  snapshot DOES exist but our payload hasn't caught up do we soften
                  to "Finishing replay capture…" (an honest transient, not a spinner
                  — and not the definitive copy for a session still being ingested). */}
              {(loading || hasEvents) && !buildFailed
                ? "Loading replay…"
                : sessionReplayExpired
                  ? "This replay has expired and is no longer available. The session's analytics are still available."
                  : !buildFailed && sessionHasReplay
                    ? "Finishing replay capture…"
                    : "No replay was captured for this session."}
            </div>
          )}
          {/* Rendered unconditionally so wrapperRef is non-null before the build
              effect runs; hidden (opacity 0) until a real replay is mounted. */}
          <div
            ref={wrapperRef}
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: viewport.width || 1,
              height: viewport.height || 1,
              transform: `translate(-50%, -50%) scale(${scale})`,
              transformOrigin: "center center",
              background: hasReplay ? "#fff" : "transparent",
              opacity: hasReplay ? 1 : 0,
              pointerEvents: hasReplay ? "auto" : "none",
            }}
          />
        </div>
      </div>
    );
  },
);

/** batches → the page-navigation timeline for the address bar. These are the
 *  SDK's TOP-LEVEL `navigation` events (NOT rrweb events — the rrweb extractor
 *  drops them), each carrying an absolute `ts` and the full, credential-redacted
 *  destination URL. Time-sorted so the player can resolve the active URL for any
 *  playhead position (including after a backward scrub). */
function useExtractedNavigations(
  batches: ReplayBatch[] | undefined,
): { ts: number; url: string }[] {
  return useMemo(
    () =>
      (batches ?? [])
        .flatMap((b) => (Array.isArray(b.events) ? b.events : []))
        .filter(
          (ev) =>
            ev.type === "navigation" &&
            typeof ev.ts === "number" &&
            typeof ev.data?.to === "string" &&
            ev.data.to.length > 0,
        )
        .map((ev) => ({ ts: ev.ts as number, url: ev.data!.to as string }))
        .sort((a, b) => a.ts - b.ts),
    [batches],
  );
}

/** Cursor comet — a fading, tapering trail rendered on a canvas overlaid inside
 *  the replay wrapper, in place of rrweb's uniform mouseTail. Each frame it reads
 *  the replayed `.replayer-mouse` centre (converted from screen to recorded px so
 *  it stays aligned at any fit scale), appends it to a short ring of recent
 *  points, and strokes segment-by-segment with width AND opacity scaled by each
 *  point's age — so the line is thick + solid at the cursor and fades to nothing
 *  along its length (a comet trail), then dissolves ~`TRAIL_MS` after the
 *  cursor stops rather than snapping away. Widths are divided by the live scale
 *  so the head stays ~`HEAD_W` on-screen px regardless of the recording's zoom.
 *  Returns a teardown that cancels the loop and removes the canvas. */
function attachFadingTrail(root: HTMLElement, recW: number, recH: number): () => void {
  // Sit between the replay iframe and the cursor: same wrapper, so it shares the
  // recorded coordinate space and the fit transform. The cursor gets z-index 3
  // (CSS) so the disc always rides on top of its own trail.
  const parent =
    (root.querySelector(".replayer-wrapper") as HTMLElement | null) ?? root;
  const W = Math.max(1, Math.round(recW));
  const H = Math.max(1, Math.round(recH));
  const canvas = document.createElement("canvas");
  canvas.className = "rv-cursor-trail";
  canvas.width = W;
  canvas.height = H;
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "1";
  parent.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const pts: { x: number; y: number; t: number }[] = [];
  const TRAIL_MS = 1200; // how long a point lives — the comet's length + fade time
  const HEAD_W = 5.5; // head thickness in on-screen px
  let raf = 0;

  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!ctx) return;
    const now = performance.now();
    const pr = parent.getBoundingClientRect();
    const scale = (pr.width || W) / W; // on-screen px per recorded px
    const mouse = parent.querySelector(".replayer-mouse") as HTMLElement | null;
    if (mouse && pr.width > 0) {
      const m = mouse.getBoundingClientRect();
      // Anchor on the pointer's tip (element top-left = the recorded hotspot),
      // so the comet streams from the arrow's point, not its middle.
      const x = (m.left - pr.left) / scale;
      const y = (m.top - pr.top) / scale;
      const last = pts[pts.length - 1];
      // Skip micro-jitter; a still cursor stops emitting so the tail ages out.
      if (!last || Math.hypot(x - last.x, y - last.y) > 0.4)
        pts.push({ x, y, t: now });
    }
    while (pts.length && now - pts[0].t > TRAIL_MS) pts.shift();

    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const life = 1 - (now - b.t) / TRAIL_MS; // 1 at the head, 0 at the tail
      if (life <= 0) continue;
      ctx.strokeStyle = `rgba(91, 92, 235, ${0.6 * life})`;
      ctx.lineWidth = (HEAD_W * life) / scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}

/** batches → the complete, timestamp-sorted rrweb event stream. Every rrweb
 *  event is wrapped by the SDK as either 'full_snapshot' or
 *  'incremental_snapshot', so this two-type filter still yields the whole
 *  stream (incl. the Meta viewport event). */
function useExtractedRrwebEvents(
  batches: ReplayBatch[] | undefined,
): eventWithTime[] {
  return useMemo(
    () =>
      (batches ?? [])
        .flatMap((b) => (Array.isArray(b.events) ? b.events : []))
        .filter(
          (ev) =>
            ev.type === "full_snapshot" || ev.type === "incremental_snapshot",
        )
        .map((ev) => ev.data?.rrwebEvent)
        .filter((e): e is eventWithTime => Boolean(e))
        .sort((a, b) => a.timestamp - b.timestamp),
    [batches],
  );
}

function hasFullSnapshot(events: eventWithTime[]): boolean {
  return events.some((e) => e.type === EventType.FullSnapshot);
}

function getDurationFromEvents(events: eventWithTime[]): number {
  if (events.length === 0) return 0;
  // min/max, not last−first: a perf/vitals event can carry a timestamp from
  // before recording began (performance timeOrigin), so the array isn't
  // guaranteed sorted and last−first can go negative. Clamp to >= 0.
  let min = events[0].timestamp;
  let max = events[0].timestamp;
  for (const e of events) {
    if (e.timestamp < min) min = e.timestamp;
    if (e.timestamp > max) max = e.timestamp;
  }
  return Math.max(0, max - min);
}

/** One idle range the "Skip inactivity" toggle fast-forwards over. Offsets are
 *  ms-from-session-start — the same timebase as the master clock's posMs. */
type IdleInterval = { start: number; end: number };

/** Ported from the reference player's ActivityManager. A gap between consecutive
 *  MEANINGFUL rrweb events longer than 10% of the whole session counts as
 *  inactivity; the trailing gap from the last real activity to the padded
 *  wall-clock end is included too — that trailing range is exactly the
 *  frameless "1 hour of nothing" a page produces when it goes idle but keeps
 *  emitting background network/perf (which advance the session clock without
 *  ever changing the DOM).
 *
 *  "Meaningful" = an IncrementalSnapshot (DOM mutation / mouse / scroll / input /
 *  viewport). FullSnapshot (type 2) is deliberately EXCLUDED: the web SDK forces
 *  a keepalive full snapshot every 30s while a visible tab is idle, so counting
 *  it as activity would mask the very inactivity we want to collapse. */
function computeSkipIntervals(
  events: eventWithTime[],
  totalMs: number,
): IdleInterval[] {
  if (events.length === 0 || totalMs <= 0) return [];
  const minInterval = totalMs * 0.1; // reference: duration * 0.1
  const start0 = events[0].timestamp;
  const intervals: IdleInterval[] = [];
  // -1 until the FIRST meaningful activity anchors the clock. We never emit a
  // skip range before that first frame-changing event: a session that only ever
  // rendered a (full) snapshot and never mutated — a static/idle-only page — has
  // nothing to fast-forward INTO, so it must not be collapsed to its end nor have
  // its whole scrubber painted idle. Seeding lastActivity=0 instead would emit a
  // spurious [0, totalMs] range for exactly that session (skips the only content,
  // and wedges restart-from-end because the range reaches totalMs).
  let lastActivity = -1;
  for (const e of events) {
    if (e.type !== EventType.IncrementalSnapshot) continue;
    const t = e.timestamp - start0;
    if (lastActivity < 0) {
      lastActivity = t; // anchor on first activity; never skip the lead-in to it
      continue;
    }
    if (t <= lastActivity) continue; // out-of-order safety (see getDurationFromEvents)
    if (t - lastActivity >= minInterval) intervals.push({ start: lastActivity, end: t });
    lastActivity = t;
  }
  if (lastActivity < 0) return []; // no meaningful activity at all → nothing to skip
  // Trailing idle tail: last real activity → padded end (the customer's case).
  if (totalMs - lastActivity >= minInterval)
    intervals.push({ start: lastActivity, end: totalMs });
  return intervals;
}
