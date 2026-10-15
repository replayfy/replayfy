/* ===========================================================================
   Mobile session player — paints the per-session frames archive inside the
   frozen .rv-screen.

   Ported from the reference MobilePlayerStage. The recording is one frames
   archive (`[uint64 ts][uint32 size][jpeg]` gzip'd). We fetch it once (direct
   from R2, off-main-thread decode), split into frames, and on each playhead
   tick set a single <img>'s src to the most-recent frame's blob (decode-then-
   swap, warm window ±2). Tap ripples are drawn from the native tap stream that
   rides the SAME /events batches. Legacy sessions with no archive fall back to
   a per-event imageRef, else a wireframe over the node tree. No archive YET
   (/frames `pending`: the session is LIVE or its frames await finalize) shows
   the reference "still being processed" state, not "No snapshots captured".
   An archive that cannot be LOADED (download, gunzip or parse failure — a
   retention-pruned archive 404s — or a /frames request that failed outright)
   shows the reference tracker's load-error copy instead, chosen by the
   session's age: still being processed, or not found.

   Playback is a self-driven rAF accumulator (mobile does NOT use rrweb's clock);
   the imperative handle exposes goto/setSpeed/getCurrentTime (play/pause are
   no-ops — the parent's `playing` prop gates the rAF).

   The clock runs to the SESSION's duration, like the reference player — not to
   the last frame. Frames only exist while the screen was captured, so past the
   last one (app backgrounded, an excluded screen, a lost upload) the last frame
   holds while the timeline's events keep playing, and a badge beside the
   device says so: "In background" whenever the app was (the reference badge),
   else "No screen recorded" for a frameless stretch. Those stretches and the
   reference user-inactivity ranges feed "Skip inactivity" and the scrubber's
   idle bands; the model lives in mobileTimeline.ts.
   ========================================================================== */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadFramesArchive } from "./mobileFrames";
import {
  backgroundMarks,
  backgroundSpanAt,
  frameIndexAt,
  hasEventsBetween,
  mobileDurationMs,
  mobileSkipIntervals,
  noFramesReason,
  screenGapAt,
  skipTargetAt,
  timelineHorizonMs,
  userActivityOffsets,
  type Interval,
  type TimelineMark,
} from "./mobileTimeline";
import { rvClock } from "../recordings.data";
import {
  mapIphoneModel,
  shellScreenOffset,
  type DeviceShell,
} from "./deviceShell";
import type {
  FramesInfo,
  MobileFrame,
  NativeSnapshot,
  NativeTap,
  ReplayBatch,
  RvPlayerHandle,
  WireNode,
} from "./playerTypes";

const RECENT_TAP_MS = 1500;

/* The longest wall-clock gap a single playhead tick may credit to the recording
   (ms, before the speed multiplier).

   rAF is not a clock. It stops completely while the tab is hidden or the window
   is occluded, and stalls for hundreds of ms behind any long main-thread task —
   the frames-archive parse and the first frame decodes are exactly that. The
   tick used to add the WHOLE `now - last` gap, so the first frame after any such
   gap teleported the playhead straight to `durationMs`. RvStage's follower reads
   that as "played to the end": it pauses and fires onEnded, which autoplays the
   next recording. Bounding the delta makes a suspended tab PAUSE instead of
   fast-forwarding — we only ever advance by time that could actually have been
   watched. 250 ms is far longer than any real frame (4 fps) and far shorter than
   a suspension. */
const MAX_TICK_MS = 250;

/** `archive` state for a frames archive that could not be loaded: its download
 *  failed (loadFramesArchive → null, or no frames where the descriptor counts
 *  some), or the /frames request that would name it did. Kept apart from an
 *  archive that parsed to zero frames: only that one has "No snapshots
 *  captured" to say. */
const ARCHIVE_FAILED = "failed";
/** The frames of a failed archive: none. One shared array, so the effects keyed
 *  on `frames` see a stable value. */
const NO_FRAMES: MobileFrame[] = [];

type RvMobilePlayerProps = {
  batches: ReplayBatch[] | undefined;
  framesInfo: FramesInfo | undefined;
  playing: boolean;
  speed: number;
  platform?: string;
  loading?: boolean;
  /** The /frames descriptor is still in flight — `framesInfo` being undefined
   *  does not yet mean "this session has no archive". */
  framesPending?: boolean;
  /** The /frames descriptor request FAILED (its retry spent): `framesInfo` is
   *  undefined because there is no answer, not because there is no archive.
   *  Gets the load-error copy, never "No snapshots captured". */
  framesFailed?: boolean;
  onDuration?: (sec: number) => void;
  /** The session's own duration (ms, from its metadata) — the reference
   *  player's total length. The frames archive only covers the stretches the
   *  screen was captured, so its last frame is NOT the session's end. */
  sessionDurationMs?: number;
  /** When the session started (epoch ms, server clock, from its metadata) —
   *  dates the load-error copy, as the reference tracker dates it by the
   *  session's start. Absent: the archive descriptor's `startedAt`, which is
   *  on the device's clock. */
  sessionStartedAtMs?: number;
  /** The session's /timeline events (offsetMs-based, same base as the frames).
   *  Taps / swipes / input drive skip-inactivity; "background" perf events say
   *  when the app was in the background. Undefined when there is none to read
   *  (still loading, or a share link without the Events panel). */
  timeline?: ReadonlyArray<TimelineMark>;
  /** "Skip inactivity" toggle (owned + persisted by the HUD). */
  skipIdle?: boolean;
  /** Reports the skip ranges as 0..1 fractions of the timeline so the
   *  scrubber can paint them, the same contract as the web player. */
  onIdleRegions?: (regions: { from: number; to: number }[]) => void;
  /** Reports whether the stage shows the "still being processed" panel, or
   *  the archive load-error panel ("still being processed" / "Session not
   *  found.") — true when it appears, false when it goes or this player
   *  unmounts. The reference shows those panels INSTEAD of a player, so the
   *  host hides its transport (scrubber, play/pause) while one is up. */
  onProcessing?: (processing: boolean) => void;
};

export const RvMobilePlayer = forwardRef<RvPlayerHandle, RvMobilePlayerProps>(
  function RvMobilePlayer(
    {
      batches,
      framesInfo,
      playing,
      speed,
      platform,
      loading,
      framesPending,
      framesFailed,
      onDuration,
      sessionDurationMs,
      sessionStartedAtMs,
      timeline,
      skipIdle,
      onIdleRegions,
      onProcessing,
    },
    ref,
  ) {
    const stageBodyRef = useRef<HTMLDivElement>(null);
    // The visible frame <img>. A state-backed callback ref (not a plain useRef)
    // so the paint effect re-runs deterministically the moment the element
    // mounts — the <img> only mounts once `ready` (fitScale + dims) settles, and
    // relying on effect-dep ordering to catch that mount is racy (blank screen).
    const imgRef = useRef<HTMLImageElement | null>(null);
    const [imgMounted, setImgMounted] = useState(false);
    const setImg = useCallback((el: HTMLImageElement | null) => {
      imgRef.current = el;
      setImgMounted(!!el);
    }, []);

    const { snapshots, taps, startTs, endTs } = useNativeEvents(batches);

    // ── Frames archive ──────────────────────────────────────────────
    // null = UNRESOLVED (descriptor in flight, or archive still downloading),
    // [] = resolved with no archive frames, [..] = resolved with frames,
    // ARCHIVE_FAILED = the archive could not be loaded (or the descriptor
    // naming it could not). The states must stay distinct: `null` is what
    // tells the duration below that the session's length is still unknown,
    // and a failure is not a session that captured nothing (see
    // `archiveFailed`).
    const [archive, setArchive] = useState<
      MobileFrame[] | null | typeof ARCHIVE_FAILED
    >(null);
    // A failed archive has no frames: everything that paints or times reads
    // it as resolved-empty; only the stage's panel tells the two apart.
    const archiveFailed = archive === ARCHIVE_FAILED;
    const frames = archive === ARCHIVE_FAILED ? NO_FRAMES : archive;
    // What `frames` was last resolved against: undefined = nothing yet, null =
    // a descriptor with no archive URL, else that URL. Tells an archive that
    // has just APPEARED apart from a re-run for the same one.
    const resolvedUrlRef = useRef<string | null | undefined>(undefined);
    // The archive URL whose download last failed. The effect re-runs for the
    // same URL when batches land (`startTs`), and downloading it again there
    // is a retry, which the reference tracker never makes. A new answer from
    // the descriptor (a re-ask, or one with no URL) clears it.
    const failedUrlRef = useRef<string | null>(null);
    useEffect(() => {
      let cancelled = false;
      // "Descriptor still loading" is NOT "no archive". Collapsing the two (the
      // old `if (!framesInfo?.url) setFrames([])`) made `frames` read as
      // resolved-empty while /frames was still in flight, which published the
      // event wall-clock span as if it were the real duration.
      if (framesPending) {
        resolvedUrlRef.current = undefined;
        failedUrlRef.current = null;
        setArchive(null);
        return undefined;
      }
      if (!framesInfo?.url) {
        // Resolved: this session has no archive yet (still processing — see
        // `processing` below), none at all, or /frames failed — the legacy
        // imageRef / wireframe path owns the screen and the duration is the
        // session's own (or the event wall-clock span, if longer). A failed
        // /frames is no answer at all: it gets the load-error copy, as an
        // archive that fails to download does, not "No snapshots captured".
        resolvedUrlRef.current = null;
        failedUrlRef.current = null;
        setArchive(framesFailed ? ARCHIVE_FAILED : []);
        return undefined;
      }
      // An archive URL where the last answer had none, with no pending
      // re-ask flagged in between (the dashboard and share wiring flag theirs
      // through `framesPending`; this covers any caller that just swaps the
      // descriptor). `frames` holds that answer's resolved-empty [], which
      // reads as "no snapshots captured" for as long as the download takes —
      // back to unresolved, so the spinner shows.
      if (resolvedUrlRef.current === null) setArchive(null);
      // Likewise a NEW archive URL (a re-finalize bumps its ?v=) after one
      // that failed to load: the spinner while it downloads, not the old
      // failure's panel. A loaded archive keeps painting until it is replaced.
      else if (resolvedUrlRef.current !== framesInfo.url)
        setArchive((prev) => (prev === ARCHIVE_FAILED ? null : prev));
      resolvedUrlRef.current = framesInfo.url;
      // Otherwise no setArchive(null), on purpose: `frames` is already null on
      // the first pass (framesPending held it there), and blanking it on a
      // later re-run — batches landing move `startTs` — would unmount a stage
      // that is already painting and flash the loading spinner.
      const url = framesInfo.url;
      if (failedUrlRef.current === url) return undefined;
      const countsFrames = framesInfo.count > 0;
      loadFramesArchive(
        url,
        framesInfo.startedAt || startTs,
        framesInfo.fileFormat || "jpeg",
      ).then((res) => {
        if (cancelled) return;
        // null is a download, gunzip or parse FAILURE (a retention-pruned
        // archive 404s), not an empty archive: it gets the reference
        // tracker's load-error copy, never "No snapshots captured". So does
        // an archive with no frames where the descriptor counts some — the
        // server only names an archive once it holds that many, so an empty
        // body (a partial upload) is a failed load, not "nothing captured".
        // No retry and no polling: the reference tracker has neither.
        const got = res?.frames ?? [];
        if (!res || (got.length === 0 && countsFrames)) {
          failedUrlRef.current = url;
          // A loaded archive keeps painting: a re-load that fails (a new ?v=
          // after a re-finalize, a transient R2 error) must not swap frames
          // the user is watching for the error panel.
          setArchive((prev) =>
            Array.isArray(prev) && prev.length > 0 ? prev : ARCHIVE_FAILED,
          );
          return;
        }
        failedUrlRef.current = null;
        setArchive(got);
      });
      return () => {
        cancelled = true;
      };
    }, [
      framesPending,
      framesFailed,
      framesInfo?.url,
      framesInfo?.count,
      framesInfo?.startedAt,
      framesInfo?.fileFormat,
      startTs,
    ]);

    const usingArchive = Array.isArray(frames) && frames.length > 0;
    const hasContent = usingArchive || snapshots.length > 0;
    // No archive YET is not no frames: the API flags a session that is still
    // LIVE or whose frames are queued for finalize, and the reference player
    // says it is still being processed (its copy, below) rather than claiming
    // nothing was captured. One answer per open, no polling — the descriptor
    // query never serves a pending answer from cache, nor re-asks it on
    // focus / reconnect (FRAMES_QUERY_OPTS).
    const processing = !!framesInfo && !framesInfo.url && !!framesInfo.pending;
    // The archive (or the legacy fallback) has resolved — the screen can paint.
    // Not while the stage only says "still being processed", or only shows
    // the load-error copy of an archive that failed: the reference shows
    // those panels INSTEAD of a player, so there is nothing to play. The
    // length stays unpublished, the clock stays at 0 and no frameless band is
    // reported — otherwise the clock ran to the end under the panel and
    // RvStage's "ended" auto-advanced to the next recording. Legacy
    // snapshot / wireframe content of a pending session still plays.
    const mediaReady =
      frames !== null && !((processing || archiveFailed) && !hasContent);
    const effStartTs = usingArchive
      ? framesInfo?.startedAt || startTs
      : startTs;
    // Total length = the session's own duration, grown to cover anything
    // recorded past it (reference: endTime = session duration, extended by
    // later messages). It used to be the LAST FRAME's time, so a 6:27 session
    // whose capture stopped at 0:21 played as 0:21 while its events ran on to
    // 6:27 — everything after the last frame was unreachable.
    const durationMs = mobileDurationMs({
      sessionMs: sessionDurationMs,
      lastFrameMs: usingArchive ? frames![frames!.length - 1].time : 0,
      eventSpanMs: endTs > 0 ? endTs - effStartTs : 0,
    });
    // Whether `durationMs` is the REAL length or just the best guess so far.
    // Until the archive resolves, a growing last frame could still extend it,
    // and publishing a stand-in made RvStage's follower fire "ended" — pausing
    // playback and autoplaying the next recording — the moment the playhead
    // passed it, and let a seek beyond it clamp back onto it. Waiting also keeps
    // the report out of this player's MOUNT commit: RvStage and Recordings
    // zero their copy of the duration in their own per-session effects, which
    // run after a child's mount effects and would wipe a report made there
    // (`frames` is always null on mount, so this flips in a later commit).
    const durationKnown = mediaReady;

    // Device pixel size, sniffed from the first decoded frame (the archive
    // carries no width/height). Probed off-DOM so it isn't gated by the <img>.
    const [natDims, setNatDims] = useState({ w: 0, h: 0 });
    useEffect(() => {
      if (!usingArchive) return undefined;
      const url = frames![0].getBlobUrl();
      const probe = new Image();
      probe.onload = () => {
        if (probe.naturalWidth)
          setNatDims({ w: probe.naturalWidth, h: probe.naturalHeight });
        URL.revokeObjectURL(url);
      };
      probe.onerror = () => URL.revokeObjectURL(url);
      probe.src = url;
      return undefined;
    }, [usingArchive, frames]);

    // ── Playhead (self-driven rAF accumulator) ──────────────────────
    const [posMs, setPosMs] = useState(0);
    // The tick reads and writes the playhead through this ref (every posMs
    // writer — the tick and goto — keeps it current), so the skip jump below
    // is decided outside a setState updater, which must stay pure.
    const posRef = useRef(0);
    const speedRef = useRef(speed);
    useEffect(() => {
      speedRef.current = speed;
    }, [speed]);

    useEffect(() => {
      if (!durationKnown) return;
      onDuration?.(Math.max(0, durationMs) / 1000);
    }, [durationKnown, durationMs, onDuration]);

    // ── Skip inactivity + frameless stretches (mobileTimeline.ts) ───
    const frameTimes = useMemo(
      () => (usingArchive ? frames!.map((f) => f.time) : []),
      [usingArchive, frames],
    );
    const activity = useMemo(() => userActivityOffsets(timeline), [timeline]);
    const bgMarks = useMemo(() => backgroundMarks(timeline), [timeline]);
    // /timeline is capped at its first TIMELINE_ROW_CAP rows, so on a long
    // session its taps and focus changes stop partway: past this point the
    // list says nothing, and nothing (idle tail, background) is read into it.
    const timelineKnownUntil = useMemo(
      () => timelineHorizonMs(timeline),
      [timeline],
    );
    // Only once the archive has resolved: until then "no frames yet" would
    // read as one long frameless stretch.
    const skipIntervals = useMemo(
      () =>
        mediaReady && durationMs > 0
          ? mobileSkipIntervals({
              activity,
              frameTimes,
              durationMs,
              activityKnownUntilMs: timelineKnownUntil,
            })
          : [],
      [mediaReady, durationMs, activity, frameTimes, timelineKnownUntil],
    );
    // Read by the tick through refs, so toggling never re-subscribes the rAF.
    const skipIntervalsRef = useRef<Interval[]>([]);
    const skipIdleRef = useRef(false);
    // Set by goto(): the first tick after a seek or restart never skip-jumps,
    // so RvStage's follower gets a frame to see the clock below the end before
    // a range reaching the end could end playback again (same guard as the
    // web player's).
    const justSeekedRef = useRef(false);
    useEffect(() => {
      skipIntervalsRef.current = skipIntervals;
    }, [skipIntervals]);
    useEffect(() => {
      skipIdleRef.current = !!skipIdle;
    }, [skipIdle]);
    useEffect(() => {
      if (!onIdleRegions) return;
      onIdleRegions(
        durationMs > 0
          ? skipIntervals.map((iv) => ({
              from: iv.start / durationMs,
              to: iv.end / durationMs,
            }))
          : [],
      );
    }, [skipIntervals, durationMs, onIdleRegions]);

    useEffect(() => {
      // Nothing to play until the screen can paint (the reference clock does
      // not advance while it is loading either) and the length is known: the
      // tick clamps to `durationMs`, so running while it is still 0 just pins
      // the playhead at 0.
      if (!playing || !mediaReady || durationMs <= 0) return undefined;
      let raf = 0;
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        // Bounded (see MAX_TICK_MS): a suspended/stalled rAF must not hand the
        // playhead the whole gap and fast-forward it to the end.
        const delta = Math.min(now - last, MAX_TICK_MS);
        last = now;
        let next = Math.min(
          posRef.current + delta * speedRef.current,
          durationMs,
        );
        // Skip inactivity: inside a range, jump to its end (reference
        // Animator: `if (skip && interval.contains(time)) time = interval.end`).
        if (justSeekedRef.current) {
          justSeekedRef.current = false;
        } else if (skipIdleRef.current) {
          const iv = skipTargetAt(skipIntervalsRef.current, next);
          if (iv) next = Math.min(iv.end, durationMs);
        }
        posRef.current = next;
        setPosMs(next);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, mediaReady, durationMs]);

    useImperativeHandle(
      ref,
      () => ({
        play: () => {},
        pause: () => {},
        goto: (sec: number) => {
          const ms = Math.max(0, sec * 1000);
          justSeekedRef.current = true;
          posRef.current = ms;
          setPosMs(ms);
        },
        setSpeed: (s: number) => {
          speedRef.current = s;
        },
        getCurrentTime: () => posMs / 1000,
      }),
      [posMs],
    );

    // Legacy event-snapshot (dims / route / imageRef fallback for old sessions).
    const current = useMemo(() => {
      if (snapshots.length === 0) return null;
      const playheadTs = effStartTs + posMs;
      let pick: NativeSnapshot | null = null;
      for (const s of snapshots) {
        if ((s.ts ?? 0) <= playheadTs) pick = s;
        else break;
      }
      return pick ?? snapshots[0];
    }, [snapshots, posMs, effStartTs]);

    // ── Frame painting (decode-then-swap) ───────────────────────────
    // The visible <img> only swaps AFTER decode completes, so playback never
    // stalls on a half-decoded frame. A trailing warm window of ±2 frames is
    // kept; older blob URLs are revoked to bound memory.
    const urlOf = (f: MobileFrame): string => (f._url ??= f.getBlobUrl());
    const releaseFrame = (f: MobileFrame | undefined) => {
      if (f && f._url) {
        URL.revokeObjectURL(f._url);
        f._url = null;
      }
    };
    const blobIdxRef = useRef(-1);

    /* Sweep EVERY warmed frame when the archive changes or the player unmounts.
       A blob URL pins its Blob (the decoded JPEG) in memory until it is revoked,
       and two effects below mint them: the paint effect for the current frame and
       the decode-ahead effect for the NEXT one. The warm-window release only ever
       frees frames BEHIND the playhead (`safeIdx - 3`, plus the previous index on
       a big scrub), so the decode-ahead frame and anything warmed by a backward
       scrub were never swept — and the unmount cleanup below frees exactly ONE
       url (the <img>'s current src). Everything else was stranded until a page
       reload. Because this component is keyed by publicId, every recording switch
       remounts it, so the strand repeated per session opened: a few hundred KB
       each time, unbounded across a triage sitting.

       `frames` is captured per-run, so the cleanup releases the array that WAS
       warmed rather than whichever one replaced it. releaseFrame nulls `_url`, so
       this is idempotent and can't double-revoke against the <img> cleanup. */
    useEffect(() => {
      const warmed = frames;
      return () => {
        if (!warmed) return;
        for (const f of warmed) releaseFrame(f);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frames]);

    useEffect(() => {
      if (!usingArchive) return undefined;
      const el = imgRef.current;
      if (!el) return undefined; // <img> not mounted yet; re-runs on natDims.w
      const idx = frameIndexAt(frames!, posMs);
      const safeIdx = idx < 0 ? 0 : idx;
      if (safeIdx === blobIdxRef.current && el.src) return undefined;
      const prevIdx = blobIdxRef.current;
      blobIdxRef.current = safeIdx;
      const url = urlOf(frames![safeIdx]);
      // Assign the blob URL directly. We used to gate the swap on
      // `probe.decode()` (to avoid a half-decoded flash), but decode() can hang
      // indefinitely in some renderers — the frame then NEVER appears. The <img>
      // decodes on its own when the browser paints; a rare partial frame during
      // fast scrubbing is a far better failure mode than a permanently blank
      // stage. The decode-ahead effect below still pre-warms the next frame.
      el.src = url;
      // Free frames that left the warm window (current ± 2).
      releaseFrame(frames![safeIdx - 3]);
      if (prevIdx >= 0 && Math.abs(prevIdx - safeIdx) > 2)
        releaseFrame(frames![prevIdx]);
      return undefined;
      // `imgMounted` is a dep so the paint re-runs the instant the <img> mounts
      // (deterministic, via the callback ref) instead of racing effect ordering.
    }, [usingArchive, frames, posMs, imgMounted]);

    // Decode-ahead: warm the next frame's bitmap while the current one shows.
    useEffect(() => {
      if (!usingArchive) return undefined;
      const idx = frameIndexAt(frames!, posMs);
      const next = frames![(idx < 0 ? 0 : idx) + 1];
      if (!next) return undefined;
      const im = new Image();
      im.src = urlOf(next);
      im.decode?.().catch(() => {});
      return undefined;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [usingArchive, frames, posMs]);

    useEffect(
      () => () => {
        const el = imgRef.current;
        if (el && el.src && el.src.startsWith("blob:"))
          URL.revokeObjectURL(el.src);
      },
      [],
    );

    const recentTaps = useMemo(() => {
      if (taps.length === 0) return [];
      const playheadTs = effStartTs + posMs;
      const cutoff = playheadTs - RECENT_TAP_MS;
      return taps.filter((t) => t.ts >= cutoff && t.ts <= playheadTs);
    }, [taps, posMs, effStartTs]);

    // ── Device shell ────────────────────────────────────────────────
    const dims = useMemo(
      () => ({
        w: current?.width || snapshots[0]?.width || natDims.w || 0,
        h: current?.height || snapshots[0]?.height || natDims.h || 0,
      }),
      [current?.width, current?.height, snapshots, natDims.w, natDims.h],
    );

    // Pick the reference device shell by platform. The frames paint into the
    // shell's inner-screen rect; the shell body (iPhone notch / Android bezel)
    // overlays on top so the result reads as a real phone, not a web window.
    // TODO(api): the session's deviceModel isn't threaded through yet — once it
    // is, pass it to mapIphoneModel and use it to size the Android shell. Until
    // then iOS + React Native + Flutter default to the iPhone 12 Pro shell, and
    // Android sizes its bezel from the recording's own pixel dimensions.
    // ONE consistent shell for every mobile session — the iPhone body. The old
    // code used the Android bezel when platform==="android", but a React-Native
    // or Flutter app on an Android phone reports platform=the framework (not
    // "android"), so physically identical devices rendered in different frames.
    // A single frame removes that OS-vs-SDK mismatch entirely.
    const device: DeviceShell = useMemo(() => mapIphoneModel(""), []);

    const shellW = device.styles.shell.width;
    const shellH = device.styles.shell.height;
    const screenW = device.styles.screen.width;
    const screenH = device.styles.screen.height;
    const screenOff = useMemo(
      () => shellScreenOffset(device.styles.margin),
      [device.styles.margin],
    );

    const [fitScale, setFitScale] = useState(0);
    // Free width between the fitted phone and the stage's edge, where the
    // screen-state badge sits (as in the reference) when it fits.
    const [sideRoom, setSideRoom] = useState(0);
    useLayoutEffect(() => {
      const body = stageBodyRef.current;
      if (!body || !shellW || !shellH) return undefined;
      // Measure the STAGE, never .rv-canvas.
      //
      // .rv-stage is `flex:1; min-height:0; overflow:hidden` — a definite box
      // that cannot be grown by its content. .rv-canvas only looks definite
      // (`width:100%;height:100%`): it is a grid item in an implicit AUTO track,
      // so the track resolves to max(content, stage) and the canvas grows with
      // the very phone it is supposed to bound. Measuring it fed the fit its own
      // output — phone → canvas → larger fit → larger phone — and
      // `.rv-stage.is-mobile .rv-screen{padding-top:8px}` added 8px on every
      // pass, so the ResizeObserver ratcheted the shell up ~8px/frame (the
      // visible "zoom") until it pinned at ~2–3×, overflowing a top-aligned
      // stage: the notch filled the frame and the body was cropped.
      // No fallback on purpose: every other ancestor (.rv-screen, .rv-canvas)
      // is content-sized, so falling back to one would silently restore the
      // feedback loop. Without a stage there is nothing definite to fit to.
      const target = body.closest(".rv-stage") as HTMLElement | null;
      if (!target) return undefined;
      const fit = () => {
        const cs = getComputedStyle(target);
        // clientWidth/Height are the padding box — subtract padding for the
        // real content box, plus whatever .rv-screen reserves above the shell.
        const padX =
          parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
        const padY =
          parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
        const screen = body.closest(".rv-screen") as HTMLElement | null;
        let screenPadY = 0;
        if (screen) {
          const scs = getComputedStyle(screen);
          screenPadY =
            parseFloat(scs.paddingTop || "0") +
            parseFloat(scs.paddingBottom || "0");
        }
        // Breathing room: the shell filled the stage edge-to-edge, which read
        // as cramped next to the web player's inset window.
        const GUTTER = 18;
        const availW = target.clientWidth - padX - GUTTER * 2;
        const availH = target.clientHeight - padY - screenPadY - GUTTER;
        if (availW <= 0 || availH <= 0) return;
        // Scale the whole device shell to fit the stage, upscaling small
        // shells up to 3× — the reference fit behavior.
        const s = Math.min(availW / shellW, availH / shellH);
        const scale = s > 0 ? Math.min(s, 3) : 0;
        setFitScale(scale);
        setSideRoom((target.clientWidth - padX - shellW * scale) / 2);
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(target);
      return () => ro.disconnect();
    }, [shellW, shellH]);

    const fallbackSrc = !usingArchive ? current?.root?.imageRef || null : null;
    const ready = hasContent && dims.w > 0 && fitScale > 0;
    // Keep the loading state up through the async natural-size probe so we
    // never show a blank stage between "frames decoded" and "dims known". Also
    // stay in "loading" while the parent's /events + /frames fetches are still
    // in flight, so we never flash the empty state before the data lands.
    const framesLoading =
      !!framesInfo?.url &&
      !ready &&
      (frames === null || (usingArchive && dims.w === 0));
    const showLoading = framesLoading || (!!loading && !hasContent);
    // The processing panel is what the stage shows (see `processing`).
    const showProcessing = !showLoading && !hasContent && processing;
    // Or the load-error panel: the archive (or the /frames descriptor naming
    // it) could not be loaded, and nothing else (legacy snapshots /
    // wireframe) can paint.
    const showLoadError = !showLoading && !hasContent && archiveFailed;
    // Tell the host while either shows: the reference panel stands in for the
    // whole player, controls included, and a scrubber / play-pause left live
    // over it moved the head and the time label (and showed "pause") over a
    // stage that cannot play. Withdrawn by the cleanup — when the panel goes
    // (the archive arrived) or this player unmounts (keyed per session, so a
    // switch always hands the next session a visible HUD).
    const showStandIn = showProcessing || showLoadError;
    useEffect(() => {
      if (!showStandIn || !onProcessing) return undefined;
      onProcessing(true);
      return () => onProcessing(false);
    }, [showStandIn, onProcessing]);

    // Reference empty-state copy (mirrors MobilePlayerStage): distinguish a
    // session that ended before the first capture window from one where capture
    // was disabled / predates periodic frame capture. Judged on the session's
    // duration: a native session's /events stream is empty, so its span read
    // 0 and every frameless session claimed it "ended before the first capture".
    const emptyHint =
      noFramesReason(durationMs) === "too-short"
        ? "Session ended before the first capture window. The SDK takes its first frame ~500 ms after foreground."
        : "Snapshot capture may be disabled, or the SDK predates periodic frame capture.";

    // What the stage cannot show at the playhead. The held frame stays
    // (reference), with a badge beside the device that says why — a stale
    // frame must not pass for the live screen while the events run on.
    // Background wins, as the reference badge does, frames or not; its range
    // is the background stretch itself, never the wider frameless one, which
    // can start earlier (capture or upload loss) and must not be blamed on it.
    const bgSpan = backgroundSpanAt(
      bgMarks,
      posMs,
      durationMs,
      timelineKnownUntil,
    );
    const screenGap = usingArchive
      ? screenGapAt(frames!, posMs, durationMs)
      : null;
    const screenState: ScreenState | null = bgSpan
      ? { kind: "background", ...bgSpan }
      : screenGap
        ? { kind: "no-screen", ...screenGap }
        : null;
    const stateStart = screenState?.start ?? 0;
    const stateEnd = screenState
      ? (screenState.end ?? Math.min(durationMs, timelineKnownUntil))
      : 0;
    // "Events still play" only where there are events to see: never on a share
    // link without the Events panel, nor past where a capped list stops.
    const eventsInState = useMemo(
      () => hasEventsBetween(timeline, stateStart, stateEnd),
      [timeline, stateStart, stateEnd],
    );

    return (
      <div
        ref={stageBodyRef}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {showLoading && (
          <div
            style={{
              display: "grid",
              placeItems: "center",
              gap: "var(--sp-12)",
              color: "var(--t3)",
              fontSize: "var(--text-sm)",
              textAlign: "center",
              padding: "var(--sp-32)",
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                border: "3px solid var(--line)",
                borderTopColor: "var(--accent)",
                animation: "spin .8s linear infinite",
              }}
            />
            <div>Loading frames…</div>
          </div>
        )}
        {showProcessing && (
          <MobileEmptyState
            title={PROCESSING_COPY.title}
            body={PROCESSING_COPY.body}
          />
        )}
        {showLoadError && (
          <MobileEmptyState
            {...loadErrorCopy(sessionStartedAtMs || framesInfo?.startedAt || 0)}
          />
        )}
        {!showLoading && !hasContent && !processing && !archiveFailed && (
          <MobileEmptyState title="No snapshots captured" body={emptyHint} />
        )}
        {ready && (
          // Anchors the screen-state badge beside the device. The device box
          // below carries the drop-shadow filter, which would also shadow the
          // badge's text if the badge sat inside it.
          <div style={{ position: "relative", flex: "0 0 auto" }}>
            <div
              style={{
                width: shellW * fitScale,
                height: shellH * fitScale,
                position: "relative",
                flex: "0 0 auto",
                // Soft ambient shadow under the phone — consistent with the web
                // player's stage shadow.
                filter: "drop-shadow(0 10px 24px rgba(0,0,0,0.18))",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: shellW,
                  height: shellH,
                  transform: `scale(${fitScale})`,
                  transformOrigin: "top left",
                }}
              >
                {/* Inner-screen rect: the frames paint here, offset to land in the
                    shell cut-out. The shell body is overlaid ON TOP below, so its
                    transparent screen area lets the frame show through while the
                    notch / bezel draws over the edges. */}
                <div
                  style={{
                    position: "absolute",
                    top: screenOff.top,
                    left: screenOff.left,
                    width: screenW,
                    height: screenH,
                    overflow: "hidden",
                    borderRadius: "var(--r-lg)",
                    background: "#000",
                  }}
                >
                  {(usingArchive || fallbackSrc) && (
                    <img
                      ref={setImg}
                      src={fallbackSrc || undefined}
                      alt=""
                      draggable={false}
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "block",
                        objectFit: "fill",
                      }}
                    />
                  )}
                  {!usingArchive && !fallbackSrc && current?.root && (
                    <WireframeRenderer
                      node={current.root}
                      sw={dims.w}
                      sh={dims.h}
                    />
                  )}
                  {recentTaps.map((tap) => (
                    <TapRipple
                      key={String(tap.id)}
                      tap={tap}
                      sw={dims.w}
                      sh={dims.h}
                      age={Math.max(0, effStartTs + posMs - tap.ts)}
                    />
                  ))}
                </div>
                {/* Reference mobile device shell body (iPhone notch / Android
                    bezel), overlaid on top of the painted screen. */}
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    pointerEvents: "none",
                  }}
                  dangerouslySetInnerHTML={{ __html: device.svg }}
                />
              </div>
            </div>
            {screenState && (
              <ScreenStateBadge
                state={screenState}
                eventsPlay={eventsInState}
                skippable={!skipIdle && !!skipTargetAt(skipIntervals, posMs)}
                beside={sideRoom >= BADGE_W + BADGE_GAP}
              />
            )}
          </div>
        )}
        {/* platform is surfaced by the frozen stagebar; kept as a reference. */}
        <span hidden>{platform}</span>
      </div>
    );
  },
);

/** Wireframe fallback when neither archive nor imageRef is available
 *  (tree-only capture). Percentage-positioned over the fitted surface. */
function WireframeRenderer({
  node,
  sw,
  sh,
}: {
  node: WireNode;
  sw: number;
  sh: number;
}) {
  if (!node) return null;
  const flat: WireNode[] = [];
  flattenWireframeNodes(node, flat);
  return (
    <>
      {flat.map((n, i) => (
        <WireframeNode
          key={n.id != null ? String(n.id) : `n${i}`}
          node={n}
          sw={sw}
          sh={sh}
        />
      ))}
    </>
  );
}

function flattenWireframeNodes(
  node: WireNode | null | undefined,
  out: WireNode[],
): void {
  if (!node || !node.bounds) return;
  const { type, text, backgroundColor, occluded, children } = node;
  const hasChildren = Array.isArray(children) && children.length > 0;
  const isPaintable =
    !!text ||
    !!backgroundColor ||
    !!occluded ||
    type === "button" ||
    type === "field" ||
    type === "image" ||
    type === "text";
  if (isPaintable) out.push(node);
  if (hasChildren) {
    for (const c of children!) flattenWireframeNodes(c, out);
  }
}

function WireframeNode({
  node,
  sw,
  sh,
}: {
  node: WireNode;
  sw: number;
  sh: number;
}) {
  const { bounds, type, text, backgroundColor, opacity, occluded } = node;
  if (!bounds) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: `${(bounds.x / sw) * 100}%`,
        top: `${(bounds.y / sh) * 100}%`,
        width: `${(bounds.w / sw) * 100}%`,
        height: `${(bounds.h / sh) * 100}%`,
        background: occluded
          ? "repeating-linear-gradient(45deg, #aaa, #aaa 4px, #ccc 4px, #ccc 8px)"
          : backgroundColor ||
            (type === "button" ? "rgba(0,123,255,0.08)" : "transparent"),
        opacity: opacity ?? 1,
        border:
          type === "button" || type === "field"
            ? "1px solid rgba(0,0,0,0.15)"
            : "none",
        borderRadius: type === "button" ? 6 : 0,
        display: "flex",
        alignItems: "center",
        justifyContent: type === "button" ? "center" : "flex-start",
        padding: type === "text" || type === "button" ? "0 6px" : 0,
        overflow: "hidden",
        fontSize: "var(--text-sm)",
        color: "rgba(0,0,0,0.85)",
        pointerEvents: "none",
      }}
    >
      {text && !occluded && (
        <span
          style={{
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            overflow: "hidden",
            maxWidth: "100%",
          }}
        >
          {text}
        </span>
      )}
    </div>
  );
}

function TapRipple({
  tap,
  sw,
  sh,
  age,
}: {
  tap: NativeTap;
  sw: number;
  sh: number;
  age: number;
}) {
  const progress = Math.min(1, age / RECENT_TAP_MS);
  const opacity = (1 - progress) * 0.7;
  const px = tap.point?.x ?? (tap.bounds ? tap.bounds.x + tap.bounds.w / 2 : 0);
  const py = tap.point?.y ?? (tap.bounds ? tap.bounds.y + tap.bounds.h / 2 : 0);
  const leftPct = (px / sw) * 100;
  const topPct = (py / sh) * 100;
  const sizePct = 4 + progress * 6;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${sizePct}%`,
          aspectRatio: "1 / 1",
          transform: "translate(-50%, -50%)",
          borderRadius: "50%",
          background: "rgba(0, 122, 255, 0.4)",
          opacity,
          pointerEvents: "none",
        }}
      />
      {tap.bounds && (
        <div
          style={{
            position: "absolute",
            left: `${(tap.bounds.x / sw) * 100}%`,
            top: `${(tap.bounds.y / sh) * 100}%`,
            width: `${(tap.bounds.w / sw) * 100}%`,
            height: `${(tap.bounds.h / sh) * 100}%`,
            border: "2px solid rgba(0, 122, 255, 0.9)",
            borderRadius: "var(--r-xs)",
            opacity: (1 - progress) * 0.9,
            pointerEvents: "none",
          }}
        />
      )}
    </>
  );
}

/** Flatten batches into snapshot + tap streams + session time bounds. Snapshots
 *  provide dimensions / route / the imageRef fallback for legacy sessions;
 *  archive sessions get their images from the frames archive. */
function useNativeEvents(batches: ReplayBatch[] | undefined): {
  snapshots: NativeSnapshot[];
  taps: NativeTap[];
  startTs: number;
  endTs: number;
} {
  return useMemo(() => {
    const all = (batches ?? []).flatMap((b) =>
      Array.isArray(b.events) ? b.events : [],
    );
    const snapshots: NativeSnapshot[] = [];
    const taps: NativeTap[] = [];
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const ev of all) {
      if (typeof ev.ts === "number") {
        if (ev.ts < minTs) minTs = ev.ts;
        if (ev.ts > maxTs) maxTs = ev.ts;
      }
      if (ev.type === "native_snapshot") {
        const d = ev.data || {};
        snapshots.push({
          id: ev.id,
          ts: ev.ts,
          width: d.width,
          height: d.height,
          pixelRatio: d.pixelRatio,
          trigger: d.trigger,
          root: d.root,
          route: extractRoute(d.root),
        });
      } else if (ev.type === "tap") {
        const d = ev.data || {};
        taps.push({
          id: ev.id,
          ts: ev.ts ?? 0,
          bounds: d.bounds,
          point: d.point,
          route: d.route,
          uiClass: d.uiClass,
          uiType: d.uiType,
          uiValue: d.uiValue,
          uiId: d.uiId,
        });
      }
    }
    snapshots.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    taps.sort((a, b) => a.ts - b.ts);
    if (!Number.isFinite(minTs)) minTs = 0;
    if (!Number.isFinite(maxTs)) maxTs = minTs;
    return { snapshots, taps, startTs: minTs, endTs: maxTs };
  }, [batches]);
}

function extractRoute(root: WireNode | null | undefined): string | null {
  if (!root) return null;
  return root.route || null;
}

/** What the stage cannot show at the playhead: the app in the background
 *  (from its focus marks — `end` null when a capped timeline stops before it
 *  came back), or a stretch with no captured frame. */
type ScreenState = {
  kind: "background" | "no-screen";
  start: number;
  end: number | null;
};

/** Width of the badge column beside the device, and its gap to the device
 *  (the reference warnings column: 200 px wide, 20 px off the shell). */
const BADGE_W = 200;
const BADGE_GAP = 20;

/** The reference player's "In Background" badge: a small light chip beside
 *  the device rather than anything over the screen, so the held frame stays
 *  readable. Ours also covers the frameless stretches and says for how long,
 *  whether the timeline still has events to watch there, and how to jump on.
 *  On a stage too narrow for the column (the phone fills it) the chip alone
 *  sits over the bottom of the device instead of being clipped off-stage. */
function ScreenStateBadge({
  state,
  eventsPlay,
  skippable,
  beside,
}: {
  state: ScreenState;
  /** The timeline has events inside this stretch. */
  eventsPlay: boolean;
  /** The playhead is in a skip range and Skip inactivity is off. */
  skippable: boolean;
  /** There is room for the column beside the device. */
  beside: boolean;
}) {
  const background = state.kind === "background";
  const range =
    state.end === null
      ? `Since ${rvClock(state.start)}.`
      : `${background ? "From" : "No frames from"} ${rvClock(state.start)} to ${rvClock(state.end)}.`;
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        ...(beside
          ? {
              left: `calc(100% + ${BADGE_GAP}px)`,
              top: "50%",
              transform: "translateY(-50%)",
              width: BADGE_W,
            }
          : { left: "50%", bottom: 24, transform: "translateX(-50%)" }),
        display: "flex",
        flexDirection: "column",
        alignItems: beside ? "flex-start" : "center",
        gap: "var(--sp-6)",
        pointerEvents: "none",
      }}
    >
      <span
        className="rv-chip"
        style={{ background: "var(--surface)", whiteSpace: "nowrap" }}
        title={beside ? undefined : range}
      >
        {background ? <EyeOffGlyph /> : <NoScreenGlyph />}
        {background ? "In background" : "No screen recorded"}
      </span>
      {beside && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--t3)",
            lineHeight: "var(--lh-normal)",
          }}
        >
          {range}
          {eventsPlay && " Events on the timeline still play."}
          {skippable && " Skip inactivity jumps past it."}
        </div>
      )}
    </div>
  );
}

/** Eye-slash, the reference background badge's icon. */
function EyeOffGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.7 5.1A10.5 10.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.1" />
      <path d="M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

/** Phone with a slash: no screen captured. */
function NoScreenGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

type PanelCopy = { title: string; body: string };

/** The reference tracker's "not ready yet" copy: /frames `pending`, and a
 *  young session whose archive failed to load. */
const PROCESSING_COPY: PanelCopy = {
  title: "This session is still being processed.",
  body: "Please check it again in a few minutes.",
};
/** The reference tracker's copy for an older session whose replay cannot be
 *  loaded — most often one its retention policy has pruned. */
const NOT_FOUND_COPY: PanelCopy = {
  title: "Session not found.",
  body: "Please check your data retention policy.",
};
/** Past this many whole days old (rounded to the nearest day, as the
 *  reference tracker counts them — so from 2.5 days), a session whose archive
 *  cannot be loaded reads as not found rather than still being processed. */
const PROCESSING_MAX_DAYS = 2;
const DAY_MS = 86_400_000;

/** The reference tracker's load-error copy, chosen by the session's age:
 *  still being processed while it is young, else not found. */
function loadErrorCopy(startedAtMs: number, nowMs = Date.now()): PanelCopy {
  const days = Math.round(Math.abs(nowMs - startedAtMs) / DAY_MS);
  return days > PROCESSING_MAX_DAYS ? NOT_FOUND_COPY : PROCESSING_COPY;
}

/** The stage's no-screen panel: the frameless empty state ("No snapshots
 *  captured"), the still-processing state and the load-error state share one
 *  markup, so they read as the same surface in both the dashboard and
 *  theatre styling. */
function MobileEmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--sp-12)",
        color: "var(--t3)",
        textAlign: "center",
        maxWidth: 380,
        padding: "var(--sp-32)",
        pointerEvents: "none",
      }}
    >
      <PhoneGlyph />
      <div
        className="rv-mob-empty-title"
        style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-semibold)", color: "var(--text)" }}
      >
        {title}
      </div>
      <div style={{ fontSize: "var(--text-sm)", opacity: 0.82, lineHeight: "var(--lh-normal)" }}>
        {body}
      </div>
    </div>
  );
}

/** Muted phone glyph for the frameless empty state (reference `.mobile-empty`). */
function PhoneGlyph() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--t3)"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10.5 5h3" />
      <path d="M11 18.5h2" />
    </svg>
  );
}
