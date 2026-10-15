/**
 * Re-finalizing a mobile session must be APPEND-SAFE: the frames archive is
 * only ever replaced by a superset of itself, an empty archive is never
 * stored, and the session's counters never go down. A cancelled session is
 * the exception: it is discarded, whatever an earlier finalize stored.
 *
 * Drives the real entry points — the orphan poll (pollExpired) and the owning
 * worker's tick — against a real Redis.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type Redis from "ioredis";
import { FramesFinalizerService } from "../src/frames/frames-finalizer.service";
import { FramesStreamService } from "../src/frames/frames-stream.service";
import { FramesWorkerService } from "../src/frames/frames-worker.service";
import {
  finalizeLockKey,
  framesCancelKey,
  framesOwnerKey,
  framesStreamKey,
  SESSION_EXPIRY_ZSET,
} from "../src/frames/frames.constants";
import type { WorkspaceStatsService } from "../src/workspace-stats/workspace-stats.service";
import type { SignalsService } from "../src/signals/signals.service";
import {
  archiveTimestamps,
  FakeSessions,
  FakeStats,
  FakeStorage,
  frames,
  newSid,
  openTestRedis,
  sleep,
  useFakeDb,
} from "./helpers";

const FRAME_BYTES = 12 + 16; // one helpers.frame() record

describe("frames finalize is append-safe", () => {
  let redis: Redis;
  const sids: string[] = [];

  before(async () => {
    redis = await openTestRedis(14);
  });

  after(async () => {
    for (const sid of sids) {
      await redis.del(
        framesStreamKey(sid),
        finalizeLockKey(sid),
        framesCancelKey(sid),
        framesOwnerKey(sid),
      );
      await redis.zrem(SESSION_EXPIRY_ZSET, sid);
    }
    await redis.quit();
  });

  /** A fresh pipeline (finalizer, worker, ingest stream) over one session. */
  function setup() {
    const storage = new FakeStorage();
    const sessions = new FakeSessions();
    const stats = new FakeStats();
    const signals = { deriveForSession: async () => {} };
    const finalizer = new FramesFinalizerService(
      redis,
      storage.asService(),
      stats as unknown as WorkspaceStatsService,
      signals as unknown as SignalsService,
    );
    useFakeDb(finalizer, sessions);
    const ingest = new FramesStreamService(redis);
    const worker = new FramesWorkerService(redis, storage.asService(), finalizer);
    const sid = newSid();
    sids.push(sid);
    const t0 = Date.now() - 60 * 60_000; // device start, an hour ago
    const row = sessions.add({ publicId: sid, startedAt: new Date(t0) });
    /** Drop the session's expiry score into the past, as /late does. */
    const end = () => ingest.markEnded(sid, Date.now());
    /** The retained stream's TTL running out. */
    const expireStream = () => redis.del(framesStreamKey(sid));
    return { storage, sessions, stats, finalizer, ingest, worker, sid, t0, row, end, expireStream };
  }

  /**
   * `n` ended sessions, older than any other, each waiting out a failed
   * finalize's retry backoff: the state a failed finalize leaves (its expiry
   * score, and its lock until the TTL runs out). They have no Session row.
   */
  async function backingOff(n: number) {
    const ids = Array.from({ length: n }, () => newSid());
    const oldest = Date.now() - 2 * 60 * 60_000;
    const pipe = redis.pipeline();
    ids.forEach((sid, i) => {
      pipe.zadd(SESSION_EXPIRY_ZSET, String(oldest + i), sid);
      pipe.set(finalizeLockKey(sid), "1", "PX", 10 * 60_000);
    });
    await pipe.exec();
    const remove = async () => {
      const del = redis.pipeline();
      for (const sid of ids) {
        del.zrem(SESSION_EXPIRY_ZSET, sid);
        del.del(finalizeLockKey(sid));
      }
      await del.exec();
    };
    return { ids, remove };
  }

  it("leaves the archive and counters alone when the stream has expired (the /late wipe)", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000, s.t0 + 3_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();
    const archived = s.storage.archive(s.sid);
    assert.ok(archived, "first finalize stores the archive");
    const first = s.sessions.get(s.row.id);
    assert.equal(first.nativeSnapshotCount, 3);

    // 40 minutes later the SDK ends the session on return: /late, empty stream.
    await s.expireStream();
    await s.end();
    await s.finalizer.pollExpired();

    assert.ok(s.storage.archive(s.sid)?.equals(archived), "archive untouched");
    const after = s.sessions.get(s.row.id);
    assert.equal(after.nativeSnapshotCount, 3);
    assert.equal(after.dataSizeBytes, first.dataSizeBytes);
    assert.equal(after.durationMs, first.durationMs);
    assert.equal(after.endedAt.getTime(), first.endedAt.getTime(), "endedAt not moved to the return time");
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "stood down");
  });

  it("merges frames that arrive after the stream expired into the archive", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000, s.t0 + 3_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    // Frames resume after the retained stream expired (long background, or a
    // paused screen), then the session idles out again.
    await s.expireStream();
    await s.ingest.append(s.sid, frames(s.t0 + 60_000, s.t0 + 61_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [1_000, 2_000, 3_000, 60_000, 61_000].map((d) => s.t0 + d),
    );
    const row = s.sessions.get(s.row.id);
    assert.equal(row.nativeSnapshotCount, 5);
    assert.equal(row.dataSizeBytes, BigInt(5 * FRAME_BYTES));
    assert.equal(row.durationMs, 61_000);
    assert.equal(s.stats.storageBytes, BigInt(5 * FRAME_BYTES));
    assert.equal(s.storage.openUploads, 0, "no multipart left staged");
  });

  it("dedupes a retained stream against the archive by frame timestamp", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    // Still inside the retention window: a retried batch repeats 2_000.
    await s.ingest.append(s.sid, frames(s.t0 + 2_000, s.t0 + 3_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [1_000, 2_000, 3_000].map((d) => s.t0 + d),
    );
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 3);
  });

  it("never stores an empty archive and keeps the bytes /i counted", async () => {
    const s = setup();
    s.sessions.rows.get(s.row.id)!.dataSizeBytes = 500n; // message bytes
    await s.end(); // /late on a session that never sent a frame
    await s.finalizer.pollExpired();

    assert.equal(s.storage.archive(s.sid), undefined, "no archive stored");
    const row = s.sessions.get(s.row.id);
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.nativeSnapshotCount, 0);
    assert.equal(row.dataSizeBytes, 500n);
  });

  it("leaves the archive alone and retries later when R2 can't be read", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();
    const archived = s.storage.archive(s.sid) as Buffer;

    await s.expireStream();
    await s.ingest.append(s.sid, frames(s.t0 + 5_000), Date.now());
    await s.end();
    s.storage.failReads = true;
    await s.finalizer.pollExpired();

    assert.ok(s.storage.archive(s.sid)?.equals(archived), "archive untouched");
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 1);
    assert.notEqual(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "still queued");
    assert.equal(await redis.xlen(framesStreamKey(s.sid)), 1, "new frames kept");

    // R2 recovers; the lock's TTL (the retry backoff) runs out.
    s.storage.failReads = false;
    await redis.del(finalizeLockKey(s.sid));
    await s.finalizer.pollExpired();
    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [s.t0 + 1_000, s.t0 + 5_000],
    );
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 2);
  });

  it("merges on the owning worker's path too, through the orphan poll", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000), Date.now());
    await s.worker.tick(); // lease + drain into the warm upload
    await s.end();
    await s.worker.tick(); // owned finalize
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 2);

    await s.expireStream();
    await s.ingest.append(s.sid, frames(s.t0 + 9_000), Date.now());
    await s.worker.tick(); // warm upload now holds only the new frame
    await s.end();
    await s.worker.tick(); // hands the merge over: lease and lock released
    assert.equal(await redis.exists(framesOwnerKey(s.sid)), 0);
    await s.finalizer.pollExpired();

    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [1_000, 2_000, 9_000].map((d) => s.t0 + d),
    );
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 3);
    assert.equal(s.storage.openUploads, 0, "discarded warm upload was aborted");
    await s.worker.onModuleDestroy();
  });

  it("keeps a session active when a batch lands while it is being finalized", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
    await s.end();
    s.storage.onComplete = async () => {
      s.storage.onComplete = null;
      await s.ingest.append(s.sid, frames(s.t0 + 2_000), Date.now());
    };
    await s.finalizer.pollExpired();

    const score = await redis.zscore(SESSION_EXPIRY_ZSET, s.sid);
    assert.ok(score !== null && Number(score) > Date.now(), "re-arm survives cleanup");
    assert.equal(await redis.pttl(framesStreamKey(s.sid)), -1, "no retention TTL on unarchived frames");
    assert.equal(await redis.exists(finalizeLockKey(s.sid)), 0, "lock released");

    await s.end();
    await s.finalizer.pollExpired();
    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [s.t0 + 1_000, s.t0 + 2_000],
    );
  });

  it("records an archive a failed finalize stored, when the retry adds nothing", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000, s.t0 + 3_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    await s.expireStream();
    await s.ingest.append(s.sid, frames(s.t0 + 60_000, s.t0 + 61_000), Date.now());
    await s.end();
    // The merged archive reaches R2, then the Postgres write fails (a pool
    // timeout, a failover, or the process dying between the two).
    const update = s.sessions.update.bind(s.sessions);
    let failed = false;
    s.sessions.update = async (args) => {
      if (!failed) {
        failed = true;
        throw new Error("Can't reach database server");
      }
      return update(args);
    };
    await s.finalizer.pollExpired();
    assert.equal(archiveTimestamps(s.storage.archive(s.sid) as Buffer).length, 5);
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 3, "not recorded yet");

    // The lock's TTL (the retry backoff) runs out; the retry's merge finds
    // every stream frame already archived.
    await redis.del(finalizeLockKey(s.sid));
    await s.finalizer.pollExpired();

    const row = s.sessions.get(s.row.id);
    assert.equal(row.nativeSnapshotCount, 5, "count matches the stored archive");
    assert.equal(row.durationMs, 61_000);
    assert.equal(row.dataSizeBytes, BigInt(5 * FRAME_BYTES));
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "stood down");
  });

  it("never lowers a duration /i raised while the archive was uploading", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000), Date.now());
    await s.end();
    // A tap at +10 min lands (/i) between the finalize's row read and its write.
    s.storage.onComplete = async () => {
      s.storage.onComplete = null;
      await s.sessions.update({ where: { id: s.row.id }, data: { durationMs: 600_000 } });
    };
    await s.finalizer.pollExpired();

    const row = s.sessions.get(s.row.id);
    assert.equal(row.nativeSnapshotCount, 2);
    assert.equal(row.durationMs, 600_000);
  });

  it("discards a cancelled session's archive from an earlier finalize", async () => {
    const s = setup();
    // Message bytes /i counted, into the row and the workspace's stats.
    s.sessions.rows.get(s.row.id)!.dataSizeBytes = 100n;
    s.stats.storageBytes = 100n;
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();
    const before = s.sessions.get(s.row.id);
    assert.equal(before.nativeSnapshotCount, 2);

    // The app calls cancelSession() (POST /v1/mobile/cancel).
    await s.ingest.drop(s.sid, Date.now());
    await s.finalizer.pollExpired();

    assert.equal(s.storage.archive(s.sid), undefined, "archive deleted");
    const row = s.sessions.get(s.row.id);
    assert.equal(row.nativeSnapshotCount, 0, "the player's \"no replay\"");
    assert.equal(row.dataSizeBytes, 0n);
    assert.equal(row.endedAt.getTime(), before.endedAt.getTime(), "end not moved");
    assert.equal(s.stats.storageBytes, 0n, "storage stats back down");
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "stood down");

    // A frames batch that was still in flight is discarded too.
    await s.ingest.append(s.sid, frames(s.t0 + 3_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();
    assert.equal(s.storage.archive(s.sid), undefined);
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 0);
  });

  it("doesn't archive the frames a worker drained before a cancel", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000, s.t0 + 2_000), Date.now());
    await s.worker.tick(); // lease + drain into the warm upload
    await s.ingest.drop(s.sid, Date.now());
    await s.worker.tick(); // owned finalize

    assert.equal(s.storage.archive(s.sid), undefined);
    const row = s.sessions.get(s.row.id);
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.nativeSnapshotCount, 0);
    assert.equal(s.storage.openUploads, 0, "warm upload aborted");
    await s.worker.onModuleDestroy();
  });

  it("keeps a session cancelled mid-finalize queued, and discards it next", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
    await s.end();
    s.storage.onComplete = async () => {
      s.storage.onComplete = null;
      await s.ingest.drop(s.sid, Date.now());
    };
    await s.finalizer.pollExpired();
    assert.ok(s.storage.archive(s.sid), "this pass stored it before the cancel");
    assert.notEqual(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "still queued");

    await s.finalizer.pollExpired();
    assert.equal(s.storage.archive(s.sid), undefined);
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 0);
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null);
  });

  it("retries a cancel whose R2 delete failed", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    await s.ingest.drop(s.sid, Date.now());
    s.storage.failDeletes = true;
    await s.finalizer.pollExpired();
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 1, "not recorded as gone");
    assert.notEqual(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "still queued");

    s.storage.failDeletes = false;
    await redis.del(finalizeLockKey(s.sid)); // the retry backoff runs out
    await s.finalizer.pollExpired();
    assert.equal(s.storage.archive(s.sid), undefined);
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 0);
  });

  it("keeps a whole-archive merge out of the worker's tick", async () => {
    const s = setup();
    await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
    await s.end();
    await s.finalizer.pollExpired();

    // Frames resume; this worker owns the session, and another one.
    await s.ingest.append(s.sid, frames(s.t0 + 5_000), Date.now());
    const other = setup();
    await other.ingest.append(other.sid, frames(other.t0 + 1_000), Date.now());
    await s.worker.tick();
    assert.equal(await redis.exists(framesOwnerKey(s.sid)), 1);
    await s.end();

    // R2 reads hang (a large archive, a slow bucket): a tick that merges
    // inline would hang with them, and every other lease would lapse.
    let release!: () => void;
    s.storage.readGate = new Promise<void>((r) => (release = r));
    const tick = s.worker.tick().then(() => "done");
    const outcome = await Promise.race([tick, sleep(1_000).then(() => "stalled")]);
    release();
    await tick;
    assert.equal(outcome, "done");
    assert.equal(s.storage.reads, 0, "the worker read no archive");
    assert.equal(await redis.exists(framesOwnerKey(s.sid)), 0, "lease handed back");
    assert.equal(await redis.exists(framesOwnerKey(other.sid)), 1, "other lease held");

    s.storage.readGate = null;
    await s.finalizer.pollExpired();
    assert.deepEqual(
      archiveTimestamps(s.storage.archive(s.sid) as Buffer),
      [s.t0 + 1_000, s.t0 + 5_000],
    );
    assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 2);
    await s.worker.onModuleDestroy();
  });

  it("finalizes the sessions behind a page of failed finalizes waiting to retry", async () => {
    // A finalize that keeps failing keeps its expiry score, so it stays at
    // the head of the ended range. Reading only the oldest page each tick, a
    // page of those hid every session behind them.
    const failed = await backingOff(100);
    try {
      const s = setup();
      await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
      await s.end();
      await s.finalizer.pollExpired();
      assert.deepEqual(archiveTimestamps(s.storage.archive(s.sid) as Buffer), [s.t0 + 1_000]);
      assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 1);
      assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, s.sid), null, "stood down");
    } finally {
      await failed.remove();
    }
  });

  it("resumes its walk where a tick stopped, and starts over from the oldest", async () => {
    // More of them than one tick reads: the next tick carries on behind them,
    // rather than reading the same ones again.
    const failed = await backingOff(1_050);
    try {
      const s = setup();
      await s.ingest.append(s.sid, frames(s.t0 + 1_000), Date.now());
      await s.end();
      await s.finalizer.pollExpired();
      assert.equal(s.storage.archive(s.sid), undefined, "beyond one tick's reach");
      await s.finalizer.pollExpired();
      assert.equal(s.sessions.get(s.row.id).nativeSnapshotCount, 1);

      // The oldest one's backoff runs out. Past the newest ended session, the
      // walk starts over from the oldest and retries it; with no Session row,
      // the retry just stands it down.
      const [oldest] = failed.ids;
      await redis.del(finalizeLockKey(oldest));
      await s.finalizer.pollExpired();
      assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, oldest), null);
    } finally {
      await failed.remove();
    }
  });
});
