import { Sk } from "@/components/feedback";

/* ============================================================================
   The session list — and ONLY the session list — while it resolves.

   RvWorkspaceSkeleton stands in for the whole page on a cold load, when there
   is no session to play and nothing to keep. Re-filtering is different: the
   workspace is already on screen and the open recording is still valid, so
   blanking the player + inspector to reload the rail throws away the thing the
   analyst is looking at. This renders inside the live rail instead.

   Same rows as the workspace skeleton's rail (it composes this) — one list, one
   shape, so the two can't drift apart.
   ========================================================================== */

type RvListSkeletonProps = {
  /** Row count. Defaults to a rail's worth. */
  rows?: number;
};

export function RvListSkeleton({ rows = 7 }: RvListSkeletonProps) {
  return (
    <>
      <div className="rv-grp">
        <Sk w={74} h={8} />
        <span className="rule" />
      </div>
      {/* Widths vary per row so the rail reads as a list of sessions rather
          than a stack of identical bars — deterministic, not random, so it
          doesn't reshuffle on every re-render. */}
      {Array.from({ length: rows }, (_, i) => (
        <div className="rv-ses" key={i}>
          <Sk w={7} h={7} r={99} style={{ marginTop: "var(--sp-4)" }} />
          <div className="rv-ses-main">
            <div className="rv-r1">
              <Sk w={`${48 + ((i * 13) % 28)}%`} h={10} />
              <Sk w={30} h={8} style={{ marginLeft: "auto" }} />
            </div>
            <div className="rv-r2">
              <Sk w={`${36 + ((i * 17) % 32)}%`} h={8} />
              <Sk w={22} h={8} style={{ marginLeft: "auto" }} />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
