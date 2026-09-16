import type { getPostgresClient } from "@replay/db-postgres";

type PostgresClient = ReturnType<typeof getPostgresClient>;

/**
 * Merge SDK custom properties onto a single session's OWN `customProps` blob.
 *
 * Why session-scoped (and not just `EndUser.customProps`): the EndUser blob is
 * last-write-wins across every session a returning user has, so two sessions
 * from the same user would otherwise display an identical props blob. Writing
 * the props onto the session row lets the player show the values AS THEY WERE
 * for THAT session.
 *
 * Access pattern / scaling: a single set-based `UPDATE` keyed on the session
 * PK using jsonb concat (`||`) — no read-modify-write, no per-key statement, so
 * it stays O(1) per batch and scales to millions of sessions. Right-hand keys
 * win, which matches "latest value seen within the session". Callers should
 * strip identity keys (plan/email/name) first so this mirrors the
 * non-promoted-only semantics of `EndUser.customProps`.
 */
export async function mergeSessionCustomProps(
  db: PostgresClient,
  sessionId: number,
  props: Record<string, unknown>,
): Promise<void> {
  if (!props || Object.keys(props).length === 0) return;
  // COALESCE seeds an empty object on the first write; `||` merges top-level
  // keys. The JSON string is passed as a bound parameter (injection-safe).
  await db.$executeRaw`
    UPDATE "Session"
    SET "customProps" = COALESCE("customProps", '{}'::jsonb) || ${JSON.stringify(
      props,
    )}::jsonb
    WHERE id = ${sessionId}`;
}
