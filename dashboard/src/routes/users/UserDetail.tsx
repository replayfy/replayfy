import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Icon, DatePicker, NumberFlow } from "@/components/primitives";
import { Sk } from "@/components/feedback";
import { EndUsers } from "@/api/endpoints";
import { resolveIdentity } from "@/lib/identity";
import { countryName } from "@/lib/device-format";
import { useApi } from "@/api/useApi";
import { relTime } from "@/lib/format";
import { parseCustomRange } from "@/lib/date-ranges";
import { AddToCohortModal } from "./AddToCohortModal";
import {
  UdBarsSkeleton,
  UdSessionsSkeleton,
  UdFeedSkeleton,
} from "./UserDetailSkeletons";
import {
  uhue,
  fmtClock,
  fmtLong,
  fmtDate,
  urlPath,
  prettifyLabel,
  formatTraitText,
  type User,
  type ApiEndUserDetail,
  type ApiUserSession,
  type ApiActivityItem,
  type ApiChartPoint,
} from "./users.data";

/** A sidebar row's value, or `null` while the fetch that owns it is in flight
 *  (rendered as a shimmer instead of the "—" that used to stand for both
 *  "loading" and "the payload has no such value"). */
type PropValue = string | null;
type PropGroup = [string, [string, PropValue][]];

/** A KPI tile. `valueBusy`/`footBusy` are separate because a tile's number and
 *  its foot can come from different requests — Sessions' count is the detail's,
 *  its trend and sparkline are the activity chart's. */
type Kpi = {
  label: string;
  value: string;
  /** The numeric value, when it's a plain count — rendered with NumberFlow so
   *  it rolls in. Absent for non-numeric tiles (Avg session's "3m 41s", Online's
   *  "Yes"/"No"), which keep the formatted string. */
  num?: number;
  valueBusy: boolean;
  sub: string;
  trend: "up" | "down" | "flat";
  /** The resolved series, or null when there aren't enough points to plot. */
  spark: number[] | null;
  /** Whether this tile plots a sparkline at all — `spark` can't answer that
   *  while the series is still loading, and Online never has one. */
  hasSpark: boolean;
  footBusy: boolean;
};

/* Picker label -> the `days` window the activity-chart endpoint takes.
   "Yesterday" is deliberately not offered: the endpoint models a window ending
   today, so it has no way to express a single day in the past — listing it
   would just silently mean something else. */
const RANGE_DAYS: Record<string, number> = {
  Today: 1,
  "Last 7 days": 7,
  "Last 14 days": 14,
  "Last 30 days": 30,
  "Last 3 months": 90,
  "Last 12 months": 365,
};
const RANGE_PRESETS = Object.keys(RANGE_DAYS);

/* Bar entrance. The stagger is a BUDGET, not a per-bar constant: at a fixed
   8ms/bar the 365-bar year view would sweep for ~3s, so the step shrinks to fit
   every range's sweep inside BAR_SWEEP_MS. Total = BAR_GROW_MS + BAR_SWEEP_MS. */
const BAR_GROW_MS = 320;
const BAR_SWEEP_MS = 240;
const BAR_STEP_MS = 8;
const BAR_EASE = [0.23, 1, 0.32, 1] as const;

type UserDetailProps = { u: User; onBack: () => void };

/* User detail — wired to GET /v1/end-users/:id (+ /sessions, /activity, /activity-chart).
   Structure/styles are unchanged; only the data sources are real now. Header falls
   back to the list row (`u`) while the detail fetch is in flight. */
export function UserDetail({ u, onBack }: UserDetailProps) {
  const navigate = useNavigate();
  const [hi, setHi] = useState<number | null>(null);
  const [cohortOpen, setCohortOpen] = useState(false);
  const reduce = useReducedMotion();
  // The picker drives the chart for real now — it used to be `onChange={() => {}}`
  // against a hardcoded "Last 30 days" label, so the range was decorative.
  const [range, setRange] = useState("Last 30 days");
  const days = RANGE_DAYS[range] ?? 7;
  // A custom "Mon D → Mon D" pick resolves to an absolute [from,to] the chart
  // endpoint honours over `days`. Folded into the chart's deps below so two
  // different custom ranges (both falling back to days=7) still refetch.
  const custom = parseCustomRange(range);
  const cFrom = custom?.from;
  const cTo = custom?.to;
  const {
    data: detailData,
    loading: detailLoading,
    stale: detailStale,
    refetch: refetchDetail,
  } = useApi<ApiEndUserDetail>(
    () => EndUsers.get<ApiEndUserDetail>(String(u.id)),
    [u.id],
  );
  const {
    data: chartData,
    loading: chartLoading,
    stale: chartStale,
  } = useApi<ApiChartPoint[]>(
    () => EndUsers.activityChart<ApiChartPoint[]>(String(u.id), days, cFrom, cTo),
    [u.id, days, cFrom, cTo],
  );
  const {
    data: sessData,
    loading: sessLoading,
    stale: sessStale,
  } = useApi<ApiUserSession[]>(
    () => EndUsers.sessions<ApiUserSession[]>(String(u.id), 8),
    [u.id],
  );
  const {
    data: feedData,
    loading: feedLoading,
    stale: feedStale,
  } = useApi<ApiActivityItem[]>(
    () => EndUsers.activity<ApiActivityItem[]>(String(u.id), 8),
    [u.id],
  );

  /* The detail that belongs to THIS user. useApi holds the previous key's data
     while a new one resolves (keepPreviousData), so on a user switch `d` is
     still the PREVIOUS person's — and serving placeholder data flips the query
     to 'success', so `loading` is false while it does. Reading it here would
     print their distinct id, environment and even their NAME under this user's
     id. `stale` is exactly that signal, so it gates the data, not just the UI.

     Each surface then waits on `loading || stale` — its own request only, never
     `syncing`: a background refetch of the same key is data that is already
     correct, and shimmering over it would blank a page the analyst is reading. */
  const d = detailStale ? undefined : detailData;
  const detailBusy = detailLoading || detailStale;
  const sessBusy = sessLoading || sessStale;
  const feedBusy = feedLoading || feedStale;
  /* The chart is the one query keyed on more than the user (`days`), so `stale`
     here also covers a range switch. It skeletons for that too, deliberately:
     the picker says "Last 30 days" the instant it is clicked, and bars from the
     old range under that label are a chart that lies. (Same call the recordings
     rail makes for a filter switch.) Switching to an already-cached range never
     goes stale, so that still swaps instantly. */
  const chartBusy = chartLoading || chartStale;

  const chart = chartData ?? [];
  const sessions = sessData ?? [];
  const feed = feedData ?? [];

  /* A value the detail request owns: shimmer while it is in flight, otherwise
     keep the page's existing "—" for a field the payload genuinely has empty. */
  const dp = (v: string | undefined | null): PropValue =>
    detailBusy ? null : v || "—";

  // Replays the bar entrance on a range switch. Keyed off the RESOLVED series,
  // not `days` — useApi holds the previous range's data while the new one is in
  // flight, so keying on `days` would replay the sweep over the old bars and
  // then snap them to the new values without a second animation.
  const barKey = `${chart.length}:${chart[0]?.date ?? ""}`;
  const barStep =
    chart.length > 1
      ? Math.min(BAR_STEP_MS, BAR_SWEEP_MS / (chart.length - 1))
      : 0;

  const online = d ? d.isOnline : !!u.on;
  const flag = (d?.flag ?? u.flag) || "";
  const country = d ? d.country || "" : u.loc.split(", ")[1] || "";
  // Prefer the fetched detail (needed for a cold /users/:userId deep-link where
  // the list row `u` is just a placeholder), falling back to the row while loading.
  /* Resolve off the detail payload once it lands, else keep the list row's
     already-resolved identity. `email` used to fall back to `distinctId`, which
     for an anonymous browser IS the fingerprint hash (replay-persistence
     .service.ts:243) — so a field styled `ud-email mono` printed opaque hashes
     at people. It shows an address or it shows nothing. */
  const ident = d ? resolveIdentity(d, String(d.id)) : null;
  const name = ident?.label ?? u.n;
  const email = ident?.sub ?? u.e;
  const avInitials = ident?.initials ?? u.initials;
  const avSeed = ident?.hueSeed ?? u.hueSeed;
  // identify() avatar URL — prefer the fetched detail, fall back to the list row.
  const avPicture = ident?.picture ?? u.picture ?? null;

  // identify() traits, prettified for display. Blanks are dropped so a key that
  // was set to "" doesn't render as an empty row.
  const customProps: [string, string][] = Object.entries(d?.customProps ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [prettifyLabel(k), formatTraitText(v)]);

  /* Rows the page can answer itself keep their value while the detail loads —
     the user id is the route's, and last-seen falls back to the list row, same
     as the header identity block. Only the rows the payload owns shimmer. */
  const props: PropGroup[] = [
    [
      "Identifiers",
      [
        ["User ID", "#" + u.id],
        ["Distinct ID", dp(d?.identifiers.distinctId || d?.distinctId)],
      ],
    ],
    [
      "Activity",
      [
        ["First seen", dp(d && fmtDate(d.firstSeenAt))],
        [
          "Last seen",
          // The row already knows this one — only a deep link (placeholder row,
          // empty `seen`) has to wait for the payload.
          online ? "now" : d ? relTime(d.lastSeenAt) : u.seen || dp(undefined),
        ],
        ["Sessions", dp(d && String(d.sessions))],
        ["Avg duration", dp(d && fmtLong(d.avgDurationMs))],
      ],
    ],
    [
      "Environment",
      [
        ["Browser", dp(d?.environment.browser)],
        ["OS", dp(d?.environment.os)],
        ["Device", dp(d?.environment.device)],
        ["Viewport", dp(d?.environment.viewport)],
        ["City", dp(d?.city)],
        ["Country", dp(d ? countryName(d.country) : null)],
        ["Timezone", dp(d?.environment.timezone)],
        ["IP", dp(d?.environment.ip)],
      ],
    ],
    // Whatever identify() attached to this user, as its own section — only when
    // they actually have properties, so the sidebar never shows an empty group.
    ...(customProps.length
      ? ([["Custom properties", customProps]] as PropGroup[])
      : []),
  ];

  // KPI series derived from real data: session sparkline + trend from the 30-day
  // chart (recent half vs prior half); duration/rage sparklines from recent sessions.
  const chartCounts = chart.map((c) => c.count);
  const mx = Math.max(1, ...chartCounts);
  const sessSpark = chartCounts.slice(-8);
  const half = Math.floor(chartCounts.length / 2);
  const priorSum = chartCounts.slice(0, half).reduce((a, b) => a + b, 0);
  const recentSum = chartCounts.slice(half).reduce((a, b) => a + b, 0);
  const pct =
    priorSum > 0 ? Math.round(((recentSum - priorSum) / priorSum) * 100) : null;
  const chrono = [...sessions].reverse();
  const durSpark = chrono.map((s) => Math.round(s.durationMs / 1000)).slice(-8);
  const rageSpark = chrono.map((s) => s.rageCount).slice(-8);
  const rageTotal = sessions.reduce((a, s) => a + s.rageCount, 0);
  // Last-seen line for the Online tile — hoisted so the tile can tell "nothing
  // to say yet" from "nothing to say".
  const seenSub = online ? "now" : d ? relTime(d.lastSeenAt) : u.seen;
  /* Tile labels never wait: they are literals, not fetched. The number and the
     foot do, each on the request that feeds it — so a range switch reworks
     Sessions' trend without blanking its count, and the rage total shimmers
     rather than reporting the 0 an unresolved session list sums to. */
  const kpis: Kpi[] = [
    {
      label: "Sessions",
      value: d ? String(d.sessions) : "—",
      num: d ? d.sessions : undefined,
      valueBusy: detailBusy,
      sub: pct == null ? "last 30 days" : `${Math.abs(pct)}%`,
      trend: pct == null ? "flat" : pct >= 0 ? "up" : "down",
      spark: sessSpark.length >= 2 ? sessSpark : null,
      hasSpark: true,
      footBusy: chartBusy,
    },
    {
      label: "Avg session",
      value: d ? fmtLong(d.avgDurationMs) : "—",
      valueBusy: detailBusy,
      sub: "per session",
      trend: "flat",
      spark: durSpark.length >= 2 ? durSpark : null,
      hasSpark: true,
      footBusy: sessBusy,
    },
    {
      label: "Rage clicks",
      value: String(rageTotal),
      num: rageTotal,
      valueBusy: sessBusy,
      sub: "recent sessions",
      trend: "flat",
      spark: rageSpark.length >= 2 ? rageSpark : null,
      hasSpark: true,
      footBusy: sessBusy,
    },
    {
      // The one tile no request is needed for: `online` and the last-seen line
      // both fall back to the list row, exactly as the header identity block
      // does — so it states what the page already knows instead of shimmering
      // over it. Only a deep link (no row) leaves the foot with nothing at all.
      label: "Online",
      value: online ? "Yes" : "No",
      valueBusy: false,
      sub: seenSub,
      trend: "flat",
      spark: null,
      hasSpark: false,
      footBusy: detailBusy && !seenSub,
    },
  ];

  return (
    <div className="user-detail">
      <aside className="ud-side">
        <button
          className="btn sm q"
          onClick={onBack}
          style={{ marginBottom: "var(--sp-18)" }}
        >
          <Icon name="chev" size={12} style={{ transform: "rotate(90deg)" }} />{" "}
          All users
        </button>
        <span
          className="u-av"
          style={{ width: 64, height: 64, fontSize: "var(--text-2xl)", background: uhue(avSeed) }}
        >
          {/* Initials sit underneath; the avatar image overlays them when present,
              and an onError hides it so a broken URL reveals the initials again. */}
          {avInitials ?? "∅"}
          {avPicture && (
            <img
              className="u-av-img"
              src={avPicture}
              alt=""
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
          {online && (
            <span className="on-d" style={{ width: 14, height: 14 }} />
          )}
        </span>
        <h2 className="ud-name">{name}</h2>
        <div className="ud-email mono">{email}</div>
        <div
          style={{ display: "flex", gap: "var(--sp-6)", marginTop: "var(--sp-12)", flexWrap: "wrap" }}
        >
          {/* Plan chip only when the customer actually set a plan trait via
              identify() — never a fabricated "Free" default. */}
          {u.plan && <span className={`tag ${u.pt}`}>{u.plan}</span>}
          {online && <span className="tag ok">● online</span>}
          {(flag || country) && (
            <span className="tag">
              {flag} {countryName(country) || country}
            </span>
          )}
        </div>
        <button
          className="btn sm"
          style={{ width: "100%", justifyContent: "center", marginTop: "var(--sp-20)" }}
          onClick={() => setCohortOpen(true)}
        >
          <Icon name="cohorts" size={12} /> Add to cohort
        </button>
        <div className="ud-props">
          {props.map((g) => (
            <div key={g[0]}>
              <div className="ud-sl">{g[0]}</div>
              {/* Keyed by index, not label: two custom-property keys can prettify
                  to the same label (user_id + userId -> "User Id"). */}
              {g[1].map((p, i) => (
                <div key={i} className="ud-prop">
                  <span className="k mono">{p[0]}</span>
                  {/* null = the detail request still owes us this value. The
                      label is already right, so only the value stands in —
                      widths vary by row so the column reads as a list of
                      different facts, deterministically (never random, or the
                      sidebar would reshuffle on every re-render). */}
                  {p[1] === null ? (
                    <Sk w={54 + ((i * 17) % 34)} h={9} />
                  ) : (
                    <span className="v">{p[1]}</span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="ud-main udx">
        {/* 1 · Executive summary — a hairline-divided pulse, not four boxes.
            Each figure is large, tight and tabular (Inter); the label quietly
            supports it and the micro-trend sits subtle to the right. */}
        <div className="udx-pulse">
          {kpis.map((k) => (
            <div className="udx-kpi" key={k.label}>
              <div className="udx-kpi-k">{k.label}</div>
              {/* Only the fetched parts stand in — the label and geometry hold,
                  so the strip never reflows as values land. */}
              <div className="udx-kpi-v">
                {k.valueBusy ? (
                  <Sk w={58} h={22} style={{ margin: "var(--sp-4) 0" }} />
                ) : (
                  <>
                    {k.label === "Online" && online && (
                      <span className="on-dot" />
                    )}
                    {k.num != null ? <NumberFlow value={k.num} /> : k.value}
                  </>
                )}
              </div>
              <div className="udx-kpi-d">
                {k.footBusy ? (
                  <>
                    <Sk w={46} h={9} />
                    {/* Only the tiles that actually draw one — Online never does,
                        and a placeholder would promise a sparkline never coming. */}
                    {k.hasSpark && <Sk w={54} h={18} r={4} />}
                  </>
                ) : (
                  <>
                    {k.trend === "flat" ? (
                      <span className="udx-kpi-sub">{k.sub}</span>
                    ) : (
                      <span className={`udx-delta ${k.trend}`}>
                        <span className="ar">
                          {k.trend === "up" ? "▲" : "▼"}
                        </span>
                        {k.sub.replace(/[+−-]/, "")}
                      </span>
                    )}
                    {k.spark &&
                      (() => {
                        const smx = Math.max(...k.spark!),
                          mn = Math.min(...k.spark!),
                          r = smx - mn || 1,
                          w = 54,
                          h = 18;
                        const pts = k.spark!
                          .map(
                            (v, i) =>
                              `${((i / (k.spark!.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - mn) / r) * (h - 2)).toFixed(1)}`,
                          )
                          .join(" ");
                        const rage = k.label === "Rage clicks";
                        const col = rage ? "var(--amber)" : "var(--accent)";
                        const gid = "udk" + k.label.replace(/\s/g, "");
                        return (
                          <svg
                            className={`udx-spark ${rage ? "rage" : ""}`}
                            width={w}
                            height={h}
                            viewBox={`0 0 ${w} ${h}`}
                            preserveAspectRatio="none"
                          >
                            <defs>
                              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                                <stop
                                  offset="0"
                                  stopColor={col}
                                  stopOpacity="0.22"
                                />
                                <stop offset="1" stopColor={col} stopOpacity="0" />
                              </linearGradient>
                            </defs>
                            <path
                              d={`M0,${h} L${pts.split(" ").join(" L")} L${w},${h} Z`}
                              fill={`url(#${gid})`}
                            />
                            <polyline
                              points={pts}
                              fill="none"
                              stroke={col}
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                            />
                          </svg>
                        );
                      })()}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 2 · Activity — the visual anchor. Full-bleed under its label, with a
            faint reference scale and a light tooltip anchored to the hovered
            day. The picker stays live so a range can change mid-load. */}
        <section className="udx-sec">
          <div className="udx-sec-h">
            <span className="udx-sec-t">Activity</span>
            <span className="udx-sec-m">
              Sessions per day · {range.toLowerCase()}
            </span>
            <span className="udx-sp" />
            <DatePicker
              value={range}
              onChange={setRange}
              presets={RANGE_PRESETS}
              align="right"
            />
          </div>
          {/* `days` is the range the request asked for, so the skeleton has the
              bar count the real chart is about to have. */}
          {chartBusy ? (
            <UdBarsSkeleton bars={days} />
          ) : (
            <div className="udx-chart">
              <div className="udx-plot" onMouseLeave={() => setHi(null)}>
                <div className="udx-grid" aria-hidden="true">
                  <span className="udx-ymax udx-num">{mx}</span>
                  <span className="ln" style={{ top: 0 }} />
                  <span className="ln" style={{ top: "50%" }} />
                  <span className="ln base" style={{ bottom: 0 }} />
                </div>
                <div className="udx-bars">
                  {chart.map((pt, i) => (
                    // Only scaleY is animated: `.udx-bar` drives its own opacity
                    // off :hover/.hot, and an inline opacity would outrank it.
                    <motion.div
                      key={`${barKey}:${i}`}
                      className={`udx-bar ${hi === i ? "hot" : ""}`}
                      style={{
                        height: (pt.count / mx) * 100 + "%",
                        transformOrigin: "bottom",
                      }}
                      initial={reduce ? false : { scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      transition={
                        reduce
                          ? { duration: 0 }
                          : {
                              duration: BAR_GROW_MS / 1000,
                              delay: (i * barStep) / 1000,
                              ease: BAR_EASE,
                            }
                      }
                      onMouseEnter={() => setHi(i)}
                    />
                  ))}
                </div>
                {hi != null &&
                  chart[hi] &&
                  (() => {
                    const dt = new Date(chart[hi].date);
                    const lbl = dt.toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    });
                    const cnt = chart[hi].count;
                    const xPct = ((hi + 0.5) / chart.length) * 100;
                    // Anchor above the bar's top, clamped so a full-height bar
                    // keeps the tip inside the plot (never over the header).
                    const bottomPx = Math.min((cnt / mx) * 220 + 12, 174);
                    return (
                      <div
                        className="udx-tip"
                        style={{ left: `${xPct}%`, bottom: `${bottomPx}px` }}
                      >
                        <b>
                          {cnt} session{cnt === 1 ? "" : "s"}
                        </b>
                        <em>{lbl}</em>
                      </div>
                    );
                  })()}
              </div>
              {chart.length > 0 &&
                (() => {
                  const fmtTick = (iso: string) =>
                    new Date(iso).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    });
                  const last = chart.length - 1;
                  const ticks =
                    chart.length >= 5
                      ? [0, Math.floor(last / 2), last]
                      : [0, last];
                  const uniq = [...new Set(ticks)];
                  return (
                    <div className="udx-xaxis" aria-hidden="true">
                      {uniq.map((idx) => (
                        <span key={idx}>{fmtTick(chart[idx].date)}</span>
                      ))}
                    </div>
                  );
                })()}
            </div>
          )}
        </section>

        {/* 3 · Recent sessions — a scannable investigation ledger. A leading
            status dot triages at a glance; the route is the entity. */}
        <section className="udx-sec">
          <div className="udx-sec-h">
            <span className="udx-sec-t">Recordings</span>
            {/* Both halves of this line are fetched — an unresolved list once
                read "showing latest 0", a count the page did not have. */}
            {detailBusy || sessBusy ? (
              <Sk w={124} h={9} />
            ) : (
              <span className="udx-sec-m">
                {d ? d.sessions : "—"} total · showing latest {sessions.length}
              </span>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th style={{ width: 88 }}>Duration</th>
                <th>Activity</th>
                <th style={{ width: 120 }}>Issues</th>
                <th style={{ width: 96 }}>When</th>
              </tr>
            </thead>
            <tbody>
              {/* Rows only — the real <thead> above is already the one the
                  skeleton would draw. */}
              {sessBusy && <UdSessionsSkeleton />}
              {!sessBusy &&
                sessions.map((s) => {
                  const kind =
                    s.rageCount > 0 ? "rage" : s.errorCount > 0 ? "err" : "clean";
                  const issue =
                    kind === "clean"
                      ? "Clean"
                      : kind === "rage"
                        ? `${s.rageCount} rage`
                        : `${s.errorCount} err`;
                  // Mobile sessions have no URL — show the humanised device model
                  // ("iPhone 17 Pro"), same as the recordings list; web shows the
                  // page path. `app://` startUrl is the mobile fallback signal.
                  const isMobile =
                    s.platform === "ios" ||
                    s.platform === "android" ||
                    (s.startUrl?.startsWith("app://") ?? false);
                  const pathLabel = isMobile
                    ? s.deviceModel || "Mobile app"
                    : urlPath(s.startUrl);
                  return (
                    <tr
                      className="clickable"
                      key={s.id}
                      onClick={() => navigate(`/recordings/${s.publicId}`)}
                    >
                      <td>
                        <span className="udx-rec-path">
                          <span className={`udx-rec-dot ${kind}`} />
                          <span className="udx-rec-route">
                            {pathLabel}
                          </span>
                        </span>
                      </td>
                      <td className="udx-rec-dur">{fmtClock(s.durationMs)}</td>
                      <td className="udx-rec-meta">
                        {s.pageCount} pages · {s.clickCount} clicks
                      </td>
                      <td>
                        <span className={`udx-iss ${kind}`}>
                          {kind !== "clean" && <span className="d" />}
                          {issue}
                        </span>
                      </td>
                      <td className="udx-rec-when">{relTime(s.startedAt)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </section>

        {/* 4 · Timeline — the feed as events on a rail. The title dominates,
            metadata recedes, and a row is actionable (opens the session). */}
        <section className="udx-sec">
          <div className="udx-sec-h">
            <span className="udx-sec-t">Activity feed</span>
            <span className="udx-sec-m">Events captured for this user</span>
          </div>
          {feedBusy ? (
            <UdFeedSkeleton />
          ) : (
            <div className="udx-tl">
              {feed.map((a, i) => (
                <button
                  className="udx-tl-row"
                  key={i}
                  onClick={() => navigate(`/recordings/${a.publicId}`)}
                >
                  <span className="udx-tl-node">
                    <span className="udx-tl-dot">
                      <Icon name="play" size={9} fill />
                    </span>
                  </span>
                  <span className="udx-tl-body">
                    <span className="udx-tl-top">
                      <span className="udx-tl-title">{a.title}</span>
                      <span className="udx-tl-time">{relTime(a.ts)}</span>
                    </span>
                    <span className="udx-tl-detail">{a.detail}</span>
                  </span>
                  <Icon name="arrowR" size={14} className="udx-tl-go" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <AddToCohortModal
        open={cohortOpen}
        userId={u.id}
        userName={name}
        cohortIds={d?.cohortIds ?? []}
        onChanged={refetchDetail}
        onClose={() => setCohortOpen(false)}
      />
    </div>
  );
}
