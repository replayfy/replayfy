import { Sk } from "@/components/feedback";

/* ============================================================================
   Loading skeletons for the single-user page's main column.

   Scoped to the three surfaces that are actually fetched — the activity bars,
   the recordings ledger and the timeline feed — never the whole page. The
   header identity block (avatar / name / email / tags) resolves off the list
   row `u` the moment the page mounts, so it has nothing to wait for; blanking
   it would replace real information with a shimmer.

   Why not just render the empty arrays: `sessions`/`feed`/`chart` are `[]`
   until their request lands, so the sections rendered their frame around
   nothing — the ledger in particular flashed five bare column headers over an
   empty tbody, and the "showing latest 0" hint stated a count it did not have
   yet. These stand in for the rows instead.

   They wear the redesigned main column's own class names (.udx-plot/.udx-bars,
   the real <table>'s cells, .udx-tl) so they occupy the true geometry and need
   no CSS of their own. Widths/heights vary per row deterministically — an
   index, never Math.random(), so a re-render doesn't reshuffle the shimmer.
   ========================================================================== */

/** The activity chart's bars. `bars` is the day count the picker asked for, so
 *  the skeleton has the same bar count and width the real chart will have. */
export function UdBarsSkeleton({ bars }: { bars: number }) {
  return (
    // The real plot carries onMouseLeave + the hover tooltip and the reference
    // grid; this one is deliberately inert — there is nothing to report yet.
    <div className="udx-chart">
      <div className="udx-plot">
        <div className="udx-bars">
          {Array.from({ length: bars }, (_, i) => (
            <Sk
              key={i}
              h={`${34 + ((i * 37) % 62)}%`}
              // flex:1 + the 3px top radius are `.udx-bar`'s own geometry, set
              // here rather than by borrowing the class: `.udx-bar` paints an
              // accent gradient that would fight the shimmer's.
              style={{ flex: 1, minHeight: 2, borderRadius: "var(--r-2xs) var(--r-2xs) 0 0" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Rows for the Recordings ledger. Returns <tr>s so they sit in the real
 *  <tbody>, under the real <thead> — the column widths are the live ones. */
export function UdSessionsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        // Not .clickable: a row that highlights under the cursor is offering
        // something to click, and there is no session here yet.
        <tr key={i}>
          <td>
            <Sk w={`${34 + ((i * 23) % 44)}%`} h={10} />
          </td>
          <td>
            <Sk w={38} h={10} />
          </td>
          <td>
            <Sk w={`${44 + ((i * 19) % 30)}%`} h={9} />
          </td>
          <td>
            <Sk w={48} h={11} />
          </td>
          <td>
            <Sk w={46} h={9} />
          </td>
        </tr>
      ))}
    </>
  );
}

/** Rows for the timeline feed — a node on the rail with a title/detail body. */
export function UdFeedSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="udx-tl">
      {Array.from({ length: rows }, (_, i) => (
        // A plain div, not the real button: there is nothing to open yet.
        <div className="udx-tl-row" key={i} style={{ cursor: "default" }}>
          <span className="udx-tl-node">
            {/* Stands in for the 26px accent node on the rail. */}
            <Sk w={26} h={26} r={99} />
          </span>
          <span className="udx-tl-body">
            <span className="udx-tl-top">
              <Sk w={`${34 + ((i * 21) % 30)}%`} h={11} />
            </span>
            <Sk w={`${24 + ((i * 13) % 26)}%`} h={8} style={{ marginTop: "var(--sp-8)" }} />
          </span>
        </div>
      ))}
    </div>
  );
}
