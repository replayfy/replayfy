/* ============================================================================
   Overview.tsx — Replayfy's front page, analytics-first.

   Reading order: one line of context → four semantic KPIs (Pulse) with a
   featured story alongside → Activity → Conversion → Stability → Worth
   watching → Segments. No cards; hierarchy is typeset. Replayfy AI is an
   enhancement layer: with the switch off every surface is deterministic and
   complete (the story slot becomes a deterministic needs-attention card);
   with it on, the same surfaces gain the analyst storyline, confidence,
   evidence, inline correlations and a floating agent (FAB) that opens Ask.

   Data pattern (unchanged): every surface renders its design fixture
   instantly and folds the real payload in when it resolves; a loaded-but-
   empty workspace drops to the approved <EmptyState>.
   ========================================================================== */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { MiniSpark } from "@/components/charts";
import { DatePicker, Icon } from "@/components/primitives";
import { V3Drawer } from "@/components/overlays";
import { useToast } from "@/components/feedback";
import { useApi } from "@/api/useApi";
import { Alerts, Dashboard, Funnels } from "@/api/endpoints";
import type {
  ApiFunnel,
  ApiFunnelCompute,
} from "@/routes/funnels/funnels.data";
import { type Crash, type Signal } from "./overview.data";
import {
  rangeToken,
  relShort,
  adaptCrashes,
  adaptIncidentSignals,
  adaptSignals,
  adaptSubsys,
  adaptPulseSubsys,
  anrRateStat,
  conversionHeadline,
  crashTotalStat,
  type CountsResp,
  type IntelligenceResp,
  type LiveResp,
  type MetricsResp,
  type OverviewResp,
  type IncidentFunnelResp,
} from "./overview.api";
import { listCrashIssues, issuesToCrashes } from "./crashlytics.api";
import { fetchReleases, adaptReleases } from "./releases.api";
import { fetchSegments, adaptSegments } from "./segments.api";
import { useAiMode } from "./useAiMode";
import { useAuth } from "@/lib/auth";
import { onbStore } from "./onboarding.store";
import { PulseBand, type PulseCell } from "./sections/PulseBand";
import { OverviewStory } from "./sections/OverviewStory";
import { ActivitySection } from "./sections/ActivitySection";
import { rangeLabelToTimeKey } from "./activity.query";
import { parseCustomRange } from "@/lib/date-ranges";
import { ConversionSection } from "./sections/ConversionSection";
import { StabilitySection } from "./sections/StabilitySection";
import { WatchlistSection, type WatchRow } from "./sections/WatchlistSection";
import { SegmentsSection, type SegmentDim } from "./sections/SegmentsSection";
import { SignalsWorkspace } from "./drawers/SignalsWorkspace";
import { SignalInvestigation } from "./drawers/SignalInvestigation";
import { SkText } from "./sections/OverviewSkeletons";
import { OnboardingChecklist } from "./sections/OnboardingChecklist";
import { ee } from "@ee";
import { CrashAllList } from "./drawers/CrashAllList";
import { osLabel, flagEmoji } from "@/lib/device-format";

type DrawerKind =
  | "health"
  | "confidence"
  | "insights"
  | "breakdown"
  | "crashes"
  | "ask";

const pctOf = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);

/** The "Worth watching" surface line — the same device + country descriptor
 *  the recordings list shows: mobile → "iOS 26 · iPhone 17 · 🇳🇬", web →
 *  "Chrome · macOS · 🇩🇪". Empty when no device is known (caller falls back to
 *  the URL). deviceModel falls back to the device TYPE; flag to the country. */
function worstSurface(w: {
  platform: string;
  browser: string | null;
  os: string | null;
  osVersion: string | null;
  device: string | null;
  deviceModel: string | null;
  country: string | null;
  flag: string | null;
}): string {
  const isMob = w.platform === "ios" || w.platform === "android";
  const dev = isMob
    ? [osLabel(w.os, w.osVersion), w.deviceModel || w.device]
        .filter(Boolean)
        .join(" · ")
    : [w.browser, w.os].filter(Boolean).join(" · ");
  return [dev, w.flag || flagEmoji(w.country)].filter(Boolean).join(" · ");
}

function jumpTo(id: string) {
  const el = document.getElementById(id);
  el?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
}

export function Overview({ empty }: { empty?: boolean }) {
  const [drawer, setDrawer] = useState<DrawerKind | null>(null);
  // Which segment dimension the breakdown drawer is showing (set on band click).
  const [breakdownDim, setBreakdownDim] = useState<SegmentDim>("Platform");
  const toast = useToast();
  const navigate = useNavigate();
  // `setAi` dropped while the header AI toggle is commented out below — re-add it
  // to this destructuring when restoring the toggle.
  const { ai, ready: aiReady } = useAiMode();

  // ── Backend reads. `range` (header DatePicker) drives every read; each
  //    surface keeps its fixture until the first payload resolves. ──
  /* Keep in step with WorkspacePrecomputeService.DEFAULT_RANGE (30d): the
     backend precomputes the Overview + metrics for THAT window every ~5min and
     mirrors them to Redis, and the /overview + /metrics fast paths only serve
     the snapshot when the requested range matches it. If this default and that
     constant ever drift apart, the homepage silently misses the cache and pays
     the full live compute (~440ms at 500k sessions) + 3 ClickHouse FINAL scans. */
  const [rangeLabel, setRangeLabel] = useState("Last 30 days");
  const range = rangeToken(rangeLabel);
  // A custom "Mon D → Mon D" pick resolves to an absolute [from,to] window the
  // dashboard endpoints honour directly (they skip the precompute cache when
  // from/to are set); named presets stay on the `range` token. cFrom/cTo are
  // folded into every window read's deps below so two DIFFERENT custom ranges
  // — which both fall back to the "30d" token — still refetch.
  const custom = parseCustomRange(rangeLabel);
  const cFrom = custom?.from;
  const cTo = custom?.to;
  /* These four poll every 30s. staleTime alone doesn't keep a dashboard live:
     it only marks data stale, and the sole triggers are mount/focus/reconnect —
     so a chart left on screen never refreshed until you tabbed away and back.
     Dashboard.intelligence is deliberately excluded: it's the AI read, it's
     expensive, and it's already gated behind `ai`. */
  const LIVE_MS = 30_000;
  const { data: overviewData, loading: overviewLoading } = useApi<OverviewResp>(
    () => Dashboard.overview<OverviewResp>(range, cFrom, cTo),
    [range, cFrom, cTo],
    { refetchInterval: LIVE_MS },
  );
  const { data: metricsData, loading: metricsLoading } = useApi<MetricsResp>(
    () => Dashboard.metrics<MetricsResp>(range, cFrom, cTo),
    [range, cFrom, cTo],
    { refetchInterval: LIVE_MS },
  );
  /* `aiReady &&`, not just `ai`: useAiMode reports AI ON while its own read is
     still in flight (deliberately — so the richer surface doesn't flash in after
     the fact on a cold load). Gating this read on that optimistic default meant
     that switching into an AI-OFF workspace fired the expensive LLM-backed
     /intelligence request before we knew the workspace didn't want it, then threw
     the answer away. Waiting for the setting costs nothing on screen: while the
     switch is unknown the query is disabled, so `intelPending` is true and
     `intelLoading` below already holds the storyline on its skeleton. */
  const { data: intelData, loading: intelPending } = useApi<IntelligenceResp>(
    () => Dashboard.intelligence<IntelligenceResp>(range, cFrom, cTo),
    [range, cFrom, cTo],
    { enabled: aiReady && ai },
  );
  const { data: liveData, loading: liveLoading } = useApi<LiveResp>(
    () => Dashboard.live<LiveResp>(),
    [],
    { refetchInterval: LIVE_MS },
  );
  // `key` is shared with the Sidebar's badge counts — one cached request serves
  // both instead of each firing its own on every overview load.
  const { data: countsData, loading: countsLoading } = useApi<CountsResp>(
    () => Dashboard.counts<CountsResp>(),
    [],
    { key: "dashboard-counts", refetchInterval: LIVE_MS },
  );
  // Deterministic crash & error groups (crashlytics) — SQL-exact counts,
  // preferred over the AI incidents feed for the Stability ledger. Shares the
  // "crash-issues" key + limit with the "All crashes" drawer, so both surfaces
  // are served by ONE cached request instead of two.
  const { data: crashIssuesData } = useApi(
    () => listCrashIssues({ limit: 60 }),
    [],
    { key: "crash-issues", refetchInterval: LIVE_MS },
  );
  // Real Release Intelligence (per-release health + deltas + regression flag)
  // for the Stability "Releases" ledger — replaces the RELEASES demo fixture.
  const { data: releasesRaw, loading: releasesLoading } = useApi(
    () => fetchReleases(),
    [],
    { key: "dashboard-releases", refetchInterval: LIVE_MS },
  );
  // Real platform/browser/country distribution for the Segments band (one
  // GROUPING SETS scan on the server). Re-keyed on the range like the other
  // window reads.
  const { data: segmentsRaw, loading: segmentsLoading } = useApi(
    () => fetchSegments(range, cFrom, cTo),
    [range, cFrom, cTo],
    { key: "dashboard-segments", refetchInterval: LIVE_MS },
  );
  // The breakdown DRAWER shows the COMPLETE ranked list (every country/browser,
  // no "Other" roll-up). Fetched lazily — `enabled` only once the drawer is open
  // — so the compact 30s poll above never carries the full tail. TanStack caches
  // it across re-opens; not polled (a drawer read doesn't need to live-refresh).
  const { data: fullSegmentsRaw } = useApi(
    () => fetchSegments(range, cFrom, cTo, true),
    [range, cFrom, cTo],
    { key: "dashboard-segments-full", enabled: drawer === "breakdown" },
  );
  /* ── Loading gates. Each `loading` above feeds ONLY the surfaces its own read
     fills, so the regions resolve independently — a slow /intelligence can't
     hold up the watchlist, and whichever payload lands first shows its numbers
     immediately.

     `loading` (isPending) and not `stale`/`syncing`, deliberately: `stale` is
     true while the PREVIOUS range's payload is still on screen under
     keepPreviousData, and `syncing` is true on every 30s poll. Shimmering over
     either would blank numbers the analyst is reading and blink the page twice
     a minute. Skeletons are for a COLD load — no data for this workspace at all.

     A DISABLED query is `pending` forever — it has no data and never asked for
     any — so on an { enabled } read `loading` means "no data yet", NOT "in
     flight". Read raw, it would shimmer for eternity with the AI switch off;
     hence `ai && …` here and `!!pinnedFunnel && …` on the compute below. */
  const intelLoading = ai && intelPending;

  // ── Pinned funnel: the Conversion section tracks whichever funnel the user
  //    pinned on the Funnels page (one pinned-only read + one compute — never a
  //    loop). Asking for `pinned` server-side (indexed) rather than pulling the
  //    workspace's whole funnel list and `.find()`-ing it in the browser.
  const { data: funnelList, loading: funnelListLoading } = useApi<ApiFunnel[]>(
    () => Funnels.list<ApiFunnel[]>({ pinned: true, limit: 1 }),
    [],
  );
  // `.find` rather than `[0]`: the server already filters to pinned, but this
  // keeps the card correct if it's talking to an API that predates the param
  // (which would return every funnel) — otherwise an UNPINNED funnel could
  // render here as though it were pinned.
  const pinnedFunnel = funnelList?.find((f) => f.pinned) ?? null;
  const { data: funnelCompute, loading: funnelComputePending } =
    useApi<ApiFunnelCompute>(
      () => Funnels.compute<ApiFunnelCompute>(String(pinnedFunnel!.id)),
      [pinnedFunnel?.id],
      { enabled: !!pinnedFunnel },
    );
  /* Conversion is unresolved until BOTH hops finish: which funnel is pinned,
     then that funnel's compute. The second is `enabled`-gated on the first, so
     it must be read as `hasPinned && pending` — with nothing pinned it stays
     `pending` forever and would shimmer over the "pin a funnel" prompt. */
  const conversionLoading =
    funnelListLoading || (!!pinnedFunnel && funnelComputePending);

  // Ask AI is mounted globally (ee.AskProvider in AppLayout) — trigger it from
  // here. Open-source build: ee.useAsk() is a no-op, so these calls do nothing.
  const { openAsk } = ee.useAsk();

  // ── Derived view-models (fixture fallback while a payload is unresolved). ──
  const pulse = overviewData?.pulse;
  // health/healthDelta are null when the window has no sessions (unmeasurable) —
  // preserve null through to the render (→ "—"); Math.round(null) would be 0,
  // silently reviving the "dead pipeline scores perfect" bug. The 82/3 fixtures
  // apply only BEFORE a payload lands (no pulse), not when a real pulse says null.
  const score = pulse
    ? pulse.health == null
      ? null
      : Math.round(pulse.health)
    : 82;
  const healthDelta = pulse
    ? pulse.healthDelta == null
      ? null
      : Math.round(pulse.healthDelta)
    : 3;
  const healthTrend = pulse?.spark ?? [];
  // Contributor rows are MEASURED subsystem scores, never a fixture: the richer
  // AI intelligence subscores (with per-subsystem delta + detail) when present,
  // else the deterministic pulse subscores, else empty (→ "no data" in-drawer).
  const subsys = adaptSubsys(intelData) ?? adaptPulseSubsys(pulse) ?? [];
  // Confidence-drawer factors are the SAME measured subsystems that drive the
  // score (never a fixture): each row's detail is its measured note (or its
  // score), and its strength reflects how far the subsystem sits from baseline.
  const confFactors = subsys.map((s) => ({
    ic:
      s.n === "Stability"
        ? "warn"
        : s.n === "Conversion"
          ? "funnel"
          : s.n === "API health"
            ? "globe"
            : s.n === "UX"
              ? "cursor"
              : "spark",
    n: s.n,
    d: s.why || `Subsystem score ${s.v}/100`,
    w: (s.v < 70 ? "Strong" : "Moderate") as "Strong" | "Moderate",
  }));
  const story = overviewData?.storyline ?? null;
  // The AI-authored storyline (intelligence pass) is the lead the model chose —
  // prefer it when present; the deterministic /overview storyline is the fallback
  // (AI off, or a degraded pass that left no fresh headline).
  const aiStory: string | null =
    ai &&
    intelData &&
    intelData.aiEnabled === true &&
    typeof intelData.storyline?.text === "string" &&
    intelData.storyline.text.trim()
      ? intelData.storyline.text.trim()
      : null;
  const conv = conversionHeadline(metricsData);
  const crashStat = crashTotalStat(metricsData);
  // Stability tiles are measured-only: crash-free sessions from the pulse
  // crash/session counters + total crashes from /metrics. Crash-free USERS and
  // ANR rate have no web-side source yet, so they're omitted rather than shown
  // as a fixture (ANR joins once the mobile ANR rollup is surfaced).
  const cfSig = pulse?.signals;
  const cfSigPrev = pulse?.signalsPrev;
  // Crash-free % needs a denominator worth trusting. A window with only a
  // handful of completed sessions (e.g. a workspace whose ingest has gone quiet,
  // leaving the trailing window on a near-empty tail day) turned "1 crash in 1
  // session" into a fabricated "0.00% ▼100pt". Floor it at the backend's own
  // stability threshold (WorkspaceHealthService.MIN_SESSIONS = 20): below that
  // there's no honest number, so show "—" rather than a wrong one.
  const CF_MIN_SESSIONS = 20;
  const cfNow =
    cfSig && cfSig.sessions >= CF_MIN_SESSIONS
      ? 100 - pctOf(cfSig.crashes, cfSig.sessions)
      : null;
  const cfWas =
    cfSigPrev && cfSigPrev.sessions >= CF_MIN_SESSIONS
      ? 100 - pctOf(cfSigPrev.crashes, cfSigPrev.sessions)
      : null;
  const crashStats: [string, string, string, string][] = [];
  if (cfNow != null) {
    const dpt = cfWas != null ? cfNow - cfWas : null;
    crashStats.push([
      "Crash-free sessions",
      cfNow.toFixed(2) + "%",
      dpt == null ? "—" : (dpt >= 0 ? "+" : "−") + Math.abs(dpt).toFixed(2) + "pt",
      dpt == null ? "flat" : dpt >= 0 ? "up" : "down",
    ]);
  } else if (cfSig) {
    // We have a real pulse but too few sessions in the window to compute an
    // honest rate — keep the tile visible as "—" instead of dropping it (or
    // showing a fabricated 0.00%).
    crashStats.push(["Crash-free sessions", "—", "—", "flat"]);
  }
  // ANR rate — real, mobile-only (the backend omits the metric for a web-only
  // workspace, so this row simply doesn't appear there).
  const anrStat = anrRateStat(metricsData);
  if (anrStat) crashStats.push(anrStat);
  if (crashStat) crashStats.push(crashStat);
  const crashes: Crash[] =
    issuesToCrashes(crashIssuesData) ?? adaptCrashes(overviewData) ?? [];
  // Real releases (null → StabilitySection shows "No release captured yet").
  const releasesData = adaptReleases(releasesRaw);
  // The per-day crash-density chart moved to the Crashlytics page (owner req
  // 2026-08-13); Overview's Stability section now shows numbers + ledger only.
  // Real segment distributions (null → SegmentsSection keeps its demo fixture).
  const segData = adaptSegments(segmentsRaw);
  // Complete per-dimension breakdown for the drawer (null until the lazy fetch
  // lands — the drawer falls back to the compact band meanwhile).
  const fullSegData = adaptSegments(fullSegmentsRaw);
  const crashHeadline = crashStat
    ? `${crashStat[1]} ${crashStat[2].startsWith("+") ? "▲" : "▼"} ${crashStat[2].replace(/^[+−-]/, "")}`
    : "312 ▲ 18%";
  // The confidence chip is only honest when the window actually has sessions to
  // score. `score` (pulse.health) is null on a data-less window; an empty
  // workspace's storyline is grounded in default health facts only, which the
  // backend used to score a flat 55 — surfacing a fabricated "55% confidence"
  // on a brand-new workspace. Gate on a measurable window so an empty one shows
  // no chip (belt-and-braces with the backend now emitting null confidence, and
  // it also suppresses any already-persisted 55 on a since-emptied window).
  const confPct: number | null =
    ai &&
    score != null &&
    intelData &&
    intelData.aiEnabled === true &&
    typeof intelData.storyline?.confidence === "number"
      ? Math.round(
          (intelData.storyline.confidence as number) <= 1
            ? (intelData.storyline.confidence as number) * 100
            : (intelData.storyline.confidence as number),
        )
      : null;

  // Signals: AI insights (confidence, correlation) vs deterministic incidents.
  // Real-only — an empty list renders the section's own empty state, never a
  // demo fixture.
  const aiSignals = adaptSignals(intelData) ?? [];
  const detSignals = adaptIncidentSignals(overviewData) ?? [];
  const signals = ai ? aiSignals : detSignals;
  const signalCount = ai ? aiSignals.length : detSignals.length;

  // Watchlist: real worst sessions when present, else the design fixture.
  const watchRows: WatchRow[] = overviewData?.worstSessions?.length
    ? overviewData.worstSessions.slice(0, 8).map(
        (w): WatchRow => ({
          s: w.sessionScore,
          t: w.sessionScore < 35 ? "var(--red)" : "var(--amber)",
          n: w.userName || "Anonymous",
          // Same "iOS 26 · iPhone 17 · 🇳🇬" surface as the recordings list:
          // mobile → OS+major · model (or device type); web → browser · OS;
          // then the session's flag. Falls back to the URL for web sessions
          // that have no geo yet.
          p:
            worstSurface(w) ||
            [w.platform, w.startUrl?.replace(/^https?:\/\//, "").slice(0, 34)]
              .filter(Boolean)
              .join(" · "),
          tags: (
            [
              w.rageCount ? [`${w.rageCount} rage`, "err"] : null,
              w.errorCount ? [`${w.errorCount} errors`, "err"] : null,
              w.deadCount ? [`${w.deadCount} dead clicks`, "warn"] : null,
            ].filter(Boolean) as [string, string][]
          ).slice(0, 2),
          id: w.publicId,
          initials: w.userInitials ?? undefined,
        }),
      )
    : [];

  // Pulse (deterministic counters from replay data; fixtures pre-load).
  const sig = pulse?.signals,
    sigPrev = pulse?.signalsPrev;
  // Same minimum-denominator floor as the Stability tile above — a thin window
  // (a quiet workspace's near-empty tail) must not render a fabricated rate.
  const cfCur = sig
    ? sig.sessions >= CF_MIN_SESSIONS
      ? 100 - pctOf(sig.crashes, sig.sessions)
      : null
    : 99.62;
  const cfPrev =
    sigPrev && sigPrev.sessions >= CF_MIN_SESSIONS
      ? 100 - pctOf(sigPrev.crashes, sigPrev.sessions)
      : sig
        ? null
        : 99.76;
  const seshCur = sig ? sig.sessions : 48932;
  const seshPrev = sigPrev?.sessions ?? (sig ? null : 46960);
  // Rows the segment-breakdown drawer shows for the clicked dimension. Prefer
  // the FULL list once it lands; fall back to the compact band (top-6 + Other)
  // so the drawer opens instantly, then expands to every row. The band is only
  // clickable when real `segData` is present, so [] just guards render.
  const breakdownSrc = fullSegData ?? segData;
  const breakdownRows = breakdownSrc
    ? breakdownDim === "Platform"
      ? breakdownSrc.platform
      : breakdownDim === "Browser"
        ? breakdownSrc.browser
        : breakdownSrc.country
    : [];
  const breakdownTotal = breakdownSrc?.totalSessions ?? seshCur;
  // Every pulse cell reads against the previous period — a flat gray chip when
  // nothing moved (or nothing to compare against), never an empty slot.
  const ptDelta = (
    cur: number,
    prev: number | null,
    goodUp: boolean,
  ): PulseCell["delta"] => {
    if (prev == null) return { tone: "flat", text: "—" };
    const d = cur - prev;
    if (Math.abs(d) < 0.005) return { tone: "flat", text: "0pt" };
    return {
      arrow: d >= 0 ? "▲" : "▼",
      tone: d >= 0 === goodUp ? "up" : "down",
      text: Math.abs(d).toFixed(Math.abs(d) >= 10 ? 1 : 2) + "pt",
    };
  };
  const pcDelta = (
    cur: number,
    prev: number | null,
    goodUp: boolean,
  ): PulseCell["delta"] => {
    if (prev == null) return { tone: "flat", text: "—" };
    if (prev === 0) {
      if (cur === 0) return { tone: "flat", text: "0%" };
      // no baseline to compute % against — report the absolute movement
      return {
        arrow: "▲",
        tone: goodUp ? "up" : "down",
        text: "+" + cur.toLocaleString(),
      };
    }
    const d = ((cur - prev) / prev) * 100;
    if (Math.abs(d) < 0.05) return { tone: "flat", text: "0%" };
    return {
      arrow: d >= 0 ? "▲" : "▼",
      tone: d >= 0 === goodUp ? "up" : "down",
      text:
        Math.abs(d) >= 100
          ? Math.round(Math.abs(d)) + "%"
          : Math.abs(d).toFixed(1) + "%",
    };
  };

  // "vs previous 30 days" — every compared surface names the window it reads against.
  const periodNote =
    rangeLabel === "Today"
      ? "vs yesterday"
      : rangeLabel === "Yesterday"
        ? "vs the day before"
        : /^Last (\d+) days$/.test(rangeLabel)
          ? `vs previous ${rangeLabel.match(/^Last (\d+) days$/)![1]} days`
          : "vs previous period";

  // Semantic hue for the health-style numbers (green healthy → red at risk).
  const grade = (v: number, good: number, warn: number) =>
    v >= good ? "var(--green)" : v >= warn ? "var(--amber)" : "var(--red)";
  const pulseCells: PulseCell[] = [
    {
      key: "score",
      label: "Experience score",
      num: score,
      numFormat: { maximumFractionDigits: 0 },
      unit: "/100",
      // null → no chip (unmeasurable); 0 → flat "0" chip (measured, no change).
      // These are different facts, so the null case can't collapse into "0".
      delta:
        healthDelta == null
          ? undefined
          : healthDelta
            ? {
                arrow: healthDelta >= 0 ? "▲" : "▼",
                tone: healthDelta >= 0 ? "up" : "down",
                text: String(Math.abs(healthDelta)),
              }
            : { tone: "flat", text: "0" },
      sub: periodNote,
      onClick: () => setDrawer("health"),
      title:
        "Composite of stability, performance, UX and conversion — open the breakdown",
      skeleton: overviewLoading,
    },
    {
      key: "crashfree",
      label: "Crash-free",
      // null (too few sessions to be honest) → the cell renders "—", same as
      // the health cell does for a null score.
      num: cfCur == null ? null : cfCur >= 99.995 ? 100 : cfCur,
      numFormat:
        cfCur != null && cfCur >= 99.995
          ? { maximumFractionDigits: 0 }
          : { minimumFractionDigits: 2, maximumFractionDigits: 2 },
      unit: "%",
      delta:
        cfCur == null ? { tone: "flat", text: "—" } : ptDelta(cfCur, cfPrev, true),
      sub: periodNote,
      onClick: () => jumpTo("ox-stability"),
      title: "Share of sessions that ended without a crash — jump to stability",
      skeleton: overviewLoading,
    },
    {
      key: "conversion",
      label: "Conversion",
      num: conv ? parseFloat(conv.pct) : 8.5,
      numFormat: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
      unit: "%",
      delta: conv
        ? {
            arrow: conv.dir === "up" ? "▲" : "▼",
            tone: conv.dir,
            text: conv.deltaPt,
          }
        : { arrow: "▼", tone: "down", text: "2.7pt" },
      sub: periodNote,
      onClick: () => jumpTo("ox-conversion"),
      title: "End-to-end funnel conversion — jump to the funnel",
      // this one cell reads /metrics, not /overview — it resolves on its own
      skeleton: metricsLoading,
    },
    {
      key: "sessions",
      label: "Sessions",
      // Windowed session count for the SELECTED range, so this card responds to
      // the date picker and stays consistent with the other three (which are all
      // windowed). Delta + `periodNote` are already period-over-period. (Was the
      // all-time `sessionsTotal`, which ignored the picker — an odd standout.)
      num: seshCur,
      numFormat: { useGrouping: true, maximumFractionDigits: 0 },
      delta: pcDelta(seshCur, seshPrev, true),
      sub: periodNote,
      onClick: () => navigate("/recordings"),
      title: "Total recorded sessions — open recordings",
      skeleton: overviewLoading,
    },
  ];

  // "Create alert" on a signal: bind a recurrence alert to the signal's backing
  // incident (or issue). Fires later — via the alert evaluator crons — when that
  // signal is active/recurring again (in-app bell + any configured email/PagerDuty
  // /Slack/webhook), so a user can be notified without watching the dashboard.
  const createSignalAlert = (s: Signal) => {
    const body =
      s.incidentId != null
        ? { incidentId: s.incidentId }
        : s.issueId != null
          ? { issueId: s.issueId }
          : null;
    if (!body) {
      toast && toast("This signal has nothing to alert on.", { kind: "err" });
      return;
    }
    Alerts.fromSignal(body)
      .then(
        () =>
          toast &&
          toast("Alert created — you'll be notified when this recurs.", {
            kind: "ok",
          }),
      )
      .catch(
        () => toast && toast("Couldn't create the alert.", { kind: "err" }),
      );
  };

  // Signal actions. Real AI insights carry the model's chosen actionKind — route
  // that to the matching dashboard surface (the backend's actionHref points at a
  // different route scheme, so we map by kind, not by following the href). Fixture
  // rows have no actionKind, so they fall through to the button-label heuristic.
  // The incident whose funnel is mid-creation, so its "Create funnel" button can
  // spin. One at a time is enough — this is a deliberate, single-click action.
  const [funnelBusyId, setFunnelBusyId] = useState<number | null>(null);

  /* Create-funnel is a WRITE that runs an LLM: the model proposes steps grounded
     in the incident's real events, the server validates + creates via the shared
     FunnelsService. The button spins while it runs; on success we toast and point
     at Funnels (per the product spec) rather than yanking the user off the page. */
  const createFunnelFromIncident = async (s: Signal) => {
    if (s.incidentId == null) return navigate("/funnels"); // issue-backed: no incident endpoint
    if (funnelBusyId != null) return; // already creating one
    setFunnelBusyId(s.incidentId);
    try {
      const res = await Dashboard.incidentCreateFunnel<IncidentFunnelResp>(
        String(s.incidentId),
      );
      const r = res?.data;
      if (r && r.created) {
        toast &&
          toast(`Funnel "${r.name}" created — open Funnels to see it.`, {
            kind: "ok",
          });
      } else {
        toast &&
          toast(
            r?.reason === "no_funnel"
              ? "Couldn't build a funnel from this signal's events."
              : "Couldn't create the funnel.",
            { kind: "err" },
          );
      }
    } catch {
      toast && toast("Couldn't create the funnel.", { kind: "err" });
    } finally {
      setFunnelBusyId(null);
    }
  };

  const runSignalAction = (s: Signal) => {
    // Dismiss the "All insights" drawer so the result is visible — navigation
    // unmounts it anyway, but the Investigate → Ask handoff opens a panel that
    // would otherwise sit hidden behind the still-open drawer.
    setDrawer(null);
    switch (s.actionKind) {
      case "view_sessions":
        /* Scope to the incident behind the signal. A NAMED param the server
           resolves, not a CSV of ids: an incident's session set is unbounded
           (a 4,000-session incident is ~24KB of URL) and its title is a
           server-owned column the clusterer rewrites, so both belong on the
           server side of the link.

           No incidentId → the unscoped list, exactly what this did for every
           row before. That still covers insights sourced from an ISSUE rather
           than an incident (they carry issueId, and there is no issue scope
           yet) — unscoped is wrong-ish for those, but it is what they do today,
           and a second named scope is its own change, not a rider on this one. */
        /* Issue-backed insights carry issueId, not incidentId — half of them on
           a real workspace. They used to fall through to the UNSCOPED list, so
           "View sessions" silently showed every recording, which is worse than
           showing none. `?issue=` is the same contract as `?incident=`: named,
           resolved server-side, never a CSV. */
        return navigate(
          s.incidentId
            ? `/recordings?incident=${s.incidentId}`
            : s.issueId
              ? `/recordings?issue=${s.issueId}`
              : "/recordings",
        );
      case "open_crash":
        return setDrawer("crashes");
      case "open_funnel":
        // The backend deep-links open_funnel to a real /funnels/{id}; follow it
        // when it's exactly that (internal, numeric id), else the funnels list.
        return navigate(
          /^\/funnels\/\d+$/.test(s.actionHref ?? "")
            ? s.actionHref!
            : "/funnels",
        );
      case "create_funnel":
        void createFunnelFromIncident(s);
        return;
      case "investigate":
        if (ai) {
          const topic = s.titleText || s.d || "this signal";
          return openAsk(
            `Investigate this signal: ${topic} — what's the root cause, and what should we do about it?`,
          );
        }
        break;
    }
    const a = s.act.toLowerCase();
    if (a.includes("funnel")) return navigate("/funnels");
    if (a.includes("crash")) return setDrawer("crashes");
    if (
      a.includes("session") ||
      a.includes("recording") ||
      a.includes("replay")
    )
      return navigate("/recordings");
    if (a.includes("cohort")) return navigate("/cohorts");
    if (a.includes("investigate") && ai)
      return openAsk("Why did conversion drop?");
    toast && toast(s.act + " opened", { kind: "ok" });
  };

  // Loaded-but-empty workspace → a first-run onboarding checklist (real
  // completion state) instead of a dead-end "no data" panel. After the SDK
  // step, setup is skippable: the dashboard renders with a compact banner as
  // the re-entry point. `?onb=1` forces the first-run surface for demos;
  // `?onb=reset` additionally wipes the stored onboarding flags.
  const { workspaceId } = useAuth();
  const [params] = useSearchParams();
  const onbParam = params.get("onb");
  const [onbSkipped, setOnbSkipped] = useState(
    () => onbStore.get(workspaceId, "skipped") === "1",
  );
  const [onbDismissed, setOnbDismissed] = useState(
    () => onbStore.get(workspaceId, "dismissed") === "1",
  );
  useEffect(() => {
    if (onbParam === "reset") {
      onbStore.reset(workspaceId);
      setOnbSkipped(false);
      setOnbDismissed(false);
    }
  }, [onbParam, workspaceId]);
  const showEmpty =
    !!onbParam || empty || (!!countsData && countsData.recordings === 0);
  if (showEmpty && !onbSkipped) {
    return (
      <div className="wrap">
        <OnboardingChecklist
          recordings={countsData?.recordings ?? 0}
          funnels={countsData?.funnels ?? 0}
          onSkip={() => setOnbSkipped(true)}
        />
      </div>
    );
  }
  const showOnbBanner = showEmpty && onbSkipped && !onbDismissed;

  const liveCount = liveData?.count ?? countsData?.live ?? 142;
  const lastEvent = countsData?.lastEventAt
    ? relShort(countsData.lastEventAt)
    : null;

  return (
    <div
      className={"ox-page" + (drawer && drawer !== "ask" ? " ox-blurred" : "")}
    >
      {/* ── 1 · Context line — always the first thing on the page ───────── */}
      <header className="ox-head">
        <h1>Overview</h1>
        <span className="ox-env">Production</span>
        {lastEvent && <span className="ox-upd">Updated {lastEvent}</span>}
        <div className="ox-head-r">
          <span className="ox-live" title="Users active right now">
            {/* Two reads can answer this (the live poll or the shared counts);
                it only stands in while NEITHER has, so the first one home wins.
                On an error both fall through to the existing fallback rather
                than shimmering forever. */}
            <b>
              {liveLoading && countsLoading ? (
                <SkText w={28} h={10} />
              ) : (
                <NumberFlow value={liveCount} format={{ useGrouping: true }} />
              )}
            </b>{" "}
            live
          </span>
          <DatePicker
            value={rangeLabel}
            onChange={setRangeLabel}
            align="right"
          />
          {/* Export button — hidden from the dashboard header per request.
          <button
            className="btn"
            onClick={() => toast && toast("Export started", { kind: "ok" })}
          >
            <Icon name="download" size={13} /> Export
          </button>
          */}
          {/* Replayfy AI toggle — hidden from the dashboard header per request.
              To restore: un-comment this block AND re-add `setAi` to the
              `useAiMode()` destructuring above (the toggle is the only caller).
          <button
            className={"ox-ai" + (ai ? " on" : "")}
            role="switch"
            aria-checked={ai}
            title={
              ai
                ? "Replayfy AI is on — analyst layer, confidence and Ask"
                : "Replayfy AI is off — deterministic analytics only"
            }
            onClick={() => {
              const next = !ai;
              setAi(next);
              if (toast) {
                if (next)
                  toast(
                    "Replayfy AI is on — signals, storyline and Ask are live",
                    { kind: "ok" },
                  );
                else toast("Replayfy AI is off — deterministic analytics only");
              }
            }}
          >
            <Icon name="spark" size={13} fill={ai} /> Replayfy AI{" "}
            <span className="ox-ai-tg" />
          </button>
          */}
        </div>
      </header>

      {/* Setup was skipped after the SDK step — a compact re-entry point sits
          right under the header (which always leads the page) until every
          step is done or it's dismissed. */}
      {showOnbBanner && (
        <OnboardingChecklist
          compact
          recordings={countsData?.recordings ?? 0}
          funnels={countsData?.funnels ?? 0}
          onDismiss={() => {
            onbStore.set(workspaceId, "dismissed", "1");
            setOnbDismissed(true);
          }}
        />
      )}

      {/* ── 2 · Pulse + featured story (analyst storyline / needs-attention) ── */}
      <PulseBand
        cells={pulseCells}
        trailing={
          <OverviewStory
            ai={ai}
            story={story}
            aiStory={aiStory}
            confPct={confPct}
            signals={signals}
            count={signalCount}
            /* Both the storyline (AI on) and the incident rows (AI off) come
               from /overview; only the confidence chip reads /intelligence. */
            loading={overviewLoading}
            confLoading={intelLoading}
            onConfidence={() => setDrawer("confidence")}
            onAllSignals={() => setDrawer("insights")}
            onAct={runSignalAction}
          />
        }
      />

      {/* ── 3 · Activity ───────────────────────────────────────────────── */}
      <ActivitySection
        metricsApi={metricsData}
        loading={metricsLoading}
        headerTime={rangeLabelToTimeKey(rangeLabel)}
        headerCustom={custom ?? undefined}
      />

      {/* ── 4 · Conversion — tracks the pinned funnel ──────────────────── */}
      <div id="ox-conversion" style={{ scrollMarginTop: 12 }}>
        <ConversionSection
          periodNote={periodNote}
          conv={conv}
          funnel={pinnedFunnel ? (funnelCompute ?? null) : null}
          funnelsReady={funnelList !== undefined}
          hasPinned={!!pinnedFunnel}
          loading={conversionLoading}
          onOpenFunnels={(id) => navigate(id ? `/funnels/${id}` : "/funnels")}
        />
      </div>

      {/* ── 5 · Stability ──────────────────────────────────────────────── */}
      <div id="ox-stability" style={{ scrollMarginTop: 12 }}>
        <StabilitySection
          ai={ai}
          stats={crashStats}
          crashes={crashes}
          crashHeadline={crashHeadline}
          releases={releasesData}
          releasesLoading={releasesLoading}
          statsLoading={metricsLoading}
          crashesLoading={overviewLoading}
          onAllCrashes={() => setDrawer("crashes")}
          onOpenCrashlytics={() => navigate("/crashlytics")}
        />
      </div>

      {/* ── 6 · Worth watching ─────────────────────────────────────────── */}
      <WatchlistSection
        rows={watchRows}
        windowLabel={rangeLabel.toLowerCase()}
        loading={overviewLoading}
        onAll={() => navigate("/recordings")}
        onRow={(w) => navigate(w.id ? `/recordings/${w.id}` : "/recordings")}
      />

      {/* ── 7 · Segments ───────────────────────────────────────────────── */}
      <SegmentsSection
        totalSessions={seshCur}
        data={segData}
        loading={overviewLoading || segmentsLoading}
        onBreakdown={(dim) => {
          setBreakdownDim(dim);
          setDrawer("breakdown");
        }}
        onRowOpen={(dim, row) => {
          // Deep-link a segment row to the filtered recordings list. Country
          // filters by the raw ISO code (row.raw), not the display name.
          const key =
            dim === "Platform"
              ? "platform"
              : dim === "Browser"
                ? "browser"
                : "country";
          const val = (row.raw ?? row.label).trim();
          if (!val || val === "Other" || val === "Unknown") return;
          const q = /\s/.test(val) ? `${key}:"${val}"` : `${key}:${val}`;
          navigate(`/recordings?q=${encodeURIComponent(q)}`);
        }}
      />

      {/* ── Drawers (always mounted for slide-in/out) ──────────────────── */}
      <V3Drawer
        open={drawer === "health"}
        onClose={() => setDrawer(null)}
        title="Experience score"
        subtitle={
          ai ? "How Replayfy AI scored today" : "How this score is calculated"
        }
        width={520}
        footer={
          <>
            {ai && (
              <Icon name="spark" size={13} style={{ color: "var(--accent)" }} />
            )}
            <span style={{ fontSize: "var(--text-xs)", color: "var(--t3)" }}>
              {ai
                ? "Recomputed hourly by Replayfy AI"
                : "Recomputed hourly from replay telemetry"}
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setDrawer(null)}>
              Close
            </button>
          </>
        }
      >
        <div className="hd-score">
          <div className="hd-big">{score ?? "—"}</div>
          <div className="hd-trend">
            <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-semibold)" }}>
              {score == null
                ? "No sessions in this window"
                : score >= 80
                  ? "Healthy"
                  : score >= 60
                    ? "Degraded"
                    : "At risk"}{" "}
              {score != null && healthDelta != null && (
                <span className={"delta " + (healthDelta >= 0 ? "up" : "down")}>
                  {healthDelta >= 0 ? "▲" : "▼"} {Math.abs(healthDelta)} vs prev
                  30d
                </span>
              )}
            </div>
            <div style={{ marginTop: "var(--sp-8)" }}>
              <MiniSpark
                data={healthTrend}
                color="var(--accent)"
                w={220}
                h={34}
              />
            </div>
          </div>
        </div>
        <div className="hd-lbl">Contributors</div>
        {subsys.length === 0 && (
          <div className="hd-row">
            <div>
              <div className="hd-why">
                No subsystem data in this window yet.
              </div>
            </div>
          </div>
        )}
        {subsys.map((s) => {
          // "—" = no measured movement (pulse fallback carries no delta) → a
          // neutral gray marker, never a green ▲ implying an improvement.
          const flat = !s.d || s.d === "—";
          const neg = s.d.startsWith("−");
          const arColor = flat
            ? "var(--t4)"
            : neg
              ? "var(--red)"
              : "var(--green)";
          return (
            <div className="hd-row" key={s.n}>
              <span className="hd-ar" style={{ color: arColor }}>
                {flat ? "•" : neg ? "▼" : "▲"}
              </span>
              <div>
                <div className="hd-n">{s.n}</div>
                {s.why && <div className="hd-why">{s.why}</div>}
              </div>
              <span className="hd-bar">
                <i style={{ width: s.v + "%", background: s.c }} />
              </span>
              <span className="hd-vv">
                {s.v}{" "}
                <span style={{ color: arColor, fontSize: "var(--text-2xs)" }}>{s.d}</span>
              </span>
            </div>
          );
        })}
        <div className="hd-method">
          <Icon name={ai ? "spark" : "chip"} size={15} className="hm-ic" />
          {ai ? (
            <div className="hm-t">
              <b>How this is calculated.</b> Replayfy AI weights four subsystems
              — Stability (30%), Conversion (30%), Performance (25%) and
              Engagement (15%) — normalized against your trailing 30-day
              baseline. Each contributor above is a measured rate; the model
              weights and narrates them, it does not invent the numbers.
            </div>
          ) : (
            <div className="hm-t">
              <b>How this is calculated.</b> A fixed weighted formula —
              Stability (30%), Conversion (30%), Performance (25%) and
              Engagement (15%) — normalized against your trailing 30-day
              baseline. No model output is involved; every contributor above is
              a measured rate.
            </div>
          )}
        </div>
      </V3Drawer>

      <V3Drawer
        open={drawer === "confidence"}
        onClose={() => setDrawer(null)}
        title={`Why ${confPct ?? "—"}% confidence`}
        subtitle="Replayfy AI reasoning"
        width={480}
        footer={
          <>
            <Icon name="spark" size={13} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--t3)" }}>
              Replayfy AI reasoning
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setDrawer(null)}>
              Close
            </button>
          </>
        }
      >
        <div className="cf-hero">
          <span className="cf-pct">{confPct ?? "—"}%</span>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--t2)", lineHeight: "var(--lh-normal)" }}>
            Confidence reflects how many independent measured subsystems point
            the same way and how large the observed move is — it rises when
            signals converge and falls when they diverge or are sparse.
          </div>
        </div>
        {confFactors.map((f) => (
          <div className="cf-row" key={f.n}>
            <span className="cf-ic">
              <Icon name={f.ic} size={13} />
            </span>
            <div>
              <div className="cf-n">{f.n}</div>
              <div className="cf-d">{f.d}</div>
            </div>
            <span
              className="cf-w"
              style={{
                color: f.w === "Strong" ? "var(--green)" : "var(--amber)",
              }}
            >
              {f.w}
            </span>
          </div>
        ))}
        <div className="hd-method">
          <Icon name="spark" size={15} className="hm-ic" />
          <div className="hm-t">
            <b>Methodology.</b> Replayfy AI cross-references replay sessions,
            deployment timing, funnel deltas, crash groups and network traces.
            When multiple independent signals converge on one release,
            confidence rises. Divergent or sparse signals lower it.
          </div>
        </div>
      </V3Drawer>

      {/* The Signals drawer is its own expanding investigation workspace — the
          signals list and the deterministic investigation are two panels of one
          surface, not a drawer stacked on a drawer. */}
      <SignalsWorkspace
        open={drawer === "insights"}
        onClose={() => setDrawer(null)}
        signals={signals}
        ai={ai}
        onAct={runSignalAction}
        onCreateAlert={createSignalAlert}
        busyFunnelId={funnelBusyId}
        renderInvestigation={(s, ai) => (
          <SignalInvestigation signal={s} ai={ai} />
        )}
      />

      <V3Drawer
        open={drawer === "crashes"}
        onClose={() => setDrawer(null)}
        title="All crashes"
        subtitle={`${crashes.length} ${crashes.length === 1 ? "group" : "groups"} · all platforms · ${rangeLabel.toLowerCase()}`}
        width={540}
        footer={
          <>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--t3)" }}>
              Sorted by impact
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setDrawer(null)}>
              Close
            </button>
            <button className="btn primary">
              <Icon name="download" size={13} /> Export
            </button>
          </>
        }
      >
        <CrashAllList
          onShowRecordings={(c) => {
            // c._id is the real Issue id (adapter) — the recordings list
            // filters by ?issue=<id> (Recordings reads sp.get("issue")).
            setDrawer(null);
            navigate(`/recordings?issue=${c._id}`);
          }}
        />
      </V3Drawer>

      <V3Drawer
        open={drawer === "breakdown"}
        onClose={() => setDrawer(null)}
        title={`${breakdownDim} breakdown`}
        subtitle={`Share of sessions · ${rangeLabel.toLowerCase()}`}
        width={540}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => setDrawer(null)}>
              Close
            </button>
          </>
        }
      >
        {breakdownRows.length ? (
          <table>
            <thead>
              <tr>
                <th>{breakdownDim}</th>
                <th className="num">Share</th>
                <th className="num">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {breakdownRows.map((r) => (
                <tr key={r.label}>
                  <td style={{ fontWeight: "var(--fw-semibold)" }}>
                    {r.flag && (
                      <span style={{ marginRight: "var(--sp-8)" }}>{r.flag}</span>
                    )}
                    {r.label}
                  </td>
                  <td className="num">{r.v}%</td>
                  <td className="num">
                    {(
                      r.sessions ?? Math.round((breakdownTotal * r.v) / 100)
                    ).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="ox-none">
            <Icon name="globe" size={14} /> No {breakdownDim.toLowerCase()} data
            reported yet for this workspace.
          </div>
        )}
      </V3Drawer>
    </div>
  );
}
