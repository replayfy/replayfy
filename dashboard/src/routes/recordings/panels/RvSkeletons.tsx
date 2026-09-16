import { Sk } from "@/components/feedback";

/* ============================================================================
   Loading skeletons for the inspector panels.

   Why these exist: useApi keeps the PREVIOUS deps' data while a new key
   resolves (placeholderData: keepPreviousData). Serving placeholder data flips
   the query to 'success', so on a session switch `loading` is false and `data`
   still holds the OLD recording's rows — the panels rendered the previous
   session's events/console/network for a beat and then swapped. That is the
   flash. Panels now gate on `loading || stale` and show these instead, so a
   panel never shows one recording's data under another's id.
   ========================================================================== */

/** Rows of a log-ish list (events / console). */
export function SkRows({ n = 7 }: { n?: number }) {
  return (
    <div className="rv-panel rv-sk">
      {Array.from({ length: n }, (_, i) => (
        <div className="rv-sk-row" key={i}>
          <Sk w={26} h={9} />
          <Sk w={`${52 + ((i * 13) % 34)}%`} h={9} />
          <Sk w={40} h={9} style={{ marginLeft: "auto" }} />
        </div>
      ))}
    </div>
  );
}

/** The network table (Time / Method / URL / Status / Duration). */
export function SkNet({ n = 6 }: { n?: number }) {
  return (
    <div className="rv-panel rv-sk">
      {Array.from({ length: n }, (_, i) => (
        <div className="rv-sk-net" key={i}>
          <Sk w={30} h={9} />
          <Sk w={34} h={9} />
          <Sk w={`${46 + ((i * 17) % 40)}%`} h={9} />
          <Sk w={24} h={9} />
          <Sk w={30} h={9} />
        </div>
      ))}
    </div>
  );
}

/** Comment rows — avatar tile + name/time header + body, reusing the real
 *  `.rv-cmt` layout so it lands exactly where the loaded comments will. Returns
 *  bare rows (no panel wrapper) so it drops into CommentsPanel's own `.rv-cmts`
 *  container above the compose box. */
export function SkComments({ n = 4 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className="rv-cmt" key={i}>
          <Sk w={22} h={22} r={6} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rv-cmt-h">
              <Sk w={`${30 + ((i * 11) % 26)}%`} h={9} />
              <Sk w={30} h={8} />
            </div>
            <Sk
              w={`${64 + ((i * 13) % 30)}%`}
              h={9}
              style={{ marginTop: "var(--sp-6)" }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

/** Stat tiles + lanes (performance). */
export function SkPerf() {
  return (
    <div className="rv-panel rv-sk">
      <div className="rv-sk-tiles">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="rv-sk-tile" key={i}>
            <Sk w={54} h={8} />
            <Sk w={72} h={17} />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div className="rv-sk-lane" key={i}>
          <Sk w={64} h={9} />
          <Sk w="100%" h={26} r={5} />
        </div>
      ))}
    </div>
  );
}
