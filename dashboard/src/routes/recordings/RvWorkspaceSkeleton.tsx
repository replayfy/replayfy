import { Sk } from "@/components/feedback";
import { RvListSkeleton } from "./rail/RvListSkeleton";

/* ============================================================================
   The recordings workspace while the session list is still resolving.

   Why this exists: the rail used to fall back to the RV_SESS fixture whenever
   the list came back empty — INCLUDING when the request failed — so an API that
   was down rendered invented recordings that read as real ones. (The tell was
   subtle: real ids look like `ses_b6f05adbe726272e`, the fixture's like `b2c`.)
   A loading state can be waited out; fabricated data silently lies.

   That fixture was also load-bearing, not decorative: `s` resolved through
   `sessions[0]`, so every hook above the page's early return read it. Dropping
   it means `s` is now legitimately undefined until the list reports, which is
   what this renders for.

   It reuses the real class names instead of a parallel layout — the theme
   custom properties (--rv-line, --rv-ink, …) are declared on `.rv-wrap`, so
   anything rendered outside it loses the palette.
   ========================================================================== */

type RvWorkspaceSkeletonProps = {
  railW: number;
  inspW: number;
};

export function RvWorkspaceSkeleton({ railW, inspW }: RvWorkspaceSkeletonProps) {
  return (
    // Same inline override the real workspace uses: `.rv-wrap` is `height:100%`
    // in the sheet, which collapses inside the page's flex column.
    <div className="rv-wrap" style={{ flex: 1, height: "auto", minHeight: 0 }}>
      <section className="rv-rail" style={{ width: railW }}>
        <div className="rv-rail-top">
          <div className="rv-rail-title">
            <Sk w={62} h={12} />
            <span className="rv-spacer" />
            <Sk w={32} h={9} />
          </div>
          <Sk w="100%" h={30} r={8} />
        </div>

        {/* The same rows the rail renders when only the LIST is reloading —
            composed, not copied, so the cold-load and re-filter skeletons can't
            drift apart. */}
        <div className="rv-list">
          <RvListSkeleton />
        </div>

        <div className="rv-rail-foot">
          <Sk w={96} h={9} />
        </div>
      </section>

      <div className="rv-resize rail" />

      {/* The centre is `.rv-main` = session header + stage, not a bare stage —
          without the header the skeleton's centre column started 47px higher
          than the real one and the rail/inspector tops didn't line up. */}
      <section className="rv-main">
        <div className="rv-stagebar">
          <Sk w={28} h={28} r={7} />
          <div className="rv-who">
            <div className="rv-who-line">
              <Sk w={104} h={11} />
              <Sk w={34} h={9} r={4} />
            </div>
            <div className="rv-who-meta">
              <Sk w={88} h={8} />
              <Sk w={64} h={8} />
              <Sk w={110} h={8} />
            </div>
          </div>
          <span className="sp" />
          <div className="rv-acts">
            <Sk w={62} h={24} r={7} />
            <Sk w={88} h={24} r={7} />
          </div>
        </div>
        <div className="rv-stage" />
      </section>

      <div className="rv-resize insp" />

      <aside className="rv-inspect" style={{ width: inspW }}>
        <div className="rv-insp-tabs">
          <Sk w={54} h={9} style={{ margin: "var(--sp-10) 0 0 var(--sp-12)" }} />
        </div>
        <div className="rv-sk">
          {Array.from({ length: 6 }, (_, i) => (
            <div className="rv-sk-row" key={i}>
              <Sk w={26} h={9} />
              <Sk w={`${50 + ((i * 15) % 32)}%`} h={9} />
              <Sk w={38} h={9} style={{ marginLeft: "auto" }} />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
