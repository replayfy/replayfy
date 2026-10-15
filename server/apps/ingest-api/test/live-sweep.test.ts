/**
 * A native session must not be listed before its frames archive exists.
 *
 * The Recordings list hides LIVE native sessions, so a native session is
 * listed when it turns COMPLETED. The frames finalizer completes it in the
 * same step that records its archive; the per-minute LIVE sweep must leave it
 * LIVE while that finalize is still to come (frames arriving, or ended and not
 * yet finalized), and only complete it itself once no finalize is pending,
 * the frames grace has passed, or the finalize is overdue. Web and frameless
 * rows flip as before. GET /frames says `pending` while a finalize is to come
 * (or is overdue, for up to 2.5 days), so the player can tell "processing"
 * from "no snapshots". A user's page (session list, activity feed, header
 * figures) and AUTO playlists hide the same unfinished native sessions as the
 * Recordings list.
 *
 * Postgres is the in-memory FakeSessions; the expiry scores live in a real
 * Redis (DB 12), the pipeline's own.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { RetentionService } from "../src/retention/retention.service";
import { FramesStreamService } from "../src/frames/frames-stream.service";
import { FramesFinalizerService } from "../src/frames/frames-finalizer.service";
import { FramesArchiveService } from "../src/frames/frames-archive.service";
import { MobileFramesService } from "../src/sessions/mobile-frames.service";
import { SessionsController } from "../src/sessions/sessions.controller";
import { SessionsService } from "../src/sessions/sessions.service";
import { ShareController } from "../src/sessions/share.controller";
import { EndUsersController } from "../src/end-users/end-users.controller";
import { EndUsersService } from "../src/end-users/end-users.service";
import { PlaylistsService } from "../src/playlists/playlists.service";
import { NATIVE_PLAYABLE_FILTER } from "../src/common/native-playable";
import {
  FINALIZE_LOCK_TTL_MS,
  FINALIZE_OVERDUE_MAX_MS,
  finalizeLockKey,
  framesCancelKey,
  framesMpKey,
  framesStreamKey,
  nativeSweepGraceMs,
  SESSION_EXPIRY_ZSET,
} from "../src/frames/frames.constants";
import type { QueueService } from "../src/queue/queue.service";
import type { NotificationsService } from "../src/notifications/notifications.service";
import type { BillingPort as BillingService } from "../src/billing/billing.port";
import type { SignalsService } from "../src/signals/signals.service";
import type { WorkspaceStatsService } from "../src/workspace-stats/workspace-stats.service";
import type { CohortsService } from "../src/cohorts/cohorts.service";
import type { SessionReaperService } from "../src/billing/session-reaper.service";
import {
  FakeSessions,
  FakeStats,
  FakeStorage,
  frames,
  newSid,
  openTestRedis,
  type SessionRow,
  useFakeDb,
} from "./helpers";

/** Remove every key these tests gave `sids`, in one round-trip. */
async function cleanUp(redis: Redis, sids: readonly string[]): Promise<void> {
  const pipe = redis.pipeline();
  for (const sid of sids) {
    pipe.del(framesStreamKey(sid), finalizeLockKey(sid), framesMpKey(sid));
    pipe.zrem(SESSION_EXPIRY_ZSET, sid);
  }
  await pipe.exec();
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("native sessions are listed only once their frames archive exists", () => {
  let redis: Redis;
  const sids: string[] = [];

  before(async () => {
    redis = await openTestRedis(12);
  });

  after(async () => {
    await cleanUp(redis, sids);
    await redis.quit();
  });

  /** The LIVE sweep over a fresh fake Session table. */
  function setup() {
    const sessions = new FakeSessions();
    const stream = new FramesStreamService(redis);
    const derived: number[] = [];
    let settles = 0;
    const signals = {
      deriveForSessions: async (ids: number[]) => {
        derived.push(...ids);
      },
    };
    const billing = {
      settleSweep: async () => {
        settles += 1;
      },
    };
    const retention = new RetentionService(
      {} as QueueService,
      {} as NotificationsService,
      billing as unknown as BillingService,
      signals as unknown as SignalsService,
      stream,
    );
    (retention as unknown as { pg: unknown }).pg = { session: sessions };
    /** A session row; its sid is cleaned up after the suite. */
    const add = (
      endedAgoMs: number,
      platform: string | null,
      extra: Partial<SessionRow> = {},
    ) => {
      const sid = newSid();
      sids.push(sid);
      const endedAt = new Date(Date.now() - endedAgoMs);
      return sessions.add({ publicId: sid, platform, endedAt, startedAt: endedAt, ...extra });
    };
    /** Arm the session's expiry score `offsetMs` from now (negative = ended). */
    const score = (sid: string, offsetMs: number) =>
      redis.zadd(SESSION_EXPIRY_ZSET, String(Date.now() + offsetMs), sid);
    const status = (id: number) => sessions.get(id).status;
    return {
      sessions,
      stream,
      retention,
      derived,
      settles: () => settles,
      add,
      score,
      status,
    };
  }

  it("holds a native LIVE session while frames are still arriving", async () => {
    const s = setup();
    // Its last /i activity is long past the grace, but frames keep the expiry
    // score in the future (no /i activity while the user just watches).
    const row = s.add(10 * MIN, "ios");
    await s.score(row.publicId, 100_000);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "LIVE");
    assert.deepEqual(s.derived, []);
    assert.equal(s.settles(), 1, "billing's settle judge still runs");
  });

  it("holds a native session that ended but is not finalized yet", async () => {
    const s = setup();
    const row = s.add(4 * MIN, "android");
    await s.score(row.publicId, -30_000); // ended 30 s ago, finalizer not there yet
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "LIVE");
  });

  it("completes it once the finalize has stood it down (score removed)", async () => {
    const s = setup();
    const row = s.add(4 * MIN, "ios");
    await s.score(row.publicId, -30_000);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "LIVE");

    await redis.zrem(SESSION_EXPIRY_ZSET, row.publicId);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "COMPLETED");
    assert.deepEqual(s.derived, [row.id], "the flipped session is derived");
  });

  it("holds it while its finalize runs minutes after the end, and /frames says pending", async () => {
    // The reviewer's in-flight case: the session ended 125 s ago and its
    // finalize (a backlog, a long rebuild) is only now uploading the archive.
    const s = setup();
    const storage = new FakeStorage();
    const finalizer = new FramesFinalizerService(
      redis,
      storage.asService(),
      new FakeStats() as unknown as WorkspaceStatsService,
      { deriveForSession: async () => {} } as unknown as SignalsService,
    );
    useFakeDb(finalizer, s.sessions);
    const player = new MobileFramesService(
      new FramesArchiveService(storage.asService()),
      s.stream,
    );
    useFakeDb(player, s.sessions);
    const row = s.add(5 * MIN, "ios");
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000, t0 + 2_000), Date.now());
    await s.score(row.publicId, -125_000);
    // Hold the upload's completion open until the sweep has run.
    let reached!: () => void;
    const atUpload = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const complete = storage.completeMultipartUpload.bind(storage);
    storage.completeMultipartUpload = async (o) => {
      reached();
      await gate;
      return complete(o);
    };
    assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
    const finalize = finalizer.finalize(row.publicId, null);
    await atUpload;

    try {
      await s.retention.sweepLiveSessions();
      assert.equal(s.status(row.id), "LIVE", "not listed before the archive exists");
      const during = await player.getFrames(row.workspaceId, row.publicId);
      assert.equal(during.url, null);
      assert.equal(during.pending, true, "the player waits instead of 'no snapshots'");
    } finally {
      release(); // even on a failed assertion, so the finalize can't hang the run
    }
    assert.equal(await finalize, true);
    const done = s.sessions.get(row.id);
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.nativeSnapshotCount, 2);
    assert.ok(storage.archive(row.publicId));
  });

  it("holds it while a failed finalize waits out its lock to retry", async () => {
    // A finalize that throws leaves its 5-min lock as the retry backoff; the
    // retry must still come before the session is listed.
    const s = setup();
    const row = s.add(9 * MIN, "android");
    await s.score(row.publicId, -(5 * MIN + 10_000));
    await redis.set(finalizeLockKey(row.publicId), "1", "PX", 1_000);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "LIVE");
    assert.equal(FINALIZE_LOCK_TTL_MS, 5 * MIN);
    assert.ok(FINALIZE_OVERDUE_MAX_MS > FINALIZE_LOCK_TTL_MS);
  });

  it("completes it once its finalize is overdue, with an endedAt billing settles", async () => {
    const s = setup();
    // Frames arrived for 20 min with no /i activity, so endedAt stayed at the
    // start; the finalize then kept failing.
    const overdue = s.add(20 * MIN, "ios");
    await s.score(overdue.publicId, -(FINALIZE_OVERDUE_MAX_MS + 5_000));
    // Neither of these was waiting on a finalize: their endedAt is real.
    const frameless = s.add(nativeSweepGraceMs() + 5_000, "android");
    const web = s.add(2 * MIN, "web");
    const before = Date.now();
    await s.retention.sweepLiveSessions();

    const done = s.sessions.get(overdue.id);
    assert.equal(done.status, "COMPLETED");
    assert.ok(
      done.endedAt.getTime() >= before,
      "stamped when completed, as the finalizer would, so it settles 3-10 min later",
    );
    assert.equal(s.status(frameless.id), "COMPLETED");
    assert.equal(s.sessions.get(frameless.id).endedAt.getTime(), frameless.endedAt.getTime());
    assert.equal(s.status(web.id), "COMPLETED");
    assert.equal(s.sessions.get(web.id).endedAt.getTime(), web.endedAt.getTime());
    assert.deepEqual(s.derived.sort(), [overdue.id, frameless.id, web.id].sort());
  });

  /** The sweep's warn lines from here on (its other log lines are dropped). */
  function captureWarns(retention: RetentionService): string[] {
    const warns: string[] = [];
    (retention as unknown as { logger: unknown }).logger = {
      log: () => {},
      warn: (line: string) => warns.push(line),
    };
    return warns;
  }

  it("warns with how many sessions it completed with their finalize overdue", async () => {
    const s = setup();
    const warns = captureWarns(s.retention);
    const overdue = s.add(20 * MIN, "ios");
    await s.score(overdue.publicId, -(FINALIZE_OVERDUE_MAX_MS + 5_000));
    const web = s.add(2 * MIN, "web");
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(overdue.id), "COMPLETED");
    assert.equal(s.status(web.id), "COMPLETED");
    assert.deepEqual(warns, [
      "Completed 1 native sessions whose frames finalize is overdue; their frames archive is not stored yet",
    ]);
  });

  it("does not warn when nothing it completed was waiting on a finalize", async () => {
    const s = setup();
    const warns = captureWarns(s.retention);
    const web = s.add(2 * MIN, "web");
    const legacy = s.add(2 * MIN, null);
    const frameless = s.add(nativeSweepGraceMs() + 5_000, "android");
    const finalized = s.add(4 * MIN, "ios"); // no score: its finalize ran
    await s.retention.sweepLiveSessions();
    for (const row of [web, legacy, frameless, finalized]) {
      assert.equal(s.status(row.id), "COMPLETED");
    }
    assert.deepEqual(warns, []);
  });

  it("holds a frameless native session for the frames grace, then completes it", async () => {
    const s = setup();
    // Past the 60 s web cutoff, inside the native grace: its frames may still
    // be on their way.
    const recent = s.add(90_000, "ios");
    const old = s.add(nativeSweepGraceMs() + 5_000, "android");
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(recent.id), "LIVE");
    assert.equal(s.status(old.id), "COMPLETED", "an event-only session still ends");
    assert.deepEqual(s.derived, [old.id]);
  });

  it("flips web and legacy rows 60 s after their last batch, as before", async () => {
    const s = setup();
    const web = s.add(61_000, "web");
    const legacy = s.add(61_000, null);
    const fresh = s.add(30_000, "web");
    // A score for a web sid means nothing to the sweep.
    await s.score(web.publicId, 100_000);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(web.id), "COMPLETED");
    assert.equal(s.status(legacy.id), "COMPLETED");
    assert.equal(s.status(fresh.id), "LIVE");
    assert.deepEqual(s.derived.sort(), [web.id, legacy.id].sort());
  });

  it("pages past a full page of held rows, ties on endedAt included", async () => {
    const s = setup();
    // 1,200 rows sharing ONE endedAt, so the first page boundary falls inside
    // the tie: a full page of held native rows, then (higher ids) 200 web
    // rows that must flip — the id tiebreak is the only way to reach them.
    // Then web rows that ended later.
    const endedAgo = 5 * MIN;
    const tiedAt = new Date(Date.now() - endedAgo);
    const held = Array.from({ length: 1_000 }, () =>
      s.add(endedAgo, "ios", { endedAt: tiedAt, startedAt: tiedAt }),
    );
    const tiedWeb = Array.from({ length: 200 }, () =>
      s.add(endedAgo, "web", { endedAt: tiedAt, startedAt: tiedAt }),
    );
    const pipe = redis.pipeline();
    for (const r of held) {
      pipe.zadd(SESSION_EXPIRY_ZSET, String(Date.now() + 100_000), r.publicId);
    }
    await pipe.exec();
    const web = Array.from({ length: 5 }, (_, i) => s.add(2 * MIN - i * 1_000, "web"));
    await s.retention.sweepLiveSessions();
    assert.ok(held.every((r) => s.status(r.id) === "LIVE"), "held rows stay LIVE");
    assert.ok(
      tiedWeb.every((r) => s.status(r.id) === "COMPLETED"),
      "rows tied with the page boundary flip",
    );
    assert.ok(web.every((r) => s.status(r.id) === "COMPLETED"), "rows after them flip");
    assert.equal(
      new Set(s.derived).size,
      tiedWeb.length + web.length,
      "each flipped row derived",
    );
    assert.equal(s.derived.length, tiedWeb.length + web.length, "and only once");
  });

  it("never reads native rows inside the grace, so they can't use up the page budget", async () => {
    const s = setup();
    // A page budget's worth of native sessions that ended 150 s ago (inside
    // the grace), and a web row that ended after them.
    const recent = new Date(Date.now() - 150_000);
    const inGrace = Array.from({ length: 10_000 }, () =>
      s.add(150_000, "android", { endedAt: recent, startedAt: recent }),
    );
    const web = s.add(61_000, "web");
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(web.id), "COMPLETED", "flipped on its first tick");
    assert.ok(inGrace.every((r) => s.status(r.id) === "LIVE"));
  });

  it("resumes where its page budget stopped, so held rows can't starve the rows behind them", async () => {
    const s = setup();
    // A page budget's worth of native sessions still recording (endedAt
    // frozen 4 min ago, score in the future), then a web row 2 min stale.
    const endedAt = new Date(Date.now() - 4 * MIN);
    const held = Array.from({ length: 10_000 }, () =>
      s.add(4 * MIN, "android", { endedAt, startedAt: endedAt }),
    );
    const pipe = redis.pipeline();
    for (const r of held) {
      pipe.zadd(SESSION_EXPIRY_ZSET, String(Date.now() + 10 * MIN), r.publicId);
    }
    await pipe.exec();
    const web = s.add(2 * MIN, "web");

    await s.retention.sweepLiveSessions();
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(web.id), "COMPLETED", "reached on the next tick");
    assert.ok(held.every((r) => s.status(r.id) === "LIVE"));

    // That walk reached the end of the range, so the next one starts from the
    // oldest row again: a held row whose finalize has since run is reached.
    await redis.zrem(SESSION_EXPIRY_ZSET, held[0].publicId);
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(held[0].id), "COMPLETED");
    assert.equal(s.status(held[1].id), "LIVE");
  });

  it("leaves alone a row that took a new batch, or that the finalizer completed, after the page was read", async () => {
    const s = setup();
    const web = s.add(2 * MIN, "web");
    const native = s.add(20 * MIN, "android");
    await s.score(native.publicId, -(FINALIZE_OVERDUE_MAX_MS + 5_000));
    const finalizedAt = new Date(Date.now() - 1_000);
    // Between the page read and the flip (the sweep reads the expiry scores in
    // between): /i stamps the web row, the finalizer completes the native one.
    const pendingFinalize = s.stream.pendingFinalize.bind(s.stream);
    s.stream.pendingFinalize = async (sids, now) => {
      Object.assign(s.sessions.rows.get(web.id) as SessionRow, {
        endedAt: new Date(),
      });
      Object.assign(s.sessions.rows.get(native.id) as SessionRow, {
        status: "COMPLETED",
        endedAt: finalizedAt,
        nativeSnapshotCount: 4,
      });
      return pendingFinalize(sids, now);
    };
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(web.id), "LIVE", "a session that is active again stays LIVE");
    assert.equal(
      s.sessions.get(native.id).endedAt.getTime(),
      finalizedAt.getTime(),
      "the finalizer's endedAt stands",
    );
  });

  it("walks at most its page budget a tick and drains the rest next tick", async () => {
    const s = setup();
    // 10,500 stale web rows (no Redis keys): 10 pages of 1,000, then the rest.
    const endedAt = new Date(Date.now() - 2 * MIN);
    for (let i = 0; i < 10_500; i++) {
      s.sessions.add({ publicId: `ses_budget_${i}`, platform: "web", endedAt });
    }
    const live = () =>
      [...s.sessions.rows.values()].filter((r) => r.status === "LIVE").length;
    await s.retention.sweepLiveSessions();
    assert.equal(live(), 500, "one tick completes 10 pages");
    await s.retention.sweepLiveSessions();
    assert.equal(live(), 0, "the next tick drains the rest");
    assert.equal(new Set(s.derived).size, 10_500);
  });

  it("flips as before when Redis fails (fail open)", async () => {
    const s = setup();
    const row = s.add(4 * MIN, "ios");
    // A client that can't reach Redis: commands error out at once.
    const down = new Redis({
      port: 9,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    down.on("error", () => {});
    const retention = new RetentionService(
      {} as QueueService,
      {} as NotificationsService,
      { settleSweep: async () => {} } as unknown as BillingService,
      { deriveForSessions: async () => {} } as unknown as SignalsService,
      new FramesStreamService(down),
    );
    (retention as unknown as { pg: unknown }).pg = { session: s.sessions };
    try {
      await s.score(row.publicId, 100_000);
      await retention.sweepLiveSessions();
      assert.equal(s.status(row.id), "COMPLETED");
    } finally {
      down.disconnect();
    }
  });

  it("is listed only once the finalizer has stored its archive", async () => {
    const s = setup();
    const storage = new FakeStorage();
    const finalizer = new FramesFinalizerService(
      redis,
      storage.asService(),
      new FakeStats() as unknown as WorkspaceStatsService,
      { deriveForSession: async () => {} } as unknown as SignalsService,
    );
    useFakeDb(finalizer, s.sessions);
    const row = s.add(4 * MIN, "ios");
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000, t0 + 2_000), Date.now());
    await s.stream.markEnded(row.publicId, Date.now()); // /late
    // The sweep reaches it before the finalizer does.
    await s.retention.sweepLiveSessions();
    assert.equal(s.status(row.id), "LIVE", "not listed before the archive exists");
    assert.equal(storage.archive(row.publicId), undefined);

    // The orphan finalize of just this session (pollExpired would also stand
    // down any other ended session in the DB).
    assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
    assert.equal(await finalizer.finalize(row.publicId, null), true);
    const done = s.sessions.get(row.id);
    assert.equal(done.status, "COMPLETED", "the finalizer lists it");
    assert.equal(done.nativeSnapshotCount, 2);
    assert.ok(storage.archive(row.publicId), "with its archive stored");
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, row.publicId), null);
  });
});

describe("pendingFinalize", () => {
  let redis: Redis;
  const sids: string[] = [];

  before(async () => {
    redis = await openTestRedis(12);
  });

  after(async () => {
    for (const sid of sids) await redis.zrem(SESSION_EXPIRY_ZSET, sid);
    await redis.quit();
  });

  it("is pending while the score is in the future or less than the cap in the past", async () => {
    const stream = new FramesStreamService(redis);
    const now = Date.now();
    const [active, ended, overdue, none] = [newSid(), newSid(), newSid(), newSid()];
    sids.push(active, ended, overdue, none);
    await redis.zadd(SESSION_EXPIRY_ZSET, String(now + 1_000), active);
    await redis.zadd(SESSION_EXPIRY_ZSET, String(now - FINALIZE_OVERDUE_MAX_MS + 1_000), ended);
    await redis.zadd(SESSION_EXPIRY_ZSET, String(now - FINALIZE_OVERDUE_MAX_MS - 1), overdue);
    const states = await stream.pendingFinalize([active, ended, overdue, none], now);
    assert.deepEqual([...states.pending].sort(), [active, ended].sort());
    assert.deepEqual([...states.overdue], [overdue]);
    const empty = await stream.pendingFinalize([], now);
    assert.equal(empty.pending.size + empty.overdue.size, 0);
  });

  it("fails open when Redis does not answer", async () => {
    // Commands queue forever on this client (as on the shared one while Redis
    // is down): the check must give up rather than hang the sweep.
    const hung = new Redis({
      port: 9,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: () => 1_000,
    });
    hung.on("error", () => {});
    try {
      const started = Date.now();
      const states = await new FramesStreamService(hung).pendingFinalize(
        [newSid()],
        Date.now(),
      );
      assert.equal(states.pending.size + states.overdue.size, 0);
      assert.ok(Date.now() - started < 5_000, "gave up after its timeout");
    } finally {
      hung.disconnect(); // it reconnects forever, which would hold the run open
    }
  });
});

describe("GET /frames reports pending", () => {
  let redis: Redis;
  const sids: string[] = [];

  before(async () => {
    redis = await openTestRedis(12);
  });

  after(async () => {
    await cleanUp(redis, sids);
    await redis.quit();
  });

  function setup() {
    const sessions = new FakeSessions();
    const storage = new FakeStorage();
    const stream = new FramesStreamService(redis);
    const service = new MobileFramesService(
      new FramesArchiveService(storage.asService()),
      stream,
    );
    useFakeDb(service, sessions);
    const add = (extra: Partial<SessionRow>) => {
      const sid = newSid();
      sids.push(sid);
      return sessions.add({ publicId: sid, ...extra });
    };
    /** A finalizer over the same table, store and Redis. */
    const finalizer = () => {
      const f = new FramesFinalizerService(
        redis,
        storage.asService(),
        new FakeStats() as unknown as WorkspaceStatsService,
        { deriveForSession: async () => {} } as unknown as SignalsService,
      );
      useFakeDb(f, sessions);
      return f;
    };
    /** Its finalize is overdue: the score is past FINALIZE_OVERDUE_MAX_MS. */
    const overdue = (sid: string) =>
      redis.zadd(
        SESSION_EXPIRY_ZSET,
        String(Date.now() - FINALIZE_OVERDUE_MAX_MS - 1),
        sid,
      );
    return { sessions, storage, stream, service, add, finalizer, overdue };
  }

  it("is pending, with no url, while the session is LIVE", async () => {
    const s = setup();
    const row = s.add({ status: "LIVE" });
    const res = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(res.url, null);
    assert.equal(res.pending, true);
  });

  it("is pending while a finalize is still to come for a COMPLETED session", async () => {
    const s = setup();
    const row = s.add({ status: "COMPLETED" });
    await redis.zadd(SESSION_EXPIRY_ZSET, String(Date.now() - 1_000), row.publicId);
    const res = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(res.url, null);
    assert.equal(res.pending, true);
  });

  it("is pending while its finalize runs minutes after the end", async () => {
    const s = setup();
    const row = s.add({ status: "COMPLETED" });
    await redis.zadd(SESSION_EXPIRY_ZSET, String(Date.now() - 3 * MIN), row.publicId);
    const res = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(res.url, null);
    assert.equal(res.pending, true);
  });

  it("is still pending when the sweep completed it with its finalize overdue", async () => {
    // A finalize that keeps failing: the sweep listed the session without its
    // archive, but a retry can still store it, so the player says
    // "processing", not "no snapshots".
    const s = setup();
    const row = s.add({
      status: "COMPLETED",
      startedAt: new Date(Date.now() - 20 * MIN),
    });
    await s.overdue(row.publicId);
    const res = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(res.url, null);
    assert.equal(res.pending, true);
  });

  it("stops reading an overdue finalize as pending 2.5 days after the start", async () => {
    const s = setup();
    const pendingAt = async (ageMs: number) => {
      const row = s.add({
        status: "COMPLETED",
        startedAt: new Date(Date.now() - ageMs),
      });
      await s.overdue(row.publicId);
      const res = await s.service.getFrames(row.workspaceId, row.publicId);
      assert.equal(res.url, null);
      return res.pending;
    };
    assert.equal(await pendingAt(2.4 * DAY), true);
    assert.equal(await pendingAt(2.6 * DAY), false);
    assert.equal(await pendingAt(3 * DAY), false, "the player's 'no snapshots'");
  });

  it("plays an archive an overdue session already has, and says more is pending", async () => {
    // A session that resumed after it was finalized: its first archive plays
    // while the finalize of the rest keeps failing.
    const s = setup();
    const row = s.add({
      status: "COMPLETED",
      nativeSnapshotCount: 4,
      startedAt: new Date(Date.now() - 20 * MIN),
    });
    await s.overdue(row.publicId);
    const res = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(res.url, `https://r2.test/frames/${row.publicId}.frames.gz?v=4`);
    assert.equal(res.pending, true);
  });

  it("plays once a retried finalize stores the overdue session's archive", async () => {
    const s = setup();
    const row = s.add({
      status: "COMPLETED", // completed by the sweep, without its archive
      startedAt: new Date(Date.now() - 20 * MIN),
    });
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000, t0 + 2_000), Date.now());
    await s.overdue(row.publicId);
    const before = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(before.url, null);
    assert.equal(before.pending, true);

    const finalizer = s.finalizer();
    assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
    assert.equal(await finalizer.finalize(row.publicId, null), true);
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, row.publicId), null);
    const after = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(after.url, `https://r2.test/frames/${row.publicId}.frames.gz?v=2`);
    assert.equal(after.pending, false);
  });

  it("never reads as 'no snapshots' when a retried finalize lands mid-request", async () => {
    // A finalize records the archive on the row, then removes the expiry
    // score. Here the retry runs right after the endpoint reads the row, so
    // that row still has no archive; the score, read first, says one is
    // still to come.
    const s = setup();
    const row = s.add({
      status: "COMPLETED", // completed by the sweep, without its archive
      startedAt: new Date(Date.now() - 20 * MIN),
    });
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000, t0 + 2_000), Date.now());
    await s.overdue(row.publicId);
    const finalizer = s.finalizer();
    const read = s.sessions.findFirst.bind(s.sessions);
    (s.service as unknown as { db: unknown }).db = {
      session: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const snapshot = await read(args);
          assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
          assert.equal(await finalizer.finalize(row.publicId, null), true);
          return snapshot;
        },
      },
    };
    const during = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(during.url, null);
    assert.equal(during.pending, true, "processing, not 'no snapshots'");

    useFakeDb(s.service, s.sessions);
    const next = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(next.url, `https://r2.test/frames/${row.publicId}.frames.gz?v=2`);
    assert.equal(next.pending, false);
  });

  it("is not pending once a cancel has discarded the recording", async () => {
    const s = setup();
    const row = s.add({
      status: "LIVE",
      startedAt: new Date(Date.now() - 20 * MIN),
    });
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000), Date.now());
    await s.stream.markEnded(row.publicId, Date.now());
    const finalizer = s.finalizer();
    assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
    assert.equal(await finalizer.finalize(row.publicId, null), true);
    const played = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(played.url, `https://r2.test/frames/${row.publicId}.frames.gz?v=1`);
    assert.equal(played.pending, false);

    try {
      // POST /v1/mobile/cancel; the next finalize discards the recording.
      await s.stream.drop(row.publicId, Date.now());
      const cancelled = await s.service.getFrames(row.workspaceId, row.publicId);
      assert.equal(cancelled.pending, true, "until the discard has run");
      assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
      assert.equal(await finalizer.finalize(row.publicId, null), true);
      assert.equal(s.storage.archive(row.publicId), undefined);
      assert.deepEqual(await s.service.getFrames(row.workspaceId, row.publicId), {
        url: null,
        count: 0,
        startedAt: 0,
        fileFormat: "jpeg",
        pending: false,
      });
    } finally {
      await redis.del(framesCancelKey(row.publicId));
    }
  });

  it("is pending for frames that reach an already-listed frameless session, until they are finalized", async () => {
    // The sweep completed (listed) it with no frames; frames then arrive. The
    // row is never re-hidden: it stays COMPLETED throughout.
    const s = setup();
    const row = s.add({ status: "COMPLETED" });
    const t0 = row.startedAt.getTime();
    await s.stream.append(row.publicId, frames(t0 + 1_000), Date.now());
    const during = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(during.url, null);
    assert.equal(during.pending, true);

    await s.stream.markEnded(row.publicId, Date.now());
    const finalizer = s.finalizer();
    assert.ok(await finalizer.acquireFinalizeLock(row.publicId));
    assert.equal(await finalizer.finalize(row.publicId, null), true);
    const done = await s.service.getFrames(row.workspaceId, row.publicId);
    assert.equal(done.url, `https://r2.test/frames/${row.publicId}.frames.gz?v=1`);
    assert.equal(done.pending, false);
    assert.equal(s.sessions.get(row.id).status, "COMPLETED");
  });

  it("is not pending when Redis does not answer (fails open)", async () => {
    // Commands queue forever on this client, as on the shared one while Redis
    // is down: the read gives up after its timeout.
    const hung = new Redis({
      port: 9,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: () => 1_000,
    });
    hung.on("error", () => {});
    const sessions = new FakeSessions();
    const service = new MobileFramesService(
      new FramesArchiveService(new FakeStorage().asService()),
      new FramesStreamService(hung),
    );
    useFakeDb(service, sessions);
    const row = sessions.add({ publicId: newSid(), status: "COMPLETED" });
    try {
      const res = await service.getFrames(row.workspaceId, row.publicId);
      assert.equal(res.url, null);
      assert.equal(res.pending, false);
    } finally {
      hung.disconnect(); // it reconnects forever, which would hold the run open
    }
  });

  it("is not pending once finalized: no frames, or the archive", async () => {
    const s = setup();
    const empty = s.add({ status: "COMPLETED" });
    const none = await s.service.getFrames(empty.workspaceId, empty.publicId);
    assert.equal(none.url, null);
    assert.equal(none.pending, false, "the player's 'no snapshots'");

    const t0 = Date.now() - MIN;
    const played = s.add({
      status: "COMPLETED",
      nativeSnapshotCount: 3,
      startedAt: new Date(t0),
      clockSkewMs: 250n,
    });
    const res = await s.service.getFrames(played.workspaceId, played.publicId);
    assert.equal(res.url, `https://r2.test/frames/${played.publicId}.frames.gz?v=3`);
    assert.equal(res.count, 3);
    assert.equal(res.startedAt, t0 + 250);
    assert.equal(res.pending, false);
  });

  it("is not pending for a session of another workspace", async () => {
    const s = setup();
    const row = s.add({ status: "LIVE", workspaceId: 2 });
    const res = await s.service.getFrames(1, row.publicId);
    assert.deepEqual(res, {
      url: null,
      count: 0,
      startedAt: 0,
      fileFormat: "jpeg",
      pending: false,
    });
    // Nor when that session's finalize is pending or overdue.
    const ended = s.add({ status: "COMPLETED", workspaceId: 2 });
    await s.overdue(ended.publicId);
    const recording = s.add({ status: "COMPLETED", workspaceId: 2 });
    await redis.zadd(SESSION_EXPIRY_ZSET, String(Date.now() + MIN), recording.publicId);
    for (const other of [ended, recording]) {
      assert.deepEqual(await s.service.getFrames(1, other.publicId), res);
    }
  });

  it("is what the authed and the share routes return", async () => {
    const s = setup();
    const row = s.add({ status: "LIVE" });
    const authed = new SessionsController(
      {} as SessionsService,
      s.service,
    );
    assert.equal((await authed.frames(row.workspaceId, row.publicId)).pending, true);

    const share = new ShareController(
      {
        resolveShare: async () => ({
          workspaceId: row.workspaceId,
          session: { publicId: row.publicId },
        }),
      } as unknown as SessionsService,
      s.service,
    );
    assert.equal((await share.frames("token")).pending, true);
  });
});

describe("a user's session list hides unfinished native sessions", () => {
  const WS = 1;
  const USER = 7;

  /** GET /v1/end-users/:id, /:id/sessions and /:id/activity over a fresh
   *  fake Session table. */
  function setup() {
    const sessions = new FakeSessions();
    const service = new EndUsersService(
      {} as CohortsService,
      {} as SessionReaperService,
    );
    const now = new Date();
    (service as unknown as { db: unknown }).db = {
      session: {
        findMany: sessions.findMany.bind(sessions),
        aggregate: sessions.aggregate.bind(sessions),
      },
      endUser: {
        findFirst: async () => ({
          id: USER,
          workspaceId: WS,
          distinctId: "user-7",
          firstSeenAt: now,
          lastSeenAt: now,
          customProps: {},
        }),
      },
      cohortMember: { findMany: async () => [] },
    };
    const users = new EndUsersController(service);
    /** One of the user's sessions (ids rise in the order they are added). */
    const add = (
      status: SessionRow["status"],
      platform: string | null,
      extra: Partial<SessionRow> = {},
    ) =>
      sessions.add({
        publicId: newSid(),
        workspaceId: WS,
        endUserId: USER,
        status,
        platform,
        ...extra,
      });
    /** Every page of the user's sessions (or activity feed), walked by its
     *  cursor. */
    const walk = async (limit: string, feed: "sessions" | "activity" = "sessions") => {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await users[feed](WS, USER, cursor, limit);
        pages.push(page.items.map((s) => s.publicId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return pages;
    };
    return { sessions, users, add, walk };
  }

  it("lists COMPLETED native, web and legacy sessions, but not LIVE native ones", async () => {
    const s = setup();
    const web = s.add("LIVE", "web");
    const liveIos = s.add("LIVE", "ios");
    const doneIos = s.add("COMPLETED", "ios");
    const liveAndroid = s.add("LIVE", "android");
    const doneAndroid = s.add("COMPLETED", "android");
    const legacy = s.add("LIVE", null);
    s.add("COMPLETED", "web", { endUserId: 8 }); // another user's

    const [page] = await s.walk("25");
    assert.deepEqual(
      page,
      [legacy, doneAndroid, doneIos, web].map((r) => r.publicId),
    );
    assert.ok(!page.includes(liveIos.publicId) && !page.includes(liveAndroid.publicId));
    const user = await s.users.get(WS, USER);
    assert.equal(user.sessions, 4, "the header count matches the list");

    // Its finalize lists it, here as on Recordings.
    s.sessions.rows.get(liveIos.id)!.status = "COMPLETED";
    const [after] = await s.walk("25");
    assert.ok(after.includes(liveIos.publicId));
    assert.equal((await s.users.get(WS, USER)).sessions, 5);
  });

  it("pages every listed session exactly once, LIVE native rows at the page boundaries", async () => {
    const s = setup();
    const rows = [
      s.add("LIVE", "web"),
      s.add("COMPLETED", "ios"),
      s.add("LIVE", "ios"), // between pages 2 and 3
      s.add("COMPLETED", "android"),
      s.add("LIVE", "android"), // between pages 1 and 2
      s.add("LIVE", null),
      s.add("COMPLETED", "web"),
      s.add("LIVE", "ios"), // ahead of page 1
    ];
    const listed = [6, 5, 3, 1, 0].map((i) => rows[i].publicId);
    assert.deepEqual(await s.walk("2"), [listed.slice(0, 2), listed.slice(2, 4), listed.slice(4)]);
    assert.deepEqual((await s.walk("1")).flat(), listed);
  });

  it("hides the same sessions as the Recordings list, whose predicate is unchanged", async () => {
    // The predicate the Recordings list applied before it was shared.
    assert.deepEqual(NATIVE_PLAYABLE_FILTER, {
      OR: [
        { platform: { notIn: ["ios", "android"] } },
        { platform: null },
        { status: "COMPLETED" },
      ],
    });
    const s = setup();
    for (const status of ["LIVE", "COMPLETED"] as const) {
      for (const platform of ["web", "ios", "android", null]) s.add(status, platform);
    }
    const recordings = Object.create(SessionsService.prototype) as {
      buildListWhere(p: { workspaceId: number; endUserId: string }): Record<string, unknown>;
    };
    const where = recordings.buildListWhere({ workspaceId: WS, endUserId: String(USER) });
    assert.equal(where.AND, NATIVE_PLAYABLE_FILTER);
    const onRecordings = await s.sessions.findMany({
      where,
      orderBy: { id: "desc" },
      select: { publicId: true },
    });
    assert.equal(onRecordings.length, 6);
    const [page] = await s.walk("25");
    assert.deepEqual(page, onRecordings.map((r) => r.publicId));
  });

  it("hides them from the activity feed too, whose rows open the replay", async () => {
    const s = setup();
    const rows = [
      s.add("COMPLETED", "ios"),
      s.add("LIVE", "android"),
      s.add("LIVE", "web"),
      s.add("LIVE", "ios"),
      s.add("COMPLETED", "android"),
      s.add("LIVE", null),
    ];
    s.add("COMPLETED", "web", { endUserId: 8 }); // another user's
    const listed = [5, 4, 2, 0].map((i) => rows[i].publicId);
    assert.deepEqual((await s.walk("25", "activity")).flat(), listed);
    assert.deepEqual((await s.walk("1", "activity")).flat(), listed);
    assert.deepEqual(await s.walk("2", "activity"), await s.walk("2"));
  });

  it("computes the header's average duration and last session over the listed sessions", async () => {
    // Four finished sessions of 60 s, then a native one 5 s into recording:
    // it is not listed, so it is neither counted, averaged nor named last.
    const s = setup();
    s.add("COMPLETED", "ios", { durationMs: 60_000 });
    s.add("LIVE", "web", { durationMs: 60_000 });
    s.add("COMPLETED", "web", { durationMs: 60_000 });
    const latest = s.add("COMPLETED", "android", { durationMs: 60_000 });
    const recording = s.add("LIVE", "android", { durationMs: 5_000 });
    const user = await s.users.get(WS, USER);
    assert.equal(user.sessions, 4);
    assert.equal(user.avgDurationMs, 60_000);
    assert.equal(user.lastSession?.publicId, latest.publicId);

    // Its finalize lists it; then it counts everywhere.
    s.sessions.rows.get(recording.id)!.status = "COMPLETED";
    const after = await s.users.get(WS, USER);
    assert.equal(after.sessions, 5);
    assert.equal(after.avgDurationMs, 49_000);
    assert.equal(after.lastSession?.publicId, recording.publicId);
  });
});

describe("an AUTO playlist holds only playable sessions", () => {
  it("leaves a LIVE native session out until it completes", async () => {
    const WS = 1;
    const sessions = new FakeSessions();
    /** The member ids each refresh wrote. */
    const written: number[][] = [];
    const playlists = new PlaylistsService({} as WorkspaceStatsService);
    (playlists as unknown as { db: unknown }).db = {
      playlist: {
        findFirst: async () => ({
          id: 3,
          workspaceId: WS,
          kind: "AUTO",
          filter: { conditions: [{ field: "hasErrors", op: "=", value: "true" }] },
        }),
        update: async () => ({}),
      },
      session: { findMany: sessions.findMany.bind(sessions) },
      playlistSession: {
        deleteMany: async () => ({ count: 0 }),
        createMany: async (a: { data: Array<{ sessionId: number }> }) => {
          written.push(a.data.map((m) => m.sessionId));
          return { count: a.data.length };
        },
      },
      $transaction: (ops: Array<Promise<unknown>>) => Promise.all(ops),
    };
    const add = (
      status: SessionRow["status"],
      platform: string | null,
      extra: Partial<SessionRow> = {},
    ) =>
      sessions.add({
        publicId: newSid(),
        workspaceId: WS,
        status,
        platform,
        errorCount: 1,
        ...extra,
      });
    const web = add("LIVE", "web");
    const recording = add("LIVE", "ios");
    const done = add("COMPLETED", "android");
    const legacy = add("LIVE", null);
    add("COMPLETED", "ios", { errorCount: 0 }); // fails the playlist's filter
    add("COMPLETED", "web", { workspaceId: 2 }); // another workspace's

    assert.deepEqual(await playlists.refresh(WS, 3), { id: 3, refreshed: 3 });
    assert.deepEqual(written.pop(), [web.id, done.id, legacy.id]);

    // Its finalize completes it: the next refresh adds it.
    sessions.rows.get(recording.id)!.status = "COMPLETED";
    assert.deepEqual(await playlists.refresh(WS, 3), { id: 3, refreshed: 4 });
    assert.deepEqual(written.pop(), [web.id, recording.id, done.id, legacy.id]);
  });
});
