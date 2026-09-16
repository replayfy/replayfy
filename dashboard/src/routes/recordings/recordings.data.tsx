/* ============================================================================
   Recordings v2 — mock-data fixtures (future API-swap points).
   Extracted verbatim from the prototype. Typed for the TS port.
   NOTE: this sibling is `.tsx` (not `.ts`) because RV_CMTS holds JSX fragments.
   ========================================================================== */
import type { ReactNode } from "react";
import { relTime } from "@/lib/format";
import { resolveIdentity } from "@/lib/identity";
import { osLabel, countryName, flagEmoji } from "@/lib/device-format";

/* ---- sessions ---- */
export type RvSession = {
  id: string;
  name: string;
  /** The email, under the name. The API has always shipped it (ApiEndUserLite)
   *  and adaptSession used to drop it on the floor — which is why the row could
   *  only ever show a name, and why "put the email there" looked like an
   *  ordering problem rather than a missing field. */
  sub: string | null;
  initials: string | null;
  /** identify() avatar URL for the player-header chip, or null → initials glyph. */
  picture: string | null;
  /** Avatar colour seed — stable across identify(), never the label. */
  hueSeed: string;
  plan: string | null;
  live: boolean;
  st: string;
  plat: string;
  os: string;
  flag: string;
  loc: string;
  dur: string;
  /** Raw wall-clock session duration (ms). The player uses this as the timeline
   *  total so it doesn't stop at the rrweb DOM-activity span on an idle session. */
  durationMs?: number;
  /** Backend-confirmed web-replay availability (Session.hasFullSnapshot). Lets
   *  the player show a definitive "no replay" empty-state vs a perpetual loader. */
  hasReplay?: boolean;
  /** True when a replay EXISTED but was pruned by retention age-out — lets the
   *  player show "replay expired" instead of "no replay was captured". The
   *  session + its analytics live on; only the watchable frames are gone. */
  replayExpired?: boolean;
  errs: number;
  rage: number;
  /** Precomputed network request count (unpaginated) — for the Perf panel's
   *  "Total requests" stat. */
  net: number;
  when: string;
  url: string;
  anon?: boolean;
};

/* ---- investigation data (for the focused session c9d) ---- */
import type { RvTick } from "./player/playerTypes";

export type RvEvent = {
  t: string;
  kind: string;
  ev: string;
  target: string;
  res?: string;
  flag?: string;
  stack?: string;
  d?: [string, string][];
  /** Source event offsetMs — the shared key that lets a timeline marker and this
   *  row cross-highlight each other (see hoverSync). */
  key?: number;
};


/* 0 level (log|info|warn|err|debug) · 1 head line · 2 src · 3 repeat count ·
   4 stack / trailing message lines · 5 structured args · 6 offsetMs.
   4-6 are trailing-optional, so the RV_CONSOLE fixture below stays valid. */
export type RvConsole = [
  string,
  string,
  string,
  number,
  string?,
  unknown[]?,
  number?,
];


export type RvNet = {
  m: string;
  path: string;
  host: string;
  st: number;
  type: string;
  size: string;
  start: number;
  dur: number;
  timing: [string, number][];
  /* ---- the request-investigation detail (all optional, so the RV_NET design
     fixtures and the share view are unaffected) ---- */
  /** Full request URL as captured — host+path drops the scheme, and the
   *  GENERAL block prints the URL verbatim. */
  url?: string;
  /** Parsed failure reason, when the backend supplies one. */
  err?: string;
  /** Payload and Response are separate tabs; `payload` collapses them. */
  reqBody?: string | null;
  resBody?: string | null;
  /** NetworkInformation at request time ("4g · 100ms RTT"). */
  connEff?: string;
  connRtt?: number;
  reqH: [string, string][];
  resH: [string, string][];
  payload: string | null;
};



export type RvVital = [string, string, string, number[], string];


// mobile performance — correlated session lanes (legacy mobile SDK metrics)
export type RvMpeak = [string, string, string];


export type RvMlane = [string, string, number[], string, string];


export type RvThermal = [string, number];


// correlation markers on the runtime timeline (% of session)
export type RvPmark = [number, string, string];


// actionable long-task / slow-frame breakdown
export type RvLt = {
  tbt: string;
  n: number;
  max: number;
  rows: [string, number, string][];
};


// mobile-only: screen navigation timeline + crash reports
export type RvScreen = [string, string, string, number];

/* A native crash, projected from a kind="error" log row (see adaptCrashes).
   The signal number, faulting thread and faulting address the fixture used to
   show are absent from the SDK's wire type itself — ErrorEventData is
   { message, stack?, kind } — so they are not "not yet mapped", they are never
   captured. They are dropped rather than invented. App version is real but
   session-scoped, so the panel takes it as a prop off the session detail. */
export type RvCrash = {
  type: string;
  msg: string;
  t: string;
  stack: string;
  /** Offset from session start (ms) — the sort key when crashes, handled
   *  exceptions and UI freezes are merged into one time-ordered list. */
  atMs: number;
  /** Category for styling: an uncaught crash vs a caught error vs a UI freeze. */
  cat: "crash" | "exception" | "freeze";
};

export type RvPropRow = [string, string, number?];


export type RvSpan = [string, string, number, number, string, string, number];
export const RV_SPANS: RvSpan[] = [
  ["POST /api/checkout", "gateway", 0, 100, "root", "184ms", 0],
  ["auth.verifyToken", "auth-svc", 4, 14, "", "24ms", 1],
  ["cart.load", "cart-svc", 19, 22, "", "40ms", 1],
  ["payment.charge", "stripe", 43, 50, "err", "90ms", 1],
  ["db.tx.insert", "postgres", 60, 8, "slow", "14ms", 2],
  ["webhook.enqueue", "queue", 70, 6, "", "11ms", 2],
];

export type RvCmt = [string, string, ReactNode];


/* ---- timeline marks (positions are % of session) ---- */


export const RV_STTEXT: Record<number, string> = {
  200: "OK",
  304: "Not Modified",
  400: "Bad Request",
  404: "Not Found",
  500: "Internal Server Error",
  0: "Request timed out",
};

/* ============================================================================
   API layer — real backend shapes + adapters into the design fixtures above.
   Endpoints: GET /v1/sessions (list), /v1/sessions/:id (detail),
   /:id/timeline, /:id/console, /:id/network, /:id/comments, /:id/performance.
   Every adapter maps ONLY fields the backend actually returns; anything the
   backend doesn't expose is left as a fixture value or '—' with a TODO(api).
   ========================================================================== */

/* ---- shared small helpers ---- */
/** ms → clock. "4:12" under an hour, rolling to "1:40:50" once past 60 min (so a
 *  long session's clock never reads "100:50"). Used for the player clock and
 *  per-event timeline timestamps (a position within the session). For a
 *  session's total LENGTH label use rvDuration() ("1h 40m") instead. */
export function rvClock(ms: number): string {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return hr > 0 ? `${hr}:${two(min)}:${two(sec)}` : `${min}:${two(sec)}`;
}

/** ms → human session LENGTH that rolls into hours/days instead of piling up
 *  minutes: "45s", "5m 30s", "1h 40m", "2d 4h". A 100-minute session reads
 *  "1h 40m", not "100:50". Use for the session's duration label (list row,
 *  detail meta, share header) — NOT the player clock (that's rvClock, mm:ss). */
export function rvDuration(ms: number): string {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  if (total < 3600) return s ? `${m}m ${s}s` : `${m}m`;
  if (total < 86400) return m ? `${h}h ${m}m` : `${h}h`;
  return h ? `${d}d ${h}h` : `${d}d`;
}
function rvCap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
/** URL → pathname (RvFrame renders `loop.shop{url}`, so keep it path-shaped). */
function rvUrlPath(u: string | null | undefined): string {
  if (!u) return "/";
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u.startsWith("/") ? u : "/" + u;
  }
}
function rvSplitUrl(u: string | null | undefined): {
  host: string;
  path: string;
} {
  if (!u) return { host: "", path: "" };
  try {
    const url = new URL(u);
    return { host: url.host, path: (url.pathname || "/") + url.search };
  } catch {
    return { host: "", path: u };
  }
}

/* ---- GET /v1/sessions item (SessionsService.toSummary) ---- */
export type ApiEndUserLite = {
  id: number;
  distinctId: string | null;
  email: string | null;
  name: string | null;
  initials?: string | null;
  picture?: string | null;
  plan?: string | null;
  flag?: string | null;
  city?: string | null;
  country?: string | null;
  browser?: string | null;
  os?: string | null;
  osVersion?: string | null;
  device?: string | null;
  deviceModel?: string | null;
  timezone?: string | null;
  isOnline?: boolean;
};
export type ApiSession = {
  id: number;
  publicId: string;
  status: "LIVE" | "COMPLETED";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  pageCount: number;
  clickCount: number;
  tapCount?: number;
  rageCount: number;
  deadCount: number;
  errorCount: number;
  consoleCount?: number;
  consoleErrorCount?: number;
  networkCount?: number;
  /** Web-replay availability + rrweb frame count from the backend DTO. */
  hasReplay?: boolean;
  replayExpired?: boolean;
  frameCount?: number;
  commentCount?: number;
  startUrl: string | null;
  entryReferrer?: string | null;
  platform: string | null;
  sdkName?: string | null;
  sdkVersion?: string | null;
  appVersion?: string | null;
  appBuild?: string | null;
  bookmarked?: boolean;
  viewed?: boolean;
  userAgent?: string | null;
  viewport?: string | null;
  // The session's OWN device + geo. Present even when endUser is null (mobile
  // anonymous sessions), so the row renders device/country regardless.
  browser?: string | null;
  os?: string | null;
  osVersion?: string | null;
  device?: string | null;
  deviceModel?: string | null;
  city?: string | null;
  country?: string | null;
  flag?: string | null;
  endUser: ApiEndUserLite | null;
};
/**
 * The Recordings header count, as the list envelope reports it.
 * `capped` means `value` is a FLOOR — render "10,000+", never "10,000".
 */
export type RvTotal = { value: number; capped: boolean };

/**
 * Read `page.total` / `page.total_capped` off the list envelope.
 *
 * `page` is typed in api/client.ts, which does NOT declare these two keys — but
 * `request()` passes `body.page` through VERBATIM, so they are present at
 * runtime. This VALIDATES rather than asserts (`as Page & {total:number}` would
 * make an unchecked promise about a payload we don't control): a missing,
 * non-numeric or negative total yields null and the header shows no number at
 * all. That is the point — the bug being fixed was a header stating a figure
 * nothing had verified, and a reader that coerced junk to 0 would reprise it in
 * a quieter register.
 *
 * Returns null for "this response makes no claim about a total", which is
 * distinct from a claim of zero. Only /v1/sessions sends these keys; every other
 * list omits them and correctly reads as null here.
 */
export function readTotal(page: unknown): RvTotal | null {
  if (!page || typeof page !== "object") return null;
  const p = page as { total?: unknown; total_capped?: unknown };
  if (typeof p.total !== "number" || !Number.isFinite(p.total)) return null;
  if (p.total < 0) return null;
  return { value: p.total, capped: p.total_capped === true };
}

/** GET /v1/sessions/:publicId — detail adds custom props + paths + playlists. */
export type ApiSessionDetail = ApiSession & {
  customProperties?: Record<string, unknown> | null;
  paths?: { sequence: number; url: string }[];
  playlists?: { id: number; title: string }[];
};

/** The session's location for the player header: the city when we have one,
 *  else the country's FULL name ("NG" → "Nigeria"). geoip and the device
 *  fallback both store the ISO-3166 alpha-2 code; countryName expands it. */
function locLabel(city?: string | null, country?: string | null): string {
  return city || countryName(country);
}

/** ios/android keep their platform even for Flutter/RN; sdkName disambiguates. */
function rvPlatform(api: ApiSession): string {
  const sdk = (api.sdkName || "").toLowerCase();
  if (sdk.includes("flutter")) return "flutter";
  if (
    sdk.includes("react-native") ||
    sdk.includes("reactnative") ||
    sdk === "rn"
  )
    return "rn";
  const p = (api.platform || "web").toLowerCase();
  return p === "ios" || p === "android" || p === "web" ? p : "web";
}

/** API session summary/detail → the design's RvSession row. Routes by publicId.
 *  `isPublic` marks the unauthenticated share page: it drops the email from the
 *  row entirely, including as a stand-in label for a user who has no name. */
export function adaptSession(api: ApiSession, isPublic = false): RvSession {
  const eu = api.endUser;
  const id = resolveIdentity(eu, api.publicId, isPublic);
  const plat = rvPlatform(api);
  const isMob =
    plat === "ios" || plat === "android" || plat === "rn" || plat === "flutter";
  // Device + geo are SESSION facts (on the session's own columns). Read them
  // from the session first so ANONYMOUS mobile sessions — which have no EndUser
  // row — still show device + country; fall back to the linked user's mirror.
  const dBrowser = api.browser ?? eu?.browser;
  const dOs = api.os ?? eu?.os;
  const dOsVer = api.osVersion ?? eu?.osVersion;
  const dModel = api.deviceModel ?? eu?.deviceModel;
  const dDevice = api.device ?? eu?.device;
  const dFlag = api.flag ?? eu?.flag;
  const dCity = api.city ?? eu?.city;
  const dCountry = api.country ?? eu?.country;
  // mobile reads "iOS 17 · iPhone 15 Pro Max" (OS+major version · model);
  // web reads "browser · os". deviceModel is the humanised marketing name —
  // fall back to the device TYPE ("Mobile"/"Tablet") when the SDK sent no
  // model, so the row never loses its device descriptor entirely.
  const os =
    (isMob
      ? [osLabel(dOs, dOsVer), dModel || dDevice].filter(Boolean).join(" · ")
      : [dBrowser, dOs].filter(Boolean).join(" · ")) ||
    api.userAgent ||
    "—";
  const live = api.status === "LIVE";
  return {
    id: api.publicId,
    name: id.label,
    sub: id.sub,
    initials: id.initials,
    picture: id.picture,
    hueSeed: id.hueSeed,
    anon: !id.identified,
    // Only surface a plan badge for an explicit, non-free plan — never default
    // an unknown/anonymous end-user to a "Free" badge.
    plan:
      eu?.plan && eu.plan.toLowerCase() !== "free"
        ? rvCap(eu.plan.toLowerCase())
        : null,
    live,
    st: api.viewed ? "seen" : api.bookmarked ? "triaged" : "new",
    plat,
    os,
    // Derive the flag from the country when the stored flag column is empty
    // (legacy rows) so a located session still shows its flag in the flag-only
    // list rail rather than collapsing to OS-only.
    flag: dFlag || flagEmoji(dCountry) || "",
    loc: locLabel(dCity, dCountry),
    dur: rvDuration(api.durationMs),
    durationMs: api.durationMs,
    hasReplay: api.hasReplay,
    replayExpired: api.replayExpired,
    errs: api.errorCount || 0,
    rage: api.rageCount || 0,
    net: api.networkCount || 0,
    when: live ? "live" : relTime(api.startedAt),
    url: rvUrlPath(api.startUrl),
  };
}

/* ---- GET /v1/sessions/:publicId/timeline → events tab (activity log) ----
   NOTE: the activity log is sourced from the TIMELINE endpoint, not
   /events. /events returns raw rrweb replay batches (the playback stream),
   which can't render a human-readable activity log without the rrweb
   runtime. timeline returns the structured event log the panel needs. */
export type ApiTimelineEvent = {
  kind: string;
  eventType?: string;
  ts: number;
  offsetMs: number;
  level?: string;
  message?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  value?: number;
  metric?: string;
  rating?: string;
  unit?: string;
  error?: string;
  stack?: string;
  uiClass?: string;
  uiValue?: string;
  uiId?: string;
  route?: string;
  gesture?: string;
  isSensitive?: boolean;
};
export type ApiTimeline = {
  durationMs: number;
  startedAt: string;
  endedAt: string;
  paths?: { sequence: number; url: string }[];
  events: ApiTimelineEvent[];
};

/* Discrete, meaningful perf metrics that belong in a per-event activity log,
   mapped to their human label. This is the legacy player's adaptPerfRow
   allowlist verbatim. Everything else the SDK emits as a "perf" event is
   continuous telemetry it polls each second — mainThreadCpu, memoryUsage,
   frame_drop_pct, thermal/battery samples — plus the aggregate web vitals
   (lcp/cls/inp/ttfb/long_task). Those are NOISE in a timeline and are dropped
   here so Events reads Screen / Tap / nav / click / error, not raw
   MAINTHREADCPU / MEMORYUSAGE rows. The dropped metrics still feed the
   Performance panel's aggregates, which is where they belong. */
const RV_TIMELINE_PERF: Record<string, string> = {
  cold_start_ms: "Cold start",
  anr_ms: "ANR",
  anr_ms_metrickit: "ANR (MetricKit)",
  frozen_frame_count: "Frozen frames",
};

/** Perf value → short label, matching the legacy formatPerfValue units. */
function rvPerfValue(e: ApiTimelineEvent): string | undefined {
  if (e.value == null || !Number.isFinite(e.value)) return undefined;
  switch (e.unit) {
    case "ms":
      return `${Math.round(e.value)}ms`;
    case "pct":
      return `${e.value.toFixed(1)}%`;
    case "count":
      return `${Math.round(e.value)}`;
    case "mb":
      return `${e.value.toFixed(0)}MB`;
    default:
      return `${Math.round(e.value)}`;
  }
}

/** Native gesture → verb, matching the legacy gestureLabel ("Tap FlutterView"). */
function rvGestureVerb(g?: string): string {
  if (g === "long_press") return "Long-press";
  if (g === "pinch") return "Pinch";
  if (g && g.startsWith("swipe")) {
    const dir = g.split("_")[1];
    return dir ? `Swipe ${dir}` : "Swipe";
  }
  return "Tap";
}

/* Custom-event variant → the row's verb/kind/flag. The SDK sends snake_case
   variants (bug_report, session_property, …); they used to be rvCap()'d straight
   into the UI, which printed "Bug_report" / "Session_property" and dropped
   bug_report's error treatment entirely. Mirrors the legacy adaptCustomRow.
   Variant list: the API client. */
const RV_CUSTOM_VARIANT: Record<
  string,
  { verb: string; kind: string; flag?: string; keepName?: boolean }
> = {
  bug_report: { verb: "Bug report", kind: "console", flag: "err", keepName: true },
  session_property: { verb: "Property", kind: "key", keepName: true },
  session_tag: { verb: "Tag", kind: "key", keepName: true },
  push_token: { verb: "Push token", kind: "console", keepName: true },
  // legacy discards the name here — the event is the whole story
  session_favorite: { verb: "Session starred", kind: "console" },
};

export function adaptEvents(events: ApiTimelineEvent[]): RvEvent[] {
  return events
    .map((e): RvEvent | null => {
      const t = rvClock(e.offsetMs);
      const status = e.statusCode;
      switch (e.kind) {
        case "network": {
          const flag =
            status != null && (status >= 500 || status === 0)
              ? "err"
              : status != null && status >= 400
                ? "warn"
                : undefined;
          const d: [string, string][] = [];
          if (status != null) d.push(["status", String(status)]);
          if (e.durationMs != null)
            d.push(["duration", `${Math.round(e.durationMs)} ms`]);
          if (e.url) d.push(["url", e.url]);
          return {
            t,
            kind: "network",
            ev: e.method || "Request",
            target: rvUrlPath(e.url),
            res: status != null ? String(status) : undefined,
            flag,
            d: d.length ? d : undefined,
          };
        }
        case "console": {
          const lvl = e.level === "error" ? "err" : e.level;
          const flag =
            lvl === "err" ? "err" : lvl === "warn" ? "warn" : undefined;
          return {
            t,
            kind: "console",
            ev: rvCap(e.level || "Log"),
            target: e.message || "",
            // `res` is a source location in this design (fixture: "pay.tsx:96");
            // the URL belongs in the drawer, not this nowrap column.
            res: e.stack ? e.stack.split("\n")[0].trim() : undefined,
            flag,
            stack: e.stack || undefined,
          };
        }
        case "error": {
          // `e.error` is the symbolication KIND SLUG ("uncaught"), not display
          // text — using it rendered every row as "Error uncaught" instead of
          // the exception. Legacy shows the message; the slug stays in `d`.
          return {
            t,
            kind: "console",
            ev: "Error",
            target: e.message || "Error",
            res: e.url || undefined,
            flag: "err",
            stack: e.stack || undefined,
          };
        }
        case "perf": {
          // Drop telemetry-grade perf polls; keep only the discrete vitals the
          // legacy activity log surfaces. THIS is the fix for the Events tab
          // showing raw MAINTHREADCPU / MEMORYUSAGE rows.
          const label = e.metric ? RV_TIMELINE_PERF[e.metric] : undefined;
          if (!label) return null;
          const flag =
            e.rating === "poor" || e.rating === "needs-improvement"
              ? "warn"
              : undefined;
          return {
            t,
            kind: "perf",
            ev: label,
            target: "",
            res: rvPerfValue(e),
            // ANR rows carry the blocked-thread stack; without this it is
            // fetched but unreachable anywhere in the UI.
            stack: e.stack || undefined,
            flag,
          };
        }
        case "screen": {
          // Mobile screen view — legacy renders this "Screen: /onboarding".
          return {
            t,
            kind: "nav",
            ev: "Screen",
            // message first (adaptScreens in this file already does), and no
            // "/" fallback — that fabricated a web root path for a mobile screen.
            target: e.message || e.route || "(unknown)",
          };
        }
        case "tap": {
          // Native gesture — "Tap FlutterView", "Long-press …". Masked
          // (sensitive) views never leak their label.
          const target = e.isSensitive
            ? "protected view"
            : e.uiValue || e.uiClass || e.uiId || "view";
          return { t, kind: "pointer", ev: rvGestureVerb(e.gesture), target };
        }
        case "custom": {
          // Rage bursts render as a flagged pointer row (the design's rage
          // treatment); other SDK custom events as a neutral marker. Matches
          // the legacy adaptCustomRow dispatch.
          if ((e.level || "") === "rage") {
            return {
              t,
              kind: "pointer",
              flag: "rage",
              ev: e.message || "Rage tap",
              target: e.route || "",
            };
          }
          const variant = (e.level || "").toLowerCase();
          const cv = RV_CUSTOM_VARIANT[variant];
          if (cv) {
            return {
              t,
              kind: cv.kind,
              flag: cv.flag,
              ev: cv.verb,
              target: cv.keepName ? e.message || "" : "",
            };
          }
          // 'track' and anything unknown: the event's own name IS the title
          // (legacy prints no verb for these).
          return {
            t,
            kind: "pointer",
            ev: e.message || rvCap(variant || "Event"),
            target: "",
          };
        }
        default:
          // Unknown kind — show its message rather than drop it (matches the
          // legacy default row). The only high-volume telemetry kind is
          // 'perf', which is already filtered above.
          return {
            t,
            kind: "console",
            ev: rvCap(e.kind),
            target: e.message || "",
          };
      }
    })
    // Stamp each row with its source offsetMs (the join key the timeline marker
    // also carries). Index-aligned: the map above preserves order + length, so
    // row i pairs with events[i] before the null-drop below.
    .map((row, i): RvEvent | null =>
      row ? { ...row, key: events[i].offsetMs } : row,
    )
    .filter((e): e is RvEvent => e !== null);
}

/* ---- GET /v1/sessions/:publicId/screens → screens tab (mobile nav flow) ----
   Rows are kind="screen" projection logs. Time-on-screen is derived from the
   gap to the NEXT screen (the final row runs to session end), matching the
   legacy ScreensPanel's derivation. Not yet wired into ScreensPanel — see the
   TODO there (the panel isn't passed publicId); this adapter is ready for when
   it is. */
export type ApiScreen = {
  eventId?: string;
  offsetMs?: number;
  message?: string;
  route?: string;
};
function rvScreenDur(sec: number): string {
  if (sec < 1) return "<1s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60),
    s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
export function adaptScreens(
  rows: ApiScreen[],
  durationMs?: number,
): RvScreen[] {
  return rows.map((s, i): RvScreen => {
    const startMs = s.offsetMs ?? 0;
    const next = rows[i + 1];
    const endMs = next ? (next.offsetMs ?? startMs) : (durationMs ?? startMs);
    const durSec = Math.max(0, Math.round((endMs - startMs) / 1000));
    const label = next ? `${rvScreenDur(durSec)} on screen` : "session end";
    return [
      s.message || s.route || "(unknown)",
      rvClock(startMs),
      label,
      durSec,
    ];
  });
}

/* ---- GET /v1/sessions/:publicId/console|network (SessionsService.mapLog) ---- */
export type ApiLog = {
  kind: string;
  level?: string;
  message?: string;
  url?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  offsetMs?: number;
  stack?: string;
  error?: string;
  args?: unknown[];
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  // NetworkInformation snapshot at request time (legacy "4g · 100ms RTT").
  connectionEffectiveType?: string;
  connectionRtt?: number;
};

/* A console row's expandable body. The projection sends `stack` only
   sometimes; error dumps otherwise arrive as one multi-line `message` whose
   tail is the frames — exactly what the legacy panel's stackOf() assumed. Split
   it client-side rather than gate the expand on a field that may never come.
   Nothing is fabricated: no stack and no trailing lines leaves index 4 unset
   and the expand falls back to args + meta. */
function rvSplitMsg(
  message: string,
  stack?: string,
): [string, string | undefined] {
  const nl = message.indexOf("\n");
  const head = nl === -1 ? message : message.slice(0, nl);
  if (stack) return [head, stack];
  return [head, nl === -1 ? undefined : message.slice(nl + 1)];
}

/** Structured console args → the text the expand shows (legacy used a JsonTree,
 *  which this app doesn't have). */
export function rvFmtArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "null";
  if (typeof v !== "object") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "[unserializable]";
  }
}

export function adaptConsole(rows: ApiLog[]): RvConsole[] {
  // repeat-count is not collapsed server-side yet → always 1. src falls back to
  // the request URL (console rows don't carry a source location in the projection).
  return rows.map((r): RvConsole => {
    const lvl = r.level === "error" ? "err" : r.level || "log";
    const [head, body] = rvSplitMsg(r.message || "", r.stack || undefined);
    return [lvl, head, r.url || "", 1, body, r.args, r.offsetMs];
  });
}

/* Server-side the `error` column is repurposed as the crash-KIND discriminator
   rather than an error string: "uncaught" (JVM/NSException), "signal" (NDK
   SIGSEGV etc), "promise"/"unhandledrejection". It is the same slug adaptEvents
   decodes off `e.error`. `level` is written as "" for error rows, so it is
   deliberately unused here. */
function rvCrashKind(kind: string | undefined): string {
  switch (kind) {
    case "uncaught":
      return "Uncaught exception";
    case "signal":
      return "Native signal";
    case "promise":
    case "unhandledrejection":
      return "Unhandled rejection";
    case "crash":
      return "Crash";
    case "exception":
      // A developer-caught error reported via the SDK's captureException — a
      // handled error, distinct from an uncaught crash.
      return "Handled exception";
    default:
      return kind && kind !== "error" ? kind : "Error";
  }
}

export function adaptCrashes(rows: ApiLog[]): RvCrash[] {
  return rows.map((r): RvCrash => {
    // `stack` is only sometimes populated; dumps otherwise arrive as one
    // multi-line `message` whose tail is the frames. Reuse the console's split
    // rather than gate the expand on a field that may never come.
    const [head, body] = rvSplitMsg(r.message || "", r.stack || undefined);
    return {
      type: rvCrashKind(r.error),
      msg: head,
      t: rvClock(r.offsetMs ?? 0),
      stack: body ?? "",
      atMs: r.offsetMs ?? 0,
      cat: r.error === "exception" ? "exception" : "crash",
    };
  });
}

/** UI-freeze / ANR occurrence from GET /v1/sessions/:id/performance. */
export type ApiAnrOccurrence = {
  ts: number;
  durationMs: number;
  rating?: string;
  details?: string | null;
};

/** ANR occurrences → the same RvCrash shape so the Crashes tab lists UI freezes
 *  alongside crashes + handled exceptions. `ts` is absolute epoch ms, so it's
 *  offset against the session start to share the recording clock. */
export function adaptAnr(occ: ApiAnrOccurrence[], startMs: number): RvCrash[] {
  return occ.map((o): RvCrash => {
    const at = Math.max(0, o.ts - startMs);
    return {
      type: "UI freeze",
      msg: `App unresponsive for ${Math.round(o.durationMs)}ms`,
      t: rvClock(at),
      stack: o.details ?? "",
      atMs: at,
      cat: "freeze",
    };
  });
}

export function adaptNetwork(rows: ApiLog[]): RvNet[] {
  return rows.map((r): RvNet => {
    const { host, path } = rvSplitUrl(r.url);
    const dur = r.durationMs != null ? Math.round(r.durationMs) : 0;
    return {
      m: r.method || "GET",
      path,
      host,
      st: r.statusCode ?? 0,
      type: "fetch", // TODO(api): request type (xhr/fetch/script) not in the log projection
      size: "—", // TODO(api): response/transfer size not in the log projection
      start: r.offsetMs ?? 0,
      dur,
      // Only a single real total-duration phase is available; the SDK does not
      // ship per-phase (DNS/Connect/TTFB/Download) timing in the projection.
      timing: (dur ? [["Duration", dur]] : []) as [string, number][], // TODO(api): per-phase resource timing not exposed
      reqH: r.requestHeaders
        ? Object.entries(r.requestHeaders).map(
            ([k, v]) => [k, String(v)] as [string, string],
          )
        : [],
      resH: r.responseHeaders
        ? Object.entries(r.responseHeaders).map(
            ([k, v]) => [k, String(v)] as [string, string],
          )
        : [],
      payload: r.responseBody || r.requestBody || null,
      url: r.url || "",
      err: r.error || undefined,
      reqBody: r.requestBody ?? null,
      resBody: r.responseBody ?? null,
      connEff: r.connectionEffectiveType,
      connRtt: r.connectionRtt,
    };
  });
}

/* ---- GET /v1/sessions/:publicId/comments (CommentsService.toSummary) ---- */
export type ApiComment = {
  id: number;
  body: string;
  atMs: number;
  author: { id?: number; name: string | null; email: string | null } | null;
  createdAt: string;
};
export function adaptComments(rows: ApiComment[]): RvCmt[] {
  return rows.map(
    (c): RvCmt => [
      c.author?.name || c.author?.email || "User",
      rvClock(c.atMs),
      c.body,
    ],
  );
}

/* ---- Custom-properties tab, built from the session detail ---- */
/** Compact JSON for object values: `.rv-prow .v` is a grid cell with
 *  word-break and no pre-wrap, so indented JSON would collapse. */
function rvPropValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function adaptProps(d: ApiSessionDetail): Record<string, RvPropRow[]> {
  const eu = d.endUser;
  const cp = d.customProperties || {};

  // identify() traits — who the SDK says this user is.
  const user: RvPropRow[] = [];
  if (eu?.email) user.push(["email", eu.email, 1]);
  if (eu?.name) user.push(["name", eu.name]);
  if (eu?.plan) user.push(["plan", rvCap(eu.plan.toLowerCase())]);
  if (eu?.distinctId) user.push(["user_id", eu.distinctId]);

  /* setSessionProperty() / identify() extras get their OWN group. They used to
     be folded into User and dropped once User hit 6 rows — so a session with
     more than a couple of custom props silently lost them, and the tab named
     "Custom properties" never actually showed a custom-properties section.
     They are session-scoped (the API snapshots them per session), so grouping
     them under User would imply a user-level scope they don't have.
     `$`-prefixed keys are reserved server-side namespaces, not SDK input. */
  const shown = new Set(user.map((r) => r[0]));
  const custom: RvPropRow[] = Object.entries(cp)
    .filter(([k]) => !k.startsWith("$") && !shown.has(k))
    .map(([k, v]): RvPropRow => [k, rvPropValue(v)]);

  const session: RvPropRow[] = [
    ["session_id", d.publicId],
    ["duration", rvDuration(d.durationMs)],
    ["pages", String(d.pageCount ?? 0)],
    ...(d.entryReferrer
      ? ([["referrer", d.entryReferrer]] as RvPropRow[])
      : []),
  ];
  const device: RvPropRow[] = [];
  // Prefer the session's own device facts over the (possibly absent) endUser
  // mirror, so anonymous mobile sessions still populate the Device group.
  const pBrowser = d.browser ?? eu?.browser;
  const pOs = d.os ?? eu?.os;
  const pOsVer = d.osVersion ?? eu?.osVersion;
  const pDevice = d.device ?? eu?.device;
  const pModel = d.deviceModel ?? eu?.deviceModel;
  if (d.platform) device.push(["platform", rvCap(d.platform)]);
  if (pBrowser) device.push(["browser", pBrowser]);
  if (pOs) device.push(["os", pOsVer ? `${pOs} ${pOsVer}` : pOs]);
  if (pModel) device.push(["model", pModel]);
  if (pDevice) device.push(["device", pDevice]);
  if (d.viewport) device.push(["viewport", d.viewport]);
  const out: Record<string, RvPropRow[]> = {};
  if (user.length) out.User = user;
  // Always present: an explicit empty Custom group tells you the SDK sent
  // nothing, which a hidden group would not.
  out.Custom = custom;
  out.Session = session;
  if (device.length) out.Device = device;
  return out;
}

/* ---- GET /v1/sessions/:publicId/performance (web branch) ---- */
export type ApiVital = { value: number; unit?: string; rating?: string } | null;
export type ApiPerformance = {
  lcp: ApiVital;
  cls: ApiVital;
  fid: ApiVital;
  inp: ApiVital;
  fcp: ApiVital;
  ttfb: ApiVital;
  longTasks: { count: number; totalMs: number; slowestMs: number };
  memory?: { peakBytes: number; samples: { ts: number; bytes: number }[] };
  // Native (mobile) device vitals — getNativePerformance. Present only on
  // ios/android/rn/flutter sessions; the web branch returns none of these.
  mainThreadCpu?: ApiVital;
  memoryRss?: ApiVital;
  thermalState?: ApiVital;
  batteryLevel?: ApiVital;
  batteryDrain?: ApiVital;
  warnings?: { type: string; firstTs: number; count: number; worst: number }[];
  nativeSeries?: {
    cpu: { ts: number; v: number }[];
    memoryRssMb: { ts: number; bytes: number }[];
    batteryLevel: { ts: number; bytes: number }[];
  };
};
function rvRating(v: ApiVital): string {
  const r = (v?.rating || "").toLowerCase();
  if (r === "good") return "good";
  if (r === "poor") return "poor";
  return "ni"; // needs-improvement / unknown
}
function rvVitalValue(label: string, v: ApiVital): string {
  if (!v) return "—";
  if (label === "CLS") return v.value.toFixed(2);
  if (label === "LCP") return (v.value / 1000).toFixed(2) + "s";
  return Math.round(v.value) + "ms"; // INP / FID
}
/** Real Core Web Vitals values + ratings. Sparkline arrays stay decorative
    (per-vital time series isn't exposed); the note is derived from the real
    value so it never misstates the metric. */
export function adaptVitals(perf: ApiPerformance): RvVital[] {
  const build = (label: string, v: ApiVital, spark: number[]): RvVital => {
    const rating = rvRating(v);
    const val = rvVitalValue(label, v);
    const word =
      rating === "good"
        ? "Good"
        : rating === "poor"
          ? "Poor"
          : "Needs improvement";
    return [
      label,
      val,
      rating,
      spark,
      v ? `${label} ${val} · ${word}` : `${label} not captured`,
    ];
  };
  /* Empty sparklines, not RV_VITALS[n][3]. The value and rating here are real,
     but the per-vital TIME SERIES has no wire field — so each real vital was
     being drawn over the fixture's invented curve. A real "LCP 1.2s · Good"
     rendered above a line climbing to a poor 3.18s. The consumer hides the
     sparkline when the series is empty. */
  return [
    build("LCP", perf.lcp, []),
    build("INP", perf.inp || perf.fid, []),
    build("CLS", perf.cls, []),
  ];
}

/** Loading vitals — FCP + TTFB. The SDK + backend capture these (they're on
 *  ApiPerformance) but the panel only ever rendered the three Core Web Vitals,
 *  so First Contentful Paint and Time to First Byte were tracked-but-unshown.
 *  Split out like the reference's "Loading" section, below Core Web Vitals. */
export function adaptLoading(perf: ApiPerformance): RvVital[] {
  const build = (label: string, v: ApiVital): RvVital => {
    const rating = rvRating(v);
    const val = v
      ? v.value >= 1000
        ? (v.value / 1000).toFixed(2) + "s"
        : Math.round(v.value) + "ms"
      : "—";
    const word =
      rating === "good"
        ? "Good"
        : rating === "poor"
          ? "Poor"
          : "Needs improvement";
    return [label, val, rating, [], v ? `${label} ${val} · ${word}` : `${label} not captured`];
  };
  return [build("FCP", perf.fcp), build("TTFB", perf.ttfb)];
}
/** Real long-task blocking summary. Per-task attribution is NOT exposed, so
 *  `rows` is empty and the consumer shows an honest note under the header. */
export function adaptLongTasks(perf: ApiPerformance): RvLt {
  const lt = perf.longTasks || { count: 0, totalMs: 0, slowestMs: 0 };
  return {
    tbt: `${Math.round(lt.totalMs)} ms`,
    n: lt.count,
    max: Math.max(1, Math.round(lt.slowestMs)),
    /* Was `RV_LT.web.rows` — the single worst line in this file. It put four
       invented rows ("0:43 · 180ms · pay.tsx — submitPayment") UNDER a real
       API header, and scaled their bars against the real `slowestMs`, so the
       fabrication rendered as if it had been measured. It was not a loading
       fallback: it shipped on every fully-loaded real web session. */
    rows: [],
  };
}

/** Mobile slow frames, from the real `warnings` projection. The mobile branch
 *  used to ignore `perf` entirely and hand back RV_LT.mobile, so every native
 *  session claimed "6 frozen · 18 frames" whatever the device actually did. */
export function adaptWarnings(perf: ApiPerformance): RvLt {
  const w = perf.warnings ?? [];
  const total = w.reduce((a, x) => a + (x.count || 0), 0);
  const worst = w.reduce((a, x) => Math.max(a, x.worst || 0), 0);
  return {
    tbt: total ? `${w.length} type${w.length > 1 ? "s" : ""}` : "0",
    n: total,
    max: Math.max(1, Math.round(worst)),
    rows: w.map(
      (x) =>
        [rvClock(x.firstTs), Math.round(x.worst || 0), x.type] as [
          string,
          number,
          string,
        ],
    ),
  };
}

/* ---- GET /v1/sessions/:publicId/performance (native/mobile branch) ----
   getNativePerformance returns the device-vitals scalars + per-second series
   (cpu / memoryRssMb / batteryLevel). These feed the mobile Device-vitals
   headline + resource-timeline lanes with the SAME shapes the fixtures use. */
export function adaptMpeak(perf: ApiPerformance): RvMpeak[] {
  const THERMAL = ["Nominal", "Fair", "Serious", "Critical"];
  const cpu = perf.mainThreadCpu,
    mem = perf.memoryRss,
    th = perf.thermalState;
  return [
    [
      "Peak CPU",
      cpu ? Math.round(cpu.value) + "%" : "—",
      cpu && cpu.value > 70 ? "poor" : cpu && cpu.value > 30 ? "ni" : "good",
    ],
    [
      "Peak memory",
      mem ? Math.round(mem.value) + " MB" : "—",
      mem && mem.value > 300 ? "poor" : mem && mem.value > 100 ? "ni" : "good",
    ],
    [
      "Thermal",
      th ? (THERMAL[Math.round(th.value)] ?? "—") : "—",
      th && th.value >= 2 ? "poor" : th && th.value >= 1 ? "ni" : "good",
    ],
  ];
}
export function adaptMlanes(perf: ApiPerformance): RvMlane[] {
  const cpu = (perf.nativeSeries?.cpu ?? []).map((s) => s.v);
  const mem = (perf.nativeSeries?.memoryRssMb ?? []).map((s) => s.bytes);
  const bat = (perf.nativeSeries?.batteryLevel ?? []).map((s) => s.bytes);
  const lanes: RvMlane[] = [];
  if (cpu.length)
    lanes.push([
      "Main-thread CPU",
      "%",
      cpu,
      "var(--rv-err)",
      Math.round(Math.max(...cpu)) + "%",
    ]);
  if (mem.length)
    lanes.push([
      "Memory RSS",
      "MB",
      mem,
      "var(--rv-net)",
      Math.round(Math.max(...mem)) + " MB",
    ]);
  if (bat.length)
    lanes.push([
      "Battery",
      "%",
      bat,
      "var(--rv-warn)",
      Math.round(bat[bat.length - 1]) + "%",
    ]);
  // Return whatever was actually captured — possibly nothing. This used to
  // fall back to RV_MLANES, so a session that captured NO native series
  // rendered the fixture's 94% peak CPU / 512 MB RSS / 86% battery: a device
  // on fire, invented. The panel renders an empty state instead.
  return lanes;
}

/* ---- scrubber ticks ------------------------------------------------------
   The marks on the progress bar are the session's real events. They are built
   from adaptEvents() — the SAME projection the Events panel lists — so a tick's
   tooltip always reads exactly what the panel reads ("0:03 · Screen
   /onboarding"), instead of re-deriving labels from raw kinds and drifting.

   Only moments worth seeking to earn a tick (the legacy player marks
   click/rage/dead/err/nav/input, not every event), so the bar stays readable:
   perf samples and chatty logs are listed but not marked. */
const TICK_TONE: Record<string, RvTick["tone"] | null> = {
  nav: "nav", // screen views
  pointer: "click", // taps / gestures (rage is promoted below)
  error: "err",
  crash: "err",
  network: null, // only failures earn a tick — see adaptTicks
  console: null, // only console.error — see adaptTicks
  perf: null,
  custom: null,
};

/** Type label shown in a marker's tooltip eyebrow. */
function tickKindLabel(row: RvEvent, tone: RvTick["tone"]): string {
  if (tone === "rage") return "Rage click";
  if (tone === "err") return row.kind === "network" ? "Network" : "Error";
  if (row.kind === "nav") return "Screen";
  return row.ev || "Event"; // pointer gestures: Tap / Long-press / Swipe / Pinch
}

export function adaptTicks(events: ApiTimelineEvent[]): RvTick[] {
  const base: RvTick[] = [];
  for (const raw of events) {
    // Project THIS event through the panel's own adapter. Per-event rather
    // than adaptEvents(all)[i]: that adapter ends in .filter(e => e !== null)
    // (it drops perf samples), so row i does not pair with raw event i — and
    // reading offsets by index put every tick at the wrong second.
    const [row] = adaptEvents([raw]);
    if (!row) continue; // not listed by the panel → not marked on the bar
    const sec = (raw.offsetMs ?? 0) / 1000;
    if (!Number.isFinite(sec) || sec < 0) continue;
    let tone: RvTick["tone"] | null = TICK_TONE[row.kind] ?? null;
    if (row.flag === "rage") tone = "rage";
    else if (row.flag === "err") tone = "err"; // failed request / error level
    else if (row.kind === "network" || row.kind === "console") tone = null;
    if (!tone) continue;
    const kind = tickKindLabel(row, tone);
    const primary = row.target || row.ev || kind;
    const label = [row.ev, row.target].filter(Boolean).join(" ").trim();
    base.push({
      sec,
      tone,
      label: `${row.t} · ${label || row.ev}`,
      key: raw.offsetMs, // shared join key → highlight the matching Events row
      kind,
      // Drop the headline when it would just echo the type label (a bare "Tap").
      primary: primary === kind ? "" : primary,
      meta: row.res || "",
      time: row.t,
      // Friction outranks routine interaction without needing a louder colour.
      weight: tone === "rage" || tone === "err" ? "high" : "low",
    });
  }

  // AI-insight markers — derived from the session's OWN friction, not new
  // backend data: a short window where rage clicks coincide with failures reads
  // as a genuine "users got stuck here" moment. Restrained (capped at 6) and
  // only real clusters qualify, so the bar never turns into a wall of insights.
  const friction = base
    .filter((t) => t.tone === "rage" || t.tone === "err")
    .sort((a, b) => a.sec - b.sec);
  const ai: RvTick[] = [];
  const WIN = 4; // seconds
  for (let i = 0; i < friction.length; ) {
    let j = i;
    while (j + 1 < friction.length && friction[j + 1].sec - friction[i].sec <= WIN) j++;
    const group = friction.slice(i, j + 1);
    const rage = group.filter((g) => g.tone === "rage").length;
    const fail = group.filter((g) => g.tone === "err").length;
    if (rage >= 2 || (rage >= 1 && fail >= 1) || fail >= 3) {
      const mid = group[Math.floor(group.length / 2)].sec;
      const detail: string[] = [];
      if (rage) detail.push(`${rage} rage click${rage > 1 ? "s" : ""}`);
      if (fail) detail.push(`${fail} failed request${fail > 1 ? "s" : ""}`);
      ai.push({
        sec: mid,
        tone: "ai",
        weight: "high",
        kind: "AI insight",
        primary: "Users became frustrated here",
        detail,
        time: rvClock(mid * 1000),
        label: `AI insight · ${detail.join(", ")}`,
      });
    }
    i = j + 1;
  }

  // Cap the routine markers so the bar stays calm; keep AI markers (added last
  // so they paint on top) inside the parent's slice(0, 400).
  return [...base.slice(0, 380), ...ai.slice(0, 6)];
}
