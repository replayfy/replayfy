import type { Redis } from "ioredis";

/**
 * The workspace ACTIVITY WATERMARK — a Redis mirror of
 * `WorkspaceSnapshot.lastActivityAt`, the coarse "workspace version" the signals
 * chokepoint bumps on any new activity. Kept in Redis so the two freshness reads
 * that hit it on nearly every request — the precompute `stale` hint and the
 * near-live execution-cache key — never touch Postgres. Postgres stays
 * authoritative: a Redis miss (eviction/TTL) safely falls back to the column, so
 * the value is never WRONG, only occasionally re-read from PG.
 *
 * Value = epoch-ms as a string (matches `lastActivityAt.getTime()` and the
 * app-clock `snapshotAt` it is compared against).
 */
export const workspaceActivityKey = (workspaceId: number): string =>
  `ws:activity:${workspaceId}`;

/** Safety-net TTL: if a bump is ever missed, the key lapses and readers fall
 *  back to Postgres within the window. Refreshed on every bump, so under normal
 *  operation it never actually expires. */
export const WORKSPACE_ACTIVITY_TTL_SEC = 6 * 3600;

/**
 * Bump the watermark for a batch of workspaces in ONE Redis round-trip
 * (pipeline — never `await` in a loop). Best-effort: Postgres is the source of
 * truth, so a Redis error is swallowed and the readers fall back to the column.
 */
export async function bumpWorkspaceActivity(
  redis: Redis,
  workspaceIds: number[],
  epochMs: number,
): Promise<void> {
  if (workspaceIds.length === 0) return;
  try {
    const pipe = redis.pipeline();
    const val = String(epochMs);
    for (const id of workspaceIds) {
      pipe.set(workspaceActivityKey(id), val, "EX", WORKSPACE_ACTIVITY_TTL_SEC);
    }
    await pipe.exec();
  } catch {
    // best-effort — the column remains authoritative
  }
}

/**
 * Read a workspace's activity watermark (epoch ms) from Redis, or null on
 * miss/error so the caller can fall back to Postgres.
 */
export async function readWorkspaceActivity(
  redis: Redis,
  workspaceId: number,
): Promise<number | null> {
  try {
    const raw = await redis.get(workspaceActivityKey(workspaceId));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
