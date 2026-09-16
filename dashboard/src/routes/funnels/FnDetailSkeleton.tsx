import { Fragment } from "react";
import { Sk } from "@/components/feedback";

/* ============================================================================
   The funnel detail page while its single GET /v1/funnels/:id/compute resolves.

   EVERYTHING on this page hangs off that one call — the funnel's name, its step
   definition and every count — so until it lands there is nothing real to draw.
   The page used to render a bare `.wrap rd-page fn` for the whole cold load,
   i.e. an empty viewport with a nav around it. This stands in for the real
   layout instead: the step builder, the summary strip, the tab bar, the
   retention bars and the per-step detail below them.

   Only the STEPS view is mirrored. A saved funnel always opens on that tab
   (`view` defaults to 'steps'; only a template-seeded NEW funnel can open on
   Breakdown), so standing in for a breakdown/timeline would be standing in for
   something the cold load never shows. Those tabs fetch on demand, from an
   already-populated page, and carry their own "Computing…" state.

   Like RvListSkeleton, it wears the real page's own class names — .fn-def /
   .fn2-step / .stats.fn-sum / .fn-hbar-track / .fn-detail — so it occupies the
   true geometry (the bordered step cards, the 46px bar tracks, the divider
   rules, the centred stat columns) and needs no new CSS.
   ========================================================================== */

type FnDetailSkeletonProps = {
  /** Step cards + bars to stand in for. The real count is only known once the
   *  compute lands; 4 is a typical saved funnel. */
  steps?: number;
  /** Kept LIVE: "Funnels" is known without the fetch, so the way out of a slow
   *  load stays clickable rather than shimmering. */
  onBack?: () => void;
};

/* Summary strip — [label, value, sub] box widths mirroring the five real
   columns (Entered · Conversion · Converted · Median time · Biggest drop), so
   the strip reads as those metrics rather than five identical blocks. */
const FN_SUM_W: [number, number, number][] = [
  [50, 62, 46],
  [72, 84, 70],
  [62, 70, 86],
  [74, 76, 52],
  [78, 82, 66],
];

/* Per-step detail — [label, value] widths for Reached · Step conversion ·
   Dropped here · Median to reach. */
const FN_DM_W: [number, number][] = [
  [52, 58],
  [94, 64],
  [82, 90],
  [90, 56],
];

export function FnDetailSkeleton({ steps = 4, onBack }: FnDetailSkeletonProps) {
  return (
    <div className="wrap rd-page fn">
      <div className="crumbs">
        <a onClick={onBack} style={{ cursor: onBack ? "pointer" : "default" }}>
          Funnels
        </a>
        <span className="sep">/</span>
        <Sk w={104} h={9} />
      </div>

      <div className="head" style={{ alignItems: "center" }}>
        <div className="head-l">
          <div className="title-row">
            {/* .fn-title (the inline-editable name) and the saved/dirty pill. */}
            <Sk w={176} h={18} />
            <Sk w={86} h={10} />
          </div>
        </div>
        <div className="actions">
          <Sk w={150} h={31} r={7} />
          <Sk w={114} h={31} r={7} />
        </div>
      </div>

      {/* definition — the step rail drives everything below it */}
      <section className="fn-def">
        {/* `.sp` is only a spacer where the real row gives it flex:1 inline —
            this row doesn't, so "Funnel steps" + "N steps" stay left. */}
        <div className="fn-def-bar">
          <Sk w={78} h={9} />
          <span className="sp" />
          <Sk w={46} h={9} />
        </div>
        <div className="fn-rail fn2-rail">
          {/* Widths vary per card so the rail reads as a sequence of different
              events rather than a row of clones — deterministic, not random, so
              it can't reshuffle on a re-render. */}
          {Array.from({ length: steps }, (_, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <div className="fn2-conn">
                  <Sk w={9} h={9} r={2} />
                </div>
              )}
              <div className="fn2-step">
                <div className="fn2-top">
                  <Sk w={24} h={24} r={8} />
                  <span className="sp" style={{ flex: 1 }} />
                </div>
                <div className="fn2-ev">
                  <Sk w={28} h={28} r={8} />
                  <Sk w={`${44 + ((i * 19) % 30)}%`} h={11} />
                </div>
                <div className="fn2-cond">
                  <Sk w={`${52 + ((i * 23) % 32)}%`} h={9} />
                </div>
              </div>
            </Fragment>
          ))}
          {/* the "Add step" card at the end of the rail */}
          <Sk
            w={128}
            h="auto"
            r={8}
            style={{ flex: "0 0 128px", alignSelf: "stretch", marginLeft: "var(--sp-14)" }}
          />
        </div>
        <div className="fn-filters">
          <Sk w={56} h={9} />
          <Sk w={102} h={28} r={7} />
        </div>
      </section>

      {/* metrics */}
      <div className="stats fn-sum" style={{ marginTop: "var(--sp-20)" }}>
        {FN_SUM_W.map(([l, v, s], i) => (
          <div className="stat" key={i}>
            <div className="stat-l">
              <Sk w={l} h={9} />
            </div>
            <div className="stat-v">
              <Sk w={v} h={20} />
            </div>
            <div className="stat-s">
              <Sk w={s} h={9} />
            </div>
          </div>
        ))}
      </div>

      {/* controls — Steps · Breakdown · Conversion over time · Metric, then the
          metric select, Compare and the date picker on the right. */}
      <div className="fn-tabs-row">
        {[34, 66, 118, 42].map((w, i) => (
          <Sk key={i} w={w} h={10} style={{ marginRight: "var(--sp-20)" }} />
        ))}
        <span className="sp" style={{ flex: 1 }} />
        <Sk w={134} h={30} r={8} style={{ marginLeft: "var(--sp-14)" }} />
        <Sk w={92} h={30} r={8} style={{ marginLeft: "var(--sp-10)" }} />
        <Sk w={124} h={30} r={8} style={{ marginLeft: "var(--sp-10)" }} />
      </div>

      {/* hero — the FnBars retention rows */}
      <section style={{ marginTop: "var(--sp-8)" }}>
        <div className="fn-flow-meta">
          <Sk w={212} h={9} />
        </div>
        <div className="fn-hbars">
          {Array.from({ length: steps }, (_, i) => (
            <div className="fn-hbar-row" key={i}>
              <Sk w={24} h={24} r={7} />
              {/* .fn-hbar-track already paints the real empty track (46px, its
                  own background); the shimmer inside it is the fill, stepping
                  down like a funnel's bars do. A fixed decay — never
                  Math.random() — so the shape stays put across re-renders. */}
              <div className="fn-hbar-track">
                <Sk w={`${Math.round(100 * Math.pow(0.72, i))}%`} h="100%" r={11} />
              </div>
              <div className="fn-hbar-side">
                <Sk w={46} h={11} />
                <Sk w={66} h={8} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* per-step detail */}
      <section className="fn-detail">
        {/* Same here: the real header's `.sp` carries no flex, so the two
            buttons sit next to the title rather than at the far right. */}
        <div className="fn-det-h">
          <Sk w={50} h={15} r={5} />
          <Sk w={164} h={12} />
          <span className="sp" />
          <Sk w={68} h={24} r={7} />
          <Sk w={106} h={24} r={7} />
        </div>
        <div className="fn-det-m">
          {FN_DM_W.map(([l, v], i) => (
            <div className="fn-dm" key={i}>
              <div className="fn-dm-l">
                <Sk w={l} h={8} />
              </div>
              <div className="fn-dm-v">
                <Sk w={v} h={16} />
              </div>
            </div>
          ))}
        </div>
        <div
          className="fn-det-sub"
          style={{ display: "flex", alignItems: "center", gap: "var(--sp-10)" }}
        >
          <Sk w={146} h={9} />
          <span className="sp" style={{ flex: 1 }} />
          <Sk w={84} h={24} r={7} />
        </div>
        {/* "What's hurting conversion" — the correlated-issue cards. */}
        <div className="fn-ins">
          <div className="fn-ins-sub">
            <Sk w={292} h={9} />
          </div>
          <div className="fn-ins-list">
            {Array.from({ length: 2 }, (_, i) => (
              <div className="fn-ins-card" key={i}>
                <div className="fn-ins-main">
                  <div className="fn-ins-title">
                    <Sk w={`${38 + ((i * 21) % 24)}%`} h={11} />
                  </div>
                  <div className="fn-ins-meta">
                    <Sk w={`${28 + ((i * 17) % 20)}%`} h={8} style={{ marginTop: "var(--sp-4)" }} />
                  </div>
                </div>
                <div className="fn-ins-impact">
                  <Sk w={34} h={16} style={{ marginLeft: "auto" }} />
                  <Sk w={30} h={8} style={{ marginLeft: "auto", marginTop: "var(--sp-4)" }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
