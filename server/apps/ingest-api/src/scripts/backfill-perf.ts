/**
 * One-shot backfill: for every Session row missing web-vitals aggregates,
 * scan its Mongo replay batches for `type: "performance"` events and
 * write the worst-LCP / worst-CLS / worst-FID + long-task totals +
 * peak heap onto the Session row.
 *
 * Safe to re-run — only touches rows where worstLcp IS NULL AND
 * longTaskCount = 0 AND peakHeapBytes = 0 (the "never written" signature).
 * Sessions captured by old SDK versions without the perf pipeline will
 * legitimately have no perf events and stay null; that's correct.
 *
 * Usage:
 *   node apps/ingest-api/dist/scripts/backfill-perf.js
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

  const PAGE = 100;
  let cursor: number | undefined;
  let touched = 0;
  let withPerf = 0;

  for (;;) {
    const rows = await pg.session.findMany({
      where: {
        worstLcp: null,
        longTaskCount: 0,
        peakHeapBytes: 0n,
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

      let lcp = 0,
        clsX1000 = 0,
        fid = 0,
        ltCount = 0,
        ltTotal = 0,
        ltSlowest = 0,
        peakHeap = 0;

      for (const b of batches) {
        const evs = (b.events ?? []) as Array<{
          type?: string;
          data?: { kind?: string; metric?: string; value?: number };
        }>;
        for (const ev of evs) {
          if (ev.type !== "performance") continue;
          const d = ev.data;
          if (!d || d.kind !== "perf" || typeof d.value !== "number") continue;
          switch (d.metric) {
            case "lcp":
              if (d.value > lcp) lcp = d.value;
              break;
            case "cls": {
              const scaled = Math.round(d.value * 1000);
              if (scaled > clsX1000) clsX1000 = scaled;
              break;
            }
            case "fid":
              if (d.value > fid) fid = d.value;
              break;
            case "long_task":
              ltCount += 1;
              ltTotal += d.value;
              if (d.value > ltSlowest) ltSlowest = d.value;
              break;
            case "memory":
              if (d.value > peakHeap) peakHeap = d.value;
              break;
          }
        }
      }

      const hasAny =
        lcp > 0 || clsX1000 > 0 || fid > 0 || ltCount > 0 || peakHeap > 0;
      if (hasAny) {
        await pg.session.update({
          where: { id: s.id },
          data: {
            worstLcp: lcp > 0 ? Math.round(lcp) : null,
            worstClsX1000: clsX1000 > 0 ? clsX1000 : null,
            worstFid: fid > 0 ? Math.round(fid) : null,
            longTaskCount: ltCount,
            longTaskTotalMs: Math.round(ltTotal),
            longTaskSlowestMs: Math.round(ltSlowest),
            peakHeapBytes: BigInt(Math.round(peakHeap)),
          },
        });
        withPerf += 1;
      }
      touched += 1;
      if (touched % 50 === 0) {
        process.stdout.write(
          `… scanned ${touched} sessions, updated ${withPerf}\n`,
        );
      }
    }
    cursor = rows[rows.length - 1].id;
  }

  process.stdout.write(
    `\nDone. Scanned ${touched} sessions; ${withPerf} had perf events and were updated.\n`,
  );
  await pg.$disconnect();
}

main().catch((e) => {
  process.stderr.write(`backfill-perf failed: ${(e as Error).message}\n`);
  process.exit(1);
});
