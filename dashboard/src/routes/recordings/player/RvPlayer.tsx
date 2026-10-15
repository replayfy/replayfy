/* ===========================================================================
   Real session player — dispatcher.

   Mounted inside the frozen .rv-screen. Branches on the `isMobile` prop already
   derived by the shell:
     - web   → RvWebPlayer  (rrweb Replayer over /events batches, in a
                             Safari-style browser window)
     - mobile→ RvMobilePlayer (frames archive over /frames + native overlays,
                               in a fitted device frame)
   Each concrete player renders its OWN loading + frameless empty state (the
   reference "No replay frames captured…" / "No snapshots captured" panels), so
   the bezel never blanks and we never fall back to a fabricated mock screen.
   NO fabrication — real events/frames only.

   Data is fetched here (web: /events; mobile: /events + /frames + /timeline)
   and the imperative ref is forwarded to whichever concrete player is active.
   ========================================================================== */
import { forwardRef } from "react";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type { ApiTimeline, RvSession } from "../recordings.data";
import { RvWebPlayer } from "./RvWebPlayer";
import { RvMobilePlayer } from "./RvMobilePlayer";
import { FRAMES_QUERY_OPTS } from "./mobileFrames";
import type { FramesInfo, ReplayBatch, RvPlayerHandle } from "./playerTypes";

type RvPlayerProps = {
  s: RvSession;
  isMobile: boolean;
  focus: boolean;
  playing: boolean;
  speed: number;
  onDuration?: (sec: number) => void;
  /** "Skip inactivity" toggle — forwarded to whichever player owns the clock.
   *  Web skips rrweb idle; mobile skips user inactivity + frameless stretches. */
  skipIdle?: boolean;
  /** Idle ranges (0..1 fractions) reported up so the scrubber can dim them. */
  onIdleRegions?: (regions: { from: number; to: number }[]) => void;
  /** Mobile only: the stage shows the "still being processed" panel (or the
   *  archive load-error panel) in place of a player (see RvMobilePlayer
   *  `onProcessing`). */
  onProcessing?: (processing: boolean) => void;
};

export const RvPlayer = forwardRef<RvPlayerHandle, RvPlayerProps>(
  function RvPlayer(
    {
      s,
      isMobile,
      focus,
      playing,
      speed,
      onDuration,
      skipIdle,
      onIdleRegions,
      onProcessing,
    },
    ref,
  ) {
    const publicId = s.id;
    // rrweb + native event batches (limit=200; the full stream for playback).
    const {
      data: batchesData,
      loading: batchesLoading,
      stale: batchesStale,
    } = useApi<ReplayBatch[]>(
      () => Sessions.events<ReplayBatch[]>(publicId),
      [publicId],
    );
    // Mobile frames archive descriptor — only fetched for native sessions.
    // One fetch per open, never polled (the reference player's model); a
    // `pending` answer is just never served from cache, so reopening the
    // session re-asks instead of sticking on "still being processed".
    const {
      data: framesData,
      loading: framesInfoLoading,
      stale: framesStale,
      syncing: framesSyncing,
      error: framesError,
    } = useApi<FramesInfo>(
      () => Sessions.frames<FramesInfo>(publicId),
      [publicId],
      { enabled: isMobile, ...FRAMES_QUERY_OPTS },
    );
    // Mobile only: the session's timeline — its taps / input drive the
    // reference skip-inactivity ranges and its "background" perf events say
    // when the app was in the background. Same `session-timeline:<id>` key +
    // dep as the scrubber ticks and the Events panel, so React Query serves
    // all three from ONE /timeline request; this adds no network round-trip.
    const { data: timelineData, stale: timelineStale } = useApi<ApiTimeline>(
      () => Sessions.timeline<ApiTimeline>(publicId),
      [publicId],
      { enabled: isMobile && !!publicId, key: `session-timeline:${publicId}` },
    );

    /* Never hand a player the PREVIOUS session's payload. useApi keeps the old
       data as a placeholder while the new key resolves, which is why selecting
       a frameless recording kept painting the last one's frames and never
       reached "No snapshots captured" until a reload: `framesInfo` still
       carried the old archive URL, so the loader's deps never changed. Treat
       stale as "not loaded yet" and let the loading state own the screen. */
    const batches = batchesStale ? undefined : batchesData;
    /* Likewise a cached PENDING descriptor whose re-ask is in flight (this
       open's refetch-on-mount): it is the question being checked again, not
       the answer. Shown as one, the stage said "still being processed" — and
       let the clock run — for a session that may be finalized by now, until
       the re-ask landed. Unresolved instead: the spinner owns the screen. */
    const framesReasking = !!framesData?.pending && framesSyncing;
    const framesUnresolved = framesInfoLoading || framesStale || framesReasking;
    const framesInfo = framesUnresolved ? undefined : framesData;
    /* The descriptor request itself failed (its retry spent): no answer at
       all, which is not "this session has no archive". The player gives it
       the archive load-error copy, not "No snapshots captured". A focus /
       reconnect re-ask is pending again (unresolved) while in flight. */
    const framesFailed = !framesUnresolved && !framesData && !!framesError;
    const timeline = timelineStale ? undefined : timelineData?.events;
    const loading = batchesLoading || batchesStale;

    if (isMobile) {
      return (
        /* key: remount per session so EVERY piece of per-session state resets
           together — frames, the sniffed device dims, the fit scale, the
           playhead, the warm blob window and the <img> src. Resetting them by
           hand in effects is the same thing, one forgotten field away from a
           bug like the one above. */
        <RvMobilePlayer
          key={publicId}
          ref={ref}
          batches={batches}
          framesInfo={framesInfo}
          playing={playing}
          speed={speed}
          platform={s.plat}
          loading={loading || framesUnresolved}
          /* Distinct from `loading`: this says the ARCHIVE DESCRIPTOR itself is
             still unresolved, so `framesInfo === undefined` must not be read as
             "this session has no archive" — the player would then publish the
             event wall-clock span as the session's duration. */
          framesPending={framesUnresolved}
          framesFailed={framesFailed}
          onDuration={onDuration}
          /* The session's own length: the clock runs to it, not to the last
             captured frame (see RvMobilePlayer). */
          sessionDurationMs={s.durationMs}
          /* Dates the copy for an archive that fails to load. */
          sessionStartedAtMs={s.startedAtMs}
          timeline={timeline}
          skipIdle={skipIdle}
          onIdleRegions={onIdleRegions}
          onProcessing={onProcessing}
        />
      );
    }

    return (
      <RvWebPlayer
        key={publicId}
        ref={ref}
        batches={batches}
        playing={playing}
        speed={speed}
        focus={focus}
        loading={loading}
        onDuration={onDuration}
        sessionDurationMs={s.durationMs}
        sessionHasReplay={s.hasReplay}
        sessionReplayExpired={s.replayExpired}
        skipIdle={skipIdle}
        onIdleRegions={onIdleRegions}
      />
    );
  },
);
