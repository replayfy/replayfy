import type { SessionRow } from "@replay/db-clickhouse";

/**
 * The Postgres Session (+ its EndUser) fields needed to build a
 * `replay.sessions` ClickHouse row. Kept here so the live finalize sync
 * (SignalsService) and the one-time backfill script project a row identically —
 * one source of truth for the mapping, no drift.
 */
export interface SessionRowSource {
  id: number;
  workspaceId: number;
  anonymousId: string | null;
  startedAt: Date;
  durationMs: number;
  platform: string | null;
  sdkVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  revId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  pageCount: number;
  errorCount: number;
  rageCount: number;
  deadCount: number;
  startUrl: string | null;
  entryReferrer: string | null;
  /** The session's OWN device facts. Null on sessions ingested before these
   *  columns landed — those fall back to the (last-write-wins) EndUser copy. */
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  device: string | null;
  deviceModel: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  endUser: {
    distinctId: string;
    plan: string | null;
    os: string | null;
    device: string | null;
    browser: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    browserVersion: string | null;
    osVersion: string | null;
    firstSeenAt: Date;
    customProps: unknown;
  } | null;
}

/** Prisma `select` for {@link SessionRowSource} — share it so reads stay aligned. */
export const SESSION_ROW_SELECT = {
  id: true,
  workspaceId: true,
  anonymousId: true,
  startedAt: true,
  durationMs: true,
  platform: true,
  sdkVersion: true,
  appVersion: true,
  appBuild: true,
  revId: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  pageCount: true,
  errorCount: true,
  rageCount: true,
  deadCount: true,
  startUrl: true,
  entryReferrer: true,
  browser: true,
  browserVersion: true,
  os: true,
  osVersion: true,
  device: true,
  deviceModel: true,
  city: true,
  state: true,
  country: true,
  endUser: {
    select: {
      distinctId: true,
      plan: true,
      os: true,
      device: true,
      browser: true,
      country: true,
      state: true,
      city: true,
      browserVersion: true,
      osVersion: true,
      firstSeenAt: true,
      customProps: true,
    },
  },
} as const;

/** Landing path — the pathname of the session's start URL (web). Mobile
 *  `app://…` start URLs have no meaningful path, so they resolve to "". */
function landingPath(startUrl: string | null): string {
  if (!startUrl) return "";
  try {
    return new URL(startUrl).pathname || "/";
  } catch {
    return startUrl.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0] || "";
  }
}

/**
 * Project a Postgres session (with its EndUser) into a `replay.sessions` row.
 * `user_id` is the identified EndUser.distinctId; '' means anonymous (matching
 * the reference's NULL user_id → excluded from funnel user counts). Release uses
 * the same `appVersion ?? revId ?? appBuild` COALESCE as the rest of the system.
 */
export function toSessionRow(s: SessionRowSource, version: number): SessionRow {
  return {
    workspace_id: s.workspaceId,
    session_id: s.id,
    user_id: s.endUser?.distinctId ?? "",
    anonymous_id: s.anonymousId ?? "",
    datetime: s.startedAt.getTime(),
    duration_ms: s.durationMs ?? 0,
    platform: s.platform ?? "web",
    // The SESSION's own device, not the EndUser's. EndUser's copy is
    // last-write-wins across every device the person uses, so projecting it
    // here re-stamped a user's whole history with their most recent device
    // (the backfill re-projects every row through this mapper). Older sessions
    // have no per-session facts yet, so they still fall back to the user row.
    os: s.os ?? s.endUser?.os ?? "",
    os_version: s.osVersion ?? s.endUser?.osVersion ?? "",
    device: s.device ?? s.endUser?.device ?? "",
    // Raw hardware model — per-session only, no EndUser fallback (EndUser holds
    // one last-write-wins device). Empty for web sessions (no model).
    device_model: s.deviceModel ?? "",
    browser: s.browser ?? s.endUser?.browser ?? "",
    browser_version: s.browserVersion ?? s.endUser?.browserVersion ?? "",
    start_path: landingPath(s.startUrl),
    // Session's own geo for the same reason as device above — the EndUser copy
    // is last-write-wins, so a user who travels had their whole history
    // re-stamped with their newest location on every backfill.
    country: s.country ?? s.endUser?.country ?? "",
    state: s.state ?? s.endUser?.state ?? "",
    city: s.city ?? s.endUser?.city ?? "",
    plan: s.endUser?.plan ?? "",
    release: s.appVersion || s.revId || s.appBuild || "",
    tracker_version: s.sdkVersion ?? "",
    utm_source: s.utmSource ?? "",
    utm_medium: s.utmMedium ?? "",
    utm_campaign: s.utmCampaign ?? "",
    pages_count: s.pageCount ?? 0,
    errors_count: s.errorCount ?? 0,
    rage_count: s.rageCount ?? 0,
    dead_count: s.deadCount ?? 0,
    start_url: s.startUrl ?? "",
    referrer: s.entryReferrer ?? "",
    first_seen_at: s.endUser?.firstSeenAt ? s.endUser.firstSeenAt.getTime() : 0,
    attrs: flattenProps(s.endUser?.customProps),
    _version: version,
  };
}

/**
 * Flatten an EndUser.customProps JSON object into a string→string map for the
 * CH `attrs` Map column. Scalar values are stringified; nested objects/arrays
 * are JSON-encoded. Capped at 64 keys so a pathological props blob can't bloat
 * the row. Non-object input (null / array / scalar) yields an empty map.
 */
function flattenProps(props: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (v == null || n >= 64) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
    n++;
  }
  return out;
}
