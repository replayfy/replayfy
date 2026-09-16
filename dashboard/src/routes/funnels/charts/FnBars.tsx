import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/primitives";
import { fmtN, fnKind } from "../funnels.helpers";
import type { FnStep } from "../funnels.data";

type FnBarsProps = {
  steps: FnStep[];
  sel: number;
  onSel: (i: number) => void;
  compare: boolean;
  prev?: number[];
  /** Open the recordings for a step — the count morphs into a "View" button on
   *  row hover and calls this with the step index. */
  onViewSessions?: (i: number) => void;
  /** Play the grow-in on mount. Default true — the funnels page mounts these
   *  where you're already looking.
   *
   *  Pass false to render at final size with no animation. A caller that waits
   *  for the rows to scroll into view needs this: the reveal is a REMOUNT (the
   *  grow-in is initial→animate, which only fires on mount), and an observer
   *  reports "in view" one render AFTER the mount — so the bars would play once
   *  for the mount and again for the remount, and if the section was already on
   *  screen you'd watch both. The quiet mount is what makes the reveal single. */
  animateIn?: boolean;
};

/** Steps view (F5) — animated horizontal retention bars. Ports the legacy
 *  FunnelBarChart mechanics (index badge · full-width track · inner fill sized
 *  to cur/steps[0].cur · label + pct-of-entry inside · count + drop on the
 *  right), colours the worst adjacent drop-off step red, and staggers each row
 *  in with motion/react (gated by prefers-reduced-motion). When `compare` is on
 *  and a previous-period series has loaded, a dashed ghost marks the prior
 *  width behind each fill. No fixtures — every number is a real `cur`/`prev`. */
export function FnBars({ steps, sel, onSel, compare, prev, onViewSessions, animateIn = true }: FnBarsProps) {
  const reduce = useReducedMotion();
  // One gate for both reasons to skip the grow-in: the user asked for less
  // motion, or the caller is mounting these off-screen and will remount to
  // play them on arrival. `false` (not a zero-duration transition) so the row
  // paints at its final size on the very first frame.
  const still = reduce || !animateIn;
  // `|| 1` guards the empty-funnel case (0 entries → 0%, never NaN); on real
  // data `x || 1 === x`, so the visuals are identical for any non-zero count.
  const c0 = steps[0]?.cur || 1;
  // Worst adjacent drop-off step → rendered red (same derivation as FlowRiver).
  let badIdx = -1,
    worstDrop = 0;
  steps.forEach((s, i) => {
    if (i === 0) return;
    const d = (steps[i - 1].cur - s.cur) / (steps[i - 1].cur || 1);
    if (d > worstDrop) {
      worstDrop = d;
      badIdx = i;
    }
  });
  const hasPrev = compare && !!prev && prev.length === steps.length;
  const p0 = hasPrev ? prev![0] || 1 : 1;

  return (
    <div className="fn-hbars">
      {steps.map((s, i) => {
        const pct = Math.round((s.cur / c0) * 100);
        const fillPct = Math.max(0, Math.min(100, (s.cur / c0) * 100));
        const prevStep = i === 0 ? null : steps[i - 1];
        const dropped = prevStep ? Math.max(0, prevStep.cur - s.cur) : 0;
        const droppedPct =
          prevStep && prevStep.cur > 0
            ? Math.round((dropped / prevStep.cur) * 100)
            : 0;
        const bad = i === badIdx;
        const on = i === sel;
        const ghostPct = hasPrev
          ? Math.max(0, Math.min(100, (prev![i] / p0) * 100))
          : 0;
        const label = s.value || fnKind(s.kind).label;
        return (
          <div
            className={`fn-hbar-row ${on ? "sel" : ""}`}
            key={i}
            onClick={() => onSel(i)}
          >
            <div className={`fn-hbar-num ${bad ? "bad" : ""}`}>{i + 1}</div>
            <div className="fn-hbar-track">
              {hasPrev && (
                <div
                  className="fn-hbar-ghost"
                  style={{ width: `${ghostPct}%` }}
                />
              )}
              <motion.div
                className={`fn-hbar-fill ${bad ? "bad" : ""}`}
                style={{ width: `${fillPct}%`, transformOrigin: "left" }}
                initial={still ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{
                  duration: 0.5,
                  delay: i * 0.06,
                  ease: [0.34, 1.1, 0.5, 1],
                }}
              />
              <motion.div
                className="fn-hbar-content"
                initial={still ? false : { opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.4, delay: 0.12 + i * 0.06 }}
              >
                <span className="fn-hbar-label">{label}</span>
                <span className="fn-hbar-pct mono">{pct}%</span>
              </motion.div>
            </div>
            <motion.div
              className="fn-hbar-side"
              initial={still ? false : { opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.16 + i * 0.06 }}
            >
              <span className="fn-hbar-swap">
                <span className="fn-hbar-count mono">{fmtN(s.cur)}</span>
                {onViewSessions && (
                  <button
                    className="fn-hbar-view"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewSessions(i);
                    }}
                    title="View these recordings"
                  >
                    <Icon name="rec" size={12} /> View
                  </button>
                )}
              </span>
              {i > 0 && dropped > 0 && (
                <span className={`fn-hbar-drop ${bad ? "bad" : ""}`}>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 2v8M3 7l3 3 3-3" />
                  </svg>
                  <span className="mono">{droppedPct}%</span> dropped
                </span>
              )}
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}
