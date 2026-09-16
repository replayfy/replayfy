import { Sk } from "@/components/feedback";

/* ============================================================================
   The Comments page while GET /v1/comments is still resolving.

   Why the whole page and not just the rows: everything in the header except the
   word "Comments" is derived from the response — the sub-line counts comments
   and distinct sessions, and the author Select's options are built from the
   comment authors. So the title stays real and only the parts actually waiting
   on the fetch get a bar. Before this, a cold load fell through to the live
   page with `rowsData` empty and painted "0 comments across 0 sessions" over an
   empty list — a number that is wrong rather than merely absent.

   It renders `.wrap rd-page cmt-page` itself rather than expecting a caller to
   wrap it: `--ease-out` is declared on `.cmt-page`, and the `.crow` / `.c-*`
   geometry this reuses is scoped under it too, so anything rendered outside
   that class silently falls back to the un-overridden `pages.css` metrics.

   Cold load only. `useApi.loading` is `query.isPending`, which keepPreviousData
   holds false across a refetch of the same key — so deleting a comment
   (`refetch()`) never blanks the list the reader is looking at.
   ========================================================================== */

type CommentsSkeletonProps = {
  /** Row count. Defaults to a plausible page's worth. */
  rows?: number;
};

export function CommentsSkeleton({ rows = 6 }: CommentsSkeletonProps) {
  return (
    <div className="wrap rd-page cmt-page">
      {/* Matches the live header's 6px nudge so the cold load doesn't shift. */}
      <div className="head" style={{ paddingLeft: "var(--sp-6)" }}>
        <div className="head-l">
          {/* Chrome, not data — the title never depended on the fetch. */}
          <h1>Comments</h1>
          <div className="sub">
            <Sk w={172} h={10} />
          </div>
        </div>
        <div className="actions">
          {/* The author Select: width={140}, and .sel-trigger is 6px/10px
              padding around 12.5px text ≈ 30px tall, radius 8. */}
          <Sk w={140} h={30} r={8} />
        </div>
      </div>

      <div style={{ marginTop: "var(--sp-18)" }}>
        {/* Widths vary per row so the list reads as comments of different
            lengths rather than a stack of identical bars — deterministic, not
            random, so it doesn't reshuffle on every re-render. Bodies alternate
            between one and two lines for the same reason. */}
        {Array.from({ length: rows }, (_, i) => (
          <div className="crow" key={i}>
            {/* .c-av is a 30px circle; it is flex-shrink:0 in the sheet and Sk
                takes no className, so the guard is restated inline. */}
            <Sk w={30} h={30} r={99} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="c-h">
                <Sk w={`${74 + ((i * 19) % 46)}px`} h={11} />
                <Sk w={44} h={9} />
                <span className="sp" />
                <div className="c-actions">
                  {/* Only "Open at 0:43" is stood in for. The delete .c-act is
                      opacity:0 until .crow:hover, so a bar for it would show
                      something the real row doesn't. */}
                  <Sk w={88} h={22} r={7} />
                </div>
              </div>
              {/* flex column rather than stacked blocks: .c-body is a plain
                  block, so sibling margins would collapse through it and into
                  its own margin-top. */}
              <div
                className="c-body"
                style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}
              >
                <Sk w={`${72 + ((i * 11) % 26)}%`} h={10} />
                {i % 3 !== 1 && <Sk w={`${34 + ((i * 23) % 32)}%`} h={10} />}
              </div>
              <div className="c-meta">
                {/* "on <session id>" then the optional " · <url>". .c-meta is
                    gap:0 under .cmt-page, so the split is spaced by hand. */}
                <Sk w={118} h={9} />
                <Sk
                  w={`${58 + ((i * 17) % 44)}px`}
                  h={9}
                  style={{ marginLeft: "var(--sp-10)" }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
