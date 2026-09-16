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

   Data is fetched here (web: /events; mobile: /events + /frames) and the
   imperative ref is forwarded to whichever concrete player is active.
   ========================================================================== */
import { forwardRef } from "react";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import type { RvSession } from "../recordings.data";
import { RvWebPlayer } from "./RvWebPlayer";
import { RvMobilePlayer } from "./RvMobilePlayer";
import type { FramesInfo, ReplayBatch, RvPlayerHandle } from "./playerTypes";

type RvPlayerProps = {
  s: RvSession;
  isMobile: boolean;
  focus: boolean;
  playing: boolean;
  speed: number;
  onDuration?: (sec: number) => void;
  /** "Skip inactivity" toggle — forwarded to the web player's master clock.
   *  (Mobile frames use a separate idle model; not wired yet.) */
  skipIdle?: boolean;
  /** Idle ranges (0..1 fractions) reported up so the scrubber can dim them. */
  onIdleRegions?: (regions: { from: number; to: number }[]) => void;
};

export const RvPlayer = forwardRef<RvPlayerHandle, RvPlayerProps>(
  function RvPlayer(
    { s, isMobile, focus, playing, speed, onDuration, skipIdle, onIdleRegions },
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
    const {
      data: framesData,
      loading: framesInfoLoading,
      stale: framesStale,
    } = useApi<FramesInfo>(
      () => Sessions.frames<FramesInfo>(publicId),
      [publicId],
      { enabled: isMobile },
    );

    /* Never hand a player the PREVIOUS session's payload. useApi keeps the old
       data as a placeholder while the new key resolves, which is why selecting
       a frameless recording kept painting the last one's frames and never
       reached "No snapshots captured" until a reload: `framesInfo` still
       carried the old archive URL, so the loader's deps never changed. Treat
       stale as "not loaded yet" and let the loading state own the screen. */
    const batches = batchesStale ? undefined : batchesData;
    const framesInfo = framesStale ? undefined : framesData;
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
          loading={loading || framesInfoLoading || framesStale}
          /* Distinct from `loading`: this says the ARCHIVE DESCRIPTOR itself is
             still unresolved, so `framesInfo === undefined` must not be read as
             "this session has no archive" — the player would then publish the
             event wall-clock span as the session's duration. */
          framesPending={framesInfoLoading || framesStale}
          onDuration={onDuration}
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
