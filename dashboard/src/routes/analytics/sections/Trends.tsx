import { useState } from "react";
import { Icon, Select, Seg } from "@/components/primitives";
import { MiniSpark } from "@/components/charts";
import { AnlTrendChart } from "../charts/AnlTrendChart";
import { FnFilterButton } from "@/routes/funnels/builder/FnFilterButton";
import { FN_FLABEL, FN_OPS, type FnFilter } from "@/routes/funnels/funnels.data";
import { useApi } from "@/api/useApi";
import { Analytics } from "@/api/endpoints";
import { rangeToken } from "@/routes/overview/overview.api";
import { countryName } from "@/lib/device-format";
import { DimMark } from "@/components/DimMark";
import { SkChart } from "@/components/feedback/skeletons";
import {
  MEASURES, ANL_COLORS,
  fmtVal, fmtN, granUnit,
  type Series, type MeasureKind, type Gran, type ChartType, type BuiltChart,
  type EventDef, type PropDef, type NumPropDef,
} from "../analytics.data";

/** Backend POST /v1/analytics/series shape — the FE fills each series' key +
 *  rank colour (presentation the chart/legend render by). */
type SeriesApi = {
  labels: string[];
  gran: Gran;
  kind: BuiltChart["kind"];
  series: { label: string; values: number[]; total: number; avg: number; deltaPct: number }[];
  prev?: number[];
};

function adaptChart(d: SeriesApi, dim: string | null): BuiltChart {
  // Country breakdown bands arrive as ISO-2 codes ("NG", "DE"); show the full
  // name ("Nigeria", "Germany"). Non-codes ("Unknown", "Other") pass through.
  const label = (v: string) => (dim === "country" ? countryName(v) || v : v);
  return {
    labels: d.labels ?? [],
    gran: d.gran,
    kind: d.kind,
    // Hide the "Unknown" breakdown band (untagged/uncaptured) — noise on the
    // chart AND in the legend, dropped everywhere else too.
    series: (d.series ?? [])
      .filter((s) => (s.label || "").toLowerCase() !== "unknown")
      .map((s, i) => ({
      key: s.label || `s${i}`,
      label: label(s.label),
      color: ANL_COLORS[i % ANL_COLORS.length],
      values: s.values ?? [],
      total: s.total,
      avg: s.avg,
      deltaPct: s.deltaPct,
    })),
    prev: d.prev,
  };
}

/* ============================================================================
   Trends (#4) — an investigation workspace, not a control panel.

   Composition: the METRIC is the subject (a large headline + its key numbers),
   the chart is the evidence, the table is the comparison, and the left rail is
   the recessive control surface. Reads live series from ClickHouse via
   `useApi(() => Analytics.series(...))`; a skeleton shows until it arrives.
   ========================================================================== */

/** Backend /v1/analytics/schema shape — populates the left-rail selects with the
 *  workspace's REAL events / dimensions / numeric props. */
type SchemaApi = {
  events: EventDef[];
  dimensions: PropDef[];
  numProps: NumPropDef[];
  measures: { value: string; label: string }[];
};

let SID = 2;
const nextId = () => `s${SID++}`;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function Trends({ range, compare }: { range: string; compare: boolean }) {
  const [series, setSeries] = useState<Series[]>([{ id: "s1", event: "$sessions", measure: "count" }]);
  const [breakdown, setBreakdown] = useState<string | null>(null);
  const [type, setType] = useState<ChartType>("line");
  const [gran, setGran] = useState<Gran>("day");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FnFilter[]>([]);

  // Real series from ClickHouse (POST body carries the query builder state); a
  // skeleton shows while the first request is in flight.
  const { data } = useApi<SeriesApi>(
    () =>
      Analytics.series<SeriesApi>({
        series: series.map((s) => ({ id: s.id, event: s.event, measure: s.measure, numProp: s.numProp })),
        breakdown,
        range: rangeToken(range),
        granularity: gran,
        compare,
        filters,
      }),
    [series, breakdown, gran, compare, filters, range],
  );
  // Real series from ClickHouse; empty (not mock) while the first request is in
  // flight — the chart area shows a skeleton until `data` arrives.
  const chart: BuiltChart = data
    ? adaptChart(data, breakdown)
    : { labels: [], gran, kind: "count", series: [] };

  // The rail's real vocabulary — this workspace's events / dimensions / numeric
  // props from the schema endpoint (no seeded lists).
  const { data: schema } = useApi<SchemaApi>(() => Analytics.schema<SchemaApi>(rangeToken(range)), [range]);
  const anlEvents: EventDef[] = schema?.events ?? [];
  const anlBreakdowns: PropDef[] = schema?.dimensions ?? [];
  const anlNumProps: NumPropDef[] = schema?.numProps ?? [];
  const evLabelOf = (v: string) => anlEvents.find((e) => e.value === v)?.label ?? v;

  const patch = (id: string, p: Partial<Series>) => setSeries((xs) => xs.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const setMeasure = (id: string, m: MeasureKind) => {
    const needsProp = MEASURES.find((x) => x.value === m)?.needsProp;
    setSeries((xs) => xs.map((s) => (s.id === id ? { ...s, measure: m, numProp: needsProp ? s.numProp ?? anlNumProps[0]?.value : undefined } : s)));
  };
  // Every numeric property is SESSION-level, so Sum/Avg/Median/P95 only compute
  // for the Sessions source ($sessions) — on any other event the backend falls
  // back to count(). So gate those measures to Sessions, and if the user switches
  // a "Sum of…" series to a non-session event, snap the measure back to count.
  const setEvent = (id: string, ev: string) => {
    setSeries((xs) => xs.map((s) => {
      if (s.id !== id) return s;
      const needsProp = MEASURES.find((m) => m.value === s.measure)?.needsProp;
      return needsProp && ev !== "$sessions"
        ? { ...s, event: ev, measure: "count", numProp: undefined }
        : { ...s, event: ev };
    }));
  };
  const measureOptsFor = (ev: string) =>
    MEASURES.filter((m) => !m.needsProp || ev === "$sessions").map((m) => ({ value: m.value, label: m.label }));
  const addSeries = () => {
    const used = new Set(series.map((s) => s.event));
    const next = anlEvents.find((e) => !used.has(e.value)) ?? anlEvents[0];
    if (!next) return; // schema not loaded yet
    setSeries((xs) => [...xs, { id: nextId(), event: next.value, measure: "count" }]);
  };
  const removeSeries = (id: string) => setSeries((xs) => (xs.length > 1 ? xs.filter((s) => s.id !== id) : xs));
  const toggle = (key: string) => setHidden((h) => { const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const eventOpts = anlEvents.map((e) => ({
    value: e.value,
    label: (<span className="anl-opt"><span>{e.label}</span><span className="anl-opt-n">{fmtN(e.volume)}</span></span>),
  }));
  const numPropOpts = anlNumProps.map((p) => ({ value: p.value, label: p.label }));
  const bdOpts = [{ value: "__none", label: "No breakdown" }, ...anlBreakdowns.map((b) => ({ value: b.value, label: b.label }))];

  const bdOn = !!breakdown;
  const unit = granUnit(gran);

  // --- the metric headline (the SUBJECT): title + total · per-unit · delta ---
  const bdLabel = breakdown ? (anlBreakdowns.find((b) => b.value === breakdown)?.label ?? breakdown) : null;
  const headTitle = breakdown ? `${evLabelOf(series[0].event)} by ${bdLabel}`
    : series.length === 1 ? evLabelOf(series[0].event) : `${series.length} series`;
  const headTotal = chart.series.reduce((a, s) => a + s.total, 0);
  const headAvg = headTotal / Math.max(1, chart.labels.length);
  const sums = chart.labels.map((_, i) => chart.series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const qn = Math.max(1, Math.floor(sums.length / 4));
  const f0 = mean(sums.slice(0, qn)); const l0 = mean(sums.slice(-qn));
  const headDelta = f0 > 0 ? ((l0 - f0) / f0) * 100 : 0;

  return (
    <div className="anl-layout">
      {/* ---- control rail (recessive: the "how") ---- */}
      <aside className="anl-rail">
        <div className="anl-rail-sec">
          <div className="anl-rail-h">Series</div>
          {series.map((s, i) => {
            const needsProp = MEASURES.find((m) => m.value === s.measure)?.needsProp;
            const dim = bdOn && i > 0;
            return (
              <div className={"anl-series-row" + (dim ? " dim" : "")} key={s.id}>
                <span className="anl-dot" style={{ backgroundColor: ["#5b5ceb", "#8b72d6", "#3b76b0", "#3f9468", "#c08a3e"][i % 5] }} />
                <div className="anl-series-fields">
                  <Select value={s.event} options={eventOpts} onChange={(v) => setEvent(s.id, v)} width="trigger" />
                  <div className="anl-series-sub">
                    <Select value={s.measure} options={measureOptsFor(s.event)} onChange={(v) => setMeasure(s.id, v as MeasureKind)} width="trigger" />
                    {needsProp && <Select value={s.numProp ?? anlNumProps[0]?.value ?? ""} options={numPropOpts} onChange={(v) => patch(s.id, { numProp: v })} width="trigger" />}
                  </div>
                </div>
                {series.length > 1 && <button className="anl-remove" onClick={() => removeSeries(s.id)} title="Remove series"><Icon name="x" size={12} /></button>}
              </div>
            );
          })}
          <button className="anl-add" onClick={addSeries}><Icon name="plus" size={12} /> Add series</button>
          {bdOn && <div className="anl-hint">Breakdown applies to the first series.</div>}
        </div>

        <div className="anl-rail-sec">
          <div className="anl-rail-h">Breakdown</div>
          <Select value={breakdown ?? "__none"} options={bdOpts} icon="chartBar" onChange={(v) => setBreakdown(v === "__none" ? null : v)} width="trigger" />
        </div>

        <div className="anl-rail-sec">
          <div className="anl-rail-h">Filters</div>
          {filters.length > 0 && (
            <div className="cond-row" style={{ marginBottom: "var(--sp-10)" }}>
              {filters.map((f, i) => (
                <span className="cond editable" key={i}>
                  <b>{FN_FLABEL[f.key] || f.key}</b><span className="op">{FN_OPS[f.op] || f.op}</span><span className="mono">{f.val || "…"}</span>
                  <span className="rm" onClick={() => setFilters((a) => a.filter((_, j) => j !== i))}>×</span>
                </span>
              ))}
            </div>
          )}
          <FnFilterButton
            note="Scope this metric to matching sessions"
            allow={["urlPath", "referrerUrl", "browser", "device", "os", "country", "plan"]}
            onCommit={(f) => setFilters((a) => [...a, f])}
          />
        </div>
      </aside>

      {/* ---- the analytical object (the "what") ---- */}
      <section className="anl-canvas">
        <div className="anl-metric-row">
          <div className="anl-metric">
            <h2 className="anl-metric-t">{headTitle}</h2>
            <div className="anl-metric-sub">
              <span className="anl-metric-big">{fmtVal(headTotal, chart.kind)}</span> total
              <span className="anl-metric-dot">·</span>{fmtVal(headAvg, chart.kind)} / {unit}
              <span className="anl-metric-dot">·</span><Delta pct={headDelta} />
            </div>
          </div>
          <div className="anl-controls">
            <Seg value={type} onChange={(v) => setType(v as ChartType)} options={[
              { value: "line", icon: "activity", label: "Line" },
              { value: "area", icon: "chartLine", label: "Area" },
              { value: "bar", icon: "chartBar", label: "Bar" },
              { value: "number", icon: "hash", label: "Value" },
            ]} />
            <Seg value={gran} onChange={(v) => setGran(v as Gran)} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
          </div>
        </div>

        {!data ? (
          <SkChart h={360} />
        ) : type === "number" ? (
          <div className="anl-numgrid">
            {chart.series.filter((s) => !hidden.has(s.key)).map((s) => (
              <div className="anl-numtile" key={s.key}>
                <div className="anl-num-lbl">{bdOn ? <DimMark dimension={breakdown!} value={s.label} code={s.key} size={14} /> : <span className="anl-dot" style={{ backgroundColor: s.color }} />} {s.label}</div>
                <div className="anl-num-v">{fmtVal(s.total, chart.kind)}</div>
                <Delta pct={s.deltaPct} />
              </div>
            ))}
          </div>
        ) : (
          <AnlTrendChart chart={chart} type={type} hidden={hidden} showPrev={compare} />
        )}

        {/* comparison / legend — the detail */}
        {data && <div className="anl-results">
          <div className="anl-res-head">
            <span>{bdOn ? bdLabel : "Series"}</span>
            <span className="anl-res-num">Total</span>
            <span className="anl-res-num">Avg / {unit}</span>
            <span className="anl-res-spark">Trend</span>
            <span className="anl-res-num">vs prev</span>
          </div>
          {chart.series.map((s) => {
            const off = hidden.has(s.key);
            return (
              <button className={"anl-res-row" + (off ? " off" : "")} key={s.key} onClick={() => toggle(s.key)} title={off ? "Show series" : "Hide series"}>
                <span className="anl-res-lbl">{bdOn ? <DimMark dimension={breakdown!} value={s.label} code={s.key} size={14} /> : <span className="anl-dot" style={{ backgroundColor: s.color }} />} <span className="anl-res-name">{s.label}</span></span>
                <span className="anl-res-num">{fmtVal(s.total, chart.kind)}</span>
                <span className="anl-res-num">{fmtVal(s.avg, chart.kind)}</span>
                <span className="anl-res-spark"><MiniSpark data={s.values} color={s.color} w={72} h={22} /></span>
                <span className="anl-res-num"><Delta pct={s.deltaPct} /></span>
              </button>
            );
          })}
        </div>}
      </section>
    </div>
  );
}

function Delta({ pct }: { pct: number }) {
  if (!isFinite(pct) || Math.abs(pct) < 0.5) return <span className="anl-delta flat">— stable</span>;
  const up = pct > 0;
  return <span className={"anl-delta " + (up ? "up" : "down")}><Icon name={up ? "trendUp" : "trendDown"} size={11} /> {Math.abs(pct).toFixed(0)}%</span>;
}
