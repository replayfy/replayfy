/**
 * setMasking's UPDATE against a real Postgres:
 *   • saves store the delta (plus the delta mark) and keep earlier keys;
 *   • concurrent saves of different keys all land (jsonb `||` in one
 *     statement, no read-modify-write);
 *   • a blob saved before delta storage drops its merged-in defaults, nulls
 *     and unknown keys on its next save, and keeps its choices;
 *   • allowedHosts is mirrored to its column only when a save sets it.
 *
 * Skipped unless TEST_DATABASE_URL_POSTGRES points at a THROWAWAY database
 * with the migrations applied (prisma migrate deploy). The suite creates and
 * deletes its own Workspace rows.
 */
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Cache } from "cache-manager";
import { Prisma, PrismaClient } from "@replay/db-postgres";
import {
  SettingsService,
  type MaskingConfig,
} from "../src/settings/settings.service";

const url = process.env.TEST_DATABASE_URL_POSTGRES;

const LEGACY_FULL_BLOB = {
  maskAllInputs: true,
  maskSelectors: ["[data-private]", ".sensitive"],
  blockSelectors: [".no-replay", ".legacy"],
  redactUrlPatterns: ["token=", "api_key="],
  blockCreditCardText: true,
  stripQueryParams: false,
  allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
  allowedHosts: null,
  bogus: "x",
};

describe(
  "setMasking against Postgres",
  { skip: url ? false : "TEST_DATABASE_URL_POSTGRES is not set" },
  () => {
    let db: PrismaClient;
    let settings: SettingsService;
    const ids: number[] = [];
    const cache = { del: async () => undefined } as unknown as Cache;

    before(() => {
      db = new PrismaClient({ datasources: { db: { url } } });
      settings = new SettingsService(cache);
      (settings as unknown as { db: unknown }).db = db;
    });

    after(async () => {
      await db.workspace.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    });

    async function workspace(
      maskingConfig?: Prisma.InputJsonValue,
      allowedHosts: string[] = [],
    ): Promise<number> {
      const ws = await db.workspace.create({
        data: {
          slug: `masking-pg-${randomBytes(6).toString("hex")}`,
          name: "masking pg test",
          maskingConfig: maskingConfig ?? Prisma.DbNull,
          allowedHosts,
        },
        select: { id: true },
      });
      ids.push(ws.id);
      return ws.id;
    }

    async function row(id: number) {
      return db.workspace.findUniqueOrThrow({
        where: { id },
        select: { maskingConfig: true, allowedHosts: true },
      });
    }

    it("stores the delta and keeps earlier keys", async () => {
      const id = await workspace();
      await settings.setMasking(id, { maskSelectors: [".card"] });
      const out = await settings.setMasking(id, { maskAllInputs: true });
      assert.deepEqual((await row(id)).maskingConfig, {
        maskSelectors: [".card"],
        maskAllInputs: true,
        v: 2,
      });
      assert.deepEqual(out, await settings.getMasking(id));
      assert.equal(out.maskAllInputs, true);
      assert.deepEqual(out.blockSelectors, [".no-replay"]);
    });

    it("lands every one of many concurrent saves of different keys", async () => {
      const patches: Partial<MaskingConfig>[] = [
        { maskAllInputs: true },
        { maskSelectors: [".a"] },
        { blockSelectors: [".b"] },
        { redactUrlPatterns: ["secret="] },
        { blockCreditCardText: false },
        { stripQueryParams: true },
        { allowedQueryParams: ["ref"] },
        { allowedHosts: ["shop.example.com"] },
      ];
      for (const start of [null, LEGACY_FULL_BLOB]) {
        for (let round = 0; round < 5; round++) {
          const id = await workspace(start ?? undefined);
          await Promise.all(patches.map((p) => settings.setMasking(id, p)));
          const stored = (await row(id)).maskingConfig as Record<
            string,
            unknown
          >;
          for (const p of patches) {
            const [k, v] = Object.entries(p)[0];
            assert.deepEqual(stored[k], v, `${k} lost (round ${round})`);
          }
          assert.equal(stored.v, 2);
          assert.equal("bogus" in stored, false);
          assert.deepEqual((await row(id)).allowedHosts, ["shop.example.com"]);
        }
      }
    });

    it("converts a blob saved before delta storage on its next save", async () => {
      const id = await workspace(LEGACY_FULL_BLOB);
      const before = await settings.getMasking(id);
      const out = await settings.setMasking(id, { stripQueryParams: true });
      // The merged-in defaults, the null and the unknown key are gone; the
      // values that differed from the defaults stay as choices.
      assert.deepEqual((await row(id)).maskingConfig, {
        maskAllInputs: true,
        blockSelectors: [".no-replay", ".legacy"],
        stripQueryParams: true,
        v: 2,
      });
      assert.deepEqual(out, { ...before, stripQueryParams: true });
      assert.deepEqual(out, await settings.getMasking(id));
    });

    it("mirrors allowedHosts only when a save sets it", async () => {
      const id = await workspace();
      await settings.setMasking(id, { allowedHosts: ["a.example.com"] });
      assert.deepEqual((await row(id)).allowedHosts, ["a.example.com"]);
      await settings.setMasking(id, { maskAllInputs: true });
      assert.deepEqual((await row(id)).allowedHosts, ["a.example.com"]);
      await settings.setMasking(id, { allowedHosts: [] });
      assert.deepEqual((await row(id)).allowedHosts, []);
    });

    it("stores strings jsonb would reject, repaired", async () => {
      const id = await workspace();
      await settings.setMasking(id, {
        allowedQueryParams: ["a\u0000b", "c\ud800"],
      });
      assert.deepEqual(
        ((await row(id)).maskingConfig as Record<string, unknown>)
          .allowedQueryParams,
        ["ab", "c�"],
      );
    });
  },
);
