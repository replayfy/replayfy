import { Sk } from "@/components/feedback";

/* ============================================================================
   The users table's ROWS — and only the rows — while the list resolves.

   Wears the real row's own markup (.cell-user, .u-av, .u-name,
   .u-email) so it occupies the true geometry and needs no CSS of its own. The
   page keeps its title, filter bar and column headers live around this: a cold
   load is not a reason to tear down the search box, which is the way out of a
   slow list. Before this existed the page fell through its empty-state guard
   (`!loading && !all.length` is false while loading) and rendered a table with
   zero rows — a cold load flashed bare column headers.

   The device cell's `.mono` is deliberately NOT copied: it only sets a
   font-family, and there is no text here for it to set.

   The two identity lines are inline-block on purpose. `.u-name`/`.u-email` are
   text divs, so their height is the 13px/11px LINE BOX: 19.5 + 16.5 + 1px
   margin = 37px, which is taller than the 30px avatar and is therefore what
   sets the row height (a real row measures 62px = 37 + 24 padding + 1 border).
   A block-level bar (the Sk default) would collapse those divs to the bar's own
   height, the 30px avatar would take over, and every row would come out 55px —
   7px short. Sitting the bar on the line box instead keeps the real geometry:
   measured against a live row, this renders 62px on the nose.
   ========================================================================== */

type UsersSkeletonProps = {
  /** Row count. Defaults to a table's worth. */
  rows?: number;
};

/** Sit a bar ON a text line box rather than replacing it — see the note above. */
const LINE = { display: "inline-block", verticalAlign: "middle" } as const;

export function UsersSkeleton({ rows = 8 }: UsersSkeletonProps) {
  return (
    <>
      {/* Widths vary per row so the table reads as a list of people rather than
          a stack of identical bars — deterministic, not random, so it doesn't
          reshuffle on every re-render. */}
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          <td>
            <div className="cell-user">
              {/* .u-av — 30px circle. */}
              <Sk w={30} h={30} r={99} />
              <div style={{ minWidth: 0 }}>
                {/* Widths are px, not %, and that is deliberate: this div is a
                    flex item sized by its CONTENT, so a percentage-width child
                    has nothing to resolve against, the div collapses to 0 and
                    both bars vanish. Real text gives it intrinsic width; fixed
                    bars do the same. `.u-name` is overflow:hidden, so a bar
                    wider than the column is clipped exactly as a long name is
                    ellipsised. */}
                <div className="u-name">
                  <Sk w={112 + ((i * 23) % 74)} h={10} style={LINE} />
                </div>
                <div className="u-email">
                  <Sk w={126 + ((i * 31) % 58)} h={8} style={LINE} />
                </div>
              </div>
            </div>
          </td>
          <td>
            {/* Flag glyph + place name, same flex row as the real cell. */}
            <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-6)" }}>
              <Sk w={13} h={10} r={2} />
              <Sk w={`${50 + ((i * 29) % 34)}%`} h={9} />
            </span>
          </td>
          <td>
            <Sk w={`${56 + ((i * 19) % 30)}%`} h={9} />
          </td>
          <td>
            <Sk w={`${46 + ((i * 13) % 28)}%`} h={9} />
          </td>
          {/* The trailing "…" cell: the real .ibtn is a 30px hit area around a
              14px glyph, so the glyph is the only ink there is to stand in for. */}
          <td>
            <Sk w={14} h={14} r={4} />
          </td>
        </tr>
      ))}
    </>
  );
}
