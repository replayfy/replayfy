import { Sk } from "@/components/feedback";

/* ============================================================================
   The funnel rows — and ONLY the rows — while GET /v1/funnels resolves.

   The page head (title, "New funnel") and the filter bar are static chrome that
   owe nothing to the fetch, so FunnelsIndex keeps rendering them live and drops
   this in where the list goes. Same spirit as the rail skeleton: stand in for
   the part that is genuinely unknown, keep the part that already is. The column
   header is static text too — it is real here, not a bar; only the rows below it
   are unknown.

   What this replaces: before the response lands `rows.length` is 0, so the page
   fell through to the `.fnx-none` branch and flashed "No funnels match" — a
   no-results answer to a search nobody had run yet.

   Wears .fnx-list/.fnx-row/.fnx-main/… so the six columns land on their real
   grid tracks and the rows stand at their real height. No new CSS.
   ========================================================================== */

type FunnelsIndexSkeletonProps = {
  /** Row count. Defaults to a plausible list's worth. */
  rows?: number;
  /** Cold load renders the static column header + list wrapper (default). The
   *  end-of-list "loading more" skeleton passes false to drop bare rows in
   *  after the live list — same row block, no second colhead, no nested list. */
  head?: boolean;
};

export function FunnelsIndexSkeleton({
  rows = 5,
  head = true,
}: FunnelsIndexSkeletonProps) {
  // Widths vary per row so the list reads as a set of funnels rather than a
  // stack of identical bars — deterministic, not random, so it doesn't
  // reshuffle on every re-render.
  const body = (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div className="fnx-row" key={i}>
          {/* .fnx-main is the tallest cell, so it sets the row height. The bars
              are thinner than the text they stand in for (house look), so the
              wrappers carry the real line boxes' heights instead — otherwise
              every row would come up ~10px short and the list would jump when
              the data landed. */}
          <div className="fnx-main">
            <div className="fnx-name" style={{ height: 16 }}>
              <Sk w={`${34 + ((i * 19) % 30)}%`} h={10} />
            </div>
            <div className="fnx-desc" style={{ height: 14 }}>
              <Sk w={`${52 + ((i * 13) % 28)}%`} h={8} style={{ marginTop: "var(--sp-4)" }} />
            </div>
          </div>
          {/* .fnx-conv is flex/flex-end, so its bar right-aligns on its own. The
              cells after it are text-align:right, which a display:block Sk
              ignores — margin-left:auto is what moves those. */}
          <div className="fnx-conv">
            <Sk w={44} h={12} />
          </div>
          <div className="fnx-sess">
            <Sk w={34} h={9} style={{ marginLeft: "auto" }} />
          </div>
          <div className="fnx-steps">
            <Sk w={42} h={8} style={{ marginLeft: "auto" }} />
          </div>
          <div className="fnx-upd">
            <Sk w={46} h={8} style={{ marginLeft: "auto" }} />
          </div>
          {/* The row-hover actions button has nothing to act on yet. */}
          <div className="fnx-actions" />
        </div>
      ))}
    </>
  );
  // Bare rows for the end-of-list skeleton — composes inside the live .fnx-list.
  if (!head) return body;
  return (
    <div className="fnx-list">
      <div className="fnx-colhead">
        <span className="h-main">Funnel</span>
        <span className="h-conv">Conversion</span>
        <span className="h-sess">Sessions</span>
        <span className="h-steps">Steps</span>
        <span className="h-upd">Updated</span>
        <span className="h-a" />
      </div>
      {body}
    </div>
  );
}
