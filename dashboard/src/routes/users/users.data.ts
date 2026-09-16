/* Users screen — API adapters + avatar-hue helper.
   (The USERS fixture that used to live here — eight invented people, "Maria
   Alvarez / maria@acme.io" — was unreferenced dead code: the page has read from
   GET /v1/end-users for a while. Identity resolution lives in @/lib/identity.) */
import { relTime } from "@/lib/format";
import { resolveIdentity } from "@/lib/identity";

export const HUES = [
  "#5b5ceb",
  "#c08a3e",
  "#3f9468",
  "#c2599f",
  "#3b76b0",
  "#8b72d6",
];
export function uhue(n: string) {
  let h = 0;
  for (const c of n || "?") h = (h * 31 + c.charCodeAt(0)) % HUES.length;
  return HUES[h];
}

export const COUNTRIES = [
  "All countries",
  "United States",
  "Spain",
  "Canada",
  "India",
  "United Kingdom",
  "Germany",
  "Brazil",
  "United Arab Emirates",
];

export type User = {
  id: number;
  n: string;
  /** The email line. Empty string when there is nothing to say — it used to
   *  fall back to `distinctId`, which for an anonymous browser IS the
   *  fingerprint hash, so a column labelled as an email printed opaque hashes. */
  e: string;
  /** Did identify() run? A real field, because the Identified/Anonymous filter
   *  used to answer this by string-comparing the rendered label against
   *  "Anonymous" — so a user identified by email alone (whose label WAS
   *  "Anonymous", see the old `u.name || "Anonymous"`) was filed as anonymous,
   *  while the recordings page counted the same person as identified. */
  identified: boolean;
  initials: string | null;
  /** identify() avatar URL, or null → render the initials glyph. */
  picture: string | null;
  hueSeed: string;
  plan: string;
  pt: string;
  flag: string;
  loc: string;
  dev: string;
  seen: string;
  on?: boolean;
};

/** GET /v1/end-users item (backend EndUsersService.toSummary). */
export type ApiEndUser = {
  id: number;
  distinctId: string | null;
  email: string | null;
  name: string | null;
  /** identify() avatar URL (server-side URL-validated), or null. */
  picture?: string | null;
  plan?: string | null;
  browser?: string | null;
  os?: string | null;
  device?: string | null;
  city?: string | null;
  country?: string | null;
  flag?: string | null;
  firstSeenAt?: string;
  lastSeenAt: string;
  isOnline?: boolean;
  /** Per-user identify() traits map (backend change landing separately; may be null/absent). */
  customProps?: Record<string, unknown> | null;
};

function planTone(plan: string): string {
  const p = plan.toLowerCase();
  if (p.includes("enterprise")) return "info";
  if (p.includes("team")) return "ok";
  if (p.includes("pro")) return "warn";
  return "";
}

/** API end-user → the design's User shape. */
export function adaptUser(u: ApiEndUser): User {
  const id = resolveIdentity(u, String(u.id));
  return {
    id: u.id,
    n: id.label,
    e: id.sub ?? "",
    identified: id.identified,
    initials: id.initials,
    picture: id.picture,
    hueSeed: id.hueSeed,
    // Plan is an identify() trait, not something we know about an end user by
    // default. Show it ONLY when the customer actually set one — never invent a
    // "Free" tier the product may not even have. Empty string → the chip is
    // suppressed at the render site.
    plan: u.plan
      ? u.plan[0].toUpperCase() + u.plan.slice(1).toLowerCase()
      : "",
    pt: planTone(u.plan || ""),
    flag: u.flag || "",
    loc: [u.city, u.country].filter(Boolean).join(", "),
    dev: [u.device || u.os, u.browser].filter(Boolean).join(" · "),
    seen: u.isOnline ? "online" : relTime(u.lastSeenAt),
    on: !!u.isOnline,
  };
}

/* --------------------------------------------- identify() trait formatting */
/** camelCase / snake_case / kebab-case key → "Title Case" label. */
export function prettifyLabel(key: string): string {
  return (
    key
      .replace(/[_-]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ") || key
  );
}

/** Prettify a trait value for TEXT rendering. */
export function formatTraitText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return Number.isFinite(value) ? value.toLocaleString() : String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------ user-detail (by id) */
/** GET /v1/end-users/:id — full profile (EndUsersService.get). */
export type ApiEndUserDetail = ApiEndUser & {
  initials?: string | null;
  firstSeenAt: string;
  sessions: number;
  avgDurationMs: number;
  lastSession: { publicId: string; startedAt: string } | null;
  /** Ids of the cohorts this user is a member of — drives Add vs Remove in the picker. */
  cohortIds: number[];
  customProps: Record<string, unknown>;
  identifiers: { distinctId: string | null; anonymousLinked: number };
  environment: {
    browser: string | null;
    os: string | null;
    device: string | null;
    viewport: string | null;
    timezone: string | null;
    ip: string | null;
  };
};
/** GET /v1/end-users/:id/sessions item. */
export type ApiUserSession = {
  id: number;
  publicId: string;
  startedAt: string;
  durationMs: number;
  startUrl: string | null;
  pageCount: number;
  clickCount: number;
  rageCount: number;
  errorCount: number;
  // Mobile sessions have no URL — the table shows the humanised device model
  // ("iPhone 17 Pro") instead, like the recordings list. `platform` = web vs mobile.
  deviceModel?: string | null;
  platform?: string | null;
};
/** GET /v1/end-users/:id/activity item. */
export type ApiActivityItem = {
  kind: "session";
  publicId: string;
  title: string;
  detail: string;
  ts: string;
};
/** GET /v1/end-users/:id/activity-chart item. */
export type ApiChartPoint = { date: string; count: number };

/** ms → "4:12" clock form (recording rows). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** ms → "3m 41s" long form (avg-duration KPI / props). */
export function fmtLong(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
/** ISO → "Nov 3, 2025". */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}
/** URL → pathname (falls back to the raw string). */
export function urlPath(u: string | null): string {
  if (!u) return "—";
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u;
  }
}

