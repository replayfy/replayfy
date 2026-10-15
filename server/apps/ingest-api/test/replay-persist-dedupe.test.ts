/**
 * A replay batch counts ONCE, however often it is processed. Two ways one
 * batch reaches persist() again:
 *   • an SDK resend under the SAME (session, segment, sequence) key (pagehide
 *     re-delivery, failed-batch retry, next-page outbox, mobile retries). Bull's
 *     jobId only dedupes while the first job is still in Redis (removeOnComplete
 *     keeps 1h / 1000 jobs), so on a busy ingest the resend runs persist() again;
 *   • a Bull retry after an attempt failed part-way (a store blip, a worker
 *     restart), which re-runs everything the failed attempt already did.
 * These tests drive persist() directly against real Postgres and Mongo (see
 * persist-stores.ts), which is what either case does.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProjectionRow } from "@replay/db-clickhouse";
import { workspaceScopedSessionId } from "../src/common/session-id";
import {
  batch,
  captureClickHouse,
  counters,
  type Harness,
  job,
  makeService,
  newSessionId,
  openThrowawayStores,
  sizeOf,
  type Stores,
} from "./persist-stores";

// ClickHouse rows each test batch() projects: console, network, error, two
// performance events and one custom event (clicks and snapshots are not rows).
const CH_ROWS_PER_BATCH = 6;

describe("replay batch counted once", () => {
  let stores: Stores;
  let h: Harness;
  let ch: { rows: ProjectionRow[]; restore: () => void };
  const batchInsertEnv = process.env.CLICKHOUSE_BATCH_INSERT;

  before(async () => {
    stores = await openThrowawayStores("dedupe");
  });

  after(async () => {
    await stores?.drop();
  });

  beforeEach(() => {
    // Awaited projection, so ClickHouse rows are recorded before persist()
    // returns. The batcher-on path has its own test below.
    process.env.CLICKHOUSE_BATCH_INSERT = "0";
    ch = captureClickHouse();
    h = makeService(stores);
  });

  afterEach(() => {
    ch.restore();
    if (batchInsertEnv === undefined) delete process.env.CLICKHOUSE_BATCH_INSERT;
    else process.env.CLICKHOUSE_BATCH_INSERT = batchInsertEnv;
  });

  const chRows = (publicId: string, sequence?: number) =>
    ch.rows.filter(
      (r) =>
        r.session_public_id === publicId &&
        (sequence === undefined || r.sequence === sequence),
    ).length;

  const docs = (workspaceId: number, sessionId: string, sequence: number, segmentId = "seg-1") =>
    stores.mongo.replayBatch.findMany({
      where: { projectId: String(workspaceId), sessionId, sequence, segmentId },
      select: { id: true, persistedAt: true, eventCount: true },
    });

  const segments = async (publicId: string) => {
    const s = await stores.pg.session.findUnique({
      where: { publicId },
      select: { segments: { orderBy: [{ sequence: "asc" }, { segmentPublicId: "asc" }] } },
    });
    return s?.segments ?? [];
  };

  const paths = async (publicId: string) => {
    const s = await stores.pg.session.findUnique({
      where: { publicId },
      select: { paths: { orderBy: { sequence: "asc" } } },
    });
    return (s?.paths ?? []).map((p) => p.url);
  };

  /** Two clean batches (pages /a and /b) of a new session. */
  async function twoBatches() {
    const sid = newSessionId();
    const b1 = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
    const b2 = batch({ sessionId: sid, sequence: 2, url: "https://shop.test/b" });
    return { sid, b1, b2 };
  }

  /** Everything one clean application of b1 then b2 leaves behind. */
  async function assertCountedOnce(
    sid: string,
    b1: ReturnType<typeof batch>,
    b2: ReturnType<typeof batch>,
    chRowsOfBatch2 = CH_ROWS_PER_BATCH,
    storageOfBatch2 = sizeOf(b2),
  ) {
    const c = await counters(stores.pg, sid);
    assert.equal(c.clickCount, 4, "clickCount");
    assert.equal(c.errorCount, 2, "errorCount");
    assert.equal(c.networkCount, 2, "networkCount");
    assert.equal(c.longTaskCount, 2, "longTaskCount");
    assert.equal(c.longTaskTotalMs, 240, "longTaskTotalMs");
    assert.equal(c.dataSizeBytes, sizeOf(b1) + sizeOf(b2), "dataSizeBytes");
    assert.equal(h.followUps.storageBytes, sizeOf(b1) + storageOfBatch2, "workspace storage bump");
    assert.equal(chRows(sid, 1), CH_ROWS_PER_BATCH, "ClickHouse rows of batch 1");
    assert.equal(chRows(sid, 2), chRowsOfBatch2, "ClickHouse rows of batch 2");
    assert.deepEqual(await paths(sid), ["https://shop.test/a", "https://shop.test/b"], "paths");
    const segs = await segments(sid);
    assert.deepEqual(segs.map((s) => [s.sequence, s.segmentPublicId]), [[1, "seg-1"], [2, "seg-1"]]);
    for (const [i, seq] of [1, 2].entries()) {
      const d = await docs(1, sid, seq);
      assert.equal(d.length, 1, `one Mongo batch for sequence ${seq}`);
      assert.ok(d[0].persistedAt instanceof Date, `batch ${seq} marked persisted`);
      assert.equal(segs[i].mongoBatchId, d[0].id, `segment ${seq} points at its Mongo batch`);
    }
  }

  it("skips a resend of a fully persisted batch: every count stays single", async () => {
    const { sid, b1, b2 } = await twoBatches();
    assert.equal(await h.service.persist(job(1, b1)), "persisted");
    assert.equal(await h.service.persist(job(1, b2)), "persisted");
    const bumps = h.followUps.perfDailyBumps;

    // Batch 1 again, after batch 2 moved the session to another page (the
    // next-page outbox case), then batch 2 again (the pagehide re-delivery).
    assert.equal(await h.service.persist(job(1, b1)), "duplicate");
    assert.equal(await h.service.persist(job(1, b2)), "duplicate");

    await assertCountedOnce(sid, b1, b2);
    assert.equal(h.followUps.perfDailyBumps, bumps);
  });

  // A write fails after the session's counts (and ClickHouse rows) went in;
  // Bull retries the job. The retry must finish the batch without adding them
  // again. Each case names the failing write.
  for (const [what, arm] of [
    ["the Mongo write (Mongo down)", (h: Harness) => h.faults.arm("replayBatch.create")],
    ["the page path insert", (h: Harness) => h.faults.arm("sessionPath.create")],
    ["the segment row write", (h: Harness) => h.faults.arm("sessionSegment.upsert")],
  ] as const) {
    it(`counts a batch once when ${what} fails and Bull retries it`, async () => {
      const { sid, b1, b2 } = await twoBatches();
      await h.service.persist(job(1, b1));

      arm(h);
      await assert.rejects(h.service.persist(job(1, b2)), /injected failure/);
      const unmarked = await docs(1, sid, 2);
      assert.ok(unmarked.every((d) => d.persistedAt === null), "a failed attempt never marks the batch");

      assert.equal(await h.service.persist(job(1, b2)), "persisted", "Bull's retry runs, it is not a duplicate");
      await assertCountedOnce(sid, b1, b2);

      // ...and a resend after that is skipped.
      assert.equal(await h.service.persist(job(1, b2)), "duplicate");
      await assertCountedOnce(sid, b1, b2);
    });
  }

  it("counts a batch once when the counts statement's reply is lost after it committed", async () => {
    const { sid, b1, b2 } = await twoBatches();
    await h.service.persist(job(1, b1));
    // The claim and the counts committed; the worker never learned it (a
    // dropped connection, or a worker killed at that instant).
    h.faults.armAfter("session.applyCounts");
    await assert.rejects(h.service.persist(job(1, b2)), /injected failure/);
    assert.equal(await h.service.persist(job(1, b2)), "persisted");
    // The trade-off, on purpose: the retry cannot know whether the lost
    // attempt queued the batch's ClickHouse rows, so it does not, and their
    // storage bump goes with them. Dropped, never doubled.
    await assertCountedOnce(sid, b1, b2, 0, 0n);
  });

  it("counts a session's FIRST batch once when a write after the session insert fails", async () => {
    const { sid, b1, b2 } = await twoBatches();
    h.faults.arm("sessionPath.create");
    await assert.rejects(h.service.persist(job(1, b1)), /injected failure/);
    assert.equal(await h.service.persist(job(1, b1)), "persisted");
    assert.equal(h.followUps.sessionsTotal, 1, "the session counted once in the workspace");
    await h.service.persist(job(1, b2));
    await assertCountedOnce(sid, b1, b2);
  });

  // The new Session row went in without the batch's counts (the claim
  // statement right after it adds them); the attempt dies in between. The
  // retry finds the session, takes the update path and adds the counts once.
  for (const [what, arm] of [
    ["the session insert's reply is lost", (h: Harness) => h.faults.armAfter("session.create")],
    ["the counts statement after the session insert fails", (h: Harness) => h.faults.arm("session.applyCounts")],
  ] as const) {
    it(`counts a session's FIRST batch once when ${what}`, async () => {
      const sid = newSessionId();
      const b1 = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
      arm(h);
      await assert.rejects(h.service.persist(job(1, b1)), /injected failure/);
      assert.equal(await h.service.persist(job(1, b1)), "persisted");
      const c = await counters(stores.pg, sid);
      assert.equal(c.clickCount, 2);
      assert.equal(c.longTaskCount, 1);
      assert.equal(c.longTaskTotalMs, 120);
      assert.equal(c.dataSizeBytes, sizeOf(b1));
      assert.equal(h.followUps.storageBytes, sizeOf(b1));
      assert.equal(chRows(sid), CH_ROWS_PER_BATCH);
      assert.deepEqual(await paths(sid), ["https://shop.test/a"]);
      assert.equal((await segments(sid)).length, 1);
    });
  }

  it("writes the marker in ONE Mongo operation and never reads the events blob back", async () => {
    const { sid, b1, b2 } = await twoBatches();
    await h.service.persist(job(1, b1));

    stores.mongoQueries.length = 0;
    await h.service.persist(job(1, b2));
    const readsBlob = (q: string) => /\$project: \{[^}]*\bevents: 1/.test(q);
    assert.deepEqual(stores.mongoQueries.filter(readsBlob), [], "no query reads the events back");
    // The lookup (1), the insert and Prisma's id read of it (2), the marker (1).
    assert.equal(stores.mongoQueries.length, 4, stores.mongoQueries.join("\n"));
    assert.match(stores.mongoQueries[3], /runCommand|update/);

    // A retry that rewrites a stored, unmarked batch reads nothing back either.
    const b3 = batch({ sessionId: sid, sequence: 3, url: "https://shop.test/b" });
    h.faults.arm("sessionSegment.upsert");
    await assert.rejects(h.service.persist(job(1, b3)));
    stores.mongoQueries.length = 0;
    await h.service.persist(job(1, b3));
    assert.deepEqual(stores.mongoQueries.filter(readsBlob), []);
  });

  it("keeps the stored copy when a persisted key comes back with other events", async () => {
    const sid = newSessionId();
    const first = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
    await h.service.persist(job(1, first));
    const before = await counters(stores.pg, sid);
    const rowsBefore = chRows(sid);

    const other = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a", extraClicks: 3 });
    assert.equal(await h.service.persist(job(1, other)), "duplicate");

    assert.deepEqual(await counters(stores.pg, sid), before);
    assert.equal(chRows(sid), rowsBefore);
    const [doc] = await docs(1, sid, 1);
    assert.equal(doc.eventCount, first.events.length, "Mongo keeps the first events");
  });

  it("does not fail the job when only the marker cannot be written, and still counts a resend once", async () => {
    const { sid, b1, b2 } = await twoBatches();
    await h.service.persist(job(1, b1));
    h.faults.arm("replayBatch.markPersisted");
    // Every side effect landed; failing now would only make Bull redo them.
    assert.equal(await h.service.persist(job(1, b2)), "persisted");
    assert.equal((await docs(1, sid, 2))[0].persistedAt, null);

    // The unmarked batch's resend runs again, adds nothing, and marks it.
    assert.equal(await h.service.persist(job(1, b2)), "persisted");
    await assertCountedOnce(sid, b1, b2);
  });

  it("counts a resend of a batch stored before the marker existed once", async () => {
    const { sid, b1, b2 } = await twoBatches();
    await h.service.persist(job(1, b1));
    await h.service.persist(job(1, b2));
    // What a batch persisted by the previous release looks like: no marker
    // (its segment row was written as now).
    await stores.mongo.$runCommandRaw({
      update: "ReplayBatch",
      updates: [{ q: { projectId: "1", sessionId: sid, sequence: 2 }, u: { $unset: { persistedAt: "" } } }],
    });

    assert.equal(await h.service.persist(job(1, b2)), "persisted", "unmarked: it runs");
    await assertCountedOnce(sid, b1, b2);
  });

  it("treats the same sequence in a new segment (a reload) as a new batch", async () => {
    // Also the transition case: until the follow-up migration drops it, the
    // deprecated SessionSegment (sessionId, sequence) unique rejects the
    // reload's batch 1, which must not be mistaken for "already counted".
    const sid = newSessionId();
    const load1 = batch({ sessionId: sid, segmentId: "seg-1", sequence: 1, url: "https://shop.test/a" });
    const load2 = batch({ sessionId: sid, segmentId: "seg-2", sequence: 1, url: "https://shop.test/b" });
    const load2b = batch({ sessionId: sid, segmentId: "seg-2", sequence: 2, url: "https://shop.test/b" });
    assert.equal(await h.service.persist(job(1, load1)), "persisted");
    assert.equal(await h.service.persist(job(1, load2)), "persisted");
    assert.equal(await h.service.persist(job(1, load2b)), "persisted");
    assert.equal((await counters(stores.pg, sid)).clickCount, 6);
    assert.equal(chRows(sid), 3 * CH_ROWS_PER_BATCH);
    assert.equal((await docs(1, sid, 1, "seg-2")).length, 1);

    // And seg-2's batch 2, which no earlier load used, is claimed: its retry
    // after a failure is counted once.
    h.faults.arm("sessionSegment.upsert");
    const load2c = batch({ sessionId: sid, segmentId: "seg-2", sequence: 3, url: "https://shop.test/b" });
    await assert.rejects(h.service.persist(job(1, load2c)));
    await h.service.persist(job(1, load2c));
    assert.equal((await counters(stores.pg, sid)).clickCount, 8);
  });

  it("stores the segment row's times as UTC wall time, like Prisma's own writes, in any server TimeZone", async () => {
    // The counts statement writes the segment row's times (startedAt stays as
    // written; upsertSegment later rewrites endedAt through Prisma).
    const [{ db }] = await stores.pg.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    await stores.pg.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Asia/Tokyo'`);
    await stores.pg.$disconnect(); // new connections pick the setting up
    try {
      const [{ tz }] = await stores.pg.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
      assert.equal(tz, "Asia/Tokyo");
      const { sid, b1, b2 } = await twoBatches();
      await h.service.persist(job(1, b1));
      await h.service.persist(job(1, b2));
      const segs = await segments(sid);
      assert.equal(segs[0].startedAt.getTime(), b1.events[0].ts);
      assert.equal(segs[1].startedAt.getTime(), b2.events[0].ts);
      const s = await stores.pg.session.findUnique({ where: { publicId: sid } });
      assert.equal(s?.startedAt.getTime(), b1.events[0].ts, "Prisma's own write, for comparison");
    } finally {
      await stores.pg.$executeRawUnsafe(`ALTER DATABASE "${db}" RESET timezone`);
      await stores.pg.$disconnect();
    }
  });

  it("never treats another workspace's batch under the same key as a resend", async () => {
    const sid = newSessionId();
    const b1 = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
    assert.equal(await h.service.persist(job(1, b1)), "persisted");
    const ws1Before = await counters(stores.pg, sid);

    assert.equal(await h.service.persist(job(2, b1)), "persisted");
    const derived = workspaceScopedSessionId(2, sid);
    assert.equal((await counters(stores.pg, derived)).clickCount, 2);
    assert.deepEqual(await counters(stores.pg, sid), ws1Before);
    assert.equal((await docs(2, derived, 1)).length, 1);

    // ...and that workspace's own resend is deduped against ITS batch.
    assert.equal(await h.service.persist(job(2, b1)), "duplicate");
    assert.equal((await counters(stores.pg, derived)).clickCount, 2);
  });

  it("re-files, marks and dedupes a batch whose session moved to its workspace-scoped id mid-job", async () => {
    // Workspace 2 creates the raw id between workspace 1's lookup and insert:
    // workspace 1's insert hits the unique publicId (a real P2002), and its
    // session moves to the derived id after its Mongo write started under the
    // raw one.
    const sid = newSessionId();
    const theirs = batch({ sessionId: sid, sequence: 1, url: "https://other.test/x" });
    const mine = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
    h.faults.hook("session.create", async () => {
      const other = makeService(stores);
      await other.service.persist(job(2, theirs));
    });
    assert.equal(await h.service.persist(job(1, mine)), "persisted");

    const derived = workspaceScopedSessionId(1, sid);
    assert.equal((await counters(stores.pg, derived)).clickCount, 2);
    assert.equal((await counters(stores.pg, sid)).clickCount, 2, "workspace 2's session untouched");
    assert.equal((await stores.pg.session.findUnique({ where: { publicId: sid } }))?.workspaceId, 2);
    assert.equal((await docs(1, sid, 1)).length, 0, "nothing left under the raw id for workspace 1");
    const [doc] = await docs(1, derived, 1);
    assert.ok(doc?.persistedAt instanceof Date, "re-filed under the derived id and marked");
    assert.equal((await segments(derived))[0]?.mongoBatchId, doc.id);

    // The SDK resends under the raw id: found under the derived one.
    const before = await counters(stores.pg, derived);
    assert.equal(await h.service.persist(job(1, mine)), "duplicate");
    assert.deepEqual(await counters(stores.pg, derived), before);
    assert.equal(chRows(derived), CH_ROWS_PER_BATCH);
  });

  it("skips a resend with the ClickHouse insert batcher on, too", async () => {
    process.env.CLICKHOUSE_BATCH_INSERT = "1";
    const sid = newSessionId();
    const b1 = batch({ sessionId: sid, sequence: 1, url: "https://shop.test/a" });
    assert.equal(await h.service.persist(job(1, b1)), "persisted");
    // The projection is not awaited in this mode: let it finish.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(chRows(sid), CH_ROWS_PER_BATCH);
    const before = await counters(stores.pg, sid);

    assert.equal(await h.service.persist(job(1, b1)), "duplicate");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(chRows(sid), CH_ROWS_PER_BATCH);
    assert.deepEqual(await counters(stores.pg, sid), before);
  });
});
