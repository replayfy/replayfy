/* ============================================================================
   overview.api.tsx — real backend contract for the Overview page (open core).

   Holds the Dashboard response DTOs + `adapt*` mappers that fold real API
   payloads into the existing design fixtures WITHOUT any markup change (same
   shapes the frozen sections already render). Every mapper reads ONLY fields
   the backend actually returns; anything it doesn't expose is left as the
   fixture value with a TODO(api).

   The agentic Ask assistant that used to live at the top of this file is
   Enterprise Edition and now lives in src/ee/ask/ask.api.tsx.
   ========================================================================== */
import type { MaterializedMetric } from "./overview.series";
import { fmtCount } from "./overview.series";
import type { Subsys, Signal, Crash } from "./overview.data";
import type { ReactNode } from "react";

/* ==========================================================================
   2 · DASHBOARD DTOs — the value INSIDE the `{ ok, data }` envelope
   ========================================================================== */
export type LiveResp = { count: number };
export type CountsResp = {
  recordings: number;
  playlists: number;
  funnels: number;
  users: number;
  comments: number;
  live: number;
  lastEventAt: string | null;
  lastEventDomain: string | null;
};

export type PulseSignals = {
  sessions: number;
  frustrated: number;
  backendFail: number;
  slowApi: number;
  formAbandon: number;
  navLoop: number;
  crashes: number;
  convSuccess: number;
  convFailure: number;
};
export type OverviewPulse = {
  // null when the window has no sessions — health is UNMEASURABLE, not 0/100.
  // The server stopped scoring an empty window as a perfect 100; render null as
  // "—", never coerce it (`health ?? 100` reintroduces the old lie).
  health: number | null;
  healthDelta: number | null; // null unless both compared windows are measurable
  sessions: number;
  signals: PulseSignals;
  signalsPrev: PulseSignals;
  subScores: {
    stability: number;
    performance: number;
    ux: number;
    conversion: number;
  } | null; // null when no sessions
  spark: Array<number | null>; // null entries = days with no data (gaps, not 100)
};
export type OverviewStoryline = {
  incidentId: number;
  title: string;
  signalType: string;
  polarity: "NEGATIVE" | "POSITIVE";
  screen: string | null;
  sessionCount: number;
  userCount: number;
  deltaPctX100: number;
  factsText: string | null;
  causeText: string | null;
} | null;
export type IncidentSuggested = { kind: string; label: string };
export type IncidentLinkedIssue = {
  id: number;
  fingerprint: string;
  title: string;
  occurrences: number;
  users: number;
  sessions: number;
  recording: string | null;
};
export type Incident = {
  id: number;
  title: string;
  signalType: string;
  polarity: "NEGATIVE" | "POSITIVE";
  severity: "critical" | "high" | "opportunity";
  screen: string | null;
  rank: number;
  sessionCount: number;
  userCount: number;
  deltaPctX100: number;
  impactCents: number;
  firstSeenAt: string;
  lastSeenAt: string;
  element: string | null;
  platform: string | null;
  release: string | null;
  likelyCause: string;
  recommendedAction: string;
  suggestedActions: IncidentSuggested[];
  linkedIssue: IncidentLinkedIssue | null;
  signals: { type: string; count: number }[];
  topSessions: {
    publicId: string;
    score: number;
    platform: string;
    userName: string | null;
    userEmail: string | null;
  }[];
};
export type OverviewResp = {
  range: string;
  /** All-time recorded-session total from the real-time WorkspaceStats counter —
   *  matches the Recordings header + sidebar, unlike the windowed pulse.sessions. */
  sessionsTotal: number;
  pulse: OverviewPulse;
  storyline: OverviewStoryline;
  incidents: { problems: Incident[]; opportunities: Incident[] };
  topFailedJourneys: {
    label: string;
    sessionCount: number;
    failCount: number;
    failRate: number;
    exampleSessionId: number | null;
  }[];
  topSuccessfulJourneys: {
    label: string;
    sessionCount: number;
    successCount: number;
    successRate: number;
    exampleSessionId: number | null;
  }[];
  worstSessions: {
    publicId: string;
    sessionScore: number;
    rageCount: number;
    errorCount: number;
    deadCount: number;
    startUrl: string;
    platform: string;
    browser: string | null;
    os: string | null;
    osVersion: string | null;
    device: string | null;
    deviceModel: string | null;
    country: string | null;
    flag: string | null;
    userName: string | null;
    userInitials: string | null;
  }[];
};

export type MetricKey =
  | "dau"
  | "wau"
  | "mau"
  | "activeUsers"
  | "sessions"
  | "avgDuration"
  | "conversionRate"
  | "retention"
  | "newUsers"
  | "returningUsers"
  | "anrRate"
  | "crashes";
export type ApiMetric = {
  key: MetricKey;
  label: string;
  value: number;
  prev: number;
  deltaPct: number;
  format: "int" | "duration" | "pct";
  goodDir: "up" | "down";
  spark: number[];
};
export type MetricsSeriesPoint = {
  day: number;
  activeUsers: number;
  sessions: number;
  conversionRate: number;
  crashes: number;
};
export type MetricsResp = {
  range: string;
  series: MetricsSeriesPoint[];
  metrics: ApiMetric[];
};

export type SubScore = {
  key: string;
  label: string;
  scoreAbs: number;
  delta: number | null;
  present: boolean;
  weight: number;
  currentRate: number | null;
  baselineRate: number | null;
  detail: string;
};
export type IntelligenceResp =
  | { aiEnabled: false }
  | {
      aiEnabled: true;
      health: {
        composite: number;
        windowDays: number;
        subScores: Record<string, SubScore>;
      };
      storyline: null | {
        text: string;
        confidence: unknown;
        citations: unknown[];
        generatedAt: string;
      };
      healthExplanations: unknown;
      insights: WorkspaceInsight[];
    };
/** A WorkspaceInsight row as returned by /v1/dashboard/intelligence. The AI pass
 *  writes explanation/tags/actionKind + a ready deep link (actionHref); the
 *  numbers are copied from the deterministic incident/issue behind it. Older
 *  best-effort aliases (body/description/summary/action) kept for resilience. */
export type WorkspaceInsight = {
  id?: number | string;
  kind?: string;
  sourceKind?: string;
  sourceIncidentId?: number | null;
  sourceIssueId?: number | null;
  severity?: string;
  polarity?: string;
  title?: string;
  explanation?: string;
  confidence?: number;
  tags?: string[];
  actionKind?: string;
  actionRef?: string;
  actionHref?: string;
  createdAt?: string;
  signalType?: string;
  /** Impact numbers copied from the deterministic incident/issue behind the
   *  insight (kept fresh by the sweep). */
  sessionCount?: number;
  userCount?: number;
  deltaPctX100?: number;
  /** Live "resurfacing" activity for this insight's source over the server's
   *  recent window — how much it has fired in the last `windowMins`. Null when
   *  it hasn't fired recently (so the tag only marks what's happening NOW). */
  recent?: { count: number; users: number; windowMins: number } | null;
  // Legacy best-effort aliases (pre-Phase-3 shape).
  body?: string;
  description?: string;
  summary?: string;
  action?: string;
};

/** One slice of a breakdown (platform / browser / country / release). */
export type Breakdown = { value: string; sessions: number; pct: number };
/** GET /v1/dashboard/incidents/:id/investigation — the deterministic findings. */
export type InvestigationResp = {
  incident: {
    id: number;
    title: string;
    signalType: string;
    polarity: string;
    screen: string;
    element: string;
    status: string;
    sessionCount: number;
    userCount: number;
    deltaPctX100: number;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  breakdowns: {
    platforms: Breakdown[];
    browsers: Breakdown[];
    countries: Breakdown[];
    releases: Breakdown[];
  };
  relatedCrashes: Array<{
    id: number;
    title: string;
    errorType: string;
    isCrash: boolean;
    occurrences: number;
    sharedSessions: number;
  }>;
  correlated: Array<{
    id: number;
    title: string;
    signalType: string;
    polarity: string;
    sessionCount: number;
    deltaPctX100: number;
    sharedSessions: number;
  }>;
  similarHistorical: Array<{
    id: number;
    title: string;
    status: string;
    sessionCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
};

/** GET /v1/dashboard/incidents/issue/:id/investigation — forensic, no model. */
export type IssueInvestigationResp = {
  issue: {
    id: number;
    title: string;
    errorType: string;
    culprit: string;
    isCrash: boolean;
    behavioral: boolean;
    status: string;
    occurrenceCount: number;
    sessionCount: number;
    userCount: number;
    firstRelease: string;
    lastRelease: string;
    firstSeenAt: string;
    lastSeenAt: string;
    lastPublicId: string | null;
  };
  breakdowns: {
    platforms: Breakdown[];
    browsers: Breakdown[];
    countries: Breakdown[];
    releases: Breakdown[];
  };
  relatedIncidents: Array<{
    id: number;
    title: string;
    signalType: string;
    polarity: string;
    sessionCount: number;
    deltaPctX100: number;
    sharedSessions: number;
  }>;
  scopeCapped: boolean;
};

/** POST /v1/dashboard/incidents/:id/funnel — propose steps + create. */
export type IncidentFunnelResp =
  | { created: true; funnelId: number; name: string; steps: unknown[] }
  | { created: false; reason: string };

/* Incident-cause (Investigate button) + update (ack/resolve) response shapes. */
export type IncidentCauseResp = {
  available: boolean;
  reason?: "not_found" | "disabled" | "no_key" | "budget";
  cause: string | null;
  confidence?: "high" | "medium" | "low";
  model?: string | null;
  cached?: boolean;
};

/* The AI INVESTIGATION REPORT (POST /incidents/:id/report) — the richer
   successor to the one-line cause.

   Every field except `summary` and `confidence` is OPTIONAL, and that is the
   contract, not laziness: the server omits any section it could not ground in
   measured evidence, so an absent key means "we do not know" and the panel must
   render nothing for it. A section rendered as an empty heading would read as a
   finding of nothing, which is not the same claim. */
/** One cited piece of evidence: a server-verified ref key plus what it shows.
 *  The server drops any citation whose `ref` is not a literal key of the
 *  evidence payload, so a ref that arrives here is real by construction. */
export type ReportCitation = { ref: string; statement: string };

export type IncidentReport = {
  executiveSummary: string;
  confidence: "high" | "medium" | "low";
  rootCause?: string;
  supportingEvidence?: ReportCitation[];
  confidenceRationale?: string;
  recommendedFix?: string;
  potentialRisks?: string[];
  relatedRegressions?: ReportCitation[];
  nextInvestigation?: string;
};

export type IncidentReportResp = {
  /** Numeric Session.id -> publicId for the sessions the report cites.
   *  /recordings/:id resolves a PUBLIC id, so a numeric id makes a dead link. */
  sessionPublicIds?: Record<string, string>;
  available: boolean;
  reason?: "not_found" | "disabled" | "no_key" | "budget" | "credits" | "no_output";
  report: IncidentReport | null;
  model?: string | null;
  cached?: boolean;
};

/** DatePicker display label → the `range` token the endpoints accept
 *  (today|24h|7d|14d|30d|90d|365d). The dashboard endpoints resolve all of these
 *  (see dashboard.service range maps + common/range.ts). Custom absolute ranges
 *  are threaded separately via from/to; only a truly unknown label falls back to
 *  30d. */
export function rangeToken(label: string): string {
  switch (label) {
    case "Today":
      return "today";
    case "Yesterday":
      return "24h";
    case "Last 7 days":
      return "7d";
    case "Last 14 days":
      return "14d";
    case "Last 30 days":
      return "30d";
    case "Last 90 days":
    case "Last 3 months":
      return "90d";
    case "Last 12 months":
      return "365d";
    default:
      return "30d";
  }
}

/* ==========================================================================
   3 · Scaled-int helpers — deltaPctX100 (×100) / impactCents (cents)
   ========================================================================== */
export const pctFromX100 = (x: number): number => x / 100;
export const dollarsFromCents = (c: number): number => c / 100;

/* ==========================================================================
   4 · Rich-text segmenter — rebuild the frozen `<b>` / `.mono` emphasis from a
   plain API string WITHOUT restyling (only tokens present in the real text get
   wrapped; nothing is invented).
   ========================================================================== */
export type Seg = { kind: "text" | "em" | "mono"; s: string };

const SEG_PATTERNS: { kind: "em" | "mono"; re: RegExp }[] = [
  // latency arrows / durations: "180ms → 2.4s", "2.4s"
  { kind: "mono", re: /\d+(?:\.\d+)?\s?ms\s?(?:→|->)\s?\d+(?:\.\d+)?\s?s/gi },
  // semantic version: "v1.6.2" / "1.6.2"
  { kind: "mono", re: /\bv?\d+\.\d+(?:\.\d+)?\b/gi },
  // signed deltas & percentages: "down 8.4%", "up 12%", "▲ 3", "−9pt", "8.5%"
  {
    kind: "em",
    re: /(?:up|down)\s+\d+(?:\.\d+)?\s?(?:%|pt)?|[▲▼]\s?\d+(?:\.\d+)?\s?(?:%|pt)?|[+−-]?\d+(?:\.\d+)?\s?(?:%|pt)\b/gi,
  },
];

/** Split `text` into typed segments so the caller can wrap `em`/`mono` spans. */
export function segmentText(text: string): Seg[] {
  type Hit = { start: number; end: number; kind: "em" | "mono" };
  const hits: Hit[] = [];
  for (const { kind, re } of SEG_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index,
        end = m.index + m[0].length;
      // skip if overlapping an earlier (higher-priority) hit
      if (!hits.some((h) => start < h.end && end > h.start))
        hits.push({ start, end, kind });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  let cur = 0;
  for (const h of hits) {
    if (h.start > cur) out.push({ kind: "text", s: text.slice(cur, h.start) });
    out.push({ kind: h.kind, s: text.slice(h.start, h.end) });
    cur = h.end;
  }
  if (cur < text.length) out.push({ kind: "text", s: text.slice(cur) });
  return out.length ? out : [{ kind: "text", s: text }];
}

/** Render segments for a signals-feed title: `em`→`<b>` (bad-red), `mono`→`.mono`. */
export function renderSignalTitle(text: string): ReactNode {
  return segmentText(text).map((seg, i) => {
    if (seg.kind === "em")
      return (
        <b key={i} style={{ color: "var(--red)" }}>
          {seg.s}
        </b>
      );
    if (seg.kind === "mono")
      return (
        <span key={i} className="mono">
          {seg.s}
        </span>
      );
    return <span key={i}>{seg.s}</span>;
  });
}

/* ==========================================================================
   5 · Dashboard adapters — API payload → existing design fixtures
   ========================================================================== */

/** intelligence.health.subScores → hero + health-drawer contributor rows.
 *  Design SUBSYS = API health / Web vitals / Stability / Conversion (4 of the 5
 *  subsystems; Engagement is not shown in the frozen hero). Returns null when AI
 *  is off so the caller keeps the fixture. */
const SUBSYS_KEYS: { key: string; n: string }[] = [
  { key: "apiHealth", n: "API health" },
  { key: "webVitals", n: "Web vitals" },
  { key: "stability", n: "Stability" },
  { key: "conversion", n: "Conversion" },
];
function scoreColor(v: number): string {
  return v >= 85 ? "var(--green)" : v >= 70 ? "var(--amber)" : "var(--red)";
}
export function adaptSubsys(
  intel: IntelligenceResp | undefined,
): Subsys[] | null {
  if (!intel || intel.aiEnabled !== true || !intel.health?.subScores)
    return null;
  const src = intel.health.subScores;
  const rows: Subsys[] = [];
  for (const { key, n } of SUBSYS_KEYS) {
    const s = src[key];
    if (!s || s.present === false) continue;
    const v = Math.round(s.scoreAbs);
    const delta =
      s.delta == null
        ? "—"
        : (s.delta >= 0 ? "+" : "−") + Math.abs(Math.round(s.delta));
    rows.push({ n, v, c: scoreColor(v), d: delta, why: s.detail || "" });
  }
  return rows.length ? rows : null;
}

/** Deterministic fallback for the health-drawer contributor rows when the AI
 *  intelligence payload isn't available (AI off): the four measured subsystem
 *  scores from /overview's pulse. No per-subsystem delta/detail is exposed here,
 *  so the delta reads "—" (neutral) rather than an invented movement. Returns
 *  null when the window has no sessions (subScores === null) → empty state. */
const PULSE_SUBSYS_LABELS: {
  key: keyof NonNullable<OverviewPulse["subScores"]>;
  n: string;
}[] = [
  { key: "stability", n: "Stability" },
  { key: "performance", n: "Performance" },
  { key: "ux", n: "UX" },
  { key: "conversion", n: "Conversion" },
];
export function adaptPulseSubsys(
  pulse: OverviewPulse | undefined,
): Subsys[] | null {
  const ss = pulse?.subScores;
  if (!ss) return null;
  const rows: Subsys[] = [];
  for (const { key, n } of PULSE_SUBSYS_LABELS) {
    const v = Math.round(ss[key]);
    if (!Number.isFinite(v)) continue;
    rows.push({ n, v, c: scoreColor(v), d: "—", why: "" });
  }
  return rows.length ? rows : null;
}

/** The AI's chosen actionKind → the button label shown on a Signals row. Unknown
 *  kinds fall back to "Investigate" (hand off to Ask). Keep in sync with the
 *  backend WorkspaceInsight.actionKind vocabulary and runSignalAction's routing. */
const ACTION_LABEL: Record<string, string> = {
  investigate: "Investigate",
  view_sessions: "View sessions",
  open_crash: "Open crash",
  open_funnel: "Open funnel",
  create_funnel: "Create funnel",
};

/** intelligence.insights → the Signals feed rows (rich title rebuilt via segmenter). */
export function adaptSignals(
  intel: IntelligenceResp | undefined,
): Signal[] | null {
  if (
    !intel ||
    intel.aiEnabled !== true ||
    !Array.isArray(intel.insights) ||
    !intel.insights.length
  )
    return null;
  const sevMap: Record<string, Signal["sev"]> = {
    critical: "bad",
    high: "bad",
    negative: "bad",
    warning: "warn",
    medium: "warn",
    positive: "good",
    good: "good",
    low: "info",
    info: "info",
  };
  const icFor = (sev: Signal["sev"]): string =>
    sev === "bad"
      ? "warn"
      : sev === "warn"
        ? "cursor"
        : sev === "good"
          ? "globe"
          : "spark";
  /* WorkspaceInsight carries `polarity` but NO severity column, so the old
     `severity || polarity` fallback could only ever yield "negative" or
     "positive" — i.e. bad or good. The warning band was unreachable by
     construction, which is why a healthy workspace still read as all-Critical
     and the severity grouping carried no information.

     Grade negatives by MEASURED impact instead, using fields the row already
     has: the deterministic confidence band (95/70/40), user reach, session
     count and the size of the move. Critical is reserved for a confident,
     large, wide-reaching regression; the merely material is a warning. If the
     server ever does send a real severity, it still wins. */
  const bandOf = (ins: WorkspaceInsight): Signal["sev"] => {
    const explicit = sevMap[(ins.severity || "").toLowerCase()];
    if (explicit) return explicit;
    if ((ins.polarity || "").toLowerCase() === "positive") return "good";
    const users = ins.userCount ?? 0;
    const sessions = ins.sessionCount ?? 0;
    const move = Math.abs(ins.deltaPctX100 ?? 0) / 100;
    // Deliberately NOT gated on `confidence`: that is the 95/70/40 band, and it
    // only reaches 95 at sessionCount >= 9 AND a large move — so a negative
    // insight essentially never clears it, which made Critical unreachable and
    // simply relabelled the whole list as Warning. Grade on impact itself: a
    // severe move, or reach across enough people to matter.
    if (move >= 50 || users >= 15) return "bad";
    if (users >= 3 || sessions >= 5 || move >= 15) return "warn";
    return "info";
  };
  return intel.insights.map((ins): Signal => {
    const sev = bandOf(ins);
    const title = ins.title || ins.summary || ins.description || "Insight";
    return {
      sev,
      ic: icFor(sev),
      t: renderSignalTitle(title),
      d: ins.explanation || ins.body || ins.description || ins.summary || "",
      conf:
        typeof ins.confidence === "number"
          ? Math.round(
              ins.confidence <= 1 ? ins.confidence * 100 : ins.confidence,
            )
          : 80,
      tags: Array.isArray(ins.tags) ? ins.tags.slice(0, 3) : [],
      time: ins.createdAt ? relShort(ins.createdAt) : "recently",
      // The button label + behaviour come from the AI's chosen actionKind (with a
      // ready deep link the backend computed), not a fixed "Investigate".
      act: ACTION_LABEL[String(ins.actionKind)] || "Investigate",
      actionKind:
        typeof ins.actionKind === "string" ? ins.actionKind : undefined,
      actionHref:
        typeof ins.actionHref === "string" ? ins.actionHref : undefined,
      titleText: title,
      recent:
        ins.recent && typeof ins.recent.count === "number" && ins.recent.count > 0
          ? ins.recent
          : null,
      id: ins.id,
      incidentId: ins.sourceIncidentId ?? null,
      issueId: ins.sourceIssueId ?? null,
      sessions:
        typeof ins.sessionCount === "number" ? ins.sessionCount : undefined,
      users: typeof ins.userCount === "number" ? ins.userCount : undefined,
      // deltaPctX100 is ×100-scaled on the wire; the row shows a plain percent.
      deltaPct:
        typeof ins.deltaPctX100 === "number"
          ? Math.round(ins.deltaPctX100 / 100)
          : undefined,
    };
  });
}
/** overview.incidents → deterministic signal rows (AI mode OFF). Same Signal
 *  shape, but built ONLY from measured fields (counts, deltas, timestamps) —
 *  no likelyCause / confidence, which are the AI layer. */
export function adaptIncidentSignals(
  overview: OverviewResp | undefined,
): Signal[] | null {
  const inc = overview?.incidents;
  if (!inc) return null;
  const all = [...(inc.problems ?? []), ...(inc.opportunities ?? [])];
  if (!all.length) return null;
  const sevMap: Record<string, Signal["sev"]> = {
    critical: "bad",
    high: "warn",
    opportunity: "good",
  };
  return all
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((p): Signal => {
      const sev =
        sevMap[p.severity] ?? (p.polarity === "POSITIVE" ? "good" : "warn");
      const pct = pctFromX100(p.deltaPctX100);
      const parts = [
        p.sessionCount ? `${p.sessionCount.toLocaleString()} sessions` : null,
        p.userCount ? `${p.userCount.toLocaleString()} users` : null,
        pct
          ? `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}% vs previous period`
          : null,
        p.screen,
      ].filter(Boolean);
      const primary = p.suggestedActions?.[0];
      return {
        sev,
        ic: sev === "good" ? "globe" : "warn",
        t: renderSignalTitle(p.title),
        d: parts.join(" · "),
        conf: 0,
        tags: [p.platform, p.release].filter(Boolean) as string[],
        time: p.lastSeenAt ? relShort(p.lastSeenAt) : "recently",
        act: primary?.label || "View sessions",
        /* These rows ARE incidents, so they carry the incident's identity. It
           used to be dropped on the floor, which quietly broke two things: the
           investigation panel's correlated-incident links resolve by
           `incidentId` and so could never match, and "View sessions" had
           nothing to scope the Recordings list to. */
        id: p.id,
        incidentId: p.id,
        /* Only `view_sessions` is promoted to an actionKind. The drawer routes a
           row with NO actionKind to the investigation panel, which is the right
           default for these deterministic rows and the behaviour every other
           action keeps. But "View sessions" that opens an investigation instead
           of sessions is just a mislabelled button — so that one kind is named
           and handled. Clicking the row (rather than the button) still opens the
           investigation, so nothing becomes unreachable. */
        actionKind: primary?.kind === "view_sessions" ? "view_sessions" : undefined,
      };
    });
}

export function relShort(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/** overview.incidents.problems (crash incidents only) → Top-crashes rows. */
export function adaptCrashes(
  overview: OverviewResp | undefined,
): Crash[] | null {
  const problems = overview?.incidents?.problems;
  if (!Array.isArray(problems)) return null;
  const crashy = problems.filter(
    (p) => p.linkedIssue || p.signalType === "crash_detected",
  );
  if (!crashy.length) return null;
  return crashy.slice(0, 5).map((p): Crash => {
    const li = p.linkedIssue;
    const pct = pctFromX100(p.deltaPctX100);
    const down = pct < 0;
    return {
      n: li?.title || p.title,
      s: p.element || p.likelyCause || "",
      p: [p.platform, p.release].filter(Boolean).join(" · ") || "—",
      c: li?.occurrences ?? p.sessionCount ?? 0,
      d: (pct >= 0 ? "+" : "−") + Math.abs(Math.round(pct)) + "%",
      down,
      note: p.likelyCause || p.recommendedAction || "",
      // TODO(api): per-crash daily sparkline not exposed on the incident payload.
      sp: [
        10,
        14,
        20,
        28,
        40,
        80,
        Math.max(1, li?.occurrences ?? p.sessionCount ?? 100),
      ],
    };
  });
}

/** Engagement tile override: map each design tile onto its backing API metric.
 *  Every tile now has a real field — DAU/WAU/MAU, New/Returning USER COUNTS, and
 *  the retention rate. Chart series/prev stay fixture-driven because the metrics
 *  endpoint exposes only a per-metric `spark` + a global day series, not
 *  per-metric-per-granularity series. */
const ENGAGEMENT_KEY_MAP: Record<string, MetricKey> = {
  dau: "dau",
  wau: "wau",
  mau: "mau",
  new: "newUsers",
  ret: "returningUsers",
  rtn: "retention",
};
/** A design tile carrying real values. `flat` mutes the delta (no baseline or
 *  no movement — never a green arrow on a zero); `liveSpark` replaces the
 *  fixture sparkline the moment real numbers take over, so the trend drawn
 *  always belongs to the number shown ([] = draw nothing). */
export type TileMetric = MaterializedMetric & {
  flat?: boolean;
  liveSpark?: number[];
};
export function overrideMetric(
  m: MaterializedMetric,
  api: MetricsResp | undefined,
): TileMetric {
  if (!api?.metrics) return m;
  const apiKey = ENGAGEMENT_KEY_MAP[m.key];
  if (!apiKey) return m; // TODO(api): no backend field for New / Returning tiles.
  const hit = api.metrics.find((x) => x.key === apiKey);
  if (!hit) return m;
  const display =
    hit.format === "pct" ? hit.value.toFixed(1) + "%" : fmtCount(hit.value);
  // Real numbers, real trend: the tile sparkline switches to the metric's own
  // spark (whatever its window); an absent spark draws nothing rather than
  // keeping a fixture trend under a live value.
  const liveSpark = Array.isArray(hit.spark) ? hit.spark : [];
  // No baseline (prev ≤ 0) or no movement → a quiet "—", never a green arrow
  // on a zero and never "▲ 100%" against an empty previous period.
  if (hit.prev <= 0 || (hit.value === 0 && hit.prev === 0)) {
    return { ...m, display, delta: "—", flat: true, liveSpark };
  }
  const dir: "up" | "down" = hit.deltaPct >= 0 ? "up" : "down";
  // The arrow (▲/▼ from `dir`) carries the sign — the text is always absolute.
  const delta =
    Math.abs(hit.deltaPct).toFixed(1) + (hit.format === "pct" ? "pt" : "%");
  const flat = Math.abs(hit.deltaPct) < 0.05;
  // Only the headline value/delta/direction/spark go live. The chart series
  // stay gran-aligned fixtures (no per-metric-per-granularity series yet).
  // TODO(api): expose per-metric per-granularity series/prev to make the chart live.
  return { ...m, display, delta: flat ? "0%" : delta, dir, flat, liveSpark };
}

/** metrics → the "8.5% end-to-end conversion · ▼2.7pt · vs 11.2%" headline. */
export function conversionHeadline(
  metrics: MetricsResp | undefined,
): { pct: string; deltaPt: string; dir: "up" | "down"; prev: string } | null {
  const m = metrics?.metrics?.find((x) => x.key === "conversionRate");
  if (!m) return null;
  const dir: "up" | "down" = m.deltaPct >= 0 ? "up" : "down";
  return {
    pct: m.value.toFixed(1) + "%",
    deltaPt: Math.abs(m.value - m.prev).toFixed(1) + "pt",
    dir,
    prev: m.prev.toFixed(1) + "%",
  };
}

/** metrics.crashes → the "Total crashes" stat tile [label, value, delta, dir]. */
export function crashTotalStat(
  metrics: MetricsResp | undefined,
): [string, string, string, string] | null {
  const m = metrics?.metrics?.find((x) => x.key === "crashes");
  if (!m) return null;
  const dir = m.deltaPct >= 0 ? "up" : "down"; // more crashes = bad, design colours 'down' red
  return [
    "Total crashes",
    fmtCount(m.value),
    (m.deltaPct >= 0 ? "+" : "") + Math.round(m.deltaPct) + "%",
    dir === "up" ? "down" : "up",
  ];
}

/** metrics.anrRate → the "ANR rate" stat tile [label, value, delta, tone]. Only
 *  present when the workspace had mobile sessions in the window (the backend
 *  omits the metric otherwise), so a null here means "no mobile data" → no tile.
 *  ANR rising is bad, so a rise colours red ("down"), a fall green ("up"). */
export function anrRateStat(
  metrics: MetricsResp | undefined,
): [string, string, string, string] | null {
  const m = metrics?.metrics?.find((x) => x.key === "anrRate");
  if (!m) return null;
  const dpt = m.value - m.prev;
  const tone = Math.abs(dpt) < 0.005 ? "flat" : dpt > 0 ? "down" : "up";
  const delta =
    Math.abs(dpt) < 0.005
      ? "—"
      : (dpt > 0 ? "+" : "−") + Math.abs(dpt).toFixed(2) + "pt";
  return ["ANR rate", m.value.toFixed(2) + "%", delta, tone];
}

/** metrics.series → real daily crashes array for the Crashlytics chart. */
export function crashesSeries(
  metrics: MetricsResp | undefined,
): number[] | null {
  const s = metrics?.series;
  if (!Array.isArray(s) || s.length < 2) return null;
  return s.map((p) => p.crashes || 0);
}
