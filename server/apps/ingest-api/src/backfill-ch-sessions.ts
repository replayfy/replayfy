/**
 * One-time backfill of the ClickHouse `replay.sessions` analytics table from
 * Postgres (Session + EndUser), so funnel user-counts / breakdown / segment
 * filters work on sessions that existed before the live finalize sync shipped.
 *
 * Safe to re-run: `replay.sessions` is a ReplacingMergeTree, so re-inserting a
 * session collapses to the highest `_version`. Walks the Session table by keyset
 * (id ASC) in bounded pages — never loads the whole table into memory.
 *
 *   npm run build && npm run backfill:ch-sessions
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient, disconnectPostgres } from "@replay/db-postgres";
import {
  ensureClickHouseSchema,
  insertSessionRows,
  disconnectClickHouse,
} from "@replay/db-clickhouse";
import { SESSION_ROW_SELECT, toSessionRow } from "./common/ch-session-row";

loadEnv();
loadEnv({ path: ".env.local", override: true });

// Page = one CH insert. Small pages create one part each; at ~1M rows that is a
// merge storm that can stall inserts past the client timeout. Override via
// BACKFILL_PAGE for large backfills (e.g. 25000) to write fewer, larger parts.
const PAGE = Number(process.env.BACKFILL_PAGE ?? 1000);

async function main() {
  const db = getPostgresClient();
  // Make sure the table exists before we write to it.
  await ensureClickHouseSchema();

  const version = Date.now();
  let cursor = 0;
  let total = 0;
  for (;;) {
    // Keyset page over an indexed PK — bounded memory, scales to any table size.
    const page = await db.session.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: PAGE,
      select: SESSION_ROW_SELECT,
    });
    if (page.length === 0) {
      break;
    }
    await insertSessionRows(page.map((s) => toSessionRow(s, version)));
    total += page.length;
    cursor = page[page.length - 1].id;
    process.stdout.write(`  backfilled ${total} sessions (cursor ${cursor})\n`);
  }

  process.stdout.write(`\nBackfill complete: ${total} sessions → replay.sessions\n`);
  await disconnectPostgres();
  await disconnectClickHouse();
}

main().catch(async (e) => {
  process.stderr.write(
    `Backfill failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  await disconnectClickHouse();
  process.exit(1);
});
