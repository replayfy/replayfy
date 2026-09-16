import type { CSSProperties, ReactNode } from "react";
import { motion, MotionConfig } from "motion/react";
import NumberFlow, { useCanAnimate, type Format } from "@number-flow/react";
import { Sk } from "@/components/feedback";

/* ============================================================================
   PulseBand — the executive numbers across the top, now paired with a
   featured story slot (the AI storyline or the deterministic needs-attention
   card) in the freed space to the right. Values run on NumberFlow; deltas
   rotate + roll with spring layout; each value can carry a semantic hue.
   ========================================================================== */

export type PulseDelta = {
  arrow?: "▲" | "▼";
  tone: "up" | "down" | "flat";
  text: string;
} | null;

export type PulseCell = {
  key: string;
  label: string;
  /** null renders as "—" (an unmeasurable metric, e.g. health with no sessions),
   *  never as 0 — a dash is a different statement from a real zero. */
  num: number | null;
  numFormat?: Format;
  unit?: string;
  delta?: PulseDelta;
  sub: string;
  color?: string;      // semantic hue for the value
  onClick?: () => void;
  title?: string;
  /** This cell's read hasn't landed yet — shimmer the value instead of
   *  printing the fixture. Per-cell, not per-band: the conversion cell reads
   *  /metrics while the other three read /overview, and whichever lands first
   *  should show its number immediately. */
  skeleton?: boolean;
};

const MotionNumberFlow = motion.create(NumberFlow);
const NF_MASK = { "--number-flow-mask-height": "0.28em" } as CSSProperties;

function TrendChip({ delta }: { delta: NonNullable<PulseDelta> }) {
  const canAnimate = useCanAnimate();
  const m = delta.text.replace(/^[+−-]/, "").match(/^([\d,.]+)(.*)$/);
  const num = m ? parseFloat(m[1].replace(/,/g, "")) : null;
  const suffix = m && m[2] ? m[2] : undefined;
  return (
    <MotionConfig
      transition={{
        layout: canAnimate
          ? { duration: 0.5, bounce: 0, type: "spring" }
          : { duration: 0 },
      }}
    >
      <motion.span
        className={`ox-tr ${delta.tone}`}
        layout
        style={{ borderRadius: "var(--r-pill)" }}
      >
        {delta.arrow && (
          <motion.span
            className="ar"
            layout
            style={{ display: "inline-block", transformOrigin: "50% 55%" }}
            transition={{
              rotate: canAnimate
                ? { type: "spring", duration: 0.5, bounce: 0 }
                : { duration: 0 },
            }}
            animate={{ rotate: delta.arrow === "▲" ? 0 : 180 }}
            initial={false}
          >
            ▲
          </motion.span>
        )}
        {num != null ? (
          <MotionNumberFlow
            value={num}
            suffix={suffix}
            format={{ maximumFractionDigits: 2 }}
            style={NF_MASK}
            layout
            layoutRoot
          />
        ) : (
          <span>{delta.text}</span>
        )}
      </motion.span>
    </MotionConfig>
  );
}

export function PulseBand({ cells, trailing }: { cells: PulseCell[]; trailing?: ReactNode }) {
  return (
    <section className="ox-pulse" aria-label="Product pulse">
      {cells.map((c, i) => {
        const body = (
          <>
            {/* The label and the period note are the page's own — only the
                value, its unit and its delta wait on a read. Widths vary per
                cell so the band doesn't read as four identical bars;
                deterministic, so it can't reshuffle on a re-render. */}
            <span className="k">{c.label}</span>
            {c.skeleton ? (
              <span className="v">
                <Sk w={66 + ((i * 17) % 28)} h={20} />
              </span>
            ) : (
              <span className="v" style={c.color ? { color: c.color } : undefined}>
                {c.num != null ? (
                  <>
                    <NumberFlow value={c.num} format={c.numFormat} style={NF_MASK} />
                    {c.unit && <span className="u">{c.unit}</span>}
                  </>
                ) : (
                  // Unmeasurable — reuse the value slot's own styling, no unit
                  // ("—/100" reads as a broken number).
                  "—"
                )}
              </span>
            )}
            {/* The delta moved OUT of `.v` and down onto the context line.
                Inside `.v` it shared one nowrap row with a 26px number and its
                unit inside a 150px column — "26.2 % ▲26.2pt" overflowed and got
                clipped mid-word, which is what made the band look broken.

                It also reads better here: the delta and "vs previous 30 days"
                are the SAME thought — how this moved, against what — so one
                line carries both. The number keeps the row above to itself. */}
            <span className="d">
              {c.delta && !c.skeleton && <TrendChip delta={c.delta} />}
              <span className="s">{c.sub}</span>
            </span>
          </>
        );
        // A skeleton cell isn't a button: its click opens a drawer onto the
        // very number that hasn't arrived. The affordance returns with the value.
        return c.onClick && !c.skeleton ? (
          <button
            key={c.key}
            className="ox-kpi"
            onClick={c.onClick}
            title={c.title}
          >
            {body}
          </button>
        ) : (
          <div key={c.key} className="ox-kpi" title={c.title}>
            {body}
          </div>
        );
      })}
      {trailing && <div className="ox-pulse-story">{trailing}</div>}
    </section>
  );
}
