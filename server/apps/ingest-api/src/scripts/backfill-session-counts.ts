/**
 * One-shot backfill for the precomputed side-tab counts on Session.
 *
 * The columns `consoleCount`, `consoleErrorCount`, `networkCount` were
 * added after a lot of sessions had already been ingested, so they
 * default to 0 on legacy rows. This script scans each session's Mongo
 * batches, counts the relevant event kinds, and writes the totals back.
 *
 * Idempotent — safe to re-run. Only touches rows where all three
 * counters are still zero, so re-running won't undo accurate counts
 * written by ingest in the meantime. (Edge case: a real session that
 * truly has zero console + zero network events gets re-scanned on every
 * run; the cost is one Mongo lookup per such row. Acceptable.)
 *
 * Usage (after `npx tsc`):
 *   node apps/ingest-api/dist/scripts/backfill-session-counts.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const pg = getPostgresClient();
  const mongo = getMongoClient();

  // Page through sessions to avoid loading the whole table into memory.
  const PAGE = 100;
  let cursor: number | undefined;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const rows = await pg.session.findMany({
      where: {
        // "Never written" signature — all three counters at zero. Once
        // a session has any non-zero count we trust ingest to keep it
        // accurate. Avoids overwriting fresh data on re-runs.
        consoleCount: 0,
        consoleErrorCount: 0,
        networkCount: 0,
        ...(cursor !== undefined ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: PAGE,
      select: { id: true, publicId: true },
    });
    if (rows.length === 0) break;

    for (const s of rows) {
      const batches = await mongo.replayBatch.findMany({
        where: { sessionId: s.publicId },
        select: { events: true },
      });

      let consoleCount = 0;
      let consoleErrorCount = 0;
      let networkCount = 0;

      for (const b of batches) {
        const evs = (b.events ?? []) as Array<{
          type?: string;
          data?: { level?: string };
        }>;
        for (const ev of evs) {
          if (ev.type === "console") {
            consoleCount += 1;
            if (ev.data?.level === "error") consoleErrorCount += 1;
          } else if (ev.type === "network") {
            networkCount += 1;
          }
        }
      }

      if (consoleCount > 0 || networkCount > 0) {
        await pg.session.update({
          where: { id: s.id },
          data: { consoleCount, consoleErrorCount, networkCount },
        });
        updated += 1;
      }
      scanned += 1;
      if (scanned % 50 === 0) {
        process.stdout.write(
          `… scanned ${scanned}, updated ${updated}\n`,
        );
      }
    }
    cursor = rows[rows.length - 1].id;
  }

  process.stdout.write(
    `\nDone. Scanned ${scanned} sessions; ${updated} had console/network events and were updated.\n`,
  );
  await pg.$disconnect();
}

main().catch((e) => {
  process.stderr.write(
    `backfill-session-counts failed: ${(e as Error).message}\n`,
  );
  process.exit(1);
});
