/* Funnels fixtures + backend vocabulary — future API-swap point.
   NOTE: this file carries JSX (REASONS uses fragments verbatim), so it is a
   .tsx module; components import it as "./funnels.data" (extension resolved). */
import type { ReactNode } from "react";
import { relTime } from "@/lib/format";

/* ── domain types ── */
export type FnStep = {
  kind: string;
  matchType: string;
  value: string;
  cur: number;
  /** Time to reach this step from the previous one (ms), carried from compute.
   *  Null on step 0 / empty sample; `reachN` is the sample size. */
  p50Reach?: number | null;
  p95Reach?: number | null;
  reachN?: number;
  target?: string;
  caseSensitive?: boolean;
  negate?: boolean;
  regex?: boolean;
  ignoreQuery?: boolean;
  _props?: unknown[];
};
export type FnKindDef = {
  id: string;
  label: string;
  ic: string;
  field: string;
};
export type FnFilter = { key: string; op: string; val: string };
export type FnSettings = {
  window: string;
  order: string;
  scope: string;
  repeat: string;
  firstOcc: boolean;
  unique: boolean;
};
export type FnReason = { c: string; t: ReactNode; l: string };
export type FnGroup = { title: string; keys: [string, string][] };
export type FnListItem = {
  id: number;
  name: string;
  desc: string;
  steps: number;
  sessions: number;
  conv: number;
  trend: number;
  updated: string;
  mine?: boolean;
  shared?: boolean;
  recent?: boolean;
  archived?: boolean;
  /** The assistant created this funnel → shows the "Created with Replayfy AI" badge. */
  createdByAi?: boolean;
};

/* ── backend contracts (GET /v1/funnels, /v1/funnels/:id/compute) ──
   Shapes mirror FunnelsService.toSummary + FunnelsService.compute exactly. */
export type ApiFunnelStep = {
  name: string;
  kind?: string;
  matchType: string;
  value: string;
};
/** GET /v1/funnels item + GET /v1/funnels/:id (FunnelsService.toSummary). */
export type ApiFunnel = {
  id: number;
  name: string;
  description: string | null;
  steps: ApiFunnelStep[];
  windowDays: number;
  /** The saved segment, or null. Same shape serializeFilters produces / the
   *  compute endpoints accept — read back to rebuild the builder's chips. */
  filter: Record<string, unknown> | null;
  pinned: boolean;
  /** True when created by the assistant (agent `funnel.create`) — provenance only. */
  createdByAi: boolean;
  owner: { id: number; name: string | null; email: string } | null;
  createdAt: string;
  updatedAt: string;
};
/** GET /v1/funnels/:id/compute step (windowFunnel per-stage row). */
export type ApiFunnelComputeStep = {
  index: number;
  name: string;
  kind: string;
  matchType: string;
  value: string;
  count: number;
  conversionPct: number;
  stepConversionPct: number;
  dropOffPct: number;
  avgTimeToReachMs: number;
  /** Time to reach this step from the PREVIOUS step (ms) — real now (was a
   *  hardcoded 0). Null on step 0 or when no unit was measured; `timeSampleSize`
   *  is how many units the delta was measured over. */
  medianTimeToReachMs?: number | null;
  p95TimeToReachMs?: number | null;
  timeSampleSize?: number;
};
/** GET /v1/funnels/:id/compute response (FunnelsService.compute). Carries the
 *  funnel name + fully-resolved steps + counts in ONE call, so the detail page
 *  needs only this single per-funnel compute (never a loop — avoids N+1). */
export type ApiFunnelCompute = {
  funnelId: number | null;
  name: string | null;
  windowDays: number;
  metric: "session" | "user";
  startedFunnel: number;
  overallConversionPct: number;
  avgTimeToConvertMs: number;
  /** Entry→last-step time for converters (ms) — real now (was 0). Null when no
   *  one converted; `convertTimeSampleSize` is the sample size. */
  medianTimeToConvertMs?: number | null;
  p95TimeToConvertMs?: number | null;
  convertTimeSampleSize?: number;
  totalSessions: number;
  steps: ApiFunnelComputeStep[];
  /** Per-step list of internal session ids that REACHED that step (session
   *  metric only; up to ~200 each). Powers the "View sessions" drill-down. */
  dropOffSessionIds?: number[][];
  insights?: {
    entered: number;
    dropped: number;
    totalDropDueToIssues: number;
    significant: Array<{
      type: string;
      title: string;
      affectedSessions: number;
      conversionImpactPct: number;
      lostConversions: number;
      significant: boolean;
    }>;
  };
};

/** POST /v1/funnels/timeline point (FunnelsService.computeTimeline). One
 *  per day in the window; `conversionPct` drives the "Conversion over time"
 *  line chart, `started`/`converted` are the raw daily counts. */
export type ApiFunnelTimelinePoint = {
  ts: string;
  conversionPct: number;
  started: number;
  converted: number;
};
export type ApiFunnelTimeline = {
  funnelId: number | null;
  windowDays: number;
  points: ApiFunnelTimelinePoint[];
};

/** POST /v1/funnels/breakdown bucket (FunnelsService.breakdown). One per
 *  dimension value (device/country/…), capped by `topN`. */
export type ApiFunnelBreakdownBucket = {
  value: string;
  totalSessions: number;
  startedFunnel: number;
  converted: number;
  overallConversionPct: number;
  steps: {
    index: number;
    name: string;
    count: number;
    conversionPct: number;
  }[];
};
export type ApiFunnelBreakdown = {
  funnelId: number | null;
  name: string | null;
  windowDays: number;
  dimension: string;
  metric: "session" | "user";
  buckets: ApiFunnelBreakdownBucket[];
};

/** API funnel (list summary) → the design's FnListItem row.
 *  conv/sessions/trend are NOT on the list summary — they only come from the
 *  per-funnel compute, which we must NOT call in a loop over the list (N+1 is
 *  forbidden). They stay neutral (0) here; the detail page shows
 *  the real numbers via a single Funnels.compute for the one opened funnel. */
export function adaptFunnel(f: ApiFunnel): FnListItem {
  return {
    id: f.id,
    name: f.name,
    desc: f.description || "",
    steps: Array.isArray(f.steps) ? f.steps.length : 0,
    // TODO(api): needs batch funnel compute (N+1 forbidden here) — keep neutral.
    conv: 0,
    // TODO(api): needs batch funnel compute (N+1 forbidden here) — keep neutral.
    sessions: 0,
    // TODO(api): trend needs a prior-period compute; not on the list summary.
    trend: 0,
    updated: relTime(f.updatedAt),
    // TODO(api): backend has no mine/shared/recent/archived flags — defaulted false.
    mine: false,
    shared: false,
    recent: false,
    archived: false,
    createdByAi: f.createdByAi,
  };
}

/** compute steps → the FlowRiver/builder FnStep shape (cur = real session count). */
export function adaptComputeSteps(c: ApiFunnelCompute): FnStep[] {
  return (c.steps ?? []).map((s) => ({
    kind: s.kind || "page",
    matchType: s.matchType,
    value: s.value,
    cur: s.count,
  }));
}

/** builder FnStep[] → backend FunnelStep[] for create/preview. The backend
 *  requires a non-empty `name` + `value` per step; we synthesize a name from
 *  the step's value/kind (the design has no separate per-step name field). */
export function toBackendSteps(steps: FnStep[]): ApiFunnelStep[] {
  return steps.map((s) => ({
    name: (s.value || "").trim() || s.kind,
    kind: s.kind,
    matchType: s.matchType,
    value: s.value,
  }));
}

export const REASONS: FnReason[][] = [
  [
    {
      c: "err",
      t: (
        <>
          <b>2,140 sessions</b> rage-clicked “Start trial” before leaving —
          likely an unresponsive CTA.
        </>
      ),
      l: "View sessions",
    },
    {
      c: "info",
      t: (
        <>
          <b>61%</b> of drop-offs left within 4s of landing on /pricing.
        </>
      ),
      l: "View sessions",
    },
  ],
  [
    {
      c: "err",
      t: (
        <>
          <b>Android</b> users drop here 2.1× more than Web at the signup step.
        </>
      ),
      l: "Break down",
    },
  ],
  [
    {
      c: "warn",
      t: (
        <>
          <b>/api/signup</b> p95 latency hit 1.8s for sessions that abandoned
          here.
        </>
      ),
      l: "View sessions",
    },
  ],
  [
    {
      c: "warn",
      t: (
        <>
          <b>/api/checkout</b> p95 hit 2.4s for abandoners vs 410ms for
          converters.
        </>
      ),
      l: "View sessions",
    },
    {
      c: "err",
      t: (
        <>
          <b>312 sessions</b> hit a payment error at checkout.
        </>
      ),
      l: "View sessions",
    },
  ],
  [
    {
      c: "info",
      t: (
        <>
          Converters who reached /success — <b>study winning paths</b> to
          replicate them.
        </>
      ),
      l: "View sessions",
    },
  ],
];

/* ── real backend vocabulary (from legacy pages/Funnels.jsx) ── */
export const FN_KINDS: FnKindDef[] = [
  { id: "page", label: "Viewed page", ic: "doc", field: "URL" },
  { id: "click", label: "Clicked element", ic: "cursor", field: "Text" },
  { id: "event", label: "Custom event", ic: "spark", field: "Event" },
  { id: "screen", label: "Viewed screen", ic: "phone", field: "Screen" },
  { id: "tap", label: "Tapped element", ic: "cursor", field: "Text" },
];
export const FN_MATCH: [string, string][] = [
  ["contains", "contains"],
  ["equals", "is exactly"],
  ["startsWith", "starts with"],
  ["regex", "matches regex"],
];
export const FN_FGROUPS: FnGroup[] = [
  {
    title: "Path",
    keys: [
      ["startUrlContains", "Viewed page"],
      ["urlPath", "URL path"],
      ["referrerUrl", "Referrer"],
    ],
  },
  {
    title: "User",
    keys: [
      ["userId", "User ID"],
      ["anonymousId", "Anonymous ID"],
      ["plan", "Plan"],
      ["userAttr", "User attribute…"],
    ],
  },
  {
    title: "Technology",
    keys: [
      ["platform", "Platform"],
      ["device", "Device"],
      ["browser", "Browser"],
      ["browserVersion", "Browser version"],
      ["os", "Operating system"],
      ["osVersion", "Operating system version"],
    ],
  },
  {
    title: "Geography",
    keys: [
      ["country", "Country"],
      ["city", "City"],
      ["state", "State / region"],
    ],
  },
  {
    title: "Acquisition",
    keys: [
      ["utmSource", "UTM source"],
      ["utmMedium", "UTM medium"],
      ["utmCampaign", "UTM campaign"],
    ],
  },
  {
    title: "Session",
    keys: [
      ["minDurationMs", "Duration"],
      ["pageCount", "Page count"],
      ["errorCount", "Error count"],
      ["newReturning", "Visitor"],
      ["revId", "Build / rev"],
    ],
  },
  {
    title: "Issues",
    keys: [
      ["hasErrors", "Error"],
      ["hasRage", "Rage click"],
      ["hasDead", "Dead click"],
    ],
  },
];
export const FN_FLABEL: Record<string, string> = Object.fromEntries(
  FN_FGROUPS.flatMap((g) => g.keys),
);
export const FN_FKIND: Record<string, string> = {
  startUrlContains: "text",
  urlPath: "text",
  referrerUrl: "text",
  userId: "text",
  anonymousId: "text",
  plan: "text",
  platform: "enum",
  device: "enum",
  browser: "enum",
  browserVersion: "text",
  os: "enum",
  osVersion: "text",
  country: "country",
  city: "text",
  state: "text",
  utmSource: "text",
  utmMedium: "text",
  utmCampaign: "text",
  minDurationMs: "number",
  pageCount: "number",
  errorCount: "number",
  newReturning: "enum",
  revId: "text",
  hasErrors: "bool",
  hasRage: "bool",
  hasDead: "bool",
  userAttr: "text",
};
// Only the TRULY bounded dimensions carry a hardcoded value list. browser / os /
// device / plan are DELIBERATELY absent so the filter picker falls through to the
// live /v1/funnels/suggest autocomplete (real workspace values — Electron, Chrome
// Headless, Samsung Internet, …), instead of a fixed list that can't represent
// whatever browser a visitor actually used. platform (Web/iOS/Android) and
// newReturning stay fixed because they're a closed set with no suggest column.
export const FN_FVALUES: Record<string, string[]> = {
  platform: ["Web", "iOS", "Android"],
  newReturning: ["New", "Returning"],
  minDurationMs: ["10s", "30s", "1m", "3m", "5m"],
  hasErrors: ["true", "false"],
  hasRage: ["true", "false"],
  hasDead: ["true", "false"],
};
export const FN_COUNTRIES: [string, string][] = [
  ["United States", "🇺🇸"],
  ["Canada", "🇨🇦"],
  ["United Kingdom", "🇬🇧"],
  ["Germany", "🇩🇪"],
  ["France", "🇫🇷"],
  ["Spain", "🇪🇸"],
  ["Portugal", "🇵🇹"],
  ["Netherlands", "🇳🇱"],
  ["Belgium", "🇧🇪"],
  ["Switzerland", "🇨🇭"],
  ["Austria", "🇦🇹"],
  ["Sweden", "🇸🇪"],
  ["Norway", "🇳🇴"],
  ["Denmark", "🇩🇰"],
  ["Finland", "🇫🇮"],
  ["Ireland", "🇮🇪"],
  ["Italy", "🇮🇹"],
  ["Poland", "🇵🇱"],
  ["Czechia", "🇨🇿"],
  ["Greece", "🇬🇷"],
  ["Romania", "🇷🇴"],
  ["Ukraine", "🇺🇦"],
  ["Russia", "🇷🇺"],
  ["Turkey", "🇹🇷"],
  ["Brazil", "🇧🇷"],
  ["Mexico", "🇲🇽"],
  ["Argentina", "🇦🇷"],
  ["Chile", "🇨🇱"],
  ["Colombia", "🇨🇴"],
  ["Peru", "🇵🇪"],
  ["India", "🇮🇳"],
  ["Pakistan", "🇵🇰"],
  ["Bangladesh", "🇧🇩"],
  ["China", "🇨🇳"],
  ["Japan", "🇯🇵"],
  ["South Korea", "🇰🇷"],
  ["Taiwan", "🇹🇼"],
  ["Hong Kong", "🇭🇰"],
  ["Singapore", "🇸🇬"],
  ["Malaysia", "🇲🇾"],
  ["Indonesia", "🇮🇩"],
  ["Thailand", "🇹🇭"],
  ["Vietnam", "🇻🇳"],
  ["Philippines", "🇵🇭"],
  ["Australia", "🇦🇺"],
  ["New Zealand", "🇳🇿"],
  ["Nigeria", "🇳🇬"],
  ["Ghana", "🇬🇭"],
  ["Kenya", "🇰🇪"],
  ["South Africa", "🇿🇦"],
  ["Egypt", "🇪🇬"],
  ["Morocco", "🇲🇦"],
  ["United Arab Emirates", "🇦🇪"],
  ["Saudi Arabia", "🇸🇦"],
  ["Israel", "🇮🇱"],
  ["Qatar", "🇶🇦"],
];
export const FN_FICON: Record<string, string> = {
  startUrlContains: "doc",
  urlPath: "doc",
  referrerUrl: "globe",
  userId: "users",
  anonymousId: "hash",
  plan: "star",
  userAttr: "users",
  platform: "monitor",
  device: "phone",
  browser: "browser",
  browserVersion: "browser",
  os: "chip",
  osVersion: "chip",
  country: "globe",
  city: "pin",
  state: "pin",
  utmSource: "mega",
  utmMedium: "mega",
  utmCampaign: "mega",
  minDurationMs: "clock",
  pageCount: "pages",
  errorCount: "warn",
  newReturning: "users",
  revId: "chip",
  hasErrors: "warn",
  hasRage: "spark",
  hasDead: "x",
};
/* Per-GROUP filter accent (F1) — colours each filter's icon square so the
   palette reads as a colourful, categorised command menu instead of a wall of
   grey. `fg` tints the glyph, `tint` the square background (matched by group). */
export const FN_FGROUP_COLOR: Record<string, { fg: string; tint: string }> = {
  Path: { fg: "#0d9488", tint: "rgba(13,148,136,.10)" },
  User: { fg: "#5b5ceb", tint: "rgba(91,92,235,.10)" },
  Technology: { fg: "#7c3aed", tint: "rgba(124,58,237,.10)" },
  Geography: { fg: "#3b76b0", tint: "rgba(59,118,176,.10)" },
  Acquisition: { fg: "#c08a3e", tint: "rgba(192,138,62,.12)" },
  Session: { fg: "#64748b", tint: "rgba(100,116,139,.10)" },
  Issues: { fg: "#d2576a", tint: "rgba(210,87,106,.10)" },
};
/** field key → its group title, so the filter palette can resolve a field's
 *  group colour in O(1) (derived from FN_FGROUPS — single source of truth). */
export const FN_FGROUP_OF: Record<string, string> = Object.fromEntries(
  FN_FGROUPS.flatMap((g) => g.keys.map(([k]) => [k, g.title])),
);
export const FN_OPS: Record<string, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "doesn't contain",
  startsWith: "starts with",
  endsWith: "ends with",
  regex: "matches",
  gte: "≥",
  gt: ">",
  lte: "≤",
  lt: "<",
};
export const FN_TEXT_OPS: string[] = [
  "contains",
  "is",
  "isNot",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
];
export const FN_ENUM_OPS: string[] = ["is", "isNot"];
export const FN_NUM_OPS: string[] = ["gte", "gt", "lte", "lt"];
export const FN_BDIMS: [string, string][] = [
  ["platform", "Platform"],
  ["browser", "Browser"],
  ["os", "OS"],
  ["device", "Device"],
  ["country", "Country"],
  ["state", "State / region"],
  ["city", "City"],
  ["release", "Release"],
  ["referrer", "Referrer"],
  ["referrerDomain", "Referring domain"],
  ["channel", "Channel"],
  ["utmSource", "UTM source"],
  ["utmMedium", "UTM medium"],
  ["utmCampaign", "UTM campaign"],
];
export const FN_COMPARE: [string, string][] = [
  ["prev", "Previous period"],
  ["dev", "Desktop vs Mobile"],
  ["brw", "Chrome vs Safari"],
  ["ret", "New vs Returning"],
  ["plat", "Web vs iOS"],
];
export const FN_SEED: FnStep[] = [
  { kind: "page", matchType: "contains", value: "/pricing", cur: 18420 },
  { kind: "click", matchType: "contains", value: "Start trial", cur: 9240 },
  { kind: "page", matchType: "contains", value: "/signup", cur: 6180 },
  { kind: "page", matchType: "contains", value: "/checkout", cur: 3920 },
  { kind: "page", matchType: "contains", value: "/success", cur: 2540 },
];

/** Blank scaffold the "New funnel" builder opens with — a SINGLE empty
 *  page/contains row (matching legacy's default of one step,
 *  the funnel builder default `steps: [newStep(0)]`), so
 *  analysts start from one row and add steps rather than deleting extras.
 *  No prefilled values, no fabricated counts: the row is empty until the
 *  user types a value. */
export const FN_NEW_SEED: FnStep[] = [
  { kind: "page", matchType: "contains", value: "", cur: 0 },
];

export const FN_HUES: Record<string, string> = {
  Maria: "#5b5ceb",
  Devon: "#3f9468",
  Leah: "#c2599f",
  Omar: "#bd8638",
  Sam: "#3b76b0",
};
export const FN_SORTS: [string, string][] = [
  ["updated", "Last updated"],
  ["sessions", "Sessions"],
  ["conv", "Conversion rate"],
  ["name", "Name"],
];
