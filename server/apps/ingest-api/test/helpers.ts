/**
 * Shared fixtures for the ingest-api tests (node:test, see `npm test`).
 *
 * The frames pipeline is exercised against a REAL Redis — its correctness
 * lives in stream TTLs, sorted-set scores and Lua scripts that a fake would
 * only restate. Postgres and R2 are in-memory fakes of the few calls the code
 * under test makes, so no database or bucket is needed.
 *
 * Redis: TEST_REDIS_URL (default: the docker-compose Redis on 6380). Each test
 * file passes its own logical DB, never 0, and nothing is flushed — every key
 * a test touches belongs to a session id generated for that test.
 */
import "reflect-metadata";
import { randomBytes } from "crypto";
import { Readable } from "stream";
import { gunzipSync } from "zlib";
import Redis from "ioredis";
import { parseRedisUrl } from "../src/common/redis-url";
import type { StorageService } from "../src/storage/storage.service";
import { framesGzKey } from "../src/frames/frames.constants";

// ClickHouse is not under test: point it at a closed port with the batcher off,
// so a projection insert fails at once and the code's own catch swallows it.
process.env.CLICKHOUSE_BATCH_INSERT = "0";
process.env.CLICKHOUSE_URL = "http://127.0.0.1:9";

export async function openTestRedis(db: number): Promise<Redis> {
  if (!Number.isInteger(db) || db <= 0) {
    throw new Error("tests use a dedicated Redis DB, never DB 0");
  }
  const opts = parseRedisUrl(
    process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380",
  );
  const redis = new Redis({
    ...opts,
    db,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  return redis;
}

export const newSid = (): string => `ses_test_${randomBytes(6).toString("hex")}`;

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ── Frames archive format: [u64 ts][u32 size][payload] ────────────────────

/** One frame record. The payload is derived from `ts`, so a frame's bytes
 *  identify it in an archive. */
export function frame(ts: number, payload = 16): Buffer {
  const b = Buffer.alloc(12 + payload);
  b.writeBigUInt64LE(BigInt(ts), 0);
  b.writeUInt32LE(payload, 8);
  b.fill(ts % 251, 12);
  return b;
}

/** A raw /images batch of frames at these timestamps. */
export const frames = (...ts: number[]): Buffer =>
  Buffer.concat(ts.map((t) => frame(t)));

/** Timestamps of every record in a stored (gzipped) archive, in order. Also
 *  checks each record's payload is the one frame() wrote for that ts. */
export function archiveTimestamps(gz: Buffer): number[] {
  const raw = gunzipSync(gz);
  const out: number[] = [];
  let off = 0;
  while (off + 12 <= raw.length) {
    const ts = Number(raw.readBigUInt64LE(off));
    const size = raw.readUInt32LE(off + 8);
    const payload = raw.subarray(off + 12, off + 12 + size);
    if (!payload.equals(frame(ts, size).subarray(12))) {
      throw new Error(`frame ${ts} payload corrupted`);
    }
    out.push(ts);
    off += 12 + size;
  }
  if (off !== raw.length) throw new Error("archive has a truncated record");
  return out;
}

// ── R2 ─────────────────────────────────────────────────────────────────────

/** In-memory object store with real multipart semantics: parts are staged per
 *  upload id and an object only appears (or is replaced) on completion. */
export class FakeStorage {
  enabled = true;
  readonly objects = new Map<string, Buffer>();
  private readonly staged = new Map<string, Map<number, Buffer>>();
  private seq = 0;
  /** Make openReadStream throw, as an R2 outage would. */
  failReads = false;
  /** Make removeOrThrow throw, as an R2 outage would. */
  failDeletes = false;
  /** openReadStream waits on this, when set — lets a test hold a read open. */
  readGate: Promise<void> | null = null;
  /** openReadStream calls made. */
  reads = 0;
  /** Runs after an object is stored — lets a test act mid-finalize. */
  onComplete: (() => Promise<void>) | null = null;

  asService(): StorageService {
    return this as unknown as StorageService;
  }

  archive(sid: string): Buffer | undefined {
    return this.objects.get(framesGzKey(sid));
  }

  async createMultipartUpload(): Promise<string> {
    const id = `upload-${++this.seq}`;
    this.staged.set(id, new Map());
    return id;
  }

  async uploadPart(o: {
    uploadId: string;
    partNumber: number;
    body: Buffer;
  }): Promise<string> {
    const parts = this.staged.get(o.uploadId);
    if (!parts) throw new Error(`NoSuchUpload ${o.uploadId}`);
    parts.set(o.partNumber, Buffer.from(o.body));
    return `etag-${o.partNumber}`;
  }

  async completeMultipartUpload(o: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number }>;
  }): Promise<string> {
    const parts = this.staged.get(o.uploadId);
    if (!parts) throw new Error(`NoSuchUpload ${o.uploadId}`);
    this.objects.set(
      o.key,
      Buffer.concat(o.parts.map((p) => parts.get(p.partNumber) as Buffer)),
    );
    this.staged.delete(o.uploadId);
    const hook = this.onComplete;
    if (hook) await hook();
    return this.publicUrl(o.key);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.staged.delete(uploadId);
  }

  async headPublicUrl(key: string): Promise<string | null> {
    return this.objects.has(key) ? this.publicUrl(key) : null;
  }

  publicUrl(key: string): string {
    return `https://r2.test/${key}`;
  }

  /** Served in 7-byte chunks so readers must cope with arbitrary chunk edges. */
  async openReadStream(key: string): Promise<Readable | null> {
    this.reads += 1;
    if (this.readGate) await this.readGate;
    if (this.failReads) throw new Error("R2 503 SlowDown");
    const obj = this.objects.get(key);
    if (!obj) return null;
    const chunks: Buffer[] = [];
    for (let i = 0; i < obj.length; i += 7) chunks.push(obj.subarray(i, i + 7));
    return Readable.from(chunks);
  }

  async removeOrThrow(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("R2 503 SlowDown");
    this.objects.delete(key);
  }

  /** Multipart uploads begun but neither completed nor aborted. */
  get openUploads(): number {
    return this.staged.size;
  }
}

// ── Postgres ───────────────────────────────────────────────────────────────

export interface SessionRow {
  id: number;
  publicId: string;
  workspaceId: number;
  endUserId: number | null;
  status: "LIVE" | "COMPLETED";
  /** "ios" / "android" for native sessions; null for legacy web rows. */
  platform: string | null;
  startedAt: Date;
  endedAt: Date;
  clockSkewMs: bigint | null;
  durationMs: number;
  dataSizeBytes: bigint;
  nativeSnapshotCount: number;
  excludedShort: boolean;
  appVersion: string | null;
  revId: string | null;
  appBuild: string | null;
  tapCount: number;
  consoleCount: number;
  networkCount: number;
  errorCount: number;
  pageCount: number;
  rageCount: number;
}

/** The Session table, reduced to the calls the frames + mobile ingest code,
 *  the LIVE sweep and the session lists make. update() applies Prisma's
 *  `{ increment }` and plain assignments; `where` supports equality,
 *  `{ lt, lte, gt, gte, in, notIn }`, `OR` and `AND` (a list or one object;
 *  see matches), and throws on anything else rather than ignore it. `notIn`
 *  follows SQL: a NULL column matches neither `in` nor `notIn`. */
export class FakeSessions {
  readonly rows = new Map<number, SessionRow>();
  private seq = 0;

  add(row: Partial<SessionRow> & { publicId: string }): SessionRow {
    const now = new Date();
    const full: SessionRow = {
      id: ++this.seq,
      workspaceId: 1,
      endUserId: null,
      status: "LIVE",
      platform: "ios",
      startedAt: now,
      endedAt: now,
      clockSkewMs: null,
      durationMs: 0,
      dataSizeBytes: 0n,
      nativeSnapshotCount: 0,
      excludedShort: false,
      appVersion: null,
      revId: null,
      appBuild: null,
      tapCount: 0,
      consoleCount: 0,
      networkCount: 0,
      errorCount: 0,
      pageCount: 0,
      rageCount: 0,
      ...row,
    };
    this.rows.set(full.id, full);
    return full;
  }

  get(id: number): SessionRow {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no session ${id}`);
    return { ...row };
  }

  async findFirst(args: {
    where: Record<string, unknown>;
  }): Promise<SessionRow | null> {
    for (const row of this.rows.values()) {
      if (this.matches(row, args.where)) return { ...row };
    }
    return null;
  }

  /** `orderBy` is one `{ column: "asc" | "desc" }` or a list of them;
   *  `select` is applied. */
  async findMany(args: {
    where?: Record<string, unknown>;
    select?: Record<string, boolean>;
    orderBy?:
      | Record<string, "asc" | "desc">
      | Array<Record<string, "asc" | "desc">>;
    take?: number;
  }): Promise<Array<Partial<SessionRow>>> {
    let out = [...this.rows.values()].filter((row) =>
      this.matches(row, args.where ?? {}),
    );
    const order = Array.isArray(args.orderBy)
      ? args.orderBy
      : args.orderBy
        ? [args.orderBy]
        : [];
    out.sort((a, b) => {
      for (const o of order) {
        const [key, dir] = Object.entries(o)[0];
        const d = this.compare(
          (a as unknown as Record<string, unknown>)[key],
          (b as unknown as Record<string, unknown>)[key],
        );
        if (d !== 0) return dir === "desc" ? -d : d;
      }
      return 0;
    });
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out.map((row) => {
      if (!args.select) return { ...row };
      const picked: Record<string, unknown> = {};
      for (const [key, on] of Object.entries(args.select)) {
        if (on) picked[key] = (row as unknown as Record<string, unknown>)[key];
      }
      return picked as Partial<SessionRow>;
    });
  }

  async count(args: { where?: Record<string, unknown> }): Promise<number> {
    return [...this.rows.values()].filter((row) =>
      this.matches(row, args.where ?? {}),
    ).length;
  }

  /** `_count: { _all: true }` and `_avg` of numeric columns over the rows
   *  matching `where`; an average over no rows is null, as in SQL. */
  async aggregate(args: {
    where?: Record<string, unknown>;
    _count?: { _all: true };
    _avg?: Record<string, boolean>;
  }): Promise<{
    _count?: { _all: number };
    _avg?: Record<string, number | null>;
  }> {
    const rows = [...this.rows.values()].filter((row) =>
      this.matches(row, args.where ?? {}),
    );
    const out: {
      _count?: { _all: number };
      _avg?: Record<string, number | null>;
    } = {};
    if (args._count) out._count = { _all: rows.length };
    if (args._avg) {
      const avg: Record<string, number | null> = {};
      for (const [key, on] of Object.entries(args._avg)) {
        if (!on) continue;
        const values = rows.map((row) =>
          Number((row as unknown as Record<string, unknown>)[key]),
        );
        avg[key] = values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
      }
      out._avg = avg;
    }
    return out;
  }

  async findUnique(args: { where: { id: number } }): Promise<SessionRow | null> {
    const row = this.rows.get(args.where.id);
    return row ? { ...row } : null;
  }

  async update(args: {
    where: { id: number };
    data: Record<string, unknown>;
  }): Promise<SessionRow> {
    const row = this.rows.get(args.where.id) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("Record to update not found.");
    this.apply(row, args.data);
    return { ...(row as unknown as SessionRow) };
  }

  /** Every row matching `where` — e.g. by id, guarded by `{ <column>: { lt: n } }`:
   *  the conditional UPDATE Postgres applies atomically to the row's current
   *  value. */
  async updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (!this.matches(row, args.where)) continue;
      this.apply(row as unknown as Record<string, unknown>, args.data);
      count += 1;
    }
    return { count };
  }

  private matches(row: SessionRow, where: Record<string, unknown>): boolean {
    const r = row as unknown as Record<string, unknown>;
    for (const [key, cond] of Object.entries(where)) {
      if (key === "OR") {
        const anyOf = cond as Array<Record<string, unknown>>;
        if (!anyOf.some((w) => this.matches(row, w))) return false;
        continue;
      }
      if (key === "AND") {
        const allOf = (Array.isArray(cond) ? cond : [cond]) as Array<
          Record<string, unknown>
        >;
        if (!allOf.every((w) => this.matches(row, w))) return false;
        continue;
      }
      const value = r[key];
      if (cond === null || typeof cond !== "object" || cond instanceof Date) {
        if (this.compare(value, cond) !== 0) return false;
        continue;
      }
      for (const [op, operand] of Object.entries(cond)) {
        const d = op === "in" || op === "notIn" ? 0 : this.compare(value, operand);
        const ok =
          op === "in"
            ? (operand as unknown[]).some((v) => this.compare(value, v) === 0)
            : op === "notIn"
              ? value !== null &&
                value !== undefined &&
                !(operand as unknown[]).some((v) => this.compare(value, v) === 0)
            : op === "lt"
              ? d < 0
              : op === "lte"
                ? d <= 0
                : op === "gt"
                  ? d > 0
                  : op === "gte"
                    ? d >= 0
                    : this.unsupported(key, op);
        if (!ok) return false;
      }
    }
    return true;
  }

  /** Orders numbers, bigints, Dates and strings; null sorts first. */
  private compare(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
    if (b === null || b === undefined) return 1;
    const key = (v: unknown): number | bigint | string =>
      v instanceof Date ? v.getTime() : (v as number | bigint | string);
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  private unsupported(key: string, op: string): never {
    throw new Error(`FakeSessions: unsupported where ${key}.${op}`);
  }

  private apply(row: Record<string, unknown>, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        const inc = (value as { increment: number | bigint }).increment;
        row[key] =
          typeof inc === "bigint"
            ? (row[key] as bigint) + inc
            : (row[key] as number) + inc;
      } else {
        row[key] = value;
      }
    }
  }
}

/** Swap a service's Prisma client (a `getPostgresClient()` field) for the fake. */
export function useFakeDb(service: object, sessions: FakeSessions): void {
  (service as { db: unknown }).db = { session: sessions };
}

/** WorkspaceStatsService stand-in that records storage deltas. */
export class FakeStats {
  storageBytes = 0n;
  async bump(_wid: number, d: { storageBytes?: bigint }): Promise<void> {
    this.storageBytes += d.storageBytes ?? 0n;
  }
}

// ── Mobile wire protocol: [varint type][varint ts][varint length][fields] ──

function uvarint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([uvarint(b.length), b]);
}

function message(type: number, ts: number, fields: Buffer): Buffer {
  return Buffer.concat([uvarint(type), uvarint(ts), uvarint(fields.length), fields]);
}

/** Encoders for the message types the tests send (see mobile-messages.ts). */
export const wire = {
  batchMeta: (ts: number, firstIndex = 0): Buffer =>
    message(107, ts, uvarint(firstIndex)),
  click: (ts: number, label = "Pay"): Buffer =>
    message(100, ts, Buffer.concat([str(label), uvarint(40), uvarint(80)])),
  performance: (ts: number, name = "memoryUsage", value = 1): Buffer =>
    message(102, ts, Buffer.concat([str(name), uvarint(value)])),
  crash: (ts: number): Buffer =>
    message(97, ts, Buffer.concat([str("Error"), str("boom"), str("at main")])),
  screen: (ts: number, name = "Home", visible = true): Buffer =>
    message(98, ts, Buffer.concat([str(name), str(name), Buffer.from([visible ? 1 : 0])])),
  /** The SDKs' foreground/background marker: 1 = left, 0 = back. */
  background: (ts: number, value: 0 | 1): Buffer =>
    message(102, ts, Buffer.concat([str("background"), uvarint(value)])),
};
