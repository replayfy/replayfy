/**
 * One-time repair of Session.pageCount on sessions recorded before the
 * off-by-one fix in ReplayPersistenceService.upsertPaths. The row was created
 * with pageCount 1 for its landing page, and the first batch then recorded that
 * same page as the session's first SessionPath and counted it again, so every
 * such session reports one page more than it visited (1 page → 2).
 *
 * Only rows carrying that exact signature are touched: at least one SessionPath
 * and pageCount = paths + 1 (only the replay batch path writes SessionPath, so
 * mobile /start sessions, which count screens, never match). They get
 * pageCount = paths. In one transaction per primary-key range:
 *   Session          pageCount lowered to the number of its paths
 *   ClickHouse       replay.sessions re-projected from Postgres and
 *                    replay.session_cards rewritten with the same pages_count,
 *                    older versions deleted (some readers skip FINAL)
 * A ClickHouse failure rolls the range's Postgres changes back, so a re-run
 * redoes it; a fixed row no longer matches, so a re-run changes nothing.
 *
 *   npm run build && npm run backfill:web-page-count            (dry run)
 *   BACKFILL_APPLY=1 npm run backfill:web-page-count            (write)
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import {
  getPostgresClient,
  disconnectPostgres,
  Prisma,
} from "@replay/db-postgres";
import {
  ensureClickHouseSchema,
  getClickHouseClient,
  insertSessionRows,
  disconnectClickHouse,
} from "@replay/db-clickhouse";
import { SESSION_ROW_SELECT, toSessionRow } from "../common/ch-session-row";

loadEnv();
loadEnv({ path: ".env.local", override: true });

/** Primary-key span per transaction. */
const RANGE = Number(process.env.BACKFILL_RANGE ?? 5000);
const APPLY = process.env.BACKFILL_APPLY === "1";

async function main() {
  const db = getPostgresClient();
  if (APPLY) await ensureClickHouseSchema();

  const [{ max }] = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(id) AS max FROM "Session"`;
  let fixed = 0;

  for (let lo = 0; lo < (max ?? 0); lo += RANGE) {
    const hi = lo + RANGE;
    // Access pattern: the range's paths are counted through
    // SessionPath @@index([sessionId, sequence]) (a "sessionId" range scan), and
    // joined to Session by primary key inside the same id range, so each
    // statement reads at most RANGE sessions and their paths. No new index.
    const counted = Prisma.sql`
      SELECT "sessionId", COUNT(*)::int AS paths
        FROM "SessionPath"
       WHERE "sessionId" > ${lo} AND "sessionId" <= ${hi}
       GROUP BY "sessionId"`;

    if (!APPLY) {
      const rows = await db.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
          FROM "Session" s JOIN (${counted}) p ON p."sessionId" = s.id
         WHERE s.id > ${lo} AND s.id <= ${hi} AND s."pageCount" = p.paths + 1`;
      const n = rows[0]?.n ?? 0;
      if (n) {
        fixed += n;
        process.stdout.write(`  would fix ${n} session(s) in ids (${lo}, ${hi}]\n`);
      }
      continue;
    }

    const count = await db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: number }[]>`
          UPDATE "Session" s SET "pageCount" = p.paths
            FROM (${counted}) p
           WHERE s.id = p."sessionId" AND s.id > ${lo} AND s.id <= ${hi}
             AND s."pageCount" = p.paths + 1
          RETURNING s.id`;
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);

        // ClickHouse, inside the transaction so a failure rolls Postgres back.
        // Every write sets absolute values from Postgres, so a re-run converges.
        const sessions = await tx.session.findMany({
          where: { id: { in: ids } },
          select: SESSION_ROW_SELECT,
        });
        const version = Date.now();
        await insertSessionRows(sessions.map((s) => toSessionRow(s, version)));
        const ch = getClickHouseClient();
        const byWs = new Map<number, typeof sessions>();
        for (const s of sessions) byWs.set(s.workspaceId, [...(byWs.get(s.workspaceId) ?? []), s]);
        for (const [ws, list] of byWs) {
          const params = {
            ws,
            ids: list.map((s) => s.id),
            pages: list.map((s) => Math.min(s.pageCount, 65_535)),
            v: version,
          };
          // Cards copy pages_count from replay.sessions: rewrite it. Access
          // pattern: the (workspace_id, session_id) sort-key prefix.
          await ch.command({
            query: `INSERT INTO replay.session_cards
                    SELECT * REPLACE (
                      transform(session_id, {ids:Array(UInt32)}, {pages:Array(UInt16)}, pages_count) AS pages_count,
                      {v:UInt64} AS _version)
                    FROM replay.session_cards FINAL
                    WHERE workspace_id = {ws:UInt32} AND session_id IN {ids:Array(UInt32)}`,
            query_params: params,
          });
          // Drop the superseded rows now: readers that skip FINAL would count
          // both versions until a background merge removes the old one.
          for (const table of ["replay.sessions", "replay.session_cards"]) {
            await ch.command({
              query: `ALTER TABLE ${table} DELETE
                      WHERE workspace_id = {ws:UInt32} AND session_id IN {ids:Array(UInt32)} AND _version < {v:UInt64}`,
              query_params: params,
              clickhouse_settings: { mutations_sync: "2" },
            });
          }
        }
        return rows.length;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    if (count) {
      fixed += count;
      process.stdout.write(`  fixed ${count} session(s) in ids (${lo}, ${hi}]\n`);
    }
  }

  process.stdout.write(
    `\n${APPLY ? "Repaired" : "Dry run: would repair"} ${fixed} session(s) whose pageCount counted the landing page twice\n`,
  );
  await disconnectPostgres();
  if (APPLY) await disconnectClickHouse();
}

main().catch(async (e) => {
  process.stderr.write(
    `Backfill failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  await disconnectClickHouse();
  process.exit(1);
});
