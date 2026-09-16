import { useMemo, useState } from "react";
import { Icon, Seg } from "@/components/primitives";
import { useApi } from "@/api/useApi";
import { Analytics } from "@/api/endpoints";
import { rangeToken } from "@/routes/overview/overview.api";
import { SkStats, SkTable } from "@/components/feedback/skeletons";
import {
  fmtVital, fmtCompact, ratingLabel, WV_METRICS,
  type WvDevice, type WvSummary, type WvRating, type WvMetricKey, type WvPageVitals, type WvModel,
} from "./webvitals.data";

const EMPTY_WV: WvModel = { pages: [], summary: [], totalPageviews: 0 };

/* ============================================================================
   Web Vitals (#6) — per-page Core Web Vitals (LCP / INP / CLS / FCP / TTFB),
   WEB ONLY. Reworked for COMPOSITION, not components: a clear analytical
   hierarchy — context → SUBJECT → distribution → detail.

     · context      — a quiet device / range toolbar (the controls recede)
     · SUBJECT      — a metric-as-subject VERDICT headline: how many page views
                      pass, which metric is weakest, which page is slowest. This
                      tells the user what the page is saying before the numbers.
     · distribution — the five Core Web Vitals as one flat `.stats` KPI row
                      (p75 + rating pill + good/needs/poor field bar)
     · detail       — the per-page table, worst-first, as the drill-down

   The verdict is computed DETERMINISTICALLY from the same model the row + table
   render — no second source of truth. Only the *problems* (weakest metric,
   slowest page) carry colour; everything else stays flat. Reads live RUM from
   ClickHouse via `useApi(() => Analytics.webVitals(...))`; a skeleton shows
   until the first response arrives.
   ========================================================================== */

/* The three metrics that define the pass verdict. FCP + TTFB are diagnostic —
   shown in the row + table, but they don't gate the headline. */
const CORE_KEYS: WvMetricKey[] = ["lcp", "inp", "cls"];
/* Rank ratings worst-first so the weakest metric sorts to the top. */
const RATING_RANK: Record<WvRating, number> = { poor: 0, needs: 1, good: 2 };

export function WebVitals({ range }: { range: string }) {
  const [device, setDevice] = useState<WvDevice>("all");

  // Backend WvModel (CH-native RUM) matches this shape 1:1; builder = placeholder.
  const { data } = useApi<WvModel>(
    () => Analytics.webVitals<WvModel>(device, rangeToken(range)),
    [device, range],
  );
  // Real RUM from ClickHouse; empty (not mock) while the first request is in
  // flight — the JSX below is gated behind a skeleton until `data` arrives.
  const model = data ?? EMPTY_WV;

  /* ---- the VERDICT (the subject) ----------------------------------------
     · passPct   = page-view-weighted "good" share across the 3 Core Web Vitals
                   (the summary dist is already pageview-weighted).
     · weakest   = the metric with the worst p75 rating, tie-broken by the
                   largest poor share — the one dragging the score down.
     · worstPage = the model already pre-sorts pages worst-LCP-first, so the
                   first row is the slowest page.
     All derived from `model`, so the headline can never disagree with the row
     or the table below it. */
  const verdict = useMemo(() => {
    const core = model.summary.filter((s) => CORE_KEYS.includes(s.key));
    const passRate = core.length ? core.reduce((a, s) => a + s.dist[0], 0) / core.length : 0;
    const weakest: WvSummary | undefined = [...model.summary].sort((a, b) => {
      const d = RATING_RANK[a.rating] - RATING_RANK[b.rating];
      return d !== 0 ? d : b.dist[2] - a.dist[2];
    })[0];
    const worstPage: WvPageVitals | undefined = model.pages[0];
    return { passPct: Math.round(passRate * 100), weakest, worstPage };
  }, [model]);

  if (!data) {
    return (
      <div className="anl-wv">
        <div style={{ margin: "var(--sp-16) 0" }}><SkStats n={5} /></div>
        <SkTable rows={6} />
      </div>
    );
  }

  return (
    <div className="anl-wv">
      {/* ---- context: device Seg · Web-only note — shown ONLY when there is web-
           vitals data to slice. On a truly-empty workspace the "All" view is
           empty (totalPageviews===0), so there is nothing to filter and both the
           toggle and note are hidden. Once the user has drilled into a specific
           device we keep the toggle visible (even if THAT device is empty) so
           they can switch back — otherwise an empty Desktop view would strand
           them with no control. ---- */}
      {(device === "all" ? model.totalPageviews > 0 : true) && (
      <div className="fbar" style={{ margin: "var(--sp-16) 0" }}>
        <Seg
          value={device}
          onChange={(v) => setDevice(v as WvDevice)}
          options={[
            { value: "all", icon: "device", label: "All" },
            { value: "desktop", icon: "monitor", label: "Desktop" },
            { value: "mobile", icon: "phone", label: "Mobile" },
          ]}
        />
        <span className="sp" />
        <span
          className="anl-wv-note"
          title="Core Web Vitals are collected from web sessions only — native mobile SDK sessions are excluded."
        >
          <Icon name="globe" size={12} /> Web only
        </span>
      </div>
      )}

      {model.totalPageviews === 0 ? (
        /* No web pageviews for this device/range — an honest empty state, not a
           misleading "100% pass · 0 ms". Native-app sessions never report Core
           Web Vitals, so a mobile filter is often empty for app-only traffic. */
        <div className="anl-ev-empty anl-wv-empty">
          <Icon name="globe" size={34} />
          <p>No {device === "desktop" ? "desktop " : device === "mobile" ? "mobile " : ""}web sessions with Core Web Vitals in this range.</p>
          <span className="anl-wv-note">Web vitals come from web (browser) sessions only — native app sessions don’t report LCP / INP / CLS.</span>
        </div>
      ) : (
      <>
      {/* ---- SUBJECT: the verdict headline — what the page is telling you ---- */}
      <div className="anl-wv-headline">
        <h2 className="anl-metric-t">Core Web Vitals</h2>
        <p className="anl-wv-verdict">
          <span
            className="anl-wv-v-strong"
            title="Page views rated good across LCP, INP and CLS, weighted by page views"
          >
            {verdict.passPct}%
          </span>
          of page views pass
          {verdict.weakest && verdict.weakest.rating !== "good" && (
            <>
              <span className="anl-metric-dot">·</span>
              <span className={"anl-wv-vk " + verdict.weakest.rating} title={ratingLabel(verdict.weakest.rating) + " · " + verdict.weakest.name}>
                {verdict.weakest.label}
              </span>
              is the weakest metric
            </>
          )}
          {verdict.weakest && verdict.weakest.rating === "good" && (
            <>
              <span className="anl-metric-dot">·</span>
              every metric is rated good
            </>
          )}
          {verdict.worstPage && (
            <>
              <span className="anl-metric-dot">·</span>
              slowest page
              <span
                className={"anl-wv-vp " + verdict.worstPage.metrics.lcp.rating}
                title={fmtVital("lcp", verdict.worstPage.metrics.lcp.value) + " LCP · " + verdict.worstPage.path}
              >
                {verdict.worstPage.path}
              </span>
            </>
          )}
        </p>
      </div>

      {/* ---- distribution: the five metrics as one flat KPI row ---- */}
      <div className="stats anl-wv-stats">
        {model.summary.map((m) => <MetricStat key={m.key} m={m} />)}
      </div>

      {/* ---- detail: per-page table (flat, full-width, worst-LCP-first) ---- */}
      <div className="anl-wv-tbl-head">
        <span className="anl-wv-eyebrow-lbl">Pages</span>
        <span className="anl-wv-tbl-hint">
          p75 per page · ranked by LCP, worst first · {fmtCompact(model.totalPageviews)} pageviews
        </span>
      </div>
      <div className="anl-wv-scroll">
        <table className="anl-wv-table">
          <thead>
            <tr>
              <th>URL path</th>
              <th className="num">Pageviews</th>
              {WV_METRICS.map((m) => (
                <th key={m.key} className="num" title={m.name}>{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.pages.map((p) => (
              <tr key={p.path}>
                <td>
                  <span className="anl-wv-path">
                    <span
                      className={"anl-wv-dot " + p.metrics.lcp.rating}
                      title={ratingLabel(p.metrics.lcp.rating) + " LCP"}
                    />
                    <span className="anl-wv-path-t" title={p.path}>{p.path}</span>
                  </span>
                </td>
                <td className="num anl-wv-pv">{fmtCompact(p.pageviews)}</td>
                {WV_METRICS.map((m) => {
                  const cell = p.metrics[m.key];
                  return (
                    <td key={m.key} className={"num anl-wv-cell " + cell.rating}>
                      {fmtVital(m.key, cell.value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

/* One metric column in the flat KPI row: eyebrow (code · full name), the p75
   value with a rating pill, then a 3-segment good/needs/poor field bar + a tiny
   %-legend. No card — the column is divided only by its left hairline. */
function MetricStat({ m }: { m: WvSummary }) {
  const [g, n, p] = m.dist;
  const pct = (x: number): number => Math.round(x * 100);
  return (
    <div className="stat anl-wv-stat">
      <div className="stat-l anl-wv-eyebrow" title={m.name}>
        <span className="anl-wv-code">{m.label}</span>
        <span className="anl-wv-full">&nbsp;·&nbsp;{m.name}</span>
      </div>
      <div className="anl-wv-vrow">
        <span className="stat-v">{fmtVital(m.key, m.value)}</span>
        <span className={"anl-wv-pill " + m.rating}>{ratingLabel(m.rating)}</span>
      </div>
      <div
        className="anl-wv-dist"
        title={`${pct(g)}% good · ${pct(n)}% needs work · ${pct(p)}% poor`}
      >
        <span className="g" style={{ flexGrow: g }} />
        <span className="n" style={{ flexGrow: n }} />
        <span className="p" style={{ flexGrow: p }} />
      </div>
      <div className="anl-wv-legend">
        <span className="g">{pct(g)}% good</span>
        <span className="p">{pct(p)}% poor</span>
      </div>
    </div>
  );
}
