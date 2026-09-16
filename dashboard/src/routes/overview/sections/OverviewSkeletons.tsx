import { Sk } from "@/components/feedback";

/* ============================================================================
   OverviewSkeletons — one shimmer stand-in per fetch-backed REGION of the
   overview, not one for the page.

   The overview reads five endpoints in parallel (overview, metrics,
   intelligence, live, counts) plus the pinned funnel's list+compute, and every
   surface renders a design FIXTURE until its own payload lands. That means a
   cold load doesn't show empty chrome — it shows invented numbers (score 82,
   48,932 sessions, "Checkout conversion is down 8.4% since v1.6.2") that are
   then silently replaced by the real ones. These stand in for exactly the slots
   that are fabricated, so nothing on screen is ever a number the workspace
   didn't report.

   Regions resolve independently: each piece is gated on the ONE read that fills
   it, so a slow /intelligence never holds up the watchlist. Everything here
   wears the live layout's own class names (.ox-watch, .ox-crash, .ox-dist …),
   so the geometry is the real geometry and no new CSS exists to drift.

   Widths vary per row deterministically (`n + ((i * k) % m)`) — never
   Math.random(), which would reshuffle the whole page on every re-render.
   ========================================================================== */

/** Inline shimmer for a run of text inside a sentence (.sk-box is display:block). */
export function SkText({ w, h = 8 }: { w: number; h?: number }) {
  return <Sk w={w} h={h} style={{ display: "inline-block", verticalAlign: "-1px" }} />;
}

/* ── Storyline / needs-attention (the featured card beside the KPIs) ─────── */

/** AI on: the analyst headline + cause paragraph, from overview.storyline. */
export function SkStoryBody() {
  return (
    <>
      <h2 className="ox-story2-h">
        <Sk w="94%" h={13} />
        <Sk w="61%" h={13} style={{ marginTop: "var(--sp-10)" }} />
      </h2>
      <p className="ox-story2-p">
        <Sk w="100%" h={9} />
        <Sk w="96%" h={9} style={{ marginTop: "var(--sp-8)" }} />
        <Sk w="54%" h={9} style={{ marginTop: "var(--sp-8)" }} />
      </p>
    </>
  );
}

/** AI off: the deterministic incident rows (overview.incidents). */
export function SkAttRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="ox-att-list">
      {Array.from({ length: rows }, (_, i) => (
        <div className="ox-att-row" key={i}>
          <Sk w={6} h={6} r={99} />
          <Sk w={`${56 + ((i * 23) % 32)}%`} h={9} />
          <Sk w={30} h={8} />
        </div>
      ))}
    </div>
  );
}

/* ── Conversion — the headline metric and the pinned funnel's bars ───────── */

export function SkConversionBody({ steps = 5 }: { steps?: number }) {
  return (
    <>
      <div className="ox-conv-line">
        <span className="big">
          <Sk w={78} h={20} />
        </span>
        <Sk w={42} h={9} />
        {/* the label names the metric — it's true before the number arrives */}
        <span className="lbl">end-to-end conversion</span>
        <span className="prev">
          <Sk w={188} h={8} />
        </span>
      </div>
      {/* The funnel descends: each track's fill is narrower than the one above,
          so the shape reads as a funnel rather than a stack of full bars.
          `.fn-hbar-side` is here (empty of everything but its own shimmer)
          because it is a fixed 112px column — drop it and every track renders
          124px too wide, then snaps narrower the moment the counts arrive. */}
      <div className="fn-hbars">
        {Array.from({ length: steps }, (_, i) => (
          <div className="fn-hbar-row" key={i}>
            <Sk w={24} h={24} r={7} style={{ flexShrink: 0 }} />
            <div className="fn-hbar-track">
              <Sk w={`${100 - i * 17}%`} h={46} r={11} />
            </div>
            <span className="fn-hbar-side">
              <Sk w={40} h={10} />
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Stability ──────────────────────────────────────────────────────────── */

/** The four typeset numbers. Labels are the section's own — only the values
 *  come from /metrics, so they're all that shimmer. */
export function SkStabNums({ labels }: { labels: string[] }) {
  return (
    <div className="ox-stab-nums">
      {labels.map((k, i) => (
        <div className="ox-snum" key={k}>
          <span className="k">{k}</span>
          <span className="v">
            <Sk w={52 + ((i * 17) % 26)} h={17} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The top-crash ledger (overview.incidents → adaptCrashes).
 *
 *  A <span>, not a <div>: the live rows are <button>s, and `.ox-crash:first-of-type`
 *  is what drops the leading hairline. The `.ox-subh` heading above them is a
 *  div, so div rows would hand `:first-of-type` to the HEADING and leave the
 *  first row wearing a border the real ledger doesn't have. Any element type
 *  that isn't the heading's works; `.ox-crash` supplies the grid either way. */
export function SkCrashRows({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <span className="ox-crash" key={i}>
          <span className="nm">
            <Sk w={`${54 + ((i * 19) % 32)}%`} h={9} />
            <Sk w={`${66 + ((i * 13) % 26)}%`} h={8} style={{ marginTop: "var(--sp-6)" }} />
            <Sk w={46} h={7} style={{ marginTop: "var(--sp-6)" }} />
          </span>
          {/* .tr-cell is the delta column's fixed 52px — worn, not re-measured */}
          <span className="tr-cell">
            <Sk w={32} h={8} style={{ marginLeft: "auto" }} />
          </span>
          <Sk w={26} h={10} />
        </span>
      ))}
    </>
  );
}

/* ── Worth watching (overview.worstSessions) ────────────────────────────── */

export function SkWatchRows({ rows = 4 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div className="ox-watch" key={i}>
          <Sk w={28} h={28} r={99} />
          <span className="who" style={{ minWidth: 0 }}>
            <Sk w={`${50 + ((i * 21) % 30)}%`} h={10} />
            <Sk w={`${62 + ((i * 17) % 26)}%`} h={8} style={{ marginTop: "var(--sp-6)" }} />
          </span>
          {/* a session carries one or two issue chips — alternate, don't randomize */}
          <span className="wiss">
            <Sk w={52 + ((i * 11) % 18)} h={14} r={5} />
            {i % 2 === 0 && <Sk w={64} h={14} r={5} />}
          </span>
          <span className="ox-wsc">
            <Sk w={22} h={11} />
            <Sk w={60} h={3} r={2} />
          </span>
          <span />
        </div>
      ))}
    </>
  );
}

/* ── Segments — three distribution bands ────────────────────────────────── */

/** Titles are the section's own; the band shares and the per-row session
 *  counts are what wait on the read. */
export function SkSegBands({ titles }: { titles: string[] }) {
  return (
    <div className="ox-segs">
      {titles.map((t, d) => (
        <div className="ox-dist" key={t}>
          <div className="hd">
            {t}
            <span className="sp" />
          </div>
          <div className="ox-dist-band" aria-hidden="true">
            <Sk w="100%" h={10} r={3} />
          </div>
          <div className="ox-dist-rows">
            {Array.from({ length: 4 }, (_, i) => (
              <div className="ox-dist-row" key={i}>
                <Sk w={7} h={7} r={2} />
                <span className="n">
                  <Sk w={`${44 + ((i * 23 + d * 9) % 36)}%`} h={9} />
                </span>
                <span className="pc">
                  <Sk w={26} h={9} />
                </span>
                <span className="sess">
                  <Sk w={78} h={8} style={{ marginLeft: "auto" }} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
