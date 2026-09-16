import { Sk } from "@/components/feedback";

/* ============================================================================
   The cohorts list — the stat figures and the table rows — while it resolves.

   Only the two things the request actually answers stand in. The rest of the
   page is already known before it lands: the title, the New-cohort button, the
   stat LABELS, the type/search filters, and the table's column headers. Those
   keep rendering, so a cold load reads as the cohorts page waiting for its
   numbers rather than as a bare table that flashes headers over nothing.

   Both pieces wear the page's own markup (`.stat-v`, `.co-tbl`'s cells, `.cond`)
   so they occupy the real geometry and need no CSS of their own. They live here
   rather than inline so the shapes stay legible next to the rows they mimic.

   Cold load only — see the `cold` comment in Cohorts.tsx.
   ========================================================================== */

/** One `.stat-v` figure. `.stat-v` is 23px/1, so a bare 18px bar would collapse
 *  the band 5px and jump the whole page down when the count lands; the margins
 *  hold the real line box. */
export function CoStatSkeleton({ w }: { w: number }) {
  return <Sk w={w} h={18} style={{ margin: "var(--sp-2) 0" }} />;
}

/* `.cond` sizes to its 11px line box (~13px); the margins give the bars that
   same 13px, so a skeleton rule chip is the same ~21px tall as a real one. */
const condBar = { margin: "var(--sp-2) 0" } as const;

type CoRowsSkeletonProps = {
  /** Row count. Defaults to a screen's worth. */
  rows?: number;
};

/** `<tr>`s for `.co-tbl`'s tbody — the real thead stays live above them. */
export function CoRowsSkeleton({ rows = 6 }: CoRowsSkeletonProps) {
  return (
    <>
      {/* Widths vary per row so the table reads as a list of distinct cohorts
          rather than a stack of identical bars — deterministic, not random, so
          it doesn't reshuffle on every re-render. */}
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          <td>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-10)" }}>
              <Sk w={30} h={30} r={8} />
              {/* The real name block sizes to its text; `flex: 1` is what lets
                  the percentages below resolve against the one column that
                  actually stretches (every other one is a fixed width). */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <Sk w={`${34 + ((i * 19) % 30)}%`} h={11} />
                <Sk
                  w={`${48 + ((i * 13) % 26)}%`}
                  h={8}
                  style={{ marginTop: "var(--sp-6)" }}
                />
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--sp-6)",
                    marginTop: "var(--sp-8)",
                  }}
                >
                  {Array.from({ length: 1 + (i % 3) }, (_, j) => (
                    <span className="cond" key={j}>
                      <Sk w={24 + ((i + j) % 3) * 9} h={9} r={4} style={condBar} />
                      <Sk
                        w={32 + ((i + j * 5) % 4) * 8}
                        h={9}
                        r={4}
                        style={condBar}
                      />
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </td>
          {/* `td.num` right-aligns text, which a block `.sk-box` ignores. */}
          <td className="num">
            <Sk w={30 + ((i * 7) % 18)} h={11} style={{ marginLeft: "auto" }} />
          </td>
          <td>
            <Sk w={i % 2 ? 52 : 72} h={17} r={5} />
          </td>
          <td>
            <Sk w={78 + ((i * 11) % 22)} h={9} />
          </td>
          {/* The row's `.ibtn` is a transparent 30px box around a 14px icon. */}
          <td>
            <Sk w={14} h={14} r={4} style={{ margin: "var(--sp-8)" }} />
          </td>
        </tr>
      ))}
    </>
  );
}
