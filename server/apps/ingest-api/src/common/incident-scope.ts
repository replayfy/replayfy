import type { PrismaClient } from "@replay/db-postgres";
import { funnelStepSessionIds } from "@replay/db-clickhouse";
import {
  FunnelsService,
  type FunnelFilter,
  type FunnelStep,
} from "../funnels/funnels.service";

/**
 * Incident → the sessions currently attributed to it. Shared by the Recordings
 * `?incident=` list scope (sessions.service.ts) and the incident summary that
 * labels its banner (incident-investigation.service.ts), so the two cannot
 * disagree about how many sessions the scope holds or whether it was capped.
 *
 * Lives in common/ rather than as a private method because it genuinely has two
 * callers in two modules — the no-free-functions rule applies to
 * *.controller.ts / *.service.ts, which is exactly what this avoids duplicating.
 */

/**
 * Ceiling on the resolved id set.
 *
 * `Incident.sessionCount` is unbounded, and the resolved ids ride in an
 * `id IN (…)` list — so this is the only thing keeping a pathological incident
 * from building a 100k-element Prisma parameter. 5,000 is well past any incident
 * a human reads through and still a trivially small IN list for Postgres.
 *
 * Truncation is REPORTED, never silent: `truncated` reaches the banner so the
 * UI says "newest 5,000 sessions" instead of implying it is showing all of them.
 */
export const INCIDENT_SCOPE_CAP = 5_000;

export interface IncidentScope {
  /** Attributed session ids, newest first, at most INCIDENT_SCOPE_CAP of them. */
  ids: number[];
  /** True when the incident holds MORE than the cap — the ids are a prefix. */
  truncated: boolean;
}

/**
 * Resolve an incident to its attributed session ids.
 *
 * Access pattern: ONE index-only probe of
 * `Signal @@index([incidentId, workspaceId, sessionId])` per incident-scoped
 * request. All three predicate/output columns live in that index, so Postgres
 * answers from the index alone — no heap fetch per signal row, and no table
 * touched. The work is bounded by the incident's own signal count and by
 * `LIMIT cap + 1`, never by the workspace's Session or Signal table, and it runs
 * ONCE per request rather than per row.
 *
 * Why resolve-then-`IN` instead of the one-line Prisma relation filter
 * (`where.signals = { some: { incidentId } }`): that compiles to a correlated
 * EXISTS the planner is free to drive from the Session side — a backward index
 * scan over `@@index([workspaceId, id desc])` walking rows until it finds a
 * page's worth of matches. For a small incident in a large workspace that scans
 * the workspace. This shape has no such failure mode: two round trips, both
 * index-served, one plan regardless of incident age or workspace size.
 *
 * `ORDER BY "sessionId" DESC` is load-bearing, not decoration: `Session.id` is
 * autoincrement, so it makes the cap keep the NEWEST sessions — matching the
 * Recordings list's own default `{ id: "desc" }` ordering. A truncated scope is
 * therefore the top of the list the user would have seen anyway: a prefix, not
 * a random sample.
 *
 * `workspaceId` is filtered IN ADDITION to `incidentId` and is not optional.
 * Filtering on `incidentId` alone would resolve another tenant's session ids;
 * the list's own `where.workspaceId` would then return zero rows, but the count
 * — and the truncation flag — would still leak the foreign incident's size.
 */
export async function resolveIncidentSessionIds(
  db: PrismaClient,
  workspaceId: number,
  incidentId: number,
): Promise<IncidentScope> {
  if (!Number.isFinite(incidentId)) return { ids: [], truncated: false };
  const rows = await db.$queryRaw<{ sessionId: number }[]>`
    SELECT DISTINCT "sessionId"
    FROM "Signal"
    WHERE "incidentId" = ${incidentId} AND "workspaceId" = ${workspaceId}
    ORDER BY "sessionId" DESC
    LIMIT ${INCIDENT_SCOPE_CAP + 1}`;
  const ids = rows.map((r) => r.sessionId);
  return {
    ids: ids.slice(0, INCIDENT_SCOPE_CAP),
    truncated: ids.length > INCIDENT_SCOPE_CAP,
  };
}


/**
 * The same scope, for an ISSUE-backed signal. Half the AI insights are sourced
 * from an Issue rather than an Incident (the crash/error clusters), and without
 * this they fell through to the UNSCOPED recordings list — "View sessions"
 * silently showed everything, which is worse than showing nothing.
 *
 * Access pattern: ONE bounded findMany over IssueOccurrence, index-served by
 * @@index([workspaceId, fingerprint]) — the issue's own fingerprint is the
 * predicate, so the scan is the issue's occurrences, never the workspace. The
 * `workspaceId` in BOTH reads is the tenant guard: a foreign issue id resolves
 * to no fingerprint and therefore to an empty scope, never to another
 * workspace's sessions.
 */
export async function resolveIssueSessionIds(
  db: PrismaClient,
  workspaceId: number,
  issueId: number,
): Promise<{ ids: number[]; truncated: boolean }> {
  if (!Number.isFinite(issueId)) return { ids: [], truncated: false };
  const issue = await db.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { fingerprint: true },
  });
  if (!issue) return { ids: [], truncated: false };
  const fp = issue.fingerprint ?? "";
  // BEHAVIORAL issues (fingerprint "beh:<type>:<screen>:<element>") never write
  // IssueOccurrence rows — their per-session occurrences live in `Signal`, keyed
  // by (type, screen, element). Only error/crash issues (SHA1-hex fingerprints)
  // populate IssueOccurrence. So resolve behavioral scopes from Signal, or every
  // "View affected sessions" on a UX issue silently resolves to zero. The
  // fingerprint is `'beh:'||type||':'||coalesce(screen,'')||':'||coalesce(element,'')`
  // (issues.service.ts), so an empty segment means the column was NULL.
  if (fp.startsWith("beh:")) {
    const parts = fp.split(":");
    const type = parts[1] ?? "";
    const screen = parts[2] ?? "";
    const element = parts.slice(3).join(":"); // selectors may contain ':'
    // Index-served by @@index([workspaceId, type, screen, occurredAt]); newest
    // sessions first, capped like the other scopes.
    const rows = await db.signal.findMany({
      where: {
        workspaceId,
        type,
        screen: screen === "" ? null : screen,
        element: element === "" ? null : element,
      },
      select: { sessionId: true },
      distinct: ["sessionId"],
      orderBy: { sessionId: "desc" },
      take: INCIDENT_SCOPE_CAP + 1,
    });
    const ids = rows.map((r: { sessionId: number }) => r.sessionId);
    return {
      ids: ids.slice(0, INCIDENT_SCOPE_CAP),
      truncated: ids.length > INCIDENT_SCOPE_CAP,
    };
  }
  const rows = await db.issueOccurrence.findMany({
    where: { workspaceId, fingerprint: issue.fingerprint },
    select: { sessionId: true },
    distinct: ["sessionId"],
    take: INCIDENT_SCOPE_CAP + 1,
  });
  const ids = rows.map((r: { sessionId: number }) => r.sessionId);
  return {
    ids: ids.slice(0, INCIDENT_SCOPE_CAP),
    truncated: ids.length > INCIDENT_SCOPE_CAP,
  };
}

/**
 * A FUNNEL STEP → the sessions that reached it, for the Recordings "view
 * sessions" drill-down. Same contract as the incident/issue scopes (≤ CAP ids,
 * newest-first, `truncated` reported) so the recordings list keyset-pages them
 * with the exact same machinery — the drill-down now scrolls through up to
 * INCIDENT_SCOPE_CAP reached sessions, 200 at a time, instead of the old fixed
 * 200-id URL sample that could never page.
 *
 * Access pattern: ONE ClickHouse `windowFunnel` pass over the analysed window's
 * events (bounded by [fromTs,toTs] + LIMIT cap+1, never the workspace), resolved
 * ONCE per drill-down; the list then pages the resolved id set in Postgres.
 * `ORDER BY session_id DESC` inside funnelStepSessionIds keeps the newest-first
 * prefix, matching the recordings list's own `{ id: "desc" }`. `workspaceId` is
 * the tenant guard on the funnel lookup — a foreign funnel id resolves empty.
 */
export async function resolveFunnelStepSessionIds(
  db: PrismaClient,
  workspaceId: number,
  funnelId: number,
  stepIndex: number,
  range?: { fromTs?: number; toTs?: number },
): Promise<{ ids: number[]; truncated: boolean }> {
  if (!Number.isFinite(funnelId) || !Number.isFinite(stepIndex))
    return { ids: [], truncated: false };
  const funnel = await db.funnel.findFirst({
    where: { id: funnelId, workspaceId },
    select: { steps: true, windowDays: true, filter: true },
  });
  if (!funnel) return { ids: [], truncated: false };
  const steps =
    (funnel.steps as unknown as Array<{
      kind?: string;
      matchType: string;
      value: string;
    }>) ?? [];
  if (stepIndex < 0 || stepIndex >= steps.length)
    return { ids: [], truncated: false };
  // Same window semantics as FunnelsService.compute: a custom [fromTs,toTs] is
  // the analysed period AND the conversion window; otherwise the saved funnel's
  // last-N-days window.
  const useCustom = !!(
    range?.fromTs &&
    range?.toTs &&
    range.toTs > range.fromTs
  );
  const since = useCustom
    ? range!.fromTs!
    : Date.now() - funnel.windowDays * 86_400_000;
  const until = useCustom ? range!.toTs! : undefined;
  const windowMs = until ? until - since : funnel.windowDays * 86_400_000;
  const mappedSteps = steps.map((s) => ({
    kind: s.kind ?? "page",
    matchType: s.matchType,
    value: s.value,
  }));
  // Apply the funnel's SAVED filter (country/device/plan/… → a CH segment on the
  // replay.sessions JOIN) so "View sessions" for a step returns only the sessions
  // matching the funnel — not every step-hitter. Same toSegment the compute uses,
  // and the segment is applied BEFORE the id cap, so the cap can't drop matching
  // rows (which client-side filtering of a capped set would).
  const segment = FunnelsService.toSegment(
    (funnel.filter as unknown as FunnelFilter | null) ?? undefined,
    mappedSteps as unknown as FunnelStep[],
    since,
  );
  const ids = await funnelStepSessionIds({
    workspaceId,
    steps: mappedSteps,
    windowMs,
    sinceMs: since,
    untilMs: until,
    stepIndex,
    segment,
    limit: INCIDENT_SCOPE_CAP + 1,
  });
  return {
    ids: ids.slice(0, INCIDENT_SCOPE_CAP),
    truncated: ids.length > INCIDENT_SCOPE_CAP,
  };
}
