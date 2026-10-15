/**
 * The mobile message path (/v1/mobile/i and /late) and the session lifecycle:
 *   • user interaction on /i holds a frame-paused session open, so it isn't
 *     finalized mid-use;
 *   • /late doesn't stretch the session to the moment the user came back;
 *   • performance samples count as activity only while the app is in the
 *     foreground, so a backgrounded app's samples neither stretch the session
 *     nor keep it from ending.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "zlib";
import type Redis from "ioredis";
import { getClickHouseClient } from "@replay/db-clickhouse";
import { MobileService } from "../src/mobile/mobile.service";
import type { MobileTokenPayload } from "../src/mobile/mobile-token";
import { FramesFinalizerService } from "../src/frames/frames-finalizer.service";
import { FramesStreamService } from "../src/frames/frames-stream.service";
import { FramesWorkerService } from "../src/frames/frames-worker.service";
import {
  appStateKey,
  finalizeLockKey,
  framesStreamKey,
  SESSION_EXPIRY_ZSET,
} from "../src/frames/frames.constants";
import type { BillingPort as BillingService } from "../src/billing/billing.port";
import type { ApiKeyCache } from "../src/api-keys/api-keys.cache";
import type { SettingsService } from "../src/settings/settings.service";
import type { WorkspaceStatsService } from "../src/workspace-stats/workspace-stats.service";
import type { CohortsService } from "../src/cohorts/cohorts.service";
import type { PresenceService } from "../src/presence/presence.service";
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
  wire,
} from "./helpers";

// A short frames idle timeout so the lifecycle runs in real time.
const IDLE_MS = 1_000;
process.env.FRAMES_IDLE_MS = String(IDLE_MS);

describe("mobile message ingest", () => {
  let redis: Redis;
  const sids: string[] = [];

  before(async () => {
    redis = await openTestRedis(15);
  });

  after(async () => {
    for (const sid of sids) {
      await redis.del(framesStreamKey(sid), finalizeLockKey(sid), appStateKey(sid));
      await redis.zrem(SESSION_EXPIRY_ZSET, sid);
    }
    await redis.quit();
    await getClickHouseClient().close();
  });

  function setup(opts: { startedAt?: number; skew?: number } = {}) {
    const storage = new FakeStorage();
    const sessions = new FakeSessions();
    const stats = new FakeStats();
    const finalizer = new FramesFinalizerService(
      redis,
      storage.asService(),
      stats as unknown as WorkspaceStatsService,
      { deriveForSession: async () => {} } as unknown as SignalsService,
    );
    useFakeDb(finalizer, sessions);
    const frameStream = new FramesStreamService(redis);
    const worker = new FramesWorkerService(redis, storage.asService(), finalizer);
    const mobile = new MobileService(
      {} as BillingService,
      {} as ApiKeyCache,
      frameStream,
      {} as SettingsService,
      stats as unknown as WorkspaceStatsService,
      { markUsersDirty: async () => {} } as unknown as CohortsService,
      { touch: async () => {} } as unknown as PresenceService,
    );
    useFakeDb(mobile, sessions);

    const sid = newSid();
    sids.push(sid);
    const skew = opts.skew ?? 0;
    const serverStart = opts.startedAt ?? Date.now();
    const row = sessions.add({
      publicId: sid,
      startedAt: new Date(serverStart),
      endedAt: new Date(serverStart),
      clockSkewMs: skew ? BigInt(skew) : null,
    });
    const token: MobileTokenPayload = {
      sid,
      snum: row.id,
      wid: row.workspaceId,
      startedAt: serverStart + skew, // the device's own start
      skew,
    };
    /** POST /v1/mobile/i — a gzipped batch. */
    const postI = (...msgs: Buffer[]) =>
      mobile.ingestMessages(token, gzipSync(Buffer.concat(msgs)), true);
    /** POST /v1/mobile/late — un-gzipped. */
    const postLate = (...msgs: Buffer[]) =>
      mobile.ingestMessages(token, Buffer.concat(msgs), false);
    const tick = async () => {
      await worker.tick();
      await finalizer.pollExpired();
    };
    return { storage, sessions, frameStream, worker, sid, row, token, postI, postLate, tick };
  }

  it("holds a frame-paused session open while the user interacts on /i", async () => {
    const s = setup();
    const deviceNow = () => Date.now() + (s.token.skew ?? 0);
    await s.frameStream.append(s.sid, frames(deviceNow()), Date.now());
    await s.tick();

    // Frames pause (an excluded screen); the user keeps tapping.
    await sleep(IDLE_MS * 0.6);
    await s.postI(wire.batchMeta(deviceNow()), wire.click(deviceNow()));
    await sleep(IDLE_MS * 0.6); // past the last frames batch's idle deadline
    await s.tick();
    assert.equal(s.sessions.get(s.row.id).status, "LIVE", "not finalized mid-use");
    assert.equal(s.storage.archive(s.sid), undefined);

    // The user stops; the session idles out and is finalized normally.
    await sleep(IDLE_MS * 0.6);
    await s.tick();
    const row = s.sessions.get(s.row.id);
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.nativeSnapshotCount, 1);
    assert.equal(archiveTimestamps(s.storage.archive(s.sid) as Buffer).length, 1);
    await s.worker.onModuleDestroy();
  });

  it("doesn't hold a session open on scheduled samples alone", async () => {
    const s = setup();
    const now = Date.now();
    await s.frameStream.append(s.sid, frames(now), now);
    await sleep(IDLE_MS * 0.6);
    // A backgrounded Android app keeps sending performance samples.
    await s.postI(wire.batchMeta(Date.now()), wire.performance(Date.now()));
    await sleep(IDLE_MS * 0.6);
    await s.tick();
    assert.equal(s.sessions.get(s.row.id).status, "COMPLETED");
    await s.worker.onModuleDestroy();
  });

  it("never revives an ended session or arms one that isn't recording", async () => {
    const s = setup();
    await s.frameStream.append(s.sid, frames(Date.now()), Date.now());
    await s.frameStream.markEnded(s.sid, Date.now()); // /late
    await s.postI(wire.click(Date.now()));
    const score = await redis.zscore(SESSION_EXPIRY_ZSET, s.sid);
    assert.ok(score !== null && Number(score) < Date.now(), "stays ended");

    const idle = setup(); // never sent a frame
    await idle.postI(wire.click(Date.now()));
    assert.equal(await redis.zscore(SESSION_EXPIRY_ZSET, idle.sid), null);
  });

  it("doesn't stretch duration or endedAt on a /late sent after a long background", async () => {
    // The session ran 5 min, idled out (finalized at +5:00 + idle), and the
    // user comes back 40 min after start: the SDK sends /late for it now.
    const start = Date.now() - 40 * 60_000;
    const s = setup({ startedAt: start });
    const finalizedAt = new Date(start + 5 * 60_000 + 150_000);
    Object.assign(s.sessions.rows.get(s.row.id)!, {
      status: "COMPLETED",
      durationMs: 5 * 60_000,
      endedAt: finalizedAt,
      nativeSnapshotCount: 300,
    });

    await s.postLate(
      wire.batchMeta(Date.now()), // stamped at send: the return time
      wire.performance(Date.now()), // the sampler's catch-up on return
      wire.click(start + 4 * 60_000), // an interaction still queued from before
    );

    const row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, 5 * 60_000);
    assert.equal(row.endedAt.getTime(), finalizedAt.getTime());
  });

  it("ends a /late at its own last activity, on the server clock", async () => {
    // Device clock 3 h fast; the app crashes and flushes via /late.
    const skew = 3 * 60 * 60_000;
    const start = Date.now() - 10 * 60_000;
    const s = setup({ startedAt: start, skew });
    Object.assign(s.sessions.rows.get(s.row.id)!, {
      durationMs: 9 * 60_000,
      endedAt: new Date(Date.now() - 60_000), // last /i a minute ago
    });

    const crashAt = Date.now() - 20_000; // server clock
    await s.postLate(wire.batchMeta(Date.now() + skew), wire.crash(crashAt + skew));

    const row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, crashAt - start);
    assert.equal(row.endedAt.getTime(), crashAt);
    assert.equal(row.errorCount, 1);
  });

  it("measures /i duration to the last activity, not the batch's send stamp", async () => {
    const start = Date.now() - 5 * 60_000;
    const s = setup({ startedAt: start });
    const before = Date.now();
    await s.postI(wire.click(start + 60_000), wire.batchMeta(start + 65_000));
    const row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, 60_000);
    assert.ok(row.endedAt.getTime() >= before, "/i still stamps its receive time");
  });

  it("counts foreground samples toward a frameless session's duration", async () => {
    // Frames off (an opt-out, an excluded screen); the user reads for two
    // minutes without touching anything — on iOS the samples' timers only
    // run while the app is on screen.
    const start = Date.now() - 5 * 60_000;
    const s = setup({ startedAt: start });
    await s.postI(wire.screen(start), wire.performance(start + 5_000));
    await s.postI(wire.performance(start + 60_000), wire.batchMeta(start + 61_000));
    const before = Date.now();
    await s.postI(wire.performance(start + 120_000), wire.batchMeta(start + 121_000));

    const row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, 120_000);
    assert.ok(row.endedAt.getTime() >= before, "still live");
  });

  it("doesn't stretch or hold open a session on a backgrounded app's samples", async () => {
    const start = Date.now() - 60 * 60_000;
    const s = setup({ startedAt: start });
    await s.postI(wire.click(start + 60_000), wire.background(start + 70_000, 1));
    assert.equal(s.sessions.get(s.row.id).durationMs, 70_000, "ends where the user left");

    // An Android app's sampler and flush timers run on in the background.
    const leftAt = new Date(Date.now() - 5 * 60_000);
    s.sessions.rows.get(s.row.id)!.endedAt = leftAt; // as of when it left
    await s.postI(wire.performance(start + 600_000), wire.batchMeta(start + 600_000));
    let row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, 70_000);
    assert.equal(row.endedAt.getTime(), leftAt.getTime(), "end not moved, so it settles");

    // Frozen past the state's TTL, then thawed: the sampler catches up.
    await redis.del(appStateKey(s.sid));
    await s.postI(wire.performance(start + 3_000_000), wire.batchMeta(start + 3_000_000));
    row = s.sessions.get(s.row.id);
    assert.equal(row.durationMs, 70_000);
    assert.equal(row.endedAt.getTime(), leftAt.getTime());

    // Back in the same session: its samples count again.
    await s.postI(wire.background(start + 3_100_000, 0), wire.performance(start + 3_105_000));
    assert.equal(s.sessions.get(s.row.id).durationMs, 3_105_000);
  });
});
