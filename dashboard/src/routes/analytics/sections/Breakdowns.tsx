import { useState } from "react";
import { Icon, Select, Seg, Search } from "@/components/primitives";
import { Donut, type DonutSegment } from "@/components/charts";
import { useApi } from "@/api/useApi";
import { Analytics } from "@/api/endpoints";
import { rangeToken } from "@/routes/overview/overview.api";
import { countryName } from "@/lib/device-format";
import { stripScheme } from "@/lib/url-format";
import { DimMark } from "@/components/DimMark";
import { SkStats, SkTable } from "@/components/feedback/skeletons";
import {
  BD_DIMENSIONS, BD_MEASURES, ANL_COLORS,
  bdDimDef, fmtN,
  type BdMeasure, type BdModel,
} from "./breakdowns.data";

/** Backend /v1/analytics/breakdown shape — the FE fills label + rank colour. */
type BdApi = {
  dimension: string;
  measure: string;
  total: number;
  rows: { key: string; count: number; share: number; deltaPct: number }[];
  maxShare: number;
};

function adaptBreakdown(d: BdApi, dimension: string, measure: BdMeasure): BdModel {
  // Hide the empty / "Unknown" bucket everywhere — untagged/uncaptured values are
  // noise in a ranked distribution (the overview traffic panel drops it too).
  const rows = (d.rows ?? [])
    .filter((r) => r.key && r.key.toLowerCase() !== "unknown")
    .map((r, i) => ({
    key: r.key,
    // Country bands come back as ISO-2 codes ("NG") → full name; the full
    // referrer URL shows without its scheme ("google.com/launch", not
    // "https://…"). referrerDomain / utm_* already arrive clean.
    label:
      dimension === "country"
        ? countryName(r.key) || r.key
        : dimension === "referrer"
          ? stripScheme(r.key)
          : r.key,
    color: ANL_COLORS[i % ANL_COLORS.length],
    count: r.count,
    share: r.share,
    deltaPct: r.deltaPct,
  }));
  return {
    dimension,
    dimensionLabel: bdDimDef(dimension).label,
    measure,
    measureLabel: BD_MEASURES.find((m) => m.value === measure)?.label ?? measure,
    total: d.total ?? 0,
    rows,
    // Scale bars to the top VISIBLE row (Unknown, possibly the real max, is gone).
    maxShare: rows[0]?.share ?? 0,
  };
}

/* ============================================================================
   Breakdowns (#8) — ONE analytical object: a dimension's distribution.

   Composition reads top-down as a single deliberate thing, not three stacked
   components:
     · context — a recessive toolbar picks the dimension, measure, filter, range;
     · SUBJECT — the dimension is the headline (large), with the period total and
       a one-line read of who leads (the interpretation);
     · the OBJECT — a full-width ranked table where every row carries its rank,
       count, share, an in-row magnitude bar (the visualization) and its vs-prev
       delta, so ranking AND distribution are read together. There is no separate
       stacked strip competing above it. A subtle, right-aligned lens toggle can
       swap the same data to a flat donut; the ranked table is the default.
     Clicking a row — or a donut/legend item — focuses that bucket and quiets the
     rest, so a comparison can be isolated inside the same object.

   Reads live data from ClickHouse via `useApi(() => Analytics.breakdown(...))`
   (top-N by measure, current vs previous period in one scan); a skeleton shows
   until the first response arrives.
   ========================================================================== */

type VizMode = "bars" | "donut";

export function Breakdowns({ range }: { range: string }) {
  const [dimension, setDimension] = useState("browser");
  const [measure, setMeasure] = useState<BdMeasure>("sessions");
  const [query, setQuery] = useState("");
  const [viz, setViz] = useState<VizMode>("bars");
  const [selected, setSelected] = useState<string | null>(null);

  // Real data from ClickHouse (keepPreviousData keeps the table up during a
  // refilter, so the skeleton shows only on the very first load).
  const { data } = useApi<BdApi>(
    () => Analytics.breakdown<BdApi>(dimension, measure, rangeToken(range)),
    [dimension, measure, range],
  );
  const model = data ? adaptBreakdown(data, dimension, measure) : null;
  if (!model) {
    return (
      <div className="anl-bd">
        <div style={{ margin: "var(--sp-16) 0 var(--sp-24)" }}><SkStats n={1} /></div>
        <SkTable rows={8} />
      </div>
    );
  }

  const pick = (key: string) => setSelected((s) => (s === key ? null : key));

  const dimOpts = BD_DIMENSIONS.map((d) => ({ value: d.value, label: d.label }));
  const measureOpts = BD_MEASURES.map((m) => ({ value: m.value, label: m.label, icon: m.icon }));

  const q = query.trim().toLowerCase();
  const ranked = model.rows.map((row, i) => ({ row, rank: i + 1 }));
  const shown = q ? ranked.filter((x) => x.row.label.toLowerCase().includes(q)) : ranked;

  const dimLabel = model.dimensionLabel;
  const measureLower = model.measureLabel.toLowerCase();
  const leader = model.rows.length ? model.rows[0] : null;

  // Donut lens shares the same colours + focus; unfocused buckets drop to a
  // neutral hairline so the picked wedge reads.
  const donutSegs: DonutSegment[] = model.rows.map((r) => ({
    v: r.share * 100,
    color: selected && selected !== r.key ? "var(--line-strong)" : r.color,
  }));

  const changeDimension = (v: string) => { setDimension(v); setSelected(null); };
  const changeMeasure = (v: string) => { setMeasure(v as BdMeasure); setSelected(null); };

  return (
    <div className="anl-bd">
      {/* ---- context: recessive toolbar (the "how") ---- */}
      <div className="fbar" style={{ margin: "var(--sp-16) 0 var(--sp-24)" }}>
        <Select value={dimension} options={dimOpts} icon={bdDimDef(dimension).icon} onChange={changeDimension} width={172} />
        <Seg value={measure} options={measureOpts} onChange={changeMeasure} />
        <span className="sp" />
        <Search value={query} onChange={setQuery} placeholder="Filter buckets…" width={200} />
      </div>

      {/* ---- subject: the dimension headline + a subtle lens toggle ---- */}
      <div className="anl-bd-headline">
        <div className="anl-bd-subject">
          <h2 className="anl-bd-h-t">{dimLabel}</h2>
          <div className="anl-bd-h-sub">
            <span className="anl-bd-h-big">{fmtN(model.total)}</span> {measureLower}
            {leader && (
              <>
                <span className="anl-bd-h-dot">·</span>
                <span className="anl-bd-h-lead">
                  <span className="anl-bd-h-lead-dot" style={{ background: leader.color }} />
                  {leader.label}
                </span>{" "}
                leads with {(leader.share * 100).toFixed(0)}%
              </>
            )}
          </div>
        </div>
        <Seg
          value={viz}
          onChange={(v) => setViz(v as VizMode)}
          options={[
            { value: "bars", icon: "chartBar", label: "Ranked" },
            { value: "donut", icon: "pie", label: "Donut" },
          ]}
        />
      </div>

      {/* ---- the object: ranked distribution (default) OR a flat donut lens ---- */}
      {viz === "donut" ? (
        <div className="anl-bd-donut-wrap">
          <div className="anl-bd-donut">
            <Donut segments={donutSegs} size={152} thickness={22} />
            <div className="anl-bd-donut-c">
              <span className="anl-bd-donut-v">{fmtN(model.total)}</span>
              <span className="anl-bd-donut-l">{measureLower}</span>
            </div>
          </div>
          <div className={"anl-bd-legend" + (selected ? " has-sel" : "")}>
            {ranked.map(({ row, rank }) => {
              const sel = selected === row.key;
              return (
                <button
                  key={row.key}
                  className={"anl-bd-leg" + (sel ? " sel" : "")}
                  onClick={() => pick(row.key)}
                  title={sel ? "Clear focus" : `Focus ${row.label}`}
                >
                  <span className="anl-bd-leg-rank">{rank}</span>
                  <DimMark dimension={dimension} value={row.label} code={row.key} size={14} />
                  <span className="anl-bd-leg-lbl">{row.label}</span>
                  <span className="anl-bd-leg-share">{(row.share * 100).toFixed(1)}%</span>
                  <span className="anl-bd-leg-count">{fmtN(row.count)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="anl-bd-rows">
          {shown.length ? (
            shown.map(({ row, rank }) => {
              const sel = selected === row.key;
              // Each row IS the bar: a proportional fill behind favicon + name +
              // count (+ vs-prev). No separate share/distribution columns.
              const pct = model.maxShare ? (row.share / model.maxShare) * 100 : 0;
              return (
                <button
                  key={row.key}
                  className={"anl-bd-row" + (sel ? " sel" : "")}
                  onClick={() => pick(row.key)}
                  title={sel ? "Clear focus" : `Focus ${row.label}`}
                >
                  <span className="fill" aria-hidden style={{ width: `${Math.max(2, pct)}%` }} />
                  <span className="rk">{rank}</span>
                  <DimMark dimension={dimension} value={row.label} code={row.key} />
                  <span className="nm" title={row.label}>{row.label}</span>
                  <span className="ct">{fmtN(row.count)}</span>
                  <span className="dl"><BdDelta pct={row.deltaPct} /></span>
                </button>
              );
            })
          ) : (
            <div className="anl-bd-empty">
              <Icon name="search" size={16} />
              <span>No {dimLabel.toLowerCase()} matches “{query}”.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* vs-prev delta — flat mono figure, token-coloured (green up / red down); no
   pill fill, so it reads as data next to the bar rather than a badge. */
function BdDelta({ pct }: { pct: number }) {
  if (!isFinite(pct) || Math.abs(pct) < 0.5) return <span className="anl-bd-delta flat">—</span>;
  const up = pct > 0;
  return (
    <span className={"anl-bd-delta " + (up ? "up" : "down")}>
      <Icon name={up ? "trendUp" : "trendDown"} size={11} /> {Math.abs(pct).toFixed(0)}%
    </span>
  );
}
