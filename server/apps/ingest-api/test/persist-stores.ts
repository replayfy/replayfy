/**
 * ReplayPersistenceService.persist() against REAL Postgres and Mongo: its
 * correctness lives in unique indexes, ON CONFLICT, a data-modifying CTE,
 * Prisma's P2002 on a create race and the number of Mongo operations Prisma
 * issues, all of which an in-memory fake would only restate.
 *
 * Each test FILE gets its own throwaway databases, created in before() and
 * dropped in after(): Postgres from the docker-compose server (migrated with
 * `prisma migrate deploy`), Mongo from the docker-compose replica set (schema
 * and indexes from `prisma db push`). Override the servers with
 * TEST_POSTGRES_URL (any database on the server, used only to CREATE and DROP
 * the throwaway one) and TEST_MONGO_URL. ClickHouse is not touched: the
 * projection's insert function is swapped for a recorder.
 *
 * Failures are injected by wrapping the two Prisma clients: a test arms an
 * operation (`faults.arm("sessionPath.create")`) to make its next call throw,
 * before or after the real call ran.
 */
import "reflect-metadata";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import path from "path";
import { PrismaClient as PgClient } from "@replay/db-postgres";
import { PrismaClient as MongoClient } from "@replay/db-mongo";
import type { ProjectionRow } from "@replay/db-clickhouse";
import type { ReplayBatchEnvelope, ReplayEvent } from "@replay/replay-schema";
import { ReplayPersistenceService } from "../src/replay/replay-persistence.service";
import type { ReplayBatchJob } from "../src/queue/queue.types";
import type { PlaylistsService } from "../src/playlists/playlists.service";
import type { CohortsService } from "../src/cohorts/cohorts.service";
import type { WorkspaceStatsService } from "../src/workspace-stats/workspace-stats.service";
import type { WorkspacePerfDailyService } from "../src/workspace-perf-daily/workspace-perf-daily.service";
import type { SignalsService } from "../src/signals/signals.service";

// dist-test/test → the repo root, where the prisma CLI and schemas live.
const ROOT = path.resolve(__dirname, "../../../..");
const PRISMA = path.join(ROOT, "node_modules/.bin/prisma");

// ── Fault injection ─────────────────────────────────────────────────────────

/** One-shot failures (and hooks) a test arms on a store operation. */
export class Faults {
  private readonly before = new Map<string, number>();
  private readonly after = new Map<string, number>();
  private readonly hooks = new Map<string, () => Promise<void>>();

  /** Make the next `times` calls of `op` throw WITHOUT running. */
  arm(op: string, times = 1): void {
    this.before.set(op, (this.before.get(op) ?? 0) + times);
  }

  /** Make the next call of `op` run (and commit), then throw: a reply lost
   *  after the store applied the write. */
  armAfter(op: string): void {
    this.after.set(op, (this.after.get(op) ?? 0) + 1);
  }

  /** Run `fn` once, just before the next call of `op`. */
  hook(op: string, fn: () => Promise<void>): void {
    this.hooks.set(op, fn);
  }

  async run<T>(op: string, call: () => Promise<T>): Promise<T> {
    const hook = this.hooks.get(op);
    if (hook) {
      this.hooks.delete(op);
      await hook();
    }
    if (this.take(this.before, op)) throw new Error(`injected failure: ${op}`);
    const result = await call();
    if (this.take(this.after, op)) {
      throw new Error(`injected failure after commit: ${op}`);
    }
    return result;
  }

  private take(m: Map<string, number>, op: string): boolean {
    const left = m.get(op) ?? 0;
    if (left <= 0) return false;
    m.set(op, left - 1);
    return true;
  }
}

/** The name a test arms for a raw statement or command. */
function rawOpName(prop: string, args: unknown[]): string {
  if (prop === "$executeRaw" || prop === "$queryRaw") {
    const sql = (args[0] as TemplateStringsArray).join("?");
    if (sql.includes("WITH claim")) return "session.applyCounts";
    if (sql.includes('"customProps"')) return "session.customProps";
    if (sql.includes('"longTaskTotalMs"')) return "session.perfTotals";
  }
  if (prop === "$runCommandRaw") {
    const cmd = args[0] as { update?: string; updates?: Array<{ u?: { $set?: object } }> };
    if (cmd.update === "ReplayBatch" && cmd.updates?.[0]?.u?.$set && "persistedAt" in cmd.updates[0].u.$set) {
      return "replayBatch.markPersisted";
    }
  }
  return prop;
}

/** The client, with every model call and raw statement routed through
 *  `faults`. A `replayBatch.update` that sets only persistedAt is named
 *  "replayBatch.markPersisted", as the raw command is. */
function withFaults<T extends object>(client: T, faults: Faults): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== "string") return value;
      if (prop === "$executeRaw" || prop === "$queryRaw" || prop === "$runCommandRaw") {
        const fn = value as (...a: unknown[]) => Promise<unknown>;
        return (...args: unknown[]) =>
          faults.run(rawOpName(prop, args), () => fn.apply(target, args));
      }
      if (typeof value === "function") return (value as Function).bind(target);
      if (prop.startsWith("$") || value === null || typeof value !== "object") {
        return value;
      }
      // A model delegate (session, replayBatch, ...).
      const delegate = value as Record<string, unknown>;
      return new Proxy(delegate, {
        get(d, method) {
          const m = d[method as string];
          if (typeof method !== "string" || typeof m !== "function") return m;
          return (...args: unknown[]) => {
            const data = (args[0] as { data?: Record<string, unknown> } | undefined)?.data;
            const op =
              prop === "replayBatch" &&
              method === "update" &&
              data &&
              Object.keys(data).length === 1 &&
              "persistedAt" in data
                ? "replayBatch.markPersisted"
                : `${prop}.${method}`;
            return faults.run(op, () => (m as Function).apply(d, args));
          };
        },
      });
    },
  });
}

// ── Throwaway databases ─────────────────────────────────────────────────────

export interface Stores {
  /** Unwrapped clients, for test setup and assertions. */
  pg: PgClient;
  mongo: MongoClient;
  /** Every Mongo query Prisma sent, as logged (cleared by the tests). */
  mongoQueries: string[];
  /** Every Postgres statement Prisma sent, as logged. */
  pgQueries: string[];
  drop(): Promise<void>;
}

function prismaCli(schema: string, args: string[], env: Record<string, string>): void {
  try {
    execFileSync(PRISMA, [...args, "--schema", path.join(ROOT, schema)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    throw new Error(
      `prisma ${args.join(" ")} failed: ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
    );
  }
}

/** Fresh Postgres + Mongo databases with the app's schema. */
export async function openThrowawayStores(tag: string): Promise<Stores> {
  const name = `replay_test_${tag}_${randomBytes(4).toString("hex")}`;

  const adminUrl =
    process.env.TEST_POSTGRES_URL ??
    "postgresql://replay:replay@127.0.0.1:5433/postgres";
  const pgUrl = new URL(adminUrl);
  pgUrl.pathname = `/${name}`;
  const admin = new PgClient({ datasources: { db: { url: adminUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);

  const mongoUrl = new URL(
    process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/?replicaSet=rs0",
  );
  mongoUrl.pathname = `/${name}`;

  const pg = new PgClient({
    datasources: { db: { url: pgUrl.toString() } },
    log: [{ emit: "event", level: "query" }],
  });
  const pgQueries: string[] = [];
  pg.$on("query", (e) => pgQueries.push(e.query));
  const mongo = new MongoClient({
    datasources: { db: { url: mongoUrl.toString() } },
    log: [{ emit: "event", level: "query" }],
  });
  const mongoQueries: string[] = [];
  mongo.$on("query", (e) => mongoQueries.push(e.query));

  const drop = async () => {
    await pg.$disconnect().catch(() => undefined);
    await mongo.$runCommandRaw({ dropDatabase: 1 }).catch(() => undefined);
    await mongo.$disconnect().catch(() => undefined);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  };
  try {
    prismaCli("packages/db-postgres/prisma/schema.prisma", ["migrate", "deploy"], {
      DATABASE_URL_POSTGRES: pgUrl.toString(),
    });
    prismaCli("packages/db-mongo/prisma/schema.prisma", ["db", "push", "--skip-generate"], {
      DATABASE_URL_MONGO: mongoUrl.toString(),
    });
    // The workspaces the tests write as.
    for (const id of [1, 2]) {
      await pg.workspace.create({ data: { id, slug: `ws-${id}-${name}`, name: `ws ${id}` } });
    }
  } catch (e) {
    await drop();
    throw e;
  }
  return { pg, mongo, mongoQueries, pgQueries, drop };
}

// ── The service under test ──────────────────────────────────────────────────

/** Records every ClickHouse projection row persist() inserts, by replacing
 *  the package export the service calls (CommonJS: looked up per call). */
export function captureClickHouse(): { rows: ProjectionRow[]; restore: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ch = require("@replay/db-clickhouse") as Record<string, unknown>;
  const original = {
    insertProjectionRows: ch.insertProjectionRows,
    ensureClickHouseSchema: ch.ensureClickHouseSchema,
  };
  const rows: ProjectionRow[] = [];
  ch.insertProjectionRows = async (batch: ProjectionRow[]) => {
    rows.push(...batch);
  };
  ch.ensureClickHouseSchema = async () => {};
  return {
    rows,
    restore: () => Object.assign(ch, original),
  };
}

/** The follow-up services persist() calls, as counters. */
export class FakeFollowUps {
  storageBytes = 0n;
  sessionsTotal = 0;
  perfDailyBumps = 0;

  readonly stats = {
    bump: async (_wid: number, d: { storageBytes?: bigint; sessionsTotal?: number }) => {
      this.storageBytes += d.storageBytes ?? 0n;
      this.sessionsTotal += d.sessionsTotal ?? 0;
    },
  };
  readonly perfDaily = {
    bumpForSession: async () => {
      this.perfDailyBumps += 1;
    },
  };
  readonly playlists = { evaluateForSession: async () => {} };
  readonly cohorts = { markUsersDirty: async () => {} };
  readonly signals = { deriveForSession: async () => {} };
}

export interface Harness {
  service: ReplayPersistenceService;
  faults: Faults;
  followUps: FakeFollowUps;
}

/** A service on the given stores, with fresh faults and follow-up counters. */
export function makeService(stores: Stores): Harness {
  const faults = new Faults();
  const followUps = new FakeFollowUps();
  const service = new ReplayPersistenceService(
    followUps.playlists as unknown as PlaylistsService,
    followUps.cohorts as unknown as CohortsService,
    followUps.stats as unknown as WorkspaceStatsService,
    followUps.perfDaily as unknown as WorkspacePerfDailyService,
    followUps.signals as unknown as SignalsService,
  );
  (service as unknown as { db: unknown }).db = withFaults(stores.pg, faults);
  (service as unknown as { mongo: unknown }).mongo = withFaults(stores.mongo, faults);
  return { service, faults, followUps };
}

export const newSessionId = (): string =>
  `ses_dedupe_${randomBytes(6).toString("hex")}`;

// ── Batches ─────────────────────────────────────────────────────────────────

let eventSeq = 0;
function ev(type: ReplayEvent["type"], ts: number, data: unknown): ReplayEvent {
  return { id: `e${++eventSeq}`, ts, offsetMs: 0, type, source: "web", data };
}

/**
 * A web batch with something in every counter persist() derives: 2 clicks,
 * a console error, a network call, an uncaught error, an LCP and a long task
 * (perf totals), a track event, and a full snapshot.
 */
export function batch(o: {
  sessionId: string;
  segmentId?: string;
  sequence: number;
  url: string;
  /** Events are stamped from here (default: now, so the session stays LIVE). */
  ts?: number;
  extraClicks?: number;
}): ReplayBatchEnvelope {
  const t = o.ts ?? Date.now();
  const events: ReplayEvent[] = [
    ev("full_snapshot", t, { node: {} }),
    ev("pointer", t + 1, { x: 1, y: 1 }),
    ev("pointer", t + 2, { x: 2, y: 2 }),
    ev("console", t + 3, { level: "error", message: "boom" }),
    ev("network", t + 4, { method: "GET", url: "https://api.test/x", statusCode: 500, durationMs: 12 }),
    ev("error", t + 5, { message: "TypeError: x", stack: "at y" }),
    ev("performance", t + 6, { kind: "perf", metric: "lcp", value: 2400, unit: "ms" }),
    ev("performance", t + 7, { kind: "perf", metric: "long_task", value: 120, unit: "ms" }),
    ev("custom", t + 8, { kind: "track", name: "checkout" }),
  ];
  for (let i = 0; i < (o.extraClicks ?? 0); i += 1) {
    events.push(ev("pointer", t + 9 + i, { x: 3, y: 3 }));
  }
  return {
    sessionId: o.sessionId,
    segmentId: o.segmentId ?? "seg-1",
    sequence: o.sequence,
    sentAt: t + 20,
    sdk: { name: "replay-web", version: "0.1.18", platform: "web" },
    page: {
      url: o.url,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    },
    events,
  };
}

/** What persist() measures as a batch's size (dataSizeBytes, storage). */
export const sizeOf = (b: ReplayBatchEnvelope): bigint =>
  BigInt(Buffer.byteLength(JSON.stringify(b.events), "utf8"));

export function job(workspaceId: number, envelope: ReplayBatchEnvelope): ReplayBatchJob {
  // A fresh copy per delivery, as each Bull job deserializes its own.
  return {
    workspaceId,
    apiKeyId: 1,
    envelope: JSON.parse(JSON.stringify(envelope)) as ReplayBatchEnvelope,
    fingerprint: "fp-test",
  };
}

/** The Session counters a duplicate would inflate. */
export async function counters(
  pg: PgClient,
  publicId: string,
): Promise<Record<string, unknown>> {
  const s = await pg.session.findUnique({ where: { publicId } });
  if (!s) throw new Error(`no session ${publicId}`);
  return {
    clickCount: s.clickCount,
    consoleCount: s.consoleCount,
    consoleErrorCount: s.consoleErrorCount,
    networkCount: s.networkCount,
    errorCount: s.errorCount,
    frameCount: s.frameCount,
    dataSizeBytes: s.dataSizeBytes,
    longTaskCount: s.longTaskCount,
    longTaskTotalMs: s.longTaskTotalMs,
    pageCount: s.pageCount,
  };
}
