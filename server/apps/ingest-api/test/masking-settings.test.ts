/**
 * Masking settings storage and the single-read /v1/mobile/start settings:
 *   • setMasking sends only the keys an admin set (the delta) in ONE
 *     primary-key UPDATE, so a default nobody overrode keeps following
 *     DEFAULT_MASKING;
 *   • null / undefined / unknown keys never reach storage;
 *   • allowedHosts is mirrored to its column only when the save sets it, and
 *     the SDK config cache is dropped;
 *   • a selector or URL pattern web SDKs can't use is rejected, unless the
 *     workspace already has it;
 *   • a blob saved before delta storage overrides only its non-default values;
 *   • getMobileStartSettings is ONE narrow primary-key read that merges like
 *     getSampling / getRecording / getMasking.
 * What the UPDATE itself stores (concurrent saves, converting an older blob)
 * runs against Postgres in masking-settings.pg.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Cache } from "cache-manager";
import { Prisma } from "@replay/db-postgres";
import { SettingsService } from "../src/settings/settings.service";
import { capMobileFps, capMobileQuality } from "../src/billing/plan-catalog";

type Row = Record<string, unknown>;

/** In-memory Workspace table: findUnique honours `select`. */
class FakeWorkspaces {
  rows = new Map<number, Row>();
  finds: Array<{ where: { id: number }; select?: Record<string, true> }> = [];

  add(id: number, row: Row = {}): void {
    this.rows.set(id, {
      id,
      plan: "FREE",
      samplingRate: 1,
      samplingConfig: null,
      recordingConfig: null,
      maskingConfig: null,
      allowedHosts: [],
      ...row,
    });
  }

  async findUnique(args: {
    where: { id: number };
    select?: Record<string, true>;
  }): Promise<Row | null> {
    this.finds.push(args);
    const row = this.rows.get(args.where.id);
    if (!row) return null;
    if (!args.select) return structuredClone(row);
    return Object.fromEntries(
      Object.keys(args.select).map((k) => [k, structuredClone(row[k])]),
    );
  }
}

/** What setMasking's UPDATE was sent. Values in statement order: delta mark,
 *  pre-delta defaults (twice), patch, delta mark, [hosts,] workspace id. */
type SentUpdate = {
  sql: string;
  patch: Row;
  hosts: unknown;
  setsHosts: boolean;
  id: unknown;
};

class FakeDb {
  workspace = new FakeWorkspaces();
  updates: SentUpdate[] = [];

  /** Stand-in for setMasking's UPDATE ... RETURNING, enough for a NULL or
   *  delta blob: stored keys, then the patch, then the mark. */
  async $queryRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Row[]> {
    const q = Prisma.sql(strings, ...values);
    const v = q.values;
    const setsHosts = v.length === 7;
    const sent: SentUpdate = {
      sql: q.sql,
      patch: JSON.parse(v[3] as string),
      hosts: setsHosts ? v[5] : undefined,
      setsHosts,
      id: v[v.length - 1],
    };
    this.updates.push(sent);
    const row = this.workspace.rows.get(sent.id as number);
    if (!row) return [];
    const old = (row.maskingConfig as Row | null) ?? {};
    row.maskingConfig = {
      ...(old.v === 2 ? old : {}),
      ...sent.patch,
      ...JSON.parse(v[0] as string),
    };
    if (setsHosts) row.allowedHosts = sent.hosts;
    return [{ maskingConfig: structuredClone(row.maskingConfig) }];
  }
}

function setup(row?: Row) {
  const db = new FakeDb();
  db.workspace.add(1, row);
  const deleted: string[] = [];
  const cache = {
    del: async (key: string) => {
      deleted.push(key);
    },
  } as unknown as Cache;
  const settings = new SettingsService(cache);
  (settings as unknown as { db: unknown }).db = db;
  return {
    settings,
    db,
    workspaces: db.workspace,
    deleted,
    stored: () => db.workspace.rows.get(1)!,
  };
}

describe("setMasking stores only the delta", () => {
  it("sends only the keys that were set and returns the merged view", async () => {
    const { settings, db, stored } = setup();
    const out = await settings.setMasking(1, { maskSelectors: [".card"] });
    assert.deepEqual(db.updates[0].patch, { maskSelectors: [".card"] });
    assert.deepEqual(stored().maskingConfig, {
      maskSelectors: [".card"],
      v: 2,
    });
    // Everything else still comes from the defaults.
    assert.equal(out.maskAllInputs, false);
    assert.deepEqual(out.maskSelectors, [".card"]);
    assert.deepEqual(out.blockSelectors, [".no-replay"]);
    assert.equal(out.blockCreditCardText, true);
    assert.deepEqual(out.allowedHosts, []);
    assert.equal("v" in out, false);
  });

  it("merges in one primary-key UPDATE, with no read for a save without rules", async () => {
    const { settings, db, workspaces } = setup();
    await settings.setMasking(1, { maskAllInputs: true });
    assert.equal(workspaces.finds.length, 0);
    assert.equal(db.updates.length, 1);
    const { sql, id } = db.updates[0];
    assert.match(sql, /^\s*UPDATE "Workspace"/);
    assert.match(sql, /\|\|/);
    assert.match(sql, /WHERE "id" = \?\s+RETURNING "maskingConfig"$/);
    assert.equal(id, 1);
  });

  it("strips null, undefined and unknown keys", async () => {
    const { settings, db } = setup({
      maskingConfig: { maskSelectors: [".keep"], v: 2 },
    });
    const out = await settings.setMasking(1, {
      maskSelectors: null,
      blockSelectors: undefined,
      stripQueryParams: true,
      bogus: "x",
    } as never);
    assert.deepEqual(db.updates[0].patch, { stripQueryParams: true });
    assert.deepEqual(out.maskSelectors, [".keep"]);
    assert.deepEqual(out.blockSelectors, [".no-replay"]);
    assert.equal("bogus" in out, false);
  });

  it("keeps an explicit false as a set key", async () => {
    const { settings, db } = setup();
    await settings.setMasking(1, { blockCreditCardText: false });
    assert.deepEqual(db.updates[0].patch, { blockCreditCardText: false });
    assert.equal((await settings.getMasking(1)).blockCreditCardText, false);
  });

  it("repairs strings Postgres jsonb would reject", async () => {
    const { settings, db } = setup();
    await settings.setMasking(1, {
      allowedQueryParams: ["a\u0000b", "c\ud800"],
    });
    // NUL removed, lone surrogate replaced by U+FFFD.
    assert.deepEqual(db.updates[0].patch.allowedQueryParams, ["ab", "c�"]);
  });

  it("mirrors allowedHosts to the column only when the save sets it, and drops the SDK config cache", async () => {
    const { settings, db, stored, deleted } = setup();
    await settings.setMasking(1, { allowedHosts: ["shop.example.com"] });
    assert.equal(db.updates[0].setsHosts, true);
    assert.deepEqual(db.updates[0].hosts, ["shop.example.com"]);
    assert.deepEqual(stored().allowedHosts, ["shop.example.com"]);
    // A save that doesn't touch allowedHosts leaves the column as it is.
    await settings.setMasking(1, { maskAllInputs: true });
    assert.equal(db.updates[1].setsHosts, false);
    assert.match(db.updates[1].sql, /"allowedHosts" = "allowedHosts"/);
    assert.deepEqual(stored().allowedHosts, ["shop.example.com"]);
    assert.ok(deleted.includes("sdk-config:1"));
    assert.ok(deleted.includes("sdk-allowed-hosts:1"));
  });

  it("returns NotFound when the workspace is gone", async () => {
    const { settings } = setup();
    await assert.rejects(settings.setMasking(2, { maskAllInputs: true }), {
      name: "NotFoundException",
    });
  });
});

describe("setMasking rejects rules web SDKs can't use", () => {
  it("rejects an invalid selector without writing", async () => {
    const { settings, db } = setup();
    await assert.rejects(
      settings.setMasking(1, { maskSelectors: ["[[", ".sensitive"] }),
      (err: Error) =>
        err.name === "BadRequestException" &&
        err.message.includes('maskSelectors: "[["'),
    );
    await assert.rejects(
      settings.setMasking(1, { blockSelectors: ["div >"] }),
      { name: "BadRequestException" },
    );
    assert.equal(db.updates.length, 0);
  });

  it("rejects a redact pattern that doesn't compile", async () => {
    const { settings, db } = setup();
    await assert.rejects(
      settings.setMasking(1, { redactUrlPatterns: ["token=", "("] }),
      (err: Error) =>
        err.name === "BadRequestException" &&
        err.message.includes('redactUrlPatterns: "("'),
    );
    assert.equal(db.updates.length, 0);
  });

  it("lets through a rule the workspace already has, so it can be removed later", async () => {
    const { settings, db, workspaces } = setup({
      maskingConfig: { v: 2, maskSelectors: [".ok", "[[", "a]"] },
    });
    // Removing one old invalid rule while another stays must still save.
    const out = await settings.setMasking(1, { maskSelectors: [".ok", "a]"] });
    assert.deepEqual(out.maskSelectors, [".ok", "a]"]);
    assert.equal(db.updates.length, 1);
    // One narrow primary-key read decided which rules were already there.
    assert.equal(workspaces.finds.length, 1);
    assert.deepEqual(workspaces.finds[0].select, { maskingConfig: true });
    // A new invalid rule next to the old one is still rejected.
    await assert.rejects(
      settings.setMasking(1, { maskSelectors: [".ok", "a]", "#1"] }),
      (err: Error) =>
        err.message.includes('"#1"') && !err.message.includes('"a]"'),
    );
  });

  it("accepts the defaults and the dashboard templates", async () => {
    const { settings, db } = setup();
    await settings.setMasking(1, {
      maskSelectors: [
        "[data-private]",
        ".sensitive",
        'input[type="password"]',
        'input[autocomplete="cc-number"], input[name*="card"]',
        'input[autocomplete="cc-csc"], input[name*="cvc"]',
        'input[name*="ssn"]',
        ".user-email, [data-email]",
      ],
      blockSelectors: [".no-replay"],
      redactUrlPatterns: ["token=", "api_key="],
    });
    assert.equal(db.updates.length, 1);
  });
});

describe("reading stored masking", () => {
  it("serves a delta blob's keys, ignoring nulls, unknown keys and the mark", async () => {
    const { settings } = setup({
      maskingConfig: {
        v: 2,
        maskAllInputs: true,
        maskSelectors: null,
        blockSelectors: [".no-replay"],
        bogus: "x",
      },
    });
    const out = await settings.getMasking(1);
    assert.equal(out.maskAllInputs, true);
    assert.deepEqual(out.maskSelectors, ["[data-private]", ".sensitive"]);
    assert.deepEqual(out.blockSelectors, [".no-replay"]);
    assert.equal("bogus" in out, false);
    assert.equal("v" in out, false);
  });

  it("reads an older full blob's default values as unset and keeps its choices", async () => {
    const legacy = {
      maskAllInputs: false,
      maskSelectors: ["[data-private]", ".sensitive"],
      blockSelectors: [".no-replay", ".legacy"],
      redactUrlPatterns: ["token=", "api_key="],
      blockCreditCardText: true,
      stripQueryParams: false,
      allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
      allowedHosts: null,
      bogus: "x",
    };
    const { settings } = setup({ maskingConfig: legacy });
    // Only the value that differs from the defaults it was saved with is an
    // override, so every other key follows DEFAULT_MASKING from now on.
    const overrides = (
      settings as unknown as { maskingOverrides(s: unknown): Row }
    ).maskingOverrides(legacy);
    assert.deepEqual(overrides, { blockSelectors: [".no-replay", ".legacy"] });
    const out = await settings.getMasking(1);
    assert.deepEqual(out.blockSelectors, [".no-replay", ".legacy"]);
    assert.deepEqual(out.maskSelectors, ["[data-private]", ".sensitive"]);
    assert.deepEqual(out.allowedHosts, []);
    assert.equal(out.maskAllInputs, false);
    assert.equal("bogus" in out, false);
  });

  it("keeps an older blob's maskAllInputs true as a force", async () => {
    // maskAllInputs defaulted to true before 2026-07-16: a stored true can't be
    // told apart from an admin's force, so it stays on.
    const legacy = { maskAllInputs: true, maskSelectors: [".x"] };
    const { settings } = setup({ maskingConfig: legacy });
    const overrides = (
      settings as unknown as { maskingOverrides(s: unknown): Row }
    ).maskingOverrides(legacy);
    assert.deepEqual(overrides, { maskAllInputs: true, maskSelectors: [".x"] });
    assert.equal((await settings.getMasking(1)).maskAllInputs, true);
  });

  it("reads through a narrow primary-key query", async () => {
    const { settings, workspaces } = setup();
    await settings.getMasking(1);
    assert.equal(workspaces.finds.length, 1);
    assert.deepEqual(workspaces.finds[0].where, { id: 1 });
    assert.deepEqual(workspaces.finds[0].select, { maskingConfig: true });
  });
});

describe("getMobileStartSettings", () => {
  it("is one narrow primary-key read with the getters' merge rules", async () => {
    const { settings, workspaces } = setup({
      plan: "FREE",
      samplingRate: 0.25,
      samplingConfig: { alwaysRecordIdentified: true },
      // Above the Free ceiling: clamped on read like getRecording wherever the
      // plan catalog has caps (self-host has none, so the value passes through).
      recordingConfig: {
        mobileFps: 30,
        mobileQuality: "high",
        captureConsole: false,
      },
      maskingConfig: { maskAllInputs: true },
    });
    const got = await settings.getMobileStartSettings(1);
    assert.equal(workspaces.finds.length, 1);
    assert.deepEqual(workspaces.finds[0].where, { id: 1 });
    assert.deepEqual(workspaces.finds[0].select, {
      plan: true,
      samplingRate: true,
      samplingConfig: true,
      recordingConfig: true,
      maskingConfig: true,
    });
    assert.deepEqual(got.sampling, await settings.getSampling(1));
    assert.deepEqual(got.recording, await settings.getRecording(1));
    assert.deepEqual(got.masking, await settings.getMasking(1));
    assert.equal(got.sampling.samplingRate, 0.25);
    assert.equal(got.sampling.alwaysRecordIdentified, true);
    assert.equal(got.recording.captureConsole, false);
    assert.equal(got.recording.mobileFps, capMobileFps("FREE", 30));
    assert.equal(got.recording.mobileQuality, capMobileQuality("FREE", "high"));
    assert.equal(got.masking.maskAllInputs, true);
  });

  it("falls back to every default for a workspace with nothing stored", async () => {
    const { settings } = setup();
    const got = await settings.getMobileStartSettings(1);
    assert.equal(got.masking.maskAllInputs, false);
    assert.equal(got.sampling.samplingRate, 1);
    assert.equal(got.recording.captureNetwork, true);
  });
});
