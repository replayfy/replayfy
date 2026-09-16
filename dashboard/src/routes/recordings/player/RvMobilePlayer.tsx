/* ===========================================================================
   Mobile session player — paints the per-session frames archive inside the
   frozen .rv-screen.

   Ported from the reference MobilePlayerStage. The recording is one frames
   archive (`[uint64 ts][uint32 size][jpeg]` gzip'd). We fetch it once (direct
   from R2, off-main-thread decode), split into frames, and on each playhead
   tick set a single <img>'s src to the most-recent frame's blob (decode-then-
   swap, warm window ±2). Tap ripples are drawn from the native tap stream that
   rides the SAME /events batches. Legacy sessions with no archive fall back to
   a per-event imageRef, else a wireframe over the node tree.

   Playback is a self-driven rAF accumulator (mobile does NOT use rrweb's clock);
   the imperative handle exposes goto/setSpeed/getCurrentTime (play/pause are
   no-ops — the parent's `playing` prop gates the rAF).
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
import { loadFramesArchive, frameIndexAt } from "./mobileFrames";
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
  onDuration?: (sec: number) => void;
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
      onDuration,
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
    // [] = resolved with no archive frames, [..] = resolved with frames.
    // The three states must stay distinct: `null` is what tells the duration
    // below that the session's length is still unknown.
    const [frames, setFrames] = useState<MobileFrame[] | null>(null);
    useEffect(() => {
      let cancelled = false;
      // "Descriptor still loading" is NOT "no archive". Collapsing the two (the
      // old `if (!framesInfo?.url) setFrames([])`) made `frames` read as
      // resolved-empty while /frames was still in flight, which published the
      // event wall-clock span as if it were the real duration.
      if (framesPending) {
        setFrames(null);
        return undefined;
      }
      if (!framesInfo?.url) {
        // Resolved: this session has no archive (or /frames failed) — the
        // legacy imageRef / wireframe path owns the screen and the event
        // wall-clock span IS the duration.
        setFrames([]);
        return undefined;
      }
      // No setFrames(null) here on purpose: `frames` is already null on the
      // first pass (framesPending held it there), and blanking it on a later
      // re-run — batches landing move `startTs` — would unmount a stage that is
      // already painting and flash the loading spinner.
      loadFramesArchive(
        framesInfo.url,
        framesInfo.startedAt || startTs,
        framesInfo.fileFormat || "jpeg",
      ).then((res) => {
        if (!cancelled) setFrames(res?.frames?.length ? res.frames : []);
      });
      return () => {
        cancelled = true;
      };
    }, [
      framesPending,
      framesInfo?.url,
      framesInfo?.startedAt,
      framesInfo?.fileFormat,
      startTs,
    ]);

    const usingArchive = Array.isArray(frames) && frames.length > 0;
    const framesDurationMs = usingArchive
      ? frames![frames!.length - 1].time
      : 0;
    const effStartTs = usingArchive
      ? framesInfo?.startedAt || startTs
      : startTs;
    const durationMs = usingArchive
      ? framesDurationMs
      : Math.max(0, endTs - startTs);
    // Whether `durationMs` is the REAL length or just the best guess so far.
    // For an archive session the duration is the last frame's time; until the
    // archive resolves, `endTs - startTs` above is a stand-in that can be far
    // short of it (the /events stream is capped, so its span is a lower bound).
    // Publishing that stand-in made RvStage's follower fire "ended" — pausing
    // playback and autoplaying the next recording — the moment the playhead
    // passed it, and let Math.min() below clamp a seek target that sat beyond
    // it back onto it. So we simply do not report a length we do not know yet.
    const durationKnown = frames !== null;

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
    const speedRef = useRef(speed);
    useEffect(() => {
      speedRef.current = speed;
    }, [speed]);

    useEffect(() => {
      if (!durationKnown) return;
      onDuration?.(Math.max(0, durationMs) / 1000);
    }, [durationKnown, durationMs, onDuration]);

    useEffect(() => {
      // Nothing to play until we know how long the recording is: the tick
      // clamps to `durationMs`, so running while it is still 0 just pins the
      // playhead at 0 (and any seek that lands meanwhile is clamped away).
      if (!playing || !durationKnown || durationMs <= 0) return undefined;
      let raf = 0;
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        // Bounded (see MAX_TICK_MS): a suspended/stalled rAF must not hand the
        // playhead the whole gap and fast-forward it to the end.
        const delta = Math.min(now - last, MAX_TICK_MS);
        last = now;
        setPosMs((p) => Math.min(p + delta * speedRef.current, durationMs));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, durationKnown, durationMs]);

    useImperativeHandle(
      ref,
      () => ({
        play: () => {},
        pause: () => {},
        goto: (sec: number) => setPosMs(Math.max(0, sec * 1000)),
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
        setFitScale(s > 0 ? Math.min(s, 3) : 0);
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(target);
      return () => ro.disconnect();
    }, [shellW, shellH]);

    const hasContent = usingArchive || snapshots.length > 0;
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

    // Reference empty-state copy (mirrors MobilePlayerStage): distinguish a
    // session that ended before the first capture window from one where capture
    // was disabled / predates periodic frame capture.
    const emptyHint = useMemo(() => {
      const totalSec = Math.max(0, (endTs - startTs) / 1000);
      return totalSec < 2
        ? "Session ended before the first capture window. The SDK takes its first frame ~500 ms after foreground."
        : "Snapshot capture may be disabled, or the SDK predates periodic frame capture.";
    }, [startTs, endTs]);

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
        {!showLoading && !hasContent && (
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
              No snapshots captured
            </div>
            <div style={{ fontSize: "var(--text-sm)", opacity: 0.82, lineHeight: "var(--lh-normal)" }}>
              {emptyHint}
            </div>
          </div>
        )}
        {ready && (
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
