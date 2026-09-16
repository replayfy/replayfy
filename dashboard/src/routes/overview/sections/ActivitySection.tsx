import { useEffect, useMemo, useState } from "react";
import { Sk } from "@/components/feedback";
import { Dashboard } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { Spark } from "../viz/Spark";
import { ActivityTrend } from "../viz/ActivityTrend";
import { ActivityFilter } from "./ActivityFilter";
import { METRIC_DEFS } from "../overview.data";
import { materialize } from "../overview.series";
import { overrideMetric, type MetricsResp } from "../overview.api";
import {
  DEFAULT_QUERY,
  TIME_RANGES,
  buildActivityFromSeries,
  chartMetricByKey,
  defaultGranFor,
  queryHash,
  querySummary,
  timeToRange,
  type ActivityQuery,
  type ActivitySeriesResp,
  type GranKey,
  type TimeKey,
} from "../activity.query";

/* ============================================================================
   ActivitySection — engagement as small multiples over one focused chart.
   The six metric tiles stay the fast path; the chart itself is driven by ONE
   analytics query (metric, breakdown, time, granularity, compare, segment,
   AND rules) owned by the single Filter button, fetched LIVE from
   /v1/dashboard/activity-series. Every control is backed by real ClickHouse
   data — the previous client-side synthesis (and its fabricated breakdown) is
   gone. The visualization is a trend-first area/line chart (ActivityTrend):
   the total leads, the breakdown is legend-toggled overlay lines + tooltip.
   ========================================================================== */

/** Format a session duration given in ms as "3m 48s" / "42s". */
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
}

/** KPI tile → the REAL chart metric it drives (dau/wau/mau all trend as active
 *  users per bucket; new/returning have their own series). */
const TILE_METRIC: Record<string, string> = {
  dau: "activeUsers",
  wau: "activeUsers",
  mau: "activeUsers",
  new: "newUsers",
  ret: "returningUsers",
  rtn: "activeUsers",
};

/** DAU/WAU/MAU all drive the SAME `activeUsers` chart metric, so the metric's
 *  own label ("Active users") can't tell them apart. Spell out the cadence in
 *  the chart header for the selected tile; other tiles fall back to the metric
 *  label (New users / Returning users / Active users). */
const TILE_TITLE: Record<string, string> = {
  dau: "Daily active users",
  wau: "Weekly active users",
  mau: "Monthly active users",
};

/** The cadence tiles ALSO set the chart's bucket width, so DAU/WAU/MAU each
 *  render a DISTINCT series — daily / weekly / (30-day) monthly active users.
 *  Before this they shared both metric (activeUsers) AND granularity, so the
 *  query hash never changed and the chart stayed frozen when you clicked between
 *  them (the visible bug). Non-cadence tiles have no entry and leave gran alone. */
const TILE_GRAN: Record<string, GranKey> = {
  dau: "day",
  wau: "week",
  mau: "month",
};

/** Reverse of TILE_GRAN: given the granularity actually plotted (on the
 *  activeUsers metric), which cadence tile should light + name the chart. Deriving
 *  this from query.gran — instead of the last-clicked tile — keeps the highlight
 *  and title honest after the header DatePicker changes gran out from under a
 *  cadence tile (e.g. picking "Last 7 days" forces gran=day → the DAU tile, not a
 *  stale WAU label over a daily series). */
const GRAN_CADENCE: Record<string, string> = {
  day: "dau",
  week: "wau",
  month: "mau",
};

/** Smallest time window whose valid granularities include `g`, but keep the
 *  current window when it already supports the cadence (so switching to DAU
 *  doesn't yank a 90-day view back to 7 days). day→d7, week→d30, month→d90. */
function timeForGran(current: TimeKey, g: GranKey): TimeKey {
  const cur = TIME_RANGES.find((r) => r.key === current);
  if (cur?.grans.includes(g)) return current;
  return TIME_RANGES.find((r) => r.grans.includes(g))?.key ?? current;
}

export function ActivitySection({
  metricsApi,
  loading,
  headerTime,
  headerCustom,
}: {
  metricsApi?: MetricsResp;
  /** The home-page header DatePicker's range, mapped to a chart TimeKey. When it
   *  changes, the chart follows it (the user can still refine time/gran after). */
  headerTime?: TimeKey;
  /** When the header holds a CUSTOM absolute range, its [from,to] epoch-ms
   *  window — passed straight to /activity-series (which honours from/to over
   *  the range token), so the chart matches the rest of the page for custom
   *  picks. Undefined for named presets, which stay on the TimeKey path. */
  headerCustom?: { from: number; to: number };
  /** /metrics hasn't landed. Only the six tile HEADLINES read from it — the
   *  chart below is a locally synthesized fixture (see the TODO above), so it
   *  is not waiting on anything and must not shimmer as though it were. */
  loading?: boolean;
}) {
  const [query, setQuery] = useState<ActivityQuery>(DEFAULT_QUERY);
  // Follow the header DatePicker: when its range changes, retarget the chart's
  // time (and a valid granularity for it). Guarded so it only fires on an actual
  // header change, leaving the user's own time/gran refinements intact between.
  useEffect(() => {
    if (!headerTime) return;
    setQuery((q) =>
      q.time === headerTime
        ? q
        : { ...q, time: headerTime, gran: defaultGranFor(headerTime) },
    );
  }, [headerTime]);
  // Which KPI tile is the active chart driver. Tracked SEPARATELY from
  // query.metric because several tiles (DAU/WAU/MAU) map to the same real chart
  // metric (activeUsers) — keying the highlight off query.metric would light all
  // three at once. Exactly one tile is "on": the one last clicked, and only
  // while the chart is still showing its metric.
  const [activeTile, setActiveTile] = useState("dau");

  // Tiles are global last-30-days small multiples: real headline values
  // (dau/wau/mau/retention) fold onto the design fixtures when they resolve.
  const tiles = METRIC_DEFS.map((d) =>
    overrideMetric(materialize(d, "day"), metricsApi),
  );

  // avgDuration can't be stacked (averages aren't additive), so it always draws
  // a single total line — the breakdown is suppressed for that metric only.
  const dimension =
    query.metric === "avgDuration" || query.breakdown === "none"
      ? "none"
      : query.breakdown;

  // The chart's data is REAL: one /activity-series call per query, re-fetched
  // whenever any control changes (keyed by the query hash). Breakdown, time,
  // granularity, compare, segment and rule-filters all reach the backend.
  const qhash = queryHash(query);
  const seriesQ = useApi<ActivitySeriesResp>(
    () =>
      Dashboard.activitySeries<ActivitySeriesResp>({
        metric: query.metric,
        dimension,
        range: timeToRange(query.time),
        gran: query.gran,
        segment: query.segment,
        compare: query.compare !== "off",
        rules: query.rules.map((r) => `${r.dim}:${r.value}`),
        // A custom header range wins over the range token on the backend, so the
        // chart tracks the same absolute window as the counts/segments above.
        from: headerCustom?.from,
        to: headerCustom?.to,
      }),
    [qhash, headerCustom?.from, headerCustom?.to],
    { key: "dashboard/activity-series" },
  );
  const seriesResp = seriesQ.data;

  // The four sub-stats are DERIVED from the real /metrics values — never the old
  // hardcoded 13.6% / 4.2 / 3m48s / 26:74. Any metric without a measured source
  // (or a zero denominator) reads "—" rather than a fabricated figure. New:returning
  // needs the newUsers/returningUsers metrics (backend GAP1) — "—" until they land.
  const substats = useMemo((): [string, string, string][] => {
    const M = metricsApi?.metrics;
    const val = (k: string) => M?.find((m) => (m.key as string) === k)?.value;
    const dash = "—";
    const dau = val("dau");
    const mau = val("mau");
    const sessions = val("sessions");
    const users = val("activeUsers");
    const avg = val("avgDuration");
    const newU = val("newUsers");
    const retU = val("returningUsers");
    const stick = dau != null && mau ? ((dau / mau) * 100).toFixed(1) + "%" : dash;
    const spu = sessions != null && users ? (sessions / users).toFixed(1) : dash;
    const avgS = avg != null && avg > 0 ? fmtDur(avg) : dash;
    const nr =
      newU != null && retU != null && newU + retU > 0
        ? `${Math.round((newU / (newU + retU)) * 100)} : ${Math.round((retU / (newU + retU)) * 100)}`
        : dash;
    return [
      ["Stickiness", stick, "DAU / MAU"],
      ["Sessions per user", spu, "last 30 days"],
      ["Avg. session", avgS, "per session"],
      ["New : returning", nr, "share of active"],
    ];
  }, [metricsApi]);

  const data = useMemo(
    () =>
      seriesResp
        ? buildActivityFromSeries(seriesResp, query.gran, query.compare !== "off")
        : null,
    [seriesResp, query.gran, query.compare],
  );
  const def = chartMetricByKey(query.metric);
  const summary = querySummary(query);
  // The cadence tile that matches the series ACTUALLY plotted: derived from the
  // live granularity (only meaningful on the activeUsers metric), so title +
  // highlight track the chart even when the header DatePicker moves gran.
  const cadenceTile =
    query.metric === "activeUsers" ? (GRAN_CADENCE[query.gran] ?? null) : null;
  // Chart header title: the cadence phrase (Daily/Weekly/Monthly active users)
  // when a cadence is active; otherwise the metric's own label (New / Returning).
  const chartTitle =
    cadenceTile && TILE_TITLE[cadenceTile] ? TILE_TITLE[cadenceTile] : def.label;

  return (
    <section className="ox-sec" aria-label="Activity">
      <div className="ox-sec-h">
        <span className="t">Activity</span>
        <span className="m">active users, growth &amp; retention</span>
        <span className="sp" />
      </div>

      <div className="ox-mults" role="tablist" aria-label="Metrics">
        {/* The tiles stay live tabs while their values load: picking one drives
            the chart, which doesn't depend on /metrics. Only the number, its
            delta and its trace shimmer — the label is the tile's own. */}
        {tiles.map((m, i) => {
          // A cadence tile lights by the plotted granularity; a non-cadence tile
          // (New/Returning) lights when the chart is on its metric. Never both.
          const on = cadenceTile
            ? m.key === cadenceTile
            : m.key === activeTile && TILE_METRIC[m.key] === query.metric;
          return (
          <button
            key={m.key}
            role="tab"
            aria-selected={on}
            className={"ox-mult" + (on ? " on" : "")}
            onClick={() => {
              setActiveTile(m.key);
              const g = TILE_GRAN[m.key];
              setQuery((q) =>
                g
                  ? {
                      ...q,
                      metric: TILE_METRIC[m.key],
                      gran: g,
                      time: timeForGran(q.time, g),
                    }
                  : // Non-cadence tiles reset gran to the window's default so a
                    // leftover week/month bucket from a previous cadence tile
                    // doesn't carry over into New/Returning.
                    {
                      ...q,
                      metric: TILE_METRIC[m.key],
                      gran: defaultGranFor(q.time),
                    },
              );
            }}
          >
            <span className="k">{m.label}</span>
            {loading ? (
              <span className="v ox-num">
                <Sk w={46 + ((i * 13) % 24)} h={13} />
              </span>
            ) : (
              <span className="v ox-num">
                {m.display}
                {m.flat ? (
                  <span className="ox-tr flat">{m.delta}</span>
                ) : (
                  <span className={`ox-tr ${m.dir}`}>
                    <span className="ar">{m.dir === "up" ? "▲" : "▼"}</span>
                    {m.delta.replace(/^[+−-]/, "")}
                  </span>
                )}
              </span>
            )}
            {loading ? (
              <span className="spark">
                <Sk w={104} h={26} r={4} />
              </span>
            ) : (
              (m.liveSpark ?? m.series).length > 0 && (
                <span className="spark">
                  <Spark data={m.liveSpark ?? m.series} />
                </span>
              )
            )}
          </button>
          );
        })}
      </div>

      <div className="ox-chartbar">
        <span className="who">
          {chartTitle}
          {summary && <span className="av-who-sub"> · {summary}</span>}
        </span>
        <span className="sp" />
      </div>

      {data ? (
        <ActivityTrend
          data={data}
          qhash={qhash}
          showPrev={query.compare !== "off"}
          toolbar={<ActivityFilter query={query} onChange={setQuery} />}
        />
      ) : (
        // First load only — keepPreviousData keeps the chart mounted on every
        // later query change, so this shows once, not on each filter tweak.
        <div className="av-chart-wrap">
          <div className="av-toolbar">
            <ActivityFilter query={query} onChange={setQuery} />
          </div>
          <Sk w="100%" h={248} r={8} />
        </div>
      )}

      <div className="ox-statline">
        {substats.map(([k, v, s]) => (
          <span className="it" key={k}>
            <b>{v}</b>
            {k} · <span className="ox-dim">{s}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
