/**
 * /v1/mobile/start and the dashboard's input-masking force:
 *   • every response shape (capped, sampled out, recording) carries
 *     privacy.occludeAllTextFields, so the SDK never sees it missing;
 *   • a recording session gets the workspace's maskAllInputs flag;
 *   • the workspace settings are read once per /start (getMobileStartSettings),
 *     never through the old separate getSampling + getRecording reads.
 */
import { afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MobileService } from "../src/mobile/mobile.service";
import type {
  MaskingConfig,
  MobileStartSettings,
  RecordingConfig,
  SamplingConfig,
  SettingsService,
} from "../src/settings/settings.service";
import type { BillingPort as BillingService } from "../src/billing/billing.port";
import type { ApiKeyCache } from "../src/api-keys/api-keys.cache";
import type { FramesStreamService } from "../src/frames/frames-stream.service";
import type { WorkspaceStatsService } from "../src/workspace-stats/workspace-stats.service";
import type { CohortsService } from "../src/cohorts/cohorts.service";
import type { PresenceService } from "../src/presence/presence.service";

const WORKSPACE_ID = 7;

const SAMPLING: SamplingConfig = {
  samplingRate: 1,
  alwaysRecordErrors: true,
  alwaysRecordIdentified: false,
  alwaysRecordOnUrls: [],
};

const RECORDING = {
  captureConsole: true,
  captureNetwork: true,
  captureNetworkHeaders: false,
  captureNetworkBodies: false,
  mobileFps: 1,
  mobileQuality: "low",
} as RecordingConfig;

function setup(opts: {
  capped?: boolean;
  samplingRate?: number;
  maskAllInputs?: boolean;
}) {
  const calls = { startSettings: 0, legacyReads: 0 };
  const settings = {
    getMobileStartSettings: async (
      wid: number,
    ): Promise<MobileStartSettings> => {
      assert.equal(wid, WORKSPACE_ID);
      calls.startSettings++;
      return {
        sampling: { ...SAMPLING, samplingRate: opts.samplingRate ?? 1 },
        recording: RECORDING,
        masking: { maskAllInputs: opts.maskAllInputs ?? false } as MaskingConfig,
      };
    },
    getSampling: async () => {
      calls.legacyReads++;
      throw new Error("/start must not call getSampling");
    },
    getRecording: async () => {
      calls.legacyReads++;
      throw new Error("/start must not call getRecording");
    },
  } as unknown as SettingsService;

  const mobile = new MobileService(
    { shouldNotRecord: async () => opts.capped ?? false } as unknown as BillingService,
    { lookup: async () => ({ workspaceId: WORKSPACE_ID }) } as unknown as ApiKeyCache,
    {} as FramesStreamService,
    settings,
    { bump: async () => {} } as unknown as WorkspaceStatsService,
    {} as CohortsService,
    {} as PresenceService,
  );
  (mobile as unknown as { db: unknown }).db = {
    endUser: {
      findUnique: async () => ({ id: 1 }),
      upsert: async () => ({ id: 1 }),
    },
    session: {
      create: async (args: { data: { publicId: string; startedAt: Date } }) => ({
        id: 1,
        publicId: args.data.publicId,
        startedAt: args.data.startedAt,
      }),
    },
  };
  const start = () =>
    mobile.createSession(
      {
        projectKey: "test-project-key",
        platform: "android",
        userUUID: "install-1",
        timestamp: Date.now(),
      },
      "127.0.0.1",
    );
  return { start, calls };
}

describe("/v1/mobile/start privacy", () => {
  const realRandom = Math.random;

  before(() => {
    // Test-only signing key for the session token the success path mints.
    process.env.MOBILE_INGEST_SECRET = "test-only-mobile-ingest-secret";
  });

  afterEach(() => {
    Math.random = realRandom;
  });

  it("capped: record:false with privacy present and no settings read", async () => {
    const { start, calls } = setup({ capped: true, maskAllInputs: true });
    const res = await start();
    assert.ok(res);
    assert.equal(res.record, false);
    assert.deepEqual(res.privacy, { occludeAllTextFields: false });
    assert.equal(calls.startSettings, 0);
    assert.equal(calls.legacyReads, 0);
  });

  it("sampled out: record:false with privacy present, one settings read", async () => {
    Math.random = () => 0.5;
    const { start, calls } = setup({ samplingRate: 0, maskAllInputs: true });
    const res = await start();
    assert.ok(res);
    assert.equal(res.record, false);
    assert.deepEqual(res.privacy, { occludeAllTextFields: false });
    assert.equal(calls.startSettings, 1);
    assert.equal(calls.legacyReads, 0);
  });

  it("recording with the dashboard force on: occludeAllTextFields true", async () => {
    const { start, calls } = setup({ maskAllInputs: true });
    const res = await start();
    assert.ok(res);
    assert.equal(res.record, true);
    assert.deepEqual(res.privacy, { occludeAllTextFields: true });
    // The capture settings come from the same single read.
    assert.equal(res.fps, RECORDING.mobileFps);
    assert.equal(res.captureConsole, RECORDING.captureConsole);
    assert.equal(calls.startSettings, 1);
    assert.equal(calls.legacyReads, 0);
  });

  it("recording with the dashboard force off: occludeAllTextFields false", async () => {
    const { start, calls } = setup({ maskAllInputs: false });
    const res = await start();
    assert.ok(res);
    assert.equal(res.record, true);
    assert.deepEqual(res.privacy, { occludeAllTextFields: false });
    assert.equal(calls.startSettings, 1);
  });
});
