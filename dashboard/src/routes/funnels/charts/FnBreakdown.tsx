import { motion, useReducedMotion } from "motion/react";
import { fmtN, fnKind } from "../funnels.helpers";
import { countryName, flagEmoji } from "@/lib/device-format";
import {
  FN_BDIMS,
  type FnStep,
  type ApiFunnelBreakdownBucket,
} from "../funnels.data";

/** Humanise a breakdown value for display. Country arrives as an ISO code — map
 *  it to "🇳🇬 Nigeria" like every other surface (recordings, segments) instead of
 *  showing the bare "NG"; all other dimensions pass through unchanged. */
function bdLabel(dim: string, value: string): string {
  if (!value) return "(none)";
  if (dim === "country") {
    const name = countryName(value) || value;
    const flag = flagEmoji(value);
    return flag ? `${flag} ${name}` : name;
  }
  return value;
}

type FnBreakdownProps = {
  dim: string;
  steps: FnStep[];
  buckets: ApiFunnelBreakdownBucket[] | null;
  metric?: string;
};

// Deterministic per-bucket hues (cycled) so each segment stays a stable color
// across the bar chart and the detailed table.
const BD_COLORS = [
  "#3b63d8",
  "#8b72d6",
  "#3f9468",
  "#c08a3e",
  "#c2599f",
  "#3b76b0",
  "#bd8638",
  "#5b5ceb",
];

/** Breakdown tab — conversion split by a dimension, rendered from the REAL
 *  POST /v1/funnels/breakdown buckets (no fixtures). Each bucket becomes one
 *  horizontal conversion bar (fill = `overallConversionPct`, fraction =
 *  `converted / startedFunnel`); the detailed per-step counts live in the table
 *  below. Enterprise horizontal-bar layout with a staggered grow-in. */
export function FnBreakdown({ dim, steps, buckets, metric }: FnBreakdownProps) {
  const reduce = useReducedMotion();
  const ax = steps.map((s) => s.value || fnKind(s.kind).label);
  const dimLabel = (FN_BDIMS.find((d) => d[0] === dim) || [null, "Segment"])[1];

  if (buckets == null) {
    return (
      <div
        className="fn-viz-empty"
        style={{
          marginTop: "var(--sp-16)",
          padding: "var(--sp-40) var(--sp-24)",
          textAlign: "center",
          color: "var(--t3)",
          fontSize: "var(--text-sm)",
        }}
      >
        Computing breakdown…
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <div
        className="fn-viz-empty"
        style={{
          marginTop: "var(--sp-16)",
          padding: "var(--sp-40) var(--sp-24)",
          textAlign: "center",
          color: "var(--t3)",
          fontSize: "var(--text-sm)",
        }}
      >
        No breakdown data for this segment yet.
      </div>
    );
  }

  const rows = buckets.map((b, i) => ({
    b,
    color: BD_COLORS[i % BD_COLORS.length],
  }));

  const unit = metric === "users" ? "users" : "sessions";

  return (
    <div className="bd-wrap" style={{ marginTop: "var(--sp-16)" }}>
      <div className="bd-head">
        <span>{dimLabel}</span>
        <span>Conversion ({unit})</span>
      </div>
      {rows.map(({ b }, rowIdx) => {
        const pct = b.overallConversionPct;
        return (
          <div className="bd-row" key={b.value}>
            <div className="bd-nm" title={bdLabel(dim, b.value)}>
              {bdLabel(dim, b.value)}
            </div>
            <div className="bd-track">
              <motion.div
                className="bd-fill"
                style={{ width: pct + "%", transformOrigin: "left" }}
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.55, delay: rowIdx * 0.05, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            <div className="bd-stat">
              <span className="pct">{pct.toFixed(2)}%</span>
              <span className="frac">
                {fmtN(b.converted)}/{fmtN(b.startedFunnel)}
              </span>
            </div>
          </div>
        );
      })}

      <div className="fn-sc-dh">Detailed results</div>
      <div className="fn-sc-tablewrap">
        <table className="fn-sc-table bd-table">
          <thead>
            <tr>
              <th>{dimLabel}</th>
              <th>Total conv.</th>
              {steps.map((s, i) => (
                <th key={i}>
                  {i + 1}. {s.value || fnKind(s.kind).label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, color }) => (
              <tr key={b.value}>
                <td className="step">
                  <span className="sw" style={{ background: color }} />
                  <span className="ev">{bdLabel(dim, b.value)}</span>
                </td>
                <td className="mono" style={{ color, fontWeight: "var(--fw-semibold)" }}>
                  {b.overallConversionPct.toFixed(1)}%
                </td>
                {b.steps.slice(0, ax.length).map((st, i) => (
                  <td key={i} className="mono">
                    <span className="bd-cell">
                      <b>{fmtN(st.count)}</b>
                      <i>{st.conversionPct.toFixed(0)}%</i>
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
