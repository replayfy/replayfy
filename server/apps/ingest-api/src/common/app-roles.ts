/**
 * Role-gating for a single deployable image.
 *
 * The whole platform is ONE codebase / ONE image, but at scale you do NOT want
 * every process doing everything: the ingest-accept path, the Bull queue
 * consumers, the @Cron schedulers (rollups / signals / precompute / retention),
 * and the dashboard read API all compete for the same Postgres pool + event
 * loop. A multi-minute load test proved the cost directly — an every-five
 * -minute cron boundary fires a swarm of precompute/rollup/cohort-refresh work
 * that seizes the connection pool and collapses replay-batch drain throughput
 * from ~900/s to ~29/s. Splitting roles across deploys of the SAME image fixes
 * that without a code fork.
 *
 * APP_ROLE is a comma/space separated subset of {ingest, api, worker, cron}.
 * When UNSET or empty, ALL roles are active — so local `yarn dev:api` and any
 * existing single-process deploy behave EXACTLY as before. Gating only ever
 * *removes* work from a process; it never changes what a full node does.
 */
export type AppRole = "ingest" | "api" | "worker" | "cron";

const ALL_ROLES: readonly AppRole[] = ["ingest", "api", "worker", "cron"];

function parseRoles(raw: string | undefined): Set<AppRole> {
  const tokens = (raw ?? "")
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  // Unset / empty / "all" → every role (unchanged single-process behavior).
  if (tokens.length === 0 || tokens.includes("all")) return new Set(ALL_ROLES);
  // Hard-fail on any unrecognized token. Silently dropping a typo (e.g.
  // "worer") would yield an EMPTY role set — and an empty set is NOT
  // single-process, so the node would stop every cron AND pause every queue,
  // draining nothing. A deploy typo must crash at boot, not ship an inert node.
  const unknown = tokens.filter(
    (t) => !(ALL_ROLES as readonly string[]).includes(t),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Invalid APP_ROLE token(s): ${unknown.join(", ")}. ` +
        `Valid roles: ${ALL_ROLES.join(", ")} (comma/space separated), "all", or unset.`,
    );
  }
  return new Set(tokens as AppRole[]);
}

// Parsed ONCE at import time — APP_ROLE is a deploy-time constant, never
// per-request, so there is no reason to re-split it on every check.
const ACTIVE_ROLES = parseRoles(process.env.APP_ROLE);

export function activeRoles(): AppRole[] {
  return [...ACTIVE_ROLES];
}

export function hasRole(role: AppRole): boolean {
  return ACTIVE_ROLES.has(role);
}

export function isSingleProcess(): boolean {
  return ACTIVE_ROLES.size === ALL_ROLES.length;
}
