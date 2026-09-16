import { useState } from "react";
import { Icon, Select, Seg } from "@/components/primitives";
import { useApi } from "@/api/useApi";
import { Analytics } from "@/api/endpoints";
import { rangeToken } from "@/routes/overview/overview.api";
import { SkStats, SkTable } from "@/components/feedback/skeletons";
import { RET_ACCENT_RGB, fmtInt, type RetGran, type RetModel } from "./retention.data";

/** Pseudo-events aren't valid "returning actions" (the backend gates retention
 *  on a real replay.track event); only real custom events are offered. Every
 *  built-in pseudo-event is `$`-prefixed ($sessions/$pageview/$console/…), so a
 *  single prefix test drops them all — the explicit list drifted out of date. */
const isPseudoEvent = (value: string): boolean => value.startsWith("$");
type SchemaEvents = { events: { value: string; label: string }[] };

/* ============================================================================
   Retention (#3) — a cohort-retention TRIANGLE: each row is a cohort (with its
   size N), each column a period offset (Day/Week/Month 0,1,2…), and each cell
   the % of that cohort still returning — an indigo heat cell whose opacity
   scales with the retention %.

   FLAT, enterprise chrome (matches Cohorts/Users): no bordered cards, no panel
   box. Hierarchy comes from typography + hairline dividers + spacing. The KPI
   row uses the shared flat `.stats/.stat/.stat-l/.stat-v` primitives; the
   triangle is a full-width base `<table>`. Reads live cohort retention from
   ClickHouse via `useApi(() => Analytics.retention(...))`; a skeleton shows
   until the first response arrives.
   ========================================================================== */

export function Retention({ range }: { range: string }) {
  const [action, setAction] = useState<string>("any");
  const [gran, setGran] = useState<RetGran>("week");

  // Real cohort retention from ClickHouse (keepPreviousData keeps the grid up
  // during a refilter, so the skeleton only shows on the very first load).
  const { data: model } = useApi<RetModel>(
    () => Analytics.retention<RetModel>(action, gran, rangeToken(range)),
    [action, gran, range],
  );
  // Real returning-action list: "Any session" + this workspace's custom events.
  const { data: schema } = useApi<SchemaEvents>(() => Analytics.schema<SchemaEvents>(rangeToken(range)), [range]);
  const actionOpts = [
    { value: "any", label: "Any session" },
    ...(schema?.events ?? [])
      .filter((e) => !isPseudoEvent(e.value))
      .map((e) => ({ value: e.value, label: e.label })),
  ];

  return (
    <div className="anl-ret">
      {/* ---- toolbar ---- */}
      <div className="fbar" style={{ margin: "var(--sp-16) 0 0" }}>
        <Select value={action} options={actionOpts} icon="refresh" onChange={setAction} width={196} />
        <Seg
          value={gran}
          onChange={(v) => setGran(v as RetGran)}
          options={[
            { value: "day", label: "Daily" },
            { value: "week", label: "Weekly" },
            { value: "month", label: "Monthly" },
          ]}
        />
      </div>

      {!model ? (
        <div style={{ marginTop: "var(--sp-24)" }}>
          <SkStats n={3} />
          <div style={{ height: "var(--sp-24)" }} />
          <SkTable rows={6} />
        </div>
      ) : (
        <RetentionBody model={model} />
      )}
    </div>
  );
}

function RetentionBody({ model }: { model: RetModel }) {
  return (
    <>

      {/* ---- retention summary — a thin strip, no cards; the matrix is the hero ---- */}
      <div className="anl-ret-summary">
        <div className="anl-ret-summary-h">Retention</div>
        <div className="anl-ret-summary-row">
          {model.milestones.map((m) => (
            <div className="anl-ret-ms" key={m.key}>
              <div className="anl-ret-ms-l">{m.label}</div>
              <div className="anl-ret-ms-v">{m.pct.toFixed(0)}%</div>
              <Delta pct={m.deltaPct} />
            </div>
          ))}
        </div>
      </div>

      {/* ---- section eyebrow + heat legend ---- */}
      <div className="anl-ret-shead" style={{ marginTop: "var(--sp-20)", marginBottom: "var(--sp-14)" }}>
        <div>
          <div className="anl-ret-eyebrow">Cohort retention</div>
          <div className="anl-ret-sub">
            % returning by {model.unitPlural} since first session · {fmtInt(model.totalUsers)} users
          </div>
        </div>
        <div className="anl-ret-legend" title="Cell opacity scales with retention %">
          <span className="anl-ret-legend-t">0%</span>
          <span className="anl-ret-legend-bar" />
          <span className="anl-ret-legend-t">100%</span>
        </div>
      </div>

      {/* ---- cohort triangle — FLAT full-width table, no panel box ---- */}
      <div className="anl-ret-scroll">
        <table className="anl-ret-tbl">
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "8%" }} />
            {Array.from({ length: model.cols }, (_, k) => (
              <col key={k} style={{ width: `${68 / model.cols}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="anl-ret-th-co">Cohort</th>
              <th className="anl-ret-th-n">Users</th>
              {Array.from({ length: model.cols }, (_, k) => (
                <th className="anl-ret-th-w" key={k}>{model.unit.charAt(0)}{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.cohorts.map((c) => (
              <tr key={c.key}>
                <td className="anl-ret-co">{c.label}</td>
                <td className="anl-ret-n">{fmtInt(c.size)}</td>
                {c.cells.map((v, k) => <HeatCell key={k} pct={v} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One heat cell — the fill is the indigo accent at an opacity that scales with
    the retention %, and the number flips to white once the fill is dark enough
    (~45%). Blank cells are the cohort's not-yet-observed future offsets — left
    empty so the grid reads as a triangle. */
function HeatCell({ pct }: { pct: number | null }) {
  if (pct == null) return <td className="anl-ret-hc"><span className="anl-ret-heat blank" aria-hidden="true" /></td>;
  const alpha = (pct / 100) * 0.9;
  const white = pct > 45;
  return (
    <td className="anl-ret-hc">
      <span
        className="anl-ret-heat"
        style={{
          background: `rgba(${RET_ACCENT_RGB}, ${alpha.toFixed(3)})`,
          color: white ? "var(--surface)" : "var(--text)",
        }}
      >
        {pct >= 99.5 ? "100" : pct.toFixed(0)}
      </span>
    </td>
  );
}

/** Newest-vs-oldest cohort delta for a milestone — concise (arrow + %) under
    the KPI value, with the comparison spelled out on hover. */
function Delta({ pct }: { pct: number }) {
  if (!isFinite(pct) || Math.abs(pct) < 0.5)
    return <span className="anl-ret-delta flat" title="No change vs oldest cohort">— stable</span>;
  const up = pct > 0;
  return (
    <span className={"anl-ret-delta " + (up ? "up" : "down")} title="vs oldest cohort">
      <Icon name={up ? "trendUp" : "trendDown"} size={11} /> {Math.abs(pct).toFixed(0)}%
    </span>
  );
}
