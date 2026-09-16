/**
 * LOAD-TEST SEEDER (Mongo/rrweb leg). Full rrweb for every synthetic session is
 * impractical (measured ~870 GB at 500k, dominated by 71k identical copies of a
 * few heavy seeds) AND pointless — no dashboard query reads Mongo. So we clone
 * rrweb only for the MOST-RECENT `SEED_MONGO_RECENT` web synthetic sessions per
 * workspace: those are the ones a human would actually click, and they play
 * exactly like a real recording (the player reads `/events` → ReplayBatch where
 * sessionId = publicId). Everything else still lists/facets/funnels at full scale
 * via PG+CH.
 *
 * Reversible: synthetic sessionId is `lt_<id>` → cleanup is deleteMany(/^lt_/).
 * seedId of a synthetic id = floor((id - 1e8) / 1e6)  (inverse of the id formula).
 *
 *   SEED_WS=1,2 SEED_MONGO_RECENT=5000 node apps/ingest-api/dist/seed-mongo-loadtest.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient, disconnectPostgres } from "@replay/db-postgres";
import { getMongoClient, disconnectMongo } from "@replay/db-mongo";

loadEnv();
loadEnv({ path: ".env.local", override: true });

const CHUNK = 500; // docs per insertMany — bounded memory regardless of N

async function seedWorkspace(
  db: ReturnType<typeof getPostgresClient>,
  mongo: ReturnType<typeof getMongoClient>,
  workspaceId: number,
  recentN: number,
): Promise<{ targets: number; docs: number }> {
  // The most-recent N web synthetic sessions — indexed scan on (startedAt).
  const targets = await db.session.findMany({
    where: {
      workspaceId,
      id: { gte: 100000000 },
      OR: [{ platform: { notIn: ["ios", "android"] } }, { platform: null }],
    },
    select: { id: true, publicId: true },
    orderBy: { startedAt: "desc" },
    take: recentN,
  });
  if (targets.length === 0) return { targets: 0, docs: 0 };

  // Group targets by their originating seed so each seed's rrweb is read once.
  const bySeed = new Map<number, Array<{ id: number; publicId: string }>>();
  for (const t of targets) {
    const seedId = Math.floor((t.id - 100000000) / 1000000);
    (bySeed.get(seedId) ?? bySeed.set(seedId, []).get(seedId)!).push(t);
  }

  let docs = 0;
  for (const [seedId, list] of bySeed) {
    const seed = await db.session.findUnique({
      where: { id: seedId },
      select: { publicId: true },
    });
    if (!seed) continue;
    const seedBatches = await mongo.replayBatch.findMany({
      where: { sessionId: seed.publicId },
      orderBy: { sequence: "asc" },
    });
    if (seedBatches.length === 0) continue;

    let buf: Array<Record<string, unknown>> = [];
    for (const t of list) {
      for (const b of seedBatches) {
        buf.push({
          projectId: b.projectId,
          sessionId: t.publicId,
          segmentId: b.segmentId,
          sequence: b.sequence,
          sentAt: b.sentAt,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          eventCount: b.eventCount,
          sdk: b.sdk === null ? undefined : b.sdk,
          page: b.page === null ? undefined : b.page,
          events: b.events === null ? undefined : b.events,
        });
        if (buf.length >= CHUNK) {
          await mongo.replayBatch.createMany({ data: buf as never });
          docs += buf.length;
          buf = [];
        }
      }
    }
    if (buf.length) {
      await mongo.replayBatch.createMany({ data: buf as never });
      docs += buf.length;
    }
  }
  return { targets: targets.length, docs };
}

async function main() {
  const wsList = (process.env.SEED_WS ?? "1,2")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const recentN = parseInt(process.env.SEED_MONGO_RECENT ?? "5000", 10);

  const db = getPostgresClient();
  const mongo = getMongoClient();
  for (const ws of wsList) {
    const { targets, docs } = await seedWorkspace(db, mongo, ws, recentN);
    process.stdout.write(
      `ws${ws}: ${targets} most-recent web sessions → ${docs} rrweb docs (playable)\n`,
    );
  }
  await disconnectPostgres();
  await disconnectMongo();
}

main().catch(async (e) => {
  process.stderr.write(
    `seed-mongo failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  await disconnectMongo();
  process.exit(1);
});
