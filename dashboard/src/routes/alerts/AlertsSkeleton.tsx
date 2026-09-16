import { Sk } from "@/components/feedback";

/* ============================================================================
   The alerts list — the counts and the rows — while it resolves.

   Everything below the page header on a cold load. Until the fetch lands `all`
   is [], and the page used to render that state literally for the width of the
   request: three stats reading 0, bare column headers, and "No alerts match
   your filters" under them — then swap the lot out once the rows arrived. Every
   one of those is a claim about the workspace, and all three were wrong. A
   shimmer claims nothing.

   It wears the page's own class names (.stats/.stat/.co-tbl/.al-*) instead of a
   parallel layout, so it needs no CSS of its own and stands in the real
   geometry. What the page knows WITHOUT asking the API renders for real rather
   than shimmering — the stat labels and the column headers are constants in the
   source, and they are what make the bars below read as a table of alerts
   instead of a grey mass. Those strings are copied from Alerts.tsx and have to
   be kept in step with it; that is the price of the early return, and it is the
   same trade RvWorkspaceSkeleton makes for the rail.
   ========================================================================== */

/** The counts the page shows, in its order, with a width per value that suits
 *  the magnitude each one actually reaches (total ≥ watching ≥ paused). */
const STATS: ReadonlyArray<readonly [string, number]> = [
  ["Alerts", 26],
  ["Watching an issue", 20],
  ["Paused", 16],
];

type AlertsSkeletonProps = {
  /** Row count. Defaults to a plausible list. */
  rows?: number;
};

export function AlertsSkeleton({ rows = 5 }: AlertsSkeletonProps) {
  return (
    <>
      {/* The same inline rule the real stats row carries. It isn't in a class,
          so repeating it here is the only way the divider lands on the pixel it
          lands on once the counts arrive. */}
      <div
        className="stats"
        style={{
          marginTop: "var(--sp-20)",
          paddingBottom: "var(--sp-20)",
          paddingLeft: "var(--sp-14)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        {STATS.map(([label, w]) => (
          <div className="stat" key={label}>
            <div className="stat-l">{label}</div>
            {/* .stat-v is a 23px line box (font-size:23/line-height:1), but a
                block child collapses it to the child's own height. Hold the 23
                here and let the bar read as a numeral inside it — sized to the
                glyphs, the row would come up 8px short and the divider (and the
                whole table under it) would step down when the count lands. */}
            <div
              className="stat-v"
              style={{ height: 23, display: "flex", alignItems: "center" }}
            >
              <Sk w={w} h={15} r={5} />
            </div>
          </div>
        ))}
      </div>

      <table className="co-tbl">
        {/* Real headers at their real widths: the columns are known before the
            rows are, and a bare header row is only a lie when there is nothing
            underneath it. */}
        <thead>
          <tr>
            <th>Watching</th>
            <th style={{ width: 210, textAlign: "center" }}>Channel</th>
            <th style={{ width: 150 }}>Last fired</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          <AlertRowsSkeleton rows={rows} />
        </tbody>
      </table>
    </>
  );
}

/** `<tr>`s for `.co-tbl`'s tbody — the real thead stays live above them. Reused
 *  as the end-of-list skeleton while a further page loads (see Alerts.tsx). */
export function AlertRowsSkeleton({ rows = 5 }: AlertsSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => {
        /* Rows vary so the list reads as alerts rather than a stack of
           identical bars, and they vary along the seams the real rows do.
           The table holds two shapes and the cell renders them exclusively:
           an issue alert prints its issue's live status as a tag and no
           second line, while a metric alert prints its condition as a
           second line and has no tag. So one or the other per row, never
           both and never neither — a bar on its own is a third shape that
           never reaches the screen.

           Deterministic, never random — a skeleton that reshuffles itself
           on every re-render is the one thing on screen asking to be
           looked at. */
        const sub = i % 3 === 1;
        return (
          <tr key={i}>
            <td>
              <div
                style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-10)" }}
              >
                {/* .co-ic's own 30×30/8px tile — a filled shape in the real
                    row, so a filled shape here. */}
                <Sk w={30} h={30} r={8} />
                {/* flex:1 is the skeleton's own. The live cell is sized by
                    its text (which ellipsises); these bars are sized in % of
                    the column and need something definite to resolve
                    against. */}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="al-subj-row">
                    <Sk w={`${44 + ((i * 19) % 30)}%`} h={10} />
                    {!sub && <Sk w={52} h={17} r={5} />}
                  </div>
                  {sub && (
                    <div className="al-sub">
                      <Sk w={`${30 + ((i * 23) % 20)}%`} h={8} />
                    </div>
                  )}
                </div>
              </div>
            </td>
            <td>
              <div className="al-chips">
                {/* Every alert routes in-app; a second channel is the
                    common case, not the rule. */}
                <Sk w={60} h={18} r={5} />
                {i % 2 === 0 && <Sk w={44} h={18} r={5} />}
              </div>
            </td>
            <td className="al-when">
              {/* A timestamp — or, on a paused alert, the .tag that stands
                  where the timestamp would be. Those are different shapes
                  (11.5px mono text vs a 2px-padded chip), so they are
                  different bars. */}
              {i % 4 === 3 ? (
                <Sk w={46} h={17} r={5} />
              ) : (
                <Sk w={78} h={9} />
              )}
            </td>
            <td>
              {/* The ⋯ menu's glyph, centred in the .ibtn's 30×30 hit area.
                  The button itself is transparent until hover, so a filled
                  30×30 block would invent a control that isn't drawn. */}
              <div
                style={{
                  width: 30,
                  height: 30,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Sk w={14} h={14} r={4} />
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
