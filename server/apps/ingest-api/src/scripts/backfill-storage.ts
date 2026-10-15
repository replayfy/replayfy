/**
 * One-shot backfill: for every Session row with `dataSizeBytes = 0`, sum the
 * JSON byte length of its Mongo replay batches and write the total back.
 *
 * Safe to re-run — only touches rows where dataSizeBytes is still zero.
 * Skip if the session has no batches (will stay at zero).
 *
 * Usage:
 *   node apps/ingest-api/dist/scripts/backfill-storage.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { loadScopedBatches } from "./scoped-replay-batches";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const pg = getPostgresClient();
  const mongo = getMongoClient();

  // Pull in pages so we don't load the whole table into memory if the
  // workspace has tens of thousands of recordings.
  const PAGE = 50;
  let cursor: number | undefined;
  let touched = 0;
  let totalBytes = 0n;

  for (;;) {
    const rows = await pg.session.findMany({
      where: {
        dataSizeBytes: 0n,
        ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
      },
      select: { id: true, publicId: true, workspaceId: true },
      orderBy: { id: "desc" },
      take: PAGE,
    });
    if (rows.length === 0) break;

    // One workspace-scoped Mongo read for the whole page (loadScopedBatches),
    // and one Postgres transaction for the page's updates.
    const batchesBySession = await loadScopedBatches(mongo, rows);
    const updates: Array<ReturnType<typeof pg.session.update>> = [];
    for (const s of rows) {
      const batches = batchesBySession.get(s.id) ?? [];
      if (batches.length === 0) continue;
      let bytes = 0n;
      for (const b of batches) {
        bytes += BigInt(
          Buffer.byteLength(JSON.stringify(b.events ?? []), "utf8"),
        );
      }
      if (bytes === 0n) continue;
      updates.push(
        pg.session.update({
          where: { id: s.id },
          data: { dataSizeBytes: bytes },
        }),
      );
      touched += 1;
      totalBytes += bytes;
    }

    if (updates.length > 0) await pg.$transaction(updates);
    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }

  process.stdout.write(
    `Backfilled ${touched} session rows (${(Number(totalBytes) / 1024 ** 2).toFixed(1)} MB total)\n`,
  );
  process.exit(0);
}

void main().catch((e) => {
  process.stderr.write(
    `Backfill failed: ${(e as Error).stack ?? (e as Error).message}\n`,
  );
  process.exit(1);
});
