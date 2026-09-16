import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon, Seg, Search, Popover, Checkbox, DatePicker } from "@/components/primitives";
import { EmptyState, EMPTY_ART, useToast } from "@/components/feedback";
import { MiniSpark } from "@/components/charts";
import { useApi, useApiInfinite, useInvalidateApi } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import { relTime, fmtN } from "@/lib/format";
import { resolveDateRange } from "@/lib/date-ranges";
import { Dashboard } from "@/api/endpoints";
import {
  listCrashIssues,
  crashFacets,
  crashBreakdown,
  crashStats,
  setIssueStatus,
  getCrashIssue,
  type CrashIssue,
} from "../overview/crashlytics.api";
import {
  CAT_META,
  CAT_ICON,
  crashCatOf,
  type CrashCat,
} from "../overview/drawers/drawers.data";
import { CrashTrend, type TrendCat } from "../overview/viz/CrashTrend";
import { fetchReleases } from "../overview/releases.api";
import { CrashDrawer } from "./CrashDrawer";

/* ============================================================================
   Crashlytics — a FLAT investigation canvas (crashlytics-v2.css). No cards: the
   page reads top-to-bottom as one surface, in the same visual language as
   Analytics — type + whitespace + thin dividers + dense flat tables + a
   restrained semantic accent. The story it tells, in order:
     header → metric row (are we healthy?) → crash trend (getting worse?) →
     release health (which release?) → platform → the ranked issues table
     (what to investigate) → one click into a session.

   Everything pages + filters SERVER-SIDE. The truly-empty workspace is decided
   from the pre-fetched dashboard counts (shared "dashboard-counts" key) BEFORE
   any page fetch fires — so an empty workspace goes straight to the illustration
   with no fetch → skeleton → illo flash.
   ========================================================================== */

type DashCounts = { crashlytics: number };

// Category dot in the segment label — the same colour language as the row icon.
const catLabel = (c: CrashCat, text: string) => (
  <span className="cr-seg-lbl">
    <i className="cr-seg-dot" style={{ background: CAT_META[c].color }} />
    {text}
  </span>
);
const CATS = [
  { value: "", label: "All" },
  { value: "crash", label: catLabel("crash", "Crashes") },
  { value: "exception", label: catLabel("exception", "Exceptions") },
  { value: "freeze", label: catLabel("freeze", "Freezes") },
];

const STATUS_OPTS: { value: string; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "REGRESSED", label: "Regressed" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "IGNORED", label: "Ignored" },
];
// Date-range presets offered by the header picker (rolling windows + All time).
const DATE_PRESETS = ["Last 7 days", "Last 14 days", "Last 30 days", "Last 90 days", "All time"];
const DAY_MS = 86_400_000;
// Month labels for the crash-trend x-axis (synthesised from the sparks' window).
const TREND_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  flutter: "Flutter",
  reactnative: "React Native",
};
const prettyPlatform = (v: string): string =>
  PLATFORM_LABEL[v.toLowerCase()] ?? v;

function Bar({ w, h = 11 }: { w: number; h?: number }) {
  return (
    <span
      className="sk"
      style={{
        display: "inline-block",
        width: w,
        height: h,
        background: "var(--line-2)",
        borderRadius: "var(--r-xs)",
      }}
    />
  );
}

function SkIssueRows({ n = 6 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={`sk${i}`} className="cr-sk-row">
          <td>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-10)" }}>
              <span
                className="sk"
                style={{ width: 28, height: 28, borderRadius: "var(--r-md)", background: "var(--line-2)", flexShrink: 0 }}
              />
              <div>
                <Bar w={200 - i * 16} h={12} />
                <div style={{ marginTop: "var(--sp-8)" }}><Bar w={130} h={9} /></div>
              </div>
            </div>
          </td>
          <td><Bar w={54} h={18} /></td>
          <td><Bar w={70} h={11} /></td>
          <td className="num"><Bar w={34} h={11} /></td>
          <td className="num"><Bar w={34} h={11} /></td>
          <td><Bar w={64} h={16} /></td>
          <td><Bar w={44} h={11} /></td>
          <td></td>
        </tr>
      ))}
    </>
  );
}

export function Crashlytics() {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateApi();
  const [cat, setCat] = useState(""); // "" = all, else a CrashCat
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [openIssue, setOpenIssue] = useState<CrashIssue | null>(null);

  // Enterprise multi-filter state.
  const [statusSel, setStatusSel] = useState<string[]>([]);
  const [platSel, setPlatSel] = useState<string[]>([]);
  const [relSel, setRelSel] = useState<string[]>([]);
  const [range, setRange] = useState("Last 30 days");

  const [dsearch, setDsearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDsearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // ── Deep-link entry (⌘K → a crash result): `/crashlytics?issue=<id>` opens
  // that issue's investigation drawer directly. The one issue is fetched by id
  // (the paged list may not contain it — search matched the whole workspace),
  // then the param is stripped so a manual drawer-close won't reopen it.
  //
  // A `useRef` latch — NOT an `alive` cleanup — makes this a true one-shot: the
  // effect itself strips the `issue` param (via setSearchParams), which changes
  // this effect's own dep and, under React 18 StrictMode's double-invoke, fires
  // the cleanup BEFORE getCrashIssue resolves. An `alive` flag would therefore be
  // false by the time the response lands and setOpenIssue would never run (the
  // bug this replaces). The latch fires the fetch exactly once and lets its
  // setOpenIssue land unconditionally. `getCrashIssue(id)` is one indexed PK read.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkedRef = useRef(false);
  useEffect(() => {
    const raw = searchParams.get("issue");
    if (!raw || deepLinkedRef.current) return;
    deepLinkedRef.current = true;
    setSearchParams(
      (p) => {
        p.delete("issue");
        return p;
      },
      { replace: true },
    );
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) return;
    getCrashIssue(id)
      .then((res) => {
        if (res?.data?.issue) setOpenIssue(res.data.issue);
      })
      .catch(() => toast("That crash could not be found", { kind: "err" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── The 0-vs-nonzero gate. `counts` is the workspace-wide aggregate already
  // fetched on dashboard load (shared key → served from cache, no refetch). We
  // fetch NOTHING on this page until we know the workspace has ≥1 crash, so an
  // empty workspace renders the illustration directly (no fetch/skeleton flash).
  const { data: counts } = useApi<DashCounts>(
    () => Dashboard.counts<DashCounts>(),
    [],
    { key: "dashboard-counts" },
  );
  const countsReady = counts !== undefined;
  const hasData = !!counts && counts.crashlytics > 0;

  const statusParam = statusSel.length ? [...statusSel].sort().join(",") : "ALL";
  const platParam = platSel.length ? [...platSel].sort().join(",") : undefined;
  const relParam = relSel.length ? [...relSel].sort().join(",") : undefined;
  // Date-range picker → [from, to] epoch-ms; scopes the WHOLE page (metric row,
  // trend, release/platform bands, issues table). resolveDateRange gives a
  // day-aligned start (00:00) + inclusive end, so the trend day-buckets line up.
  const { from, to } = useMemo(() => {
    // "All time" ⇒ no bounds → the backend's all-time path (shows every issue
    // regardless of age). Any resolvable preset → its [start, end] epoch-ms.
    if (range === "All time") return { from: undefined, to: undefined };
    const r = resolveDateRange(range);
    return {
      from: r ? r.start.getTime() : undefined,
      to: r ? r.end.getTime() : undefined,
    };
  }, [range]);
  const filterCount = statusSel.length + platSel.length + relSel.length;

  // Header metric row — per-category event volume + affected users (one set-based
  // groupBy). Only fires once the workspace is known non-empty.
  const { data: stats } = useApi(() => crashStats(from, to), [from, to], {
    key: "crash-stats",
    enabled: hasData,
  });

  // Filter-dropdown options (distinct platforms + releases).
  const { data: facetsData } = useApi(() => crashFacets(), [], {
    key: "crash-facets",
    enabled: hasData,
  });
  const facets = facetsData ?? { platforms: [], releases: [] };

  // Release first-seen days → deploy markers on the crash trend (so a spike lines
  // up with the release that shipped it). Shares Overview's cache key — one read.
  const { data: releasesRaw } = useApi(() => fetchReleases(), [], {
    key: "dashboard-releases",
    enabled: hasData,
  });

  // Crash trend = the four metric-row sparks (crashes/exceptions/freezes/errors)
  // stacked per day, so the chart sums to the header's own events number and
  // reads in the same category colours as §2. The sparks are ALREADY fetched for
  // the metric row, so this adds NO crash query. Labels are the trailing-N days
  // ending today (the sparks' own window); each release's first-seen is pinned to
  // its nearest day (≤36h). Null until the sparks land / when there's no data.
  const trend = useMemo(() => {
    if (!stats || from == null) return null;
    const cats: TrendCat[] = [
      { name: "Crashes", color: CAT_META.crash.color, data: stats.crashes.spark ?? [] },
      { name: "Exceptions", color: CAT_META.exception.color, data: stats.exceptions.spark ?? [] },
      { name: "Freezes", color: CAT_META.freeze.color, data: stats.freezes.spark ?? [] },
      { name: "Errors", color: CAT_META.error.color, data: stats.errors.spark ?? [] },
    ];
    const N = Math.max(0, ...cats.map((c) => c.data.length));
    if (N === 0) return null;
    const hasAny = cats.some((c) => c.data.some((v) => v > 0));
    // Labels span the picked window: index 0 = the `from` day (matches the
    // backend spark's day_idx = floor((occurredAt - from) / day)).
    const startDay = new Date(from);
    startDay.setHours(0, 0, 0, 0);
    const dayTs: number[] = [];
    const labels: string[] = [];
    for (let i = 0; i < N; i++) {
      const d = new Date(startDay.getTime() + i * DAY_MS);
      dayTs.push(d.getTime());
      labels.push(`${TREND_MONTHS[d.getMonth()]} ${d.getDate()}`);
    }
    const deploys: { i: number; v: string }[] = [];
    const used = new Set<number>();
    for (const r of releasesRaw?.releases ?? []) {
      const t = new Date(r.firstSeen).getTime();
      if (Number.isNaN(t) || !r.release || r.release === "unknown") continue;
      let best = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < dayTs.length; i++) {
        const diff = Math.abs(dayTs[i] - t);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      if (best >= 0 && bestDiff <= 36 * 3600 * 1000 && !used.has(best)) {
        deploys.push({ i: best, v: r.release });
        used.add(best);
      }
    }
    return { cats, labels, deploys, hasAny };
  }, [stats, releasesRaw, from]);

  // Crashes by release + platform (set-based groupBy aggregates).
  const { data: brkData } = useApi(() => crashBreakdown(from, to), [from, to], {
    key: "crash-breakdown",
    enabled: hasData,
  });

  // The paged issues list — server-side filters, keyset cursor, 10 / page.
  const { items, loading, loadingMore, stale, hasMore, fetchMore, refetch } =
    useApiInfinite<CrashIssue>(
      (cursor) =>
        listCrashIssues({
          status: statusParam,
          category: cat || undefined,
          search: dsearch || undefined,
          platform: platParam,
          release: relParam,
          // Scope the table to the picked date range (lastSeenAt in [from, to]).
          since: from,
          until: to,
          // Crashlytics triage: freshest-first (lastSeenAt DESC), not impact-rank.
          sort: "recent",
          limit: 10,
          cursor: cursor ?? undefined,
        }),
      [statusParam, cat, dsearch, platParam, relParam, from, to],
      { key: "crash-issues-page", enabled: hasData },
    );
  const issues: CrashIssue[] = items;

  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), { root: rootEl });

  const investigate = (iss: CrashIssue) =>
    navigate(`/recordings?issue=${iss.id}`);

  const refreshAll = () => {
    refetch();
    invalidate("crash-issues");
    invalidate("crash-stats");
  };

  const setStatus = async (
    id: number,
    status: "RESOLVED" | "IGNORED" | "OPEN",
  ) => {
    setBusy(id);
    try {
      await setIssueStatus(id, status);
      toast(
        status === "OPEN" ? "Reopened" : status === "RESOLVED" ? "Resolved" : "Ignored",
        { kind: "ok" },
      );
      refreshAll();
    } catch (e) {
      toast("Couldn't update: " + (e instanceof Error ? e.message : "error"), {
        kind: "err",
      });
    } finally {
      setBusy(null);
    }
  };

  const clearFilters = () => {
    setStatusSel([]);
    setPlatSel([]);
    setRelSel([]);
  };
  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const statusTag = (iss: CrashIssue) => {
    if (iss.status === "REGRESSED") return <span className="tag err">Regressed</span>;
    if (iss.status === "RESOLVED") return <span className="tag ok">Resolved</span>;
    if (iss.status === "IGNORED") return <span className="tag">Ignored</span>;
    if (Date.now() - new Date(iss.firstSeenAt).getTime() < 24 * 3600 * 1000)
      return <span className="tag info">New</span>;
    return <span className="tag info">Open</span>;
  };

  const cold = !countsReady || loading || stale;
  const anyFilter = !!(cat || dsearch || filterCount);

  // Truly-empty workspace — decided from counts, before any page fetch.
  if (countsReady && !hasData)
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.crashes}
          title="Crashlytics"
          desc="Crashes, handled exceptions and UI freezes across your releases and platforms — grouped, ranked by impact, and one click from the session where each one happened."
          actions={[
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/crashlytics",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
      </div>
    );

  // ── Derived view models ──
  const metricRow: {
    key: CrashCat | "users";
    label: string;
    value: number;
    sub: string;
    color: string;
    spark?: number[];
    delta?: number | null;
  }[] = [
    { key: "crash", label: "Crashes", value: stats?.crashes.events ?? 0, sub: `${stats?.crashes.groups ?? 0} issues`, color: CAT_META.crash.color, spark: stats?.crashes.spark, delta: stats?.crashes.deltaPct ?? null },
    { key: "exception", label: "Exceptions", value: stats?.exceptions.events ?? 0, sub: `${stats?.exceptions.groups ?? 0} issues`, color: CAT_META.exception.color, spark: stats?.exceptions.spark, delta: stats?.exceptions.deltaPct ?? null },
    { key: "freeze", label: "Freezes", value: stats?.freezes.events ?? 0, sub: `${stats?.freezes.groups ?? 0} issues`, color: CAT_META.freeze.color, spark: stats?.freezes.spark, delta: stats?.freezes.deltaPct ?? null },
    { key: "users", label: "Affected users", value: stats?.affectedUsers ?? 0, sub: "across all issues", color: "var(--accent)" },
  ];

  const releases = brkData?.version ?? [];
  const relMax = Math.max(1, ...releases.map((r) => r.occurrences));
  const platforms = brkData?.platform ?? [];
  const platMax = Math.max(1, ...platforms.map((p) => p.occurrences));
  const platTotal = platforms.reduce((s, p) => s + p.occurrences, 0) || 1;
  const totalCrashEvents = stats
    ? stats.crashes.events + stats.exceptions.events + stats.freezes.events + stats.errors.events
    : 0;

  return (
    <div
      className="wrap rd-page cr2"
      ref={(el) => setRootEl(el?.closest<HTMLElement>(".main") ?? null)}
    >
      {/* §1 Header + primary controls */}
      <div className="head">
        <div className="head-l">
          <h1>Crashlytics</h1>
          <div className="sub">
            Crashes, exceptions and UI freezes across your releases and platforms —
            ranked by impact, one click from the session where each happened.
          </div>
        </div>
        <div className="actions">
          {/* One date range scopes the WHOLE page — metric row, trend, release
              health, platform split and the issues table all honour it. */}
          <DatePicker
            value={range}
            onChange={setRange}
            align="right"
            presets={DATE_PRESETS}
          />
        </div>
      </div>

      {/* §2 Inline metric row — no cards, vertical hairlines only */}
      <div className="cr2-metrics" style={{ marginTop: "var(--sp-24)" }}>
        {metricRow.map((m) => {
          const hasSpark = !!m.spark && m.spark.some((v) => v > 0);
          return (
            <div className="cr2-metric" key={m.key}>
              <div className="cr2-metric-l">
                <i className="cr2-metric-dot" style={{ background: m.color }} />
                {m.label}
              </div>
              <div className="cr2-metric-row">
                <span className="cr2-metric-v">{cold || !stats ? "—" : fmtN(m.value)}</span>
                {/* Delta is crash-inverted: more failures (up) is BAD (red). */}
                {stats && m.delta != null && m.value > 0 && (
                  <span className={`cr2-delta ${m.delta > 0 ? "bad" : m.delta < 0 ? "good" : "flat"}`}>
                    <Icon name={m.delta > 0 ? "trendUp" : "trendDown"} size={11} />
                    {Math.abs(m.delta)}%
                  </span>
                )}
              </div>
              {stats && hasSpark ? (
                <div className="cr2-metric-spark">
                  <MiniSpark data={m.spark!} color={m.color} w={112} h={26} />
                </div>
              ) : (
                <div className="cr2-metric-sub">{cold || !stats ? "" : m.sub}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="cr2-rule" />

      {/* §3 Crash trend — stacked-by-category density chart, flat on the page.
          One bar per day, summed to the header's own events number and split into
          the four category colours over a faint crash-red wash, with release
          markers and an emphasised latest day. Fed by the §2 sparks (no new
          query); hidden entirely when there's no crash data in the window. */}
      {trend && trend.hasAny && (
        <>
          <div className="cr2-trend-head">
            <div>
              <h2 className="cr2-h">Crash trend</h2>
              <div className="cr2-h-sub">
                <span className="cr2-h-big">{fmtN(totalCrashEvents)}</span> events · {range.toLowerCase()}
              </div>
            </div>
            <div className="cr2-trend-legend">
              {trend.cats.map((c) => (
                <span className="cr2-lg" key={c.name}>
                  <i style={{ background: c.color }} /> {c.name}
                </span>
              ))}
            </div>
          </div>
          <CrashTrend
            cats={trend.cats}
            labels={trend.labels}
            deploys={trend.deploys}
            height={196}
          />
          <div className="cr2-rule" />
        </>
      )}

      {/* §4 + §5 — Release health (which release?) beside platform split */}
      {(releases.length > 0 || platforms.length > 0) && (
        <>
          <div
            className="cr2-split"
            style={{
              display: "grid",
              gridTemplateColumns: releases.length > 0 && platforms.length > 0 ? "minmax(0,1.6fr) minmax(0,1fr)" : "1fr",
              gap: "var(--sp-40)",
              alignItems: "start",
            }}
          >
            {releases.length > 0 && (
              <div>
                <div className="cr2-eyebrow">Release health</div>
                <div className="cr2-scroll">
                  <table className="cr2-rel">
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>#</th>
                        <th>Release</th>
                        <th className="c-n" style={{ width: 84 }}>Crashes</th>
                        <th className="c-n" style={{ width: 76 }}>Users</th>
                        <th className="c-dist">Distribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {releases.map((r, i) => (
                        <tr
                          key={r.key}
                          className={`clickable${i === 0 ? " is-worst" : ""}${relSel.includes(r.key) ? " is-sel" : ""}`}
                          onClick={() => setRelSel(relSel.includes(r.key) ? [] : [r.key])}
                        >
                          <td className="cr2-rel-rank">{i + 1}</td>
                          <td><span className="cr2-rel-name" title={r.key}>{r.key}</span></td>
                          <td className="c-n"><span className="cr2-rel-n">{fmtN(r.occurrences)}</span></td>
                          <td className="c-n"><span className="cr2-rel-n">{fmtN(r.users ?? 0)}</span></td>
                          <td className="c-dist">
                            <span className="cr2-track">
                              <i className="cr2-fill" style={{ width: `${Math.max(3, (r.occurrences / relMax) * 100)}%`, opacity: i === 0 ? 1 : 0.5 }} />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {platforms.length > 0 && (
              <div>
                <div className="cr2-eyebrow">Platform</div>
                <div className="cr2-plat">
                  {platforms.map((p) => (
                    <div className="cr2-plat-row" key={p.key}>
                      <span className="cr2-plat-name">{prettyPlatform(p.key)}</span>
                      <span className="cr2-track">
                        <i className="cr2-fill" style={{ width: `${Math.max(3, (p.occurrences / platMax) * 100)}%`, background: "var(--red)", opacity: 0.75 }} />
                      </span>
                      <span className="cr2-plat-n">{fmtN(p.occurrences)}</span>
                      <span className="cr2-plat-pct">{Math.round((p.occurrences / platTotal) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="cr2-rule" />
        </>
      )}

      {/* §6 Issues — the first-class investigation surface */}
      <div className="cr2-trend-head" style={{ marginBottom: "var(--sp-14)" }}>
        <div>
          <h2 className="cr2-h">Issues</h2>
          <div className="cr2-h-sub">Ranked by impact — click a row to investigate</div>
        </div>
        <div className="cr2-controls">
          <Seg value={cat} options={CATS} onChange={setCat} />
          <Popover
            align="right"
            menuClass="cr-flt-menu"
            trigger={
              <button className={`btn cr-flt-btn ${filterCount ? "on" : ""}`} aria-label="Filter issues">
                <Icon name="sliders" size={13} /> Filter
                {filterCount > 0 && <span className="cr-flt-n">{filterCount}</span>}
              </button>
            }
          >
            {() => (
              <div className="cr-flt">
                <div className="cr-flt-sec">
                  <div className="cr-flt-h">Status</div>
                  {STATUS_OPTS.map((o) => (
                    <label className="cr-flt-row" key={o.value}>
                      <Checkbox on={statusSel.includes(o.value)} onChange={() => toggle(statusSel, setStatusSel, o.value)} />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
                {facets.platforms.length > 0 && (
                  <div className="cr-flt-sec">
                    <div className="cr-flt-h">Platform</div>
                    {facets.platforms.map((p) => (
                      <label className="cr-flt-row" key={p}>
                        <Checkbox on={platSel.includes(p)} onChange={() => toggle(platSel, setPlatSel, p)} />
                        <span style={{ textTransform: "capitalize" }}>{p}</span>
                      </label>
                    ))}
                  </div>
                )}
                {facets.releases.length > 0 && (
                  <div className="cr-flt-sec">
                    <div className="cr-flt-h">Release</div>
                    <div className="cr-flt-scroll">
                      {facets.releases.map((r) => (
                        <label className="cr-flt-row" key={r}>
                          <Checkbox on={relSel.includes(r)} onChange={() => toggle(relSel, setRelSel, r)} />
                          <span className="mono">{r}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {filterCount > 0 && (
                  <div className="cr-flt-foot">
                    <button className="cr-flt-clear" onClick={clearFilters}>Clear all filters</button>
                  </div>
                )}
              </div>
            )}
          </Popover>
          <Search
            value={search}
            onChange={setSearch}
            placeholder="Search stack, exception, file…"
            width={240}
            className="av-tall"
          />
        </div>
      </div>

      <div className="cr2-scroll">
        <table className="cr2-issues">
          <thead>
            <tr>
              <th>Issue</th>
              <th style={{ width: 96 }}>Status</th>
              <th style={{ width: 128 }}>Release</th>
              <th className="num" style={{ width: 80 }}>Users</th>
              <th className="num" style={{ width: 80 }}>Recordings</th>
              <th style={{ width: 90 }}>Trend</th>
              <th style={{ width: 96 }}>Last seen</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {cold && <SkIssueRows />}
            {!cold &&
              issues.map((iss) => {
                const c = crashCatOf(iss.errorClass);
                return (
                  <tr
                    className="clickable"
                    key={iss.id}
                    onClick={() => setOpenIssue(iss)}
                    style={{ opacity: busy === iss.id ? 0.5 : 1 }}
                  >
                    <td>
                      <div className="cr2-iss-main">
                        <div className={`co-ic cr-ic ${c}`} title={CAT_META[c].label}>
                          <Icon name={CAT_ICON[c]} size={13} />
                        </div>
                        <div className="cr2-iss-txt">
                          <div className="cr2-iss-ttl">{iss.errorType || iss.title || "Error"}</div>
                          <div className="cr2-iss-sub">{iss.message || iss.culprit || CAT_META[c].label}</div>
                        </div>
                      </div>
                    </td>
                    <td>{statusTag(iss)}</td>
                    <td>
                      <span className="cr2-iss-rel" title={iss.lastRelease || iss.platform}>
                        {iss.lastRelease || iss.platform || "—"}
                      </span>
                    </td>
                    <td className="num">{iss.userCount.toLocaleString()}</td>
                    <td className="num">{iss.sessionCount.toLocaleString()}</td>
                    <td>
                      {iss.trend && iss.trend.some((n) => n > 0) ? (
                        <span className="cr2-iss-trend">
                          {iss.status === "REGRESSED" && <span className="cr2-iss-reg"><Icon name="trendUp" size={12} /></span>}
                          <MiniSpark data={iss.trend} color={CAT_META[c].color} w={70} h={22} />
                        </span>
                      ) : (
                        <span style={{ color: "var(--t4)" }}>—</span>
                      )}
                    </td>
                    <td className="cr2-iss-seen">{relTime(iss.lastSeenAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Popover
                        align="right"
                        trigger={
                          <button className="ibtn" aria-label="Issue actions">
                            <Icon name="more" size={14} />
                          </button>
                        }
                      >
                        {({ close }) => (
                          <>
                            <button onClick={() => { close(); setOpenIssue(iss); }}>
                              <Icon name="doc" size={14} /> Investigate
                            </button>
                            <button onClick={() => { close(); investigate(iss); }}>
                              <Icon name="rec" size={14} /> View recordings
                            </button>
                            <div className="sep" />
                            {iss.status !== "RESOLVED" && (
                              <button onClick={() => { close(); setStatus(iss.id, "RESOLVED"); }}>
                                <Icon name="check" size={14} /> Resolve
                              </button>
                            )}
                            {iss.status !== "IGNORED" && (
                              <button onClick={() => { close(); setStatus(iss.id, "IGNORED"); }}>
                                <Icon name="pause" size={14} /> Ignore
                              </button>
                            )}
                            {(iss.status === "RESOLVED" || iss.status === "IGNORED") && (
                              <button onClick={() => { close(); setStatus(iss.id, "OPEN"); }}>
                                <Icon name="refresh" size={14} /> Reopen
                              </button>
                            )}
                          </>
                        )}
                      </Popover>
                    </td>
                  </tr>
                );
              })}
            {!cold && issues.length === 0 && (
              <tr>
                <td colSpan={8} className="cr2-iss-empty">
                  {hasData && from != null && !cat && !dsearch && !filterCount ? (
                    // Workspace HAS crashes (counts>0) but none in the picked
                    // window — say so plainly and offer a one-click escape to the
                    // full history, instead of a bare "No issues." that reads as
                    // a broken page next to the sidebar's all-time count.
                    <div className="cr2-window-empty">
                      <div className="cr2-window-empty-t">
                        No crashes in {range.toLowerCase()}
                      </div>
                      <div className="cr2-window-empty-s">
                        This workspace has crash issues — just none in this window.
                      </div>
                      <button
                        className="btn cr2-viewall"
                        onClick={() => setRange("All time")}
                      >
                        View all time
                      </button>
                    </div>
                  ) : (
                    <>
                      No{" "}
                      {cat ? CAT_META[cat as CrashCat].plural.toLowerCase() : "issues"}
                      {dsearch ? ` matching “${dsearch}”` : ""}
                      {filterCount ? " for these filters" : ""}.
                    </>
                  )}
                </td>
              </tr>
            )}
            {loadingMore && <SkIssueRows n={2} />}
            <tr ref={sentinelRef} className="cr2-more" aria-hidden={!hasMore}>
              <td colSpan={8} />
            </tr>
          </tbody>
        </table>
      </div>

      {openIssue && (
        <CrashDrawer
          issue={openIssue}
          onClose={() => setOpenIssue(null)}
          onChanged={refreshAll}
        />
      )}
    </div>
  );
}
