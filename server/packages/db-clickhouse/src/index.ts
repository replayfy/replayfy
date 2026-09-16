import {
  createClient,
  type ClickHouseClient,
  type ClickHouseSettings,
} from "@clickhouse/client";
import { ClickHouseInsertBatcher } from "./insert-batcher";

/**
 * Discriminator for `replay.session_events` rows.
 *
 * - `console` / `network` / `error` — original web-SDK kinds.
 * - `tap` — native-platform touch events (Android OnTouchListener
 *   / iOS UIGestureRecognizer). Web "click" events also persist
 *   here so the dashboard's EventsPanel renders both uniformly.
 * - `custom` — kind-tagged custom events the SDK emits via
 *   `Replay.track`, plus dashboard-promoted variants like
 *   `bug_report`, `session_property`, `session_tag`, `push_token`,
 *   `session_favorite`. The custom subtype is stored in `level`
 *   (acts as the discriminator inside the kind) + the event's
 *   `name` field lives in `message`. Structured properties land
 *   in `raw` as JSON.
 * - `screen` — `tagScreenName` / auto-screen-detect route changes.
 *   `message` holds the route name; the player uses these to
 *   anchor the timeline + drive the "Screens" tab.
 * - `perf` — performance events (web vitals + native vitals).
 *   `method` holds the metric name (`cold_start_ms`, `anr_ms`,
 *   `frame_drop_pct`, …); `duration_ms` holds the value × 1000
 *   when it's a fractional pct, else the raw value; `level`
 *   holds the rating bucket.
 */
export type ProjectionKind =
  | "console"
  | "network"
  | "error"
  | "tap"
  | "custom"
  | "screen"
  | "perf";

export interface ProjectionRow {
  workspace_id: number;
  session_id: number;
  session_public_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  kind: ProjectionKind;
  timestamp: number;
  offset_ms: number;
  level: string;
  message: string;
  method: string;
  url: string;
  status_code: number;
  duration_ms: number;
  error: string;
  stack: string;
  raw: string;
  // Network detail. Stored as serialised JSON strings so we don't need to
  // touch the schema each time the SDK adds another piece of metadata.
  request_headers: string;
  response_headers: string;
  request_body: string;
  response_body: string;
  // Connection quality at the time the request was made. Lets us answer
  // "was the user's network bad?" without leaving the player.
  connection_rtt: number;
  connection_effective_type: string;
  // Native-platform tap fields. Empty / 0 for non-tap rows.
  // ui_class = view class name (e.g. "Button", "UIButton");
  // ui_value = the rendered text / label;
  // ui_id    = stable hash for grouping (route+class+value).
  // bounds_x/y/w/h + point_x/y are SCREEN-RELATIVE pixels so the
  // dashboard overlays don't need to know about the host's coord
  // system. is_sensitive=1 when the tap landed inside a
  // privacy-marked view; uiClass / uiValue blanked in that case.
  // gesture is "tap" | "long_press" | "swipe_*" | "pinch"
  // (omitted ⇒ "tap"); pinch_scale × 1000 for pinch gestures.
  ui_class: string;
  ui_value: string;
  ui_id: string;
  ui_type: string;
  bounds_x: number;
  bounds_y: number;
  bounds_w: number;
  bounds_h: number;
  point_x: number;
  point_y: number;
  is_sensitive: number;
  gesture: string;
  pinch_scale_x1000: number;
  // Route at event time. Populated for tap + screen rows; lets
  // dashboard filter "show me every tap on the Checkout screen"
  // without joining against the screen-change row sequence.
  route: string;
  // Release (appVersion / web revId) the session ran — denormalised so Release
  // Intelligence can aggregate by release without a cross-store join.
  release: string;
}

export interface ListLogsFilter {
  sessionId?: number;
  sessionPublicId?: string;
  workspaceId?: number;
  kind?: ProjectionKind;
  limit?: number;
  cursor?: number;
}

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS replay;

CREATE TABLE IF NOT EXISTS replay.session_events (
  workspace_id      UInt32,
  session_id        UInt32,
  session_public_id String,
  sequence          UInt32,
  event_id          String,
  event_type        LowCardinality(String),
  kind              LowCardinality(String),
  timestamp         UInt64,
  offset_ms         UInt32,
  level             LowCardinality(String) DEFAULT '',
  message           String DEFAULT '',
  method            LowCardinality(String) DEFAULT '',
  url               String DEFAULT '',
  status_code       Int32 DEFAULT 0,
  duration_ms       UInt32 DEFAULT 0,
  error             String DEFAULT '',
  stack             String DEFAULT '',
  raw               String DEFAULT '',
  request_headers   String DEFAULT '',
  response_headers  String DEFAULT '',
  request_body      String DEFAULT '',
  response_body     String DEFAULT '',
  connection_rtt    UInt32 DEFAULT 0,
  connection_effective_type LowCardinality(String) DEFAULT '',
  release           LowCardinality(String) DEFAULT '',
  ingested_at       DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(toDateTime(timestamp / 1000))
ORDER BY (workspace_id, session_id, sequence, timestamp);

ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS request_headers String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS response_headers String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS request_body String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS response_body String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS connection_rtt UInt32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS connection_effective_type LowCardinality(String) DEFAULT '';

-- Native-platform tap + gesture columns. Idempotent ADDs so this
-- migration is safe to re-run on existing deployments.
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS ui_class String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS ui_value String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS ui_id String DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS ui_type LowCardinality(String) DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS bounds_x Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS bounds_y Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS bounds_w Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS bounds_h Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS point_x Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS point_y Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS is_sensitive UInt8 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS gesture LowCardinality(String) DEFAULT '';
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS pinch_scale_x1000 Int32 DEFAULT 0;
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS route String DEFAULT '';

-- Release (appVersion / web revId) denormalised onto every event so
-- Release Intelligence can aggregate latency etc. by release without a
-- cross-store join. Idempotent.
ALTER TABLE replay.session_events ADD COLUMN IF NOT EXISTS release LowCardinality(String) DEFAULT '';

-- One row per session, mirroring the reference's analytics sessions table.
-- The funnel engine INNER JOINs it to session_events USING(session_id) to
-- count by user (GROUP BY user_id, anonymous rows excluded), break down by
-- any session attribute, and filter segments — all in pure ClickHouse, no
-- cross-store id lookup. Written once at finalize (web + mobile) plus a
-- one-time backfill. ReplacingMergeTree(_version) keeps the latest re-write,
-- and reads use FINAL so a session counts exactly once. user_id is the
-- identified EndUser.distinctId, and '' means anonymous (reference NULL).
CREATE TABLE IF NOT EXISTS replay.sessions (
  workspace_id     UInt32,
  session_id       UInt32,
  user_id          String DEFAULT '',
  anonymous_id     String DEFAULT '',
  datetime         UInt64 DEFAULT 0,
  duration_ms      UInt32 DEFAULT 0,
  platform         LowCardinality(String) DEFAULT 'web',
  os               LowCardinality(String) DEFAULT '',
  os_version       LowCardinality(String) DEFAULT '',
  device           String DEFAULT '',
  device_model     String DEFAULT '',
  browser          LowCardinality(String) DEFAULT '',
  browser_version  LowCardinality(String) DEFAULT '',
  start_path       String DEFAULT '',
  country          LowCardinality(String) DEFAULT '',
  state            LowCardinality(String) DEFAULT '',
  city             String DEFAULT '',
  plan             LowCardinality(String) DEFAULT '',
  release          LowCardinality(String) DEFAULT '',
  tracker_version  LowCardinality(String) DEFAULT '',
  utm_source       String DEFAULT '',
  utm_medium       String DEFAULT '',
  utm_campaign     String DEFAULT '',
  pages_count      UInt16 DEFAULT 0,
  errors_count     UInt16 DEFAULT 0,
  rage_count       UInt16 DEFAULT 0,
  dead_count       UInt16 DEFAULT 0,
  start_url        String DEFAULT '',
  referrer         String DEFAULT '',
  first_seen_at    UInt64 DEFAULT 0,
  attrs            Map(String, String),
  _version         UInt64 DEFAULT 0
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMMDD(toDateTime(datetime / 1000))
ORDER BY (workspace_id, session_id);

-- Filter attributes denormalised so EVERY funnel filter is pure ClickHouse (no
-- Postgres fallback). These mirror Postgres Session/EndUser columns that also
-- back the Recordings UI; here they exist purely so the funnel sessions JOIN can
-- filter on rage/dead/errors, landing URL, referrer, and new-vs-returning
-- (first_seen_at compared to the funnel window) without leaving ClickHouse.
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS rage_count UInt16 DEFAULT 0;
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS dead_count UInt16 DEFAULT 0;
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS start_url String DEFAULT '';
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS referrer String DEFAULT '';
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS first_seen_at UInt64 DEFAULT 0;
-- Identify() traits (EndUser.customProps) as a CH Map so user-attribute funnel
-- filters (plan=pro, role=admin, …) run pure-CH via s.attrs[key], the same role
-- the reference's metadata_1..10 slots play — but key-agnostic.
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS attrs Map(String, String);
-- OS/browser version + landing path, for the osVersion/browserVersion/urlPath
-- funnel filters + breakdowns. Idempotent.
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS os_version LowCardinality(String) DEFAULT '';
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS browser_version LowCardinality(String) DEFAULT '';
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS start_path String DEFAULT '';
-- Raw hardware model (iPhone 17, Pixel 8) for the "device model" facet + filter.
-- Populated for mobile only (web UAs expose no model). String, NOT
-- LowCardinality: model cardinality grows unbounded across the device fleet.
ALTER TABLE replay.sessions ADD COLUMN IF NOT EXISTS device_model String DEFAULT '';

-- Per-session AI "card" — the compact, figurative summary the Replayfy AI
-- reads instead of raw events. One row per session, emitted by the session
-- processor at finalize (after signals + issues). Denormalises the outcome,
-- journey, signal types, issue fingerprints, key counts, and a deterministic
-- one-line summary so the agent can reason over a workspace's sessions cheaply
-- and cite a recording. ReplacingMergeTree(_version) keeps the latest
-- re-processing; reads use FINAL so a session counts exactly once.
CREATE TABLE IF NOT EXISTS replay.session_cards (
  workspace_id       UInt32,
  session_id         UInt32,
  session_public_id  String DEFAULT '',
  user_id            String DEFAULT '',
  anonymous_id       String DEFAULT '',
  datetime           UInt64 DEFAULT 0,
  duration_ms        UInt32 DEFAULT 0,
  platform           LowCardinality(String) DEFAULT 'web',
  release            LowCardinality(String) DEFAULT '',
  device             String DEFAULT '',
  os                 LowCardinality(String) DEFAULT '',
  browser            LowCardinality(String) DEFAULT '',
  country            LowCardinality(String) DEFAULT '',
  outcome            LowCardinality(String) DEFAULT 'normal',
  journey            String DEFAULT '',
  signals            Array(LowCardinality(String)),
  issue_fingerprints Array(String),
  pages_count        UInt16 DEFAULT 0,
  error_count        UInt16 DEFAULT 0,
  crash_count        UInt16 DEFAULT 0,
  rage_count         UInt16 DEFAULT 0,
  dead_count         UInt16 DEFAULT 0,
  network_fail_count UInt16 DEFAULT 0,
  slow_api_count     UInt16 DEFAULT 0,
  session_score      Int16 DEFAULT 100,
  summary            String DEFAULT '',
  _version           UInt64 DEFAULT 0
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMMDD(toDateTime(datetime / 1000))
ORDER BY (workspace_id, session_id);
`;

let cached: ClickHouseClient | undefined;

export function getClickHouseClient(): ClickHouseClient {
  if (!cached) {
    cached = createClient({
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: process.env.CLICKHOUSE_DATABASE ?? "default",
      compression: { request: false, response: true },
      // Default 30s. Large batch inserts during a big backfill can outlast that
      // while ClickHouse merges parts under memory pressure; allow raising it.
      request_timeout: Number(process.env.CLICKHOUSE_REQUEST_TIMEOUT ?? 30000),
      // The client's socket pool caps CONCURRENT inserts. The default (10) sits
      // BELOW the replay-worker concurrency (REPLAY_WORKER_CONCURRENCY, up to
      // 16+), so under ingest load the extra workers block waiting for a socket
      // and per-insert latency balloons from ~15ms to ~670ms — measured, and the
      // dominant cap on worker drain throughput. The CH server itself sustains
      // 16-way async inserts at ~15ms p50 (651/s), so the fix is purely to give
      // the client enough sockets. Keep it >= worker concurrency; default 24
      // covers the default-16 worker pool with headroom for reads.
      max_open_connections: Number(
        process.env.CLICKHOUSE_MAX_OPEN_CONNECTIONS ?? 24,
      ),
      // Reuse sockets across inserts rather than re-handshaking each time.
      keep_alive: { enabled: true },
      // Server-side resource caps so a user-crafted analytical query (huge time
      // window, high-cardinality group-by) can't run unbounded and OOM the
      // shared node — the query-abuse DoS from the audit. Deliberately GENEROUS:
      // normal reads scan millions of rows / use MBs / finish in <1s, and async
      // inserts return no rows, so these only bite pathological abuse. Unlike
      // request_timeout (a client socket close), max_execution_time makes the CH
      // SERVER actually kill the query and free its memory. All env-tunable so a
      // larger prod box / a legitimate heavy backfill can raise them.
      clickhouse_settings: {
        max_execution_time: Number(
          process.env.CLICKHOUSE_MAX_EXECUTION_TIME ?? 60,
        ),
        max_memory_usage: process.env.CLICKHOUSE_MAX_MEMORY_USAGE ?? "4000000000",
        max_rows_to_read: process.env.CLICKHOUSE_MAX_ROWS_TO_READ ?? "2000000000",
        max_result_rows: process.env.CLICKHOUSE_MAX_RESULT_ROWS ?? "5000000",
      } as ClickHouseSettings,
    });
  }
  return cached;
}

export async function disconnectClickHouse(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = undefined;
  }
}

export async function ensureClickHouseSchema(): Promise<void> {
  const client = getClickHouseClient();
  // Strip `--` line comments BEFORE splitting on `;` — otherwise a semicolon
  // inside a comment splits a statement and yields a comment-only "Empty query".
  // (Our DDL has no string literals containing `--`, so this is safe.)
  const sql = SCHEMA.replace(/--[^\n]*/g, "");
  for (const stmt of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.command({ query: stmt });
  }
}

/**
 * Fetch selected event rows for MANY sessions at once (one query, no N+1) —
 * used by the funnel engine to walk mobile stages (tap / screen / custom) and
 * collect issues (errors) across all candidate sessions in a single round
 * trip. Rows come back ordered by (session_id, offset_ms) so the caller can
 * walk each session's events in chronological order.
 */
export async function listEventsForSessions(opts: {
  workspaceId: number;
  sessionIds: number[];
  kinds: string[];
  limit?: number;
}): Promise<
  Array<
    Pick<
      ProjectionRow,
      | "session_id"
      | "kind"
      | "offset_ms"
      | "ui_value"
      | "route"
      | "message"
      | "level"
      | "error"
    >
  >
> {
  if (opts.sessionIds.length === 0 || opts.kinds.length === 0) return [];
  const client = getClickHouseClient();
  const result = await client.query({
    query: `SELECT session_id, kind, offset_ms, ui_value, route, message, level, error
            FROM replay.session_events
            WHERE workspace_id = {workspaceId:UInt32}
              AND kind IN {kinds:Array(String)}
              AND session_id IN {sessionIds:Array(UInt32)}
            ORDER BY session_id ASC, offset_ms ASC
            LIMIT ${Math.min(opts.limit ?? 500_000, 1_000_000)}`,
    format: "JSONEachRow",
    query_params: {
      workspaceId: opts.workspaceId,
      kinds: opts.kinds,
      sessionIds: opts.sessionIds,
    },
  });
  return (await result.json()) as never;
}

/**
 * ClickHouse async-insert settings for the HIGH-VOLUME ingest inserts.
 *
 * The ingest worker writes one small INSERT per batch. At scale that is millions
 * of tiny inserts → a "part explosion" that ClickHouse then has to merge and
 * scan (the #1 ingest bottleneck measured under load). `async_insert` buffers
 * rows SERVER-SIDE and flushes them as fewer, larger parts — which also makes
 * queries FASTER (fewer parts to merge), the only cost being that rows are
 * queryable after the flush (async_insert_busy_timeout_ms, ~1s, tunable) rather
 * than instantly. For replay analytics — where sessions are viewed seconds-to-
 * days later — that delay is invisible.
 *
 * `wait_for_async_insert = 0` (default) returns immediately so the worker isn't
 * blocked on the flush (max throughput); the durable rrweb copy in Mongo is the
 * backstop for the rare crash-before-flush window. Both env-gated:
 *   CLICKHOUSE_ASYNC_INSERT=0 disables it (back to synchronous per-batch inserts).
 *   CLICKHOUSE_ASYNC_INSERT_WAIT=1 waits for the flush (synchronous error ack).
 */
function asyncInsertSettings(): ClickHouseSettings | undefined {
  if ((process.env.CLICKHOUSE_ASYNC_INSERT ?? "1") !== "1") return undefined;
  return {
    async_insert: 1,
    wait_for_async_insert: Number(
      process.env.CLICKHOUSE_ASYNC_INSERT_WAIT ?? 0,
    ) as 0 | 1,
  };
}

/** Direct bulk insert of projection rows — one INSERT, no app-level batching.
 *  Used by the batcher's flush and by the direct path when batching is off. */
async function insertProjectionRowsDirect(
  rows: ProjectionRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const client = getClickHouseClient();
  const settings = asyncInsertSettings();
  await client.insert({
    table: "replay.session_events",
    values: rows,
    format: "JSONEachRow",
    ...(settings ? { clickhouse_settings: settings } : {}),
  });
}

// App-level micro-batcher. `async_insert` batches SERVER-SIDE but the worker
// still pays one HTTP INSERT (parse + async-buffer bookkeeping) PER session
// batch — and that per-request cost is what saturates CH under ingest load
// (measured: the dominant cap on drain throughput). Coalescing many callers
// into one bulk INSERT per short window removes that per-request tax: a few
// large inserts/sec instead of thousands of tiny ones. Lazily built so the
// env knobs are read after dotenv, and so nothing changes for non-ingest
// importers that never insert. CLICKHOUSE_BATCH_INSERT=0 restores the direct
// per-batch path.
let insertBatcher: ClickHouseInsertBatcher<ProjectionRow> | null = null;
function getInsertBatcher(): ClickHouseInsertBatcher<ProjectionRow> | null {
  if ((process.env.CLICKHOUSE_BATCH_INSERT ?? "1") !== "1") return null;
  if (!insertBatcher) {
    insertBatcher = new ClickHouseInsertBatcher<ProjectionRow>(
      (rows) => insertProjectionRowsDirect(rows),
      {
        maxRows: Number(process.env.CLICKHOUSE_BATCH_MAX_ROWS ?? 5000),
        maxWaitMs: Number(process.env.CLICKHOUSE_BATCH_MAX_MS ?? 200),
        // Backpressure ceiling: buffered + in-flight rows. Over this, the
        // batcher sheds (drops) rather than growing the worker heap during a
        // CH stall. ~20 full windows of the default 5000-row batches.
        maxOutstandingRows: Number(
          process.env.CLICKHOUSE_BATCH_MAX_OUTSTANDING ?? 100_000,
        ),
      },
    );
  }
  return insertBatcher;
}

export async function insertProjectionRows(
  rows: ProjectionRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const batcher = getInsertBatcher();
  if (batcher) {
    // Resolves when the flush carrying these rows completes; rejects if that
    // bulk insert fails. Callers keep their existing best-effort try/catch, so
    // CH failures stay non-fatal + backfill-recoverable — same contract as the
    // direct path, just batched.
    await batcher.enqueue(rows);
    return;
  }
  await insertProjectionRowsDirect(rows);
}

/** Flush any buffered projection rows and RESOLVE once they have been written —
 *  call (awaited) on graceful shutdown so the last partial window isn't lost.
 *  No-op (resolved) when batching is disabled or nothing is buffered. */
export function flushProjectionInserts(): Promise<void> {
  return insertBatcher?.flushNow() ?? Promise.resolve();
}

/** One row of the `replay.sessions` analytics table (one per session). */
export interface SessionRow {
  workspace_id: number;
  session_id: number;
  /** Identified EndUser.distinctId; '' = anonymous (excluded from user counts). */
  user_id: string;
  anonymous_id: string;
  /** Session start, epoch ms (same units as session_events.timestamp). */
  datetime: number;
  duration_ms: number;
  platform: string;
  os: string;
  os_version: string;
  device: string;
  device_model: string;
  browser: string;
  browser_version: string;
  start_path: string;
  country: string;
  state: string;
  city: string;
  plan: string;
  release: string;
  tracker_version: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  pages_count: number;
  errors_count: number;
  rage_count: number;
  dead_count: number;
  start_url: string;
  referrer: string;
  /** EndUser.firstSeenAt epoch ms (0 = anonymous/unknown). Compared to the
   *  funnel window for new-vs-returning filtering. */
  first_seen_at: number;
  /** Identify() traits (EndUser.customProps), stringified, for attribute filters. */
  attrs: Record<string, string>;
  /** ReplacingMergeTree version — latest write wins (use the write time in ms). */
  _version: number;
}

/**
 * Bulk upsert session rows into `replay.sessions` (ReplacingMergeTree — a
 * re-insert for the same (workspace_id, session_id) collapses to the highest
 * `_version`). Called at finalize + by the backfill. Batched, never per-row.
 */
export async function insertSessionRows(rows: SessionRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const client = getClickHouseClient();
  await client.insert({
    table: "replay.sessions",
    values: rows,
    format: "JSONEachRow",
  });
}

/** One row of `replay.session_cards` — the compact per-session AI card. */
export interface SessionCardRow {
  workspace_id: number;
  session_id: number;
  /** Session.publicId — how the AI cites / opens the recording. */
  session_public_id: string;
  user_id: string;
  anonymous_id: string;
  /** Session start, epoch ms. */
  datetime: number;
  duration_ms: number;
  platform: string;
  release: string;
  device: string;
  os: string;
  browser: string;
  country: string;
  /** converted | abandoned | crashed | errored | normal. */
  outcome: string;
  /** Compact screen/URL path, e.g. "/home → /cart → /checkout". */
  journey: string;
  /** Signal types present on the session (crash_detected, slow_api, …). */
  signals: string[];
  /** Fingerprints of the errors/crashes on this session — link to Issues. */
  issue_fingerprints: string[];
  pages_count: number;
  error_count: number;
  crash_count: number;
  rage_count: number;
  dead_count: number;
  network_fail_count: number;
  slow_api_count: number;
  session_score: number;
  /** Deterministic one-line summary (no LLM). */
  summary: string;
  /** ReplacingMergeTree version — latest write wins (write time in ms). */
  _version: number;
}

/**
 * Bulk upsert session cards into `replay.session_cards` (ReplacingMergeTree —
 * a re-insert for the same (workspace_id, session_id) collapses to the highest
 * `_version`). Called by the session processor at finalize/backfill. Batched,
 * never per-row.
 */
export async function insertSessionCards(
  rows: SessionCardRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const client = getClickHouseClient();
  await client.insert({
    table: "replay.session_cards",
    values: rows,
    format: "JSONEachRow",
  });
}

export interface SessionCardQuery {
  workspaceId: number;
  /** Point lookup — a specific set of sessions (the AI citing recordings). */
  sessionIds?: number[];
  /** Filter to an outcome (converted | abandoned | crashed | errored | normal). */
  outcome?: string;
  /** Only a specific user's cards. */
  userId?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

/**
 * Read session cards for the AI / dashboard. `workspace_id` leads the
 * ReplacingMergeTree ORDER BY key, so every query is a tenant-bounded range
 * read — never a cross-workspace scan. FINAL dedups re-processed sessions; the
 * `limit` is hard-capped so a single call can't pull an unbounded set.
 */
export async function sessionCards(
  q: SessionCardQuery,
): Promise<SessionCardRow[]> {
  const client = getClickHouseClient();
  const conds = ["workspace_id = {ws:UInt32}"];
  const params: Record<string, unknown> = { ws: q.workspaceId };
  if (q.sessionIds && q.sessionIds.length > 0) {
    conds.push("session_id IN {ids:Array(UInt32)}");
    params.ids = q.sessionIds;
  }
  if (q.outcome) {
    conds.push("outcome = {outcome:String}");
    params.outcome = q.outcome;
  }
  if (q.userId) {
    conds.push("user_id = {uid:String}");
    params.uid = q.userId;
  }
  if (q.sinceMs) {
    conds.push("datetime >= {since:UInt64}");
    params.since = q.sinceMs;
  }
  if (q.untilMs) {
    conds.push("datetime < {until:UInt64}");
    params.until = q.untilMs;
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const result = await client.query({
    query: `SELECT * FROM replay.session_cards FINAL
            WHERE ${conds.join(" AND ")}
            ORDER BY datetime DESC
            LIMIT ${limit}`,
    format: "JSONEachRow",
    query_params: params,
  });
  return (await result.json()) as SessionCardRow[];
}

export async function listLogs(
  filter: ListLogsFilter = {},
): Promise<ProjectionRow[]> {
  const client = getClickHouseClient();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.sessionId !== undefined) {
    conditions.push("session_id = {sessionId:UInt32}");
    params.sessionId = filter.sessionId;
  }
  if (filter.sessionPublicId) {
    conditions.push("session_public_id = {sessionPublicId:String}");
    params.sessionPublicId = filter.sessionPublicId;
  }
  if (filter.workspaceId !== undefined) {
    conditions.push("workspace_id = {workspaceId:UInt32}");
    params.workspaceId = filter.workspaceId;
  }
  if (filter.kind) {
    conditions.push("kind = {kind:String}");
    params.kind = filter.kind;
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit ?? 1000, 5000);

  const result = await client.query({
    query: `SELECT * FROM replay.session_events ${where} ORDER BY timestamp ASC LIMIT ${limit}`,
    format: "JSONEachRow",
    query_params: params,
  });
  return (await result.json()) as ProjectionRow[];
}

export async function countByKind(
  sessionId: number,
): Promise<Record<ProjectionKind, number>> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `SELECT kind, count() AS c FROM replay.session_events WHERE session_id = {sessionId:UInt32} GROUP BY kind`,
    format: "JSONEachRow",
    query_params: { sessionId },
  });
  const rows = (await result.json()) as Array<{
    kind: ProjectionKind;
    c: string;
  }>;
  const counts: Record<ProjectionKind, number> = {
    console: 0,
    network: 0,
    error: 0,
    tap: 0,
    custom: 0,
    screen: 0,
    perf: 0,
  };
  for (const row of rows) {
    counts[row.kind] = Number(row.c);
  }
  return counts;
}

/** One funnel step expressed for ClickHouse matching. */
export interface FunnelStepCond {
  kind: string; // page | click | screen | tap | event
  matchType: string; // equals | contains | startsWith | regex
  value: string;
}

export interface FunnelStagesResult {
  /** Counted units in the window (sessions, or distinct users when metric=user). */
  totalSessions: number;
  /** Units reaching each stage k (1..N), in order. */
  stages: number[];
  /** Up to 200 example session ids per stage. Session metric: session_ids that
   *  reached the stage. User metric: session_ids of the users who reached it. Powers
   *  the funnel-step "View sessions" drill-down. */
  exampleIds: number[][];
  entered: number;
  dropped: number;
  /** Per-issue contingency among entered units: [withIssue, withIssue&dropped].
   *  `any` = the union (any issue), for total-drop-due-to-issues. */
  issues: Record<"error" | "crash" | "rage" | "dead" | "any", [number, number]>;
  /** Time-between-consecutive-steps (ms) for units whose ordered chain reached
   *  the later step. Length N-1 (empty when <2 steps). `n` is the sample size;
   *  avg/p50/p95 are null when n=0 so the UI shows "—", not a fabricated 0.
   *  Approximate: first-hit timestamps gated on the ordered chain (flevel) + a
   *  non-negative delta — derived in the SAME grouped pass, no extra query. */
  transitions: Array<{
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    n: number;
  }>;
  /** Entry→last-step time (ms) for converters — same shape as one transition. */
  convertTime: {
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    n: number;
  };
}

/** CH column a step kind matches against. */
function funnelColumn(kind: string): string {
  if (kind === "tap" || kind === "click") return "ui_value";
  if (kind === "event") return "message";
  return "route"; // page | screen | default
}

/**
 * Build the per-step `windowFunnel` conditions, registering each step value as
 * a bound query param (`p0`, `p1`, …) on `params`. Shared by funnelStages +
 * funnelTimeline so both match steps identically.
 */
function buildFunnelConds(
  steps: FunnelStepCond[],
  params: Record<string, unknown>,
  prefix = "",
): string[] {
  return steps.map((s, i) => {
    const col = `${prefix}${funnelColumn(s.kind)}`;
    const p = `p${i}`;
    params[p] = s.value;
    let match: string;
    switch (s.matchType) {
      case "equals":
        match = `${col} = {${p}:String}`;
        break;
      case "startsWith":
        match = `startsWith(${col}, {${p}:String})`;
        break;
      case "regex":
        match = `match(${col}, {${p}:String})`;
        break;
      default: // contains
        match = `position(${col}, {${p}:String}) > 0`;
    }
    // A custom-event step must match ONLY real tracked events
    // (kind='custom' + level='track'). Without this it also matches screen /
    // console rows that share the same `message` text, AND it disagrees with the
    // event-name picker (suggestFunnelStepValues / topTrackEvents, both of which
    // constrain identically). Every caller aliases the events table `e.`.
    if (s.kind === "event") {
      return `(${prefix}kind = 'custom' AND ${prefix}level = 'track' AND ${match})`;
    }
    return match;
  });
}

/** Supported filter operators (mirrors the reference's operator set). */
export type SegmentOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isAny"
  | "isUndefined";

/** One funnel filter condition against a `replay.sessions` column. */
export interface SegmentCond {
  /** Whitelisted sessions column (e.g. "country", "duration_ms"). Ignored when
   *  `mapKey` is set (then the column is the `attrs` Map). */
  column?: string;
  /** Identify()-trait key — matched against `s.attrs[mapKey]` (text). */
  mapKey?: string;
  op: SegmentOp;
  /** One value for most ops; multiple → IN / OR (the reference's multi-value). */
  values: string[];
}

/**
 * A funnel segment over `replay.sessions` (alias `s`) — pure ClickHouse via the
 * sessions JOIN, no Postgres. `conditions` are the user-driven filters (each
 * with an operator); `platformIn` + `firstSeen*` are system-derived (mobile
 * restriction, new-vs-returning) and carry no operator.
 */
export interface FunnelSegment {
  conditions?: SegmentCond[];
  /** `s.platform IN (...)` — explicit platform filter + the mobile-funnel
   *  native restriction (['ios','android']). */
  platformIn?: string[];
  /** New-vs-returning: first_seen_at vs the funnel-window start (ms); both
   *  require an identified user (first_seen_at > 0). */
  firstSeenGteMs?: number;
  firstSeenLtMs?: number;
}

/** Text columns a condition may target; everything else is numeric/unknown. */
const SEGMENT_TEXT_COLS = new Set([
  "country",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device",
  "state",
  "city",
  "plan",
  "user_id",
  "anonymous_id",
  "release",
  "start_url",
  "start_path",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "platform",
]);
const SEGMENT_NUM_COLS = new Set([
  "duration_ms",
  "pages_count",
  "errors_count",
  "rage_count",
  "dead_count",
]);

/**
 * Compile ONE condition to a `s.*` SQL predicate, binding every value as a param
 * (`seg0`, `seg1`, … via `bind`) — nothing is string-interpolated. Column names
 * are whitelisted (unknown → skipped). Operator SQL mirrors the reference:
 * `is/isNot` exact (= / IN), `contains/startsWith/endsWith` case-insensitive
 * ILIKE, `regex` → match(), numeric comparators, isAny/isUndefined on emptiness.
 */
function segmentCondSql(
  c: SegmentCond,
  bind: (v: unknown) => string,
): string | null {
  let colExpr: string;
  let isNumeric = false;
  if (c.mapKey) {
    colExpr = `s.attrs[{${bind(c.mapKey)}:String}]`;
  } else if (c.column && SEGMENT_TEXT_COLS.has(c.column)) {
    colExpr = `s.${c.column}`;
  } else if (c.column && SEGMENT_NUM_COLS.has(c.column)) {
    colExpr = `s.${c.column}`;
    isNumeric = true;
  } else {
    return null; // unknown column — never interpolate it
  }

  if (c.op === "isAny") return `${colExpr} != ''`;
  if (c.op === "isUndefined") return `${colExpr} = ''`;

  const vals = (c.values ?? []).filter((v) => v != null && v !== "");
  if (vals.length === 0) return null;

  if (isNumeric) {
    const numOps: Partial<Record<SegmentOp, string>> = {
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      isNot: "!=",
      is: "=",
    };
    const sqlOp = numOps[c.op] ?? ">=";
    return `${colExpr} ${sqlOp} {${bind(Number(vals[0]))}:Float64}`;
  }

  const ilike = (pat: (v: string) => string) =>
    "(" +
    vals.map((v) => `${colExpr} ILIKE {${bind(pat(v))}:String}`).join(" OR ") +
    ")";
  // Case-INSENSITIVE exact match for is/isNot: the dashboard and the ingest
  // path don't always agree on casing ("iOS" vs "ios", "Mobile" vs "mobile"),
  // and case-sensitive `=` silently matched nothing. lowerUTF8 both sides rather
  // than ILIKE so values containing `_`/`%` (e.g. "Google sdk_gphone64_arm64")
  // aren't treated as wildcards.
  const lc = (v: unknown) => String(v).toLowerCase();
  switch (c.op) {
    case "isNot":
      return vals.length === 1
        ? `lowerUTF8(${colExpr}) != {${bind(lc(vals[0]))}:String}`
        : `lowerUTF8(${colExpr}) NOT IN {${bind(vals.map(lc))}:Array(String)}`;
    case "contains":
      return ilike((v) => `%${v}%`);
    case "notContains":
      return `NOT ${ilike((v) => `%${v}%`)}`;
    case "startsWith":
      return ilike((v) => `${v}%`);
    case "endsWith":
      return ilike((v) => `%${v}`);
    case "regex":
      return `match(${colExpr}, {${bind(vals[0])}:String})`;
    case "is":
    default:
      return vals.length === 1
        ? `lowerUTF8(${colExpr}) = {${bind(lc(vals[0]))}:String}`
        : `lowerUTF8(${colExpr}) IN {${bind(vals.map(lc))}:Array(String)}`;
  }
}

/**
 * Build the `s.*` WHERE predicates for a segment (bound params only). Returns []
 * when empty so callers can decide whether the sessions JOIN is needed.
 */
function buildSegmentConds(
  seg: FunnelSegment,
  params: Record<string, unknown>,
): string[] {
  const conds: string[] = [];
  let i = 0;
  const bind = (v: unknown): string => {
    const k = `seg${i++}`;
    params[k] = v;
    return k;
  };
  if (seg.platformIn && seg.platformIn.length > 0) {
    conds.push(
      `s.platform IN {${bind(seg.platformIn.map((x) => x.toLowerCase()))}:Array(String)}`,
    );
  }
  if (seg.firstSeenGteMs != null) {
    conds.push(
      `s.first_seen_at > 0 AND s.first_seen_at >= {${bind(Math.floor(seg.firstSeenGteMs))}:UInt64}`,
    );
  }
  if (seg.firstSeenLtMs != null) {
    conds.push(
      `s.first_seen_at > 0 AND s.first_seen_at < {${bind(Math.floor(seg.firstSeenLtMs))}:UInt64}`,
    );
  }
  for (const c of seg.conditions ?? []) {
    const sql = segmentCondSql(c, bind);
    if (sql) conds.push(sql);
  }
  return conds;
}

/**
 * Funnel stage counts via ClickHouse `windowFunnel` — the set-based, scales-to-
 * millions approach the reference uses (ordered sequence match in CH), replacing
 * the old in-Node walk over a capped 50k-session fetch. One grouped pass:
 *   inner — per unit (session, or user when metric=user), the max ordered stage
 *           reached (windowFunnel) + the CH-resident issue flags;
 *   outer — SUM per stage, example ids, and the entered/dropped×issue
 *           contingency for the significance (issues-affecting-conversion) pass.
 * `metric=user` INNER JOINs `replay.sessions` and groups by `user_id`, excluding
 * anonymous units (empty user_id) exactly like the reference — so a "user"
 * converts if their pooled, time-ordered events match the step sequence.
 * A `segment` (any denormalised attribute) also INNER JOINs `replay.sessions`,
 * time-bounded to the funnel window — so a filtered funnel stays pure ClickHouse.
 */
export async function funnelStages(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  metric?: "session" | "user";
  segment?: FunnelSegment;
}): Promise<FunnelStagesResult> {
  const n = opts.steps.length;
  const isUser = opts.metric === "user";
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
  };
  // Per-step condition over the right column + matchType, each value a param.
  // Events are always aliased `e` so the optional sessions JOIN is unambiguous.
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    where += ` AND e.timestamp < {untilMs:UInt64}`;
  }

  // The grouping unit: one session, or one identified user (anon excluded).
  // A user metric OR a segment filter needs the per-session sessions JOIN.
  const unit = isUser ? "s.user_id" : "e.session_id";
  let from = `replay.session_events AS e`;
  if (isUser || segConds.length > 0) {
    from += ` INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
    if (isUser) where += ` AND s.user_id != ''`;
    if (segConds.length > 0) where += ` AND ${segConds.join(" AND ")}`;
  }

  const stageCols = opts.steps
    .map((_, i) => `countIf(flevel >= ${i + 1}) AS s${i + 1}`)
    .join(", ");
  // Drill-down example ids per stage. Session metric: the session_ids that
  // reached the stage. User metric: the SESSION ids belonging to the users who
  // reached it — flattened from each qualifying user's per-user session array
  // (`sess`, added to the inner SELECT below) — so "view recordings" in user
  // mode opens the recordings of those users, not the whole workspace. Was
  // hard-coded to [] for the user metric, which left that drill-down unscoped.
  const idCols = opts.steps
    .map((_, i) =>
      isUser
        ? `arraySlice(arrayFlatten(groupArrayIf(sess, flevel >= ${i + 1})), 1, 200) AS ids${i + 1}`
        : `arraySlice(groupArrayIf(unit, flevel >= ${i + 1}), 1, 200) AS ids${i + 1}`,
    )
    .join(", ");
  const issueCols = (["err", "crash", "rage", "dead", "any"] as const)
    .map(
      (k) =>
        `countIf(flevel >= 1 AND has_${k}) AS ${k}_t, countIf(flevel >= 1 AND flevel < ${n} AND has_${k}) AS ${k}_d`,
    )
    .join(", ");

  // Time-between-steps (approximate, SAME grouped pass — no extra scan/query).
  // Inner: per-step first-hit timestamp via minIf. Outer: per consecutive pair,
  // avg/p50/p95 of the delta over units whose ORDERED chain reached the later
  // step (flevel) with a non-negative delta; plus overall entry→last for
  // converters. Aggregates are wrapped in `if(count>0, …, default)` so an empty
  // sample yields 0/[0,0] (not NaN, which would break JSON parsing). TDigest is
  // bounded-memory + deterministic (unlike reservoir `quantile`).
  const includeTimes = n >= 2;
  const timeCols = includeTimes
    ? opts.steps
        .map((_, i) => `minIf(e.timestamp, ${conds[i]}) AS t${i}`)
        .join(", ")
    : "";
  const timeTriplet = (alias: string, gate: string, d: string) =>
    `if(countIf(${gate}) > 0, avgIf(${d}, ${gate}), 0.) AS ${alias}_avg, ` +
    `if(countIf(${gate}) > 0, quantilesTDigestIf(0.5, 0.95)(${d}, ${gate}), [0., 0.]) AS ${alias}_q, ` +
    `countIf(${gate}) AS ${alias}_n`;
  const timeAggCols = includeTimes
    ? opts.steps
        .slice(1)
        .map((_, k) => {
          const d = `toInt64(t${k + 1}) - toInt64(t${k})`;
          // Bound the delta to the funnel window. minIf is a first-hit-anywhere
          // approximation, so an early step that RECURS (page reload, a broad
          // 'contains' match, or user-metric pooling across a user's sessions
          // over days) can make the global-first-hit span far exceed the window
          // windowFunnel actually matched the chain within — which would report a
          // time-to-reach larger than the window itself. Excluding spans that
          // don't fit windowMs keeps every reported time ≤ the window; the sample
          // `n` then reflects the honest sub-set (and shows "—" when it empties).
          return timeTriplet(
            `d${k}`,
            `flevel >= ${k + 2} AND ${d} >= 0 AND ${d} <= ${windowMs}`,
            d,
          );
        })
        .concat([
          (() => {
            const d = `toInt64(t${n - 1}) - toInt64(t0)`;
            return timeTriplet(
              "conv",
              `flevel >= ${n} AND ${d} >= 0 AND ${d} <= ${windowMs}`,
              d,
            );
          })(),
        ])
        .join(", ")
    : "";

  const sql = `
    SELECT count() AS total,
           countIf(flevel >= 1) AS entered,
           countIf(flevel >= 1 AND flevel < ${n}) AS dropped,
           ${stageCols}, ${idCols}, ${issueCols}${includeTimes ? `, ${timeAggCols}` : ""}
    FROM (
      SELECT ${unit} AS unit,
             ${isUser ? "groupUniqArray(e.session_id) AS sess," : ""}
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel,${includeTimes ? `\n             ${timeCols},` : ""}
             max(e.kind = 'error' AND e.error NOT IN ('crash', 'signal', 'uncaught', 'promise')) AS has_err,
             max(e.kind = 'error' AND e.error IN ('crash', 'signal', 'uncaught', 'promise')) AS has_crash,
             max(e.level = 'rage') AS has_rage,
             max(e.level = 'dead_click') AS has_dead,
             max(e.kind = 'error' OR e.level IN ('rage', 'dead_click')) AS has_any
      FROM ${from}
      WHERE ${where}
      GROUP BY unit
    )`;

  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const [row] = (await res.json()) as Array<Record<string, unknown>>;
  const num = (k: string) => Number(row?.[k] ?? 0);
  const arr = (k: string) => ((row?.[k] as unknown[]) ?? []).map(Number);
  // avg/p50/p95 are null when the sample is empty so the UI renders "—" rather
  // than a fabricated 0. `n` is the number of units the delta was measured over.
  const transitions = includeTimes
    ? opts.steps.slice(1).map((_, k) => {
        const sample = num(`d${k}_n`);
        const [p50, p95] = arr(`d${k}_q`);
        return {
          avgMs: sample ? Math.round(num(`d${k}_avg`)) : null,
          p50Ms: sample ? Math.round(p50) : null,
          p95Ms: sample ? Math.round(p95) : null,
          n: sample,
        };
      })
    : [];
  const convSample = includeTimes ? num("conv_n") : 0;
  const [convP50, convP95] = includeTimes ? arr("conv_q") : [0, 0];
  const convertTime = {
    avgMs: convSample ? Math.round(num("conv_avg")) : null,
    p50Ms: convSample ? Math.round(convP50) : null,
    p95Ms: convSample ? Math.round(convP95) : null,
    n: convSample,
  };
  return {
    totalSessions: num("total"),
    entered: num("entered"),
    dropped: num("dropped"),
    stages: opts.steps.map((_, i) => num(`s${i + 1}`)),
    exampleIds: opts.steps.map((_, i) => arr(`ids${i + 1}`)),
    transitions,
    convertTime,
    issues: {
      error: [num("err_t"), num("err_d")],
      crash: [num("crash_t"), num("crash_d")],
      rage: [num("rage_t"), num("rage_d")],
      dead: [num("dead_t"), num("dead_d")],
      any: [num("any_t"), num("any_d")],
    },
  };
}

/** One day-bucket of funnel conversion. `day` is a day-floored epoch (ms). */
export interface FunnelTimelinePoint {
  day: number;
  total: number;
  converted: number;
}

/**
 * The reached-session ids for ONE funnel step, keyset-paginated. Powers the
 * Recordings "view sessions" drill-down: the SAME windowFunnel pass as
 * funnelStages, but returns the session_ids that reached `stepIndex` (0-based)
 * rather than counts — ordered session_id DESC (newest first, matching the
 * recordings list) and paged by `beforeId`, so the list scrolls past the
 * per-page cap without ever materialising the whole reached set. Session metric
 * only (the drill-down opens a session list). One CH query per page; bounded by
 * the window + LIMIT, never the workspace.
 */
export async function funnelStepSessionIds(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  stepIndex: number; // 0-based
  limit: number;
  beforeId?: number; // keyset cursor: session_id < beforeId
  segment?: FunnelSegment;
}): Promise<number[]> {
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    lvl: opts.stepIndex + 1,
    lim: Math.max(1, Math.floor(opts.limit)),
  };
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    where += ` AND e.timestamp < {untilMs:UInt64}`;
  }
  let from = `replay.session_events AS e`;
  if (segConds.length > 0) {
    from += ` INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
    where += ` AND ${segConds.join(" AND ")}`;
  }
  let outer = `flevel >= {lvl:UInt32}`;
  if (opts.beforeId && Number.isFinite(opts.beforeId)) {
    params.beforeId = Math.floor(opts.beforeId);
    outer += ` AND session_id < {beforeId:UInt32}`;
  }
  const query = `
    SELECT session_id FROM (
      SELECT e.session_id AS session_id,
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel
      FROM ${from}
      WHERE ${where}
      GROUP BY session_id
    )
    WHERE ${outer}
    ORDER BY session_id DESC
    LIMIT {lim:UInt32}`;
  const result = await client.query({
    query,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await result.json()) as { session_id: number }[];
  return rows.map((r) => Number(r.session_id));
}

/**
 * The DISTINCT identified users who DROPPED OUT of a funnel at a given step —
 * reached step k-1 but NOT step k (windowFunnel level == k, 0-based, k>=1).
 * Powers "create a cohort from drop-off". SAME windowFunnel pass as funnelStages
 * but grouped by user (metric:user — anonymous excluded, since they can't be
 * cohort members) and keyset-paginated by user_id so the full dropper set drains
 * without ever materialising it. Returns EndUser distinctIds (CH `user_id`); the
 * caller maps them to EndUser ids. One CH query per page; bounded by the window +
 * LIMIT, never the workspace.
 */
export async function funnelStepDropoffUserIds(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  dropAtStep: number; // 0-based; users with windowFunnel level == dropAtStep
  limit: number;
  afterId?: string; // keyset cursor: user_id > afterId (ascending)
  segment?: FunnelSegment;
}): Promise<string[]> {
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    // Dropped at step k = reached exactly k steps (flevel == k). Floor at 1: a
    // drop-off is always a transition out of step k-1 into k (k>=1).
    lvl: Math.max(1, Math.floor(opts.dropAtStep)),
    lim: Math.max(1, Math.floor(opts.limit)),
  };
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    where += ` AND e.timestamp < {untilMs:UInt64}`;
  }
  // User metric needs the per-session sessions JOIN for user_id; anonymous
  // (user_id = '') can't be a cohort member so they're excluded.
  const from = `replay.session_events AS e INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
  where += ` AND s.user_id != ''`;
  if (segConds.length > 0) where += ` AND ${segConds.join(" AND ")}`;
  let outer = `flevel = {lvl:UInt32}`;
  if (opts.afterId) {
    params.afterId = opts.afterId;
    outer += ` AND user_id > {afterId:String}`;
  }
  const query = `
    SELECT user_id FROM (
      SELECT s.user_id AS user_id,
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel
      FROM ${from}
      WHERE ${where}
      GROUP BY user_id
    )
    WHERE ${outer}
    ORDER BY user_id ASC
    LIMIT {lim:UInt32}`;
  const result = await client.query({
    query,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await result.json()) as { user_id: string }[];
  return rows.map((r) => String(r.user_id));
}

/**
 * Count of DISTINCT identified users who dropped out at a step — the cheap
 * preview for the "create cohort from drop-off" modal (one aggregate, no id
 * materialisation). Same window/segment/flevel==k semantics as
 * funnelStepDropoffUserIds.
 */
export async function funnelStepDropoffUserCount(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  dropAtStep: number;
  segment?: FunnelSegment;
}): Promise<number> {
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    lvl: Math.max(1, Math.floor(opts.dropAtStep)),
  };
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    where += ` AND e.timestamp < {untilMs:UInt64}`;
  }
  const from = `replay.session_events AS e INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
  where += ` AND s.user_id != ''`;
  if (segConds.length > 0) where += ` AND ${segConds.join(" AND ")}`;
  const query = `
    SELECT countIf(flevel = {lvl:UInt32}) AS c FROM (
      SELECT s.user_id AS user_id,
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel
      FROM ${from}
      WHERE ${where}
      GROUP BY user_id
    )`;
  const result = await client.query({
    query,
    format: "JSONEachRow",
    query_params: params,
  });
  const [row] = (await result.json()) as Array<{ c: string }>;
  return Number(row?.c ?? 0);
}

/**
 * Daily funnel conversion in ONE ClickHouse pass (replacing the per-day in-Node
 * walk). The inner query buckets each session by the day of its first event and
 * computes its `windowFunnel` level; the outer groups by day to count total
 * sessions vs. those reaching the last stage. Scales to millions — no per-day
 * round-trips, no in-memory session list. A `segment` INNER JOINs `replay.sessions`.
 */
export async function funnelTimeline(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs: number;
  segment?: FunnelSegment;
  metric?: "session" | "user";
}): Promise<FunnelTimelinePoint[]> {
  const n = opts.steps.length;
  const isUser = opts.metric === "user";
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
  };
  // Events aliased `e` so the optional segment JOIN is unambiguous.
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  // The grouping unit: one session, or one identified user (anon excluded) —
  // same rule funnelStages uses, so the timeline agrees with the steps totals.
  // Each unit is bucketed by the day of its FIRST event in the window.
  const unit = isUser ? "s.user_id" : "e.session_id";
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64} AND e.timestamp < {untilMs:UInt64}`;
  let from = `replay.session_events AS e`;
  if (isUser || segConds.length > 0) {
    from += ` INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
    if (isUser) where += ` AND s.user_id != ''`;
    if (segConds.length > 0) where += ` AND ${segConds.join(" AND ")}`;
  }
  const sql = `
    SELECT day, count() AS total, countIf(flevel >= ${n}) AS converted
    FROM (
      SELECT ${unit} AS unit,
             intDiv(min(e.timestamp), 86400000) * 86400000 AS day,
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel
      FROM ${from}
      WHERE ${where}
      GROUP BY unit
    )
    GROUP BY day
    ORDER BY day ASC`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    day: Number(r.day),
    total: Number(r.total),
    converted: Number(r.converted),
  }));
}

/** One breakdown bucket of a funnel (e.g. one release). */
export interface FunnelBreakdownBucket {
  value: string;
  total: number;
  entered: number;
  converted: number;
  /** Sessions reaching each stage k (1..N), in order. */
  stages: number[];
}

/**
 * Dimensions denormalized onto `session_events` — broken down with NO join (one
 * pure pass). Whitelisted: the value is interpolated into the query, so it must
 * never come from user input. `release` answers "did this release change
 * conversion?".
 */
export const FUNNEL_BREAKDOWN_COLUMNS: Record<string, string> = {
  release: "release",
};

/**
 * Dimensions that live on the per-session `replay.sessions` table — broken down
 * by INNER JOINing it (the reference's breakdown by user/session property).
 * Whitelisted column names (never user input). `userId` maps to the identified
 * `user_id`; the rest are EndUser / Session attributes.
 */
export const FUNNEL_BREAKDOWN_SESSION_COLUMNS: Record<string, string> = {
  country: "country",
  browser: "browser",
  browserVersion: "browser_version",
  os: "os",
  osVersion: "os_version",
  device: "device",
  plan: "plan",
  platform: "platform",
  state: "state",
  city: "city",
  urlPath: "start_path",
  userId: "user_id",
  anonymousId: "anonymous_id",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  // Traffic source. `referrer` is the raw column; referrerDomain + channel are
  // computed columns the sessions subquery adds (see funnelBreakdown) — the
  // same referring-host and channel-classification the analytics breakdown uses.
  referrer: "referrer",
  referrerDomain: "ref_domain",
  channel: "channel",
};

/**
 * Autocomplete for a filter value: the distinct values of a session attribute
 * seen in this workspace, matching `q` (case-insensitive substring), ranked by
 * how many sessions have them (most common first) — the reference's frequency-
 * ranked autocomplete, but read live off `replay.sessions` (one row/session, so
 * a workspace-scoped GROUP BY is cheap; no separate autocomplete table needed).
 * `column` is whitelisted to a text session column — never interpolated raw.
 */
export async function suggestSessionValues(opts: {
  workspaceId: number;
  column: string;
  q?: string;
  limit?: number;
}): Promise<Array<{ value: string; count: number }>> {
  if (!SEGMENT_TEXT_COLS.has(opts.column)) return []; // safety: whitelisted only
  const client = getClickHouseClient();
  // Bound to the last 30 days so the daily-partitioned table prunes to recent
  // partitions (the reference caps its autocomplete at ~1 month too).
  const sinceMs = Math.floor(Date.now() - 30 * 86_400_000);
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs,
    limit: Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10))),
  };
  let where = `workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND ${opts.column} != ''`;
  if (opts.q) {
    params.q = `%${opts.q}%`;
    where += ` AND ${opts.column} ILIKE {q:String}`;
  }
  // No FINAL: `uniqExact(session_id)` counts DISTINCT sessions, so a not-yet-
  // merged ReplacingMergeTree duplicate (same session_id) is counted once —
  // accurate frequency ranking without paying for merge-on-read. One
  // partition-pruned, workspace-indexed, single-column columnar scan → scales.
  const sql = `
    SELECT ${opts.column} AS value, uniqExact(session_id) AS c
    FROM replay.sessions
    WHERE ${where}
    GROUP BY value
    ORDER BY c DESC, value ASC
    LIMIT {limit:UInt32}`;
  const res = await client.query({ query: sql, format: "JSONEachRow", query_params: params });
  const rows = (await res.json()) as Array<{ value: string; c: string }>;
  return rows.map((r) => ({ value: r.value, count: Number(r.c) }));
}

/**
 * The session dimensions the Recordings search autocompletes, mapped to their
 * `replay.sessions` column. A FIXED Map — never a plain object — because the
 * caller passes the key: a `Record` lookup would answer `"constructor"` with a
 * truthy inherited value and interpolate it straight into the SQL below.
 */
const SUGGEST_DIMENSION_COLS = new Map<string, string>([
  ["page", "start_path"],
  ["browser", "browser"],
  ["os", "os"],
  ["device", "device"],
  ["deviceModel", "device_model"],
  ["country", "country"],
  ["city", "city"],
  ["release", "release"],
  ["plan", "plan"],
  ["platform", "platform"],
]);

/** Every dimension `suggestSessionDimensions` can answer. */
export const SUGGEST_DIMENSIONS: string[] = [...SUGGEST_DIMENSION_COLS.keys()];

/**
 * Hard ceiling on `LIMIT n BY type` — a GUARD, not a default. Callers still pass
 * the size they actually want (the dropdown asks for 6); this only bounds what a
 * caller can ask for, so the statement can never return an unbounded group.
 *
 * 500 rather than the dropdown's own handful because the FACETS caller needs the
 * COMPLETE value set for a bounded dimension, not its head: those values are
 * filtered client-side, so a truncated list is not "fewer suggestions", it is a
 * value the user can no longer filter by at all. The real ceilings sit far below
 * this — country is bounded by the ISO set (~250), browser/device by the
 * canonical vocabulary in common/device-facts (a handful each) — so 500 leaves
 * room to spare while still refusing to stream an unbounded group.
 *
 * Costs nothing to raise: `LIMIT n BY type` is applied AFTER the GROUP BY, so a
 * larger n returns more of an already-computed aggregate — it does not widen the
 * scan.
 */
const SUGGEST_MAX_PER_TYPE = 500;

export interface DimensionSuggestion {
  /** The requested dimension key — "page", "browser", … */
  type: string;
  value: string;
  /** Sessions carrying this value in the window — the frequency ranking. */
  count: number;
}

/**
 * Frequency-ranked autocomplete for MANY session dimensions in ONE round-trip.
 *
 * `suggestSessionValues` (above) answers a single column and is what the funnel
 * picker needs — one field at a time. The Recordings search needs eight groups
 * repopulated on every keystroke, so calling it per column would fire eight
 * queries per typed character. This unpivots the columns into one statement and
 * bounds each group with `LIMIT n BY type`, so the whole dropdown costs a single
 * partition-pruned pass and can never return more than `perType` rows per group.
 *
 * Scales: `replay.sessions` is one row per session, ORDER BY (workspace_id,
 * session_id) — so the primary index pins every UNION branch to this workspace —
 * and PARTITION BY day means the `sinceMs` bound prunes to ~30 partitions. Each
 * branch then reads exactly two columns (session_id + its own), which is what a
 * columnar store is for. `uniqExact(session_id)` counts DISTINCT sessions, so an
 * unmerged ReplacingMergeTree duplicate is still counted once — no FINAL needed.
 */
export async function suggestSessionDimensions(opts: {
  workspaceId: number;
  types: string[];
  q?: string;
  perType?: number;
  sinceDays?: number;
  /** ALL-TIME: skip the recency window entirely. The complete-set facet preload
   *  passes this so its counts match the Recordings list's all-time total
   *  (otherwise the dropdown showed a 30-day count next to an all-time list). It
   *  is still cheap: uniqExact over two columns with NO FINAL, workspace-pinned
   *  by the primary index, and the result is cached per workspace. The typeahead
   *  keeps the default window — there, recent values are what you want. */
  allTime?: boolean;
}): Promise<DimensionSuggestion[]> {
  // Dedupe before mapping: a caller repeating `?groups=page&groups=page…` must
  // not translate into an unbounded pile of UNION branches.
  const types = [...new Set(opts.types)].filter((t) =>
    SUGGEST_DIMENSION_COLS.has(t),
  );
  if (!types.length) return [];
  const client = getClickHouseClient();
  const sinceDays = Math.max(1, Math.min(90, Math.floor(opts.sinceDays ?? 30)));
  const sinceMs = Math.floor(Date.now() - sinceDays * 86_400_000);
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs,
    perType: Math.max(
      1,
      Math.min(SUGGEST_MAX_PER_TYPE, Math.floor(opts.perType ?? 6)),
    ),
  };
  const q = escapeLikePattern((opts.q ?? "").trim());
  if (q) params.q = `%${q}%`;
  // Both `t` and `col` come from SUGGEST_DIMENSION_COLS — a closed, hand-written
  // whitelist — so neither is caller-controlled. `q` is always a bound param.
  const windowClause = opts.allTime
    ? ""
    : "\n        AND datetime >= {sinceMs:UInt64}";
  const branches = types.map((t) => {
    const col = SUGGEST_DIMENSION_COLS.get(t) as string;
    return `SELECT session_id, '${t}' AS type, ${col} AS value
      FROM replay.sessions
      WHERE workspace_id = {ws:UInt32}${windowClause}
        AND ${col} != ''${q ? `\n        AND ${col} ILIKE {q:String}` : ""}`;
  });
  const sql = `
    SELECT type, value, uniqExact(session_id) AS c
    FROM (${branches.join("\n      UNION ALL\n      ")})
    GROUP BY type, value
    ORDER BY type ASC, c DESC, value ASC
    LIMIT {perType:UInt32} BY type`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<{
    type: string;
    value: string;
    c: string;
  }>;
  return rows.map((r) => ({
    type: r.type,
    value: r.value,
    count: Number(r.c),
  }));
}

export type SegmentDimRow = { dim: string; label: string; sessions: number };

/**
 * Session counts grouped by seven acquisition/context dimensions for the
 * Overview's Segments band — platform / browser / country (device context) plus
 * the referring domain and utm source / medium / campaign (traffic sources) —
 * all in ONE pass.
 *
 * Why it lives here: this is a dimension aggregation, and those run on
 * replay.sessions, never as a parallel Postgres GROUP BY. The Postgres version
 * this replaces ran `GROUP BY GROUPING SETS` over "Session" on every 30s
 * dashboard poll, per open tab. Measured on a 500k-session workspace at the 30d
 * default: 181-223ms and ~273MB of shared-buffer traffic per request (34,112
 * heap blocks), because platform/browser/country are not in the
 * (workspaceId, startedAt) index so every row in the window was a heap fetch.
 * That page churn on the OLTP primary — evicting hot Session/EndUser pages —
 * was the real cost, not the latency. The same aggregation here measures
 * 21-33ms with zero impact on the primary, and returns byte-identical numbers
 * (verified against the Postgres query on the 500k set before the switch).
 *
 * Access pattern / why it scales: (workspace_id, datetime) is the table's sort
 * prefix, so the WHERE is a bounded range scan over one tenant's slice rather
 * than a full-table read, and GROUPING SETS folds ALL SEVEN dimensions into a
 * single pass instead of seven separate scans. Cost grows with the WINDOW, not
 * with total retained sessions, and adding the four traffic-source sets is only
 * more aggregate states over the same rows already read — no extra scan. The
 * referring host (referrer / utm_* are String columns, not indexed) is derived
 * once in the inner SELECT so the GROUP BY keys stay plain columns — grouping()
 * needs an exact key match, so a bare `domain(referrer)` in the GROUP BY would
 * not line up with the SELECT expression.
 *
 * Returns the same {dim,label,sessions} row shape the Postgres query did, so
 * the caller's ranking/"Other"-folding logic is unchanged. Empty values are
 * normalised to 'Unknown' here (as Postgres did via COALESCE/NULLIF), which the
 * caller relies on to decide whether a dimension carries any real signal (so a
 * workspace with no utm tagging simply shows no Sources/Media/Campaigns rows).
 */
export async function sessionSegments(opts: {
  workspaceId: number;
  fromMs: number;
  toMs: number;
}): Promise<SegmentDimRow[]> {
  const client = getClickHouseClient();
  // `grouping(col) = 0` means the column IS the current grouping set's key —
  // same convention as Postgres' GROUPING(), verified against the live table
  // before this replaced the Postgres query (each dimension's counts summed to
  // the identical window total, and the per-label breakdown matched exactly).
  const dimExpr = `multiIf(
    grouping(platform) = 0, 'platform',
    grouping(browser) = 0, 'browser',
    grouping(country) = 0, 'country',
    grouping(ref_domain) = 0, 'referrer',
    grouping(utm_source) = 0, 'source',
    grouping(utm_medium) = 0, 'medium',
    'campaign')`;
  const labelExpr = `multiIf(
    grouping(platform) = 0, platform,
    grouping(browser) = 0, browser,
    grouping(country) = 0, country,
    grouping(ref_domain) = 0, ref_domain,
    grouping(utm_source) = 0, utm_source,
    grouping(utm_medium) = 0, utm_medium,
    utm_campaign)`;
  // ref_domain: the clean referring HOST. domain() needs a scheme, so prepend
  // one when the stored referrer is a bare host; cutWWW folds www.x → x so the
  // two don't split into separate rows. lowerUTF8 case-folds the host so
  // 'News.Ycombinator.com' and 'news.ycombinator.com' are ONE row (utm_* stay
  // case-sensitive — they're user-authored tags). Empty referrer → '' → 'Unknown'.
  const refDomainExpr = `lowerUTF8(cutWWW(domain(if(referrer != '' AND position(referrer, '://') = 0, concat('http://', referrer), referrer))))`;
  // Cardinality guard: referrer/utm_campaign are unbounded String columns, so a
  // tenant with referrer spam or per-user campaign tags (utm_campaign=email_<uid>)
  // could otherwise stream millions of distinct labels into Node. `LIMIT n BY dim`
  // (applied AFTER the GROUP BY, same single scan — the sanctioned pattern used by
  // suggestFacetValues) caps EACH dimension to its top-`cap` by session count, so
  // at most 7*cap rows ever reach the app; the caller only shows the top 6 anyway.
  const sql = `
    SELECT
      ${dimExpr} AS dim,
      if(${labelExpr} = '', 'Unknown', ${labelExpr}) AS label,
      count() AS sessions
    FROM (
      SELECT platform, browser, country,
             ${refDomainExpr} AS ref_domain,
             utm_source, utm_medium, utm_campaign
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32}
        AND datetime >= {fromMs:UInt64}
        AND datetime <  {toMs:UInt64}
    )
    GROUP BY GROUPING SETS ((platform), (browser), (country), (ref_domain), (utm_source), (utm_medium), (utm_campaign))
    ORDER BY sessions DESC
    LIMIT {cap:UInt32} BY dim`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: {
      ws: opts.workspaceId,
      fromMs: Math.floor(opts.fromMs),
      toMs: Math.floor(opts.toMs),
      cap: 200,
    },
  });
  const rows = (await res.json()) as Array<{
    dim: string;
    label: string;
    sessions: string;
  }>;
  return rows.map((r) => ({
    dim: r.dim,
    label: r.label,
    sessions: Number(r.sessions),
  }));
}

/**
 * Neutralise LIKE/ILIKE wildcards in user-typed text. Without this a `q` of "%"
 * is not a search for a percent sign — it matches every row in the workspace,
 * which is the one result this endpoint is built to never return. Backslash is
 * the default escape character in both ClickHouse and Postgres LIKE.
 */
export function escapeLikePattern(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Structured, whitelisted filter for querySessions — the agent's session.query. */
export interface SessionQueryFilter {
  platform?: string;
  country?: string;
  os?: string;
  browser?: string;
  release?: string;
  /** start_path / start_url contains. */
  urlContains?: string;
  /** Fired this tracked (custom/track) event. */
  event?: string;
  errored?: boolean;
  frustrated?: boolean;
  sinceDays?: number;
}

export interface QueriedSession {
  session_id: number;
  platform: string;
  country: string;
  os: string;
  browser: string;
  release: string;
  duration_ms: number;
  errors_count: number;
  rage_count: number;
  start_path: string;
  datetime: number;
}

/** Equality-filterable columns — a FIXED whitelist so a filter key can never
 *  inject a column name (values are always bound parameters). */
const SESSION_EQ_COLS: Record<string, string> = {
  platform: "platform",
  country: "country",
  os: "os",
  browser: "browser",
  release: "release",
};

/**
 * Attribute-filtered session search over `replay.sessions` — the engine behind
 * the agent's session.query ("Android users in Nigeria who fired X"). Column
 * names are a fixed whitelist; every value is a bound ClickHouse parameter (no
 * interpolation). `event` filters via a subquery on `session_events`. Returns a
 * bounded, recency-ordered list (FINAL for ReplacingMergeTree correctness on the
 * small page) plus an approximate-safe `uniqExact` total for the "N recordings"
 * badge. Partition/workspace-scoped → scales; the caller hydrates public ids.
 */
export async function querySessions(opts: {
  workspaceId: number;
  filter: SessionQueryFilter;
  limit?: number;
  /** Keyset cursor for "show recordings" pagination — the last page's tail. */
  cursor?: { datetime: number; sessionId: number };
}): Promise<{ sessions: QueriedSession[]; total: number; distinctUsers: number }> {
  const client = getClickHouseClient();
  const f = opts.filter ?? {};
  const params: Record<string, unknown> = { ws: opts.workspaceId };
  const conds: string[] = ["workspace_id = {ws:UInt32}"];
  for (const [key, col] of Object.entries(SESSION_EQ_COLS)) {
    const v = f[key as keyof SessionQueryFilter];
    if (typeof v === "string" && v.trim()) {
      params[key] = v.trim();
      conds.push(`${col} = {${key}:String}`);
    }
  }
  if (typeof f.urlContains === "string" && f.urlContains.trim()) {
    params.url = `%${f.urlContains.trim()}%`;
    conds.push(`(start_path ILIKE {url:String} OR start_url ILIKE {url:String})`);
  }
  if (f.errored) conds.push("errors_count > 0");
  if (f.frustrated) conds.push("rage_count > 0");
  if (Number.isFinite(Number(f.sinceDays)) && Number(f.sinceDays) > 0) {
    params.sinceMs = Math.floor(Date.now() - Number(f.sinceDays) * 86_400_000);
    conds.push("datetime >= {sinceMs:UInt64}");
  }
  if (typeof f.event === "string" && f.event.trim()) {
    params.event = f.event.trim().toLowerCase();
    conds.push(
      `session_id IN (SELECT session_id FROM replay.session_events ` +
        `WHERE workspace_id = {ws:UInt32} AND kind = 'custom' AND level = 'track' ` +
        `AND lower(message) = {event:String})`,
    );
  }
  // Keyset page: everything strictly "after" the last row in (datetime, session_id)
  // descending order — stable pagination without OFFSET. The count ignores it.
  const countWhere = conds.join(" AND ");
  if (
    opts.cursor &&
    Number.isFinite(opts.cursor.datetime) &&
    Number.isFinite(opts.cursor.sessionId)
  ) {
    params.curDt = Math.floor(opts.cursor.datetime);
    params.curSid = Math.floor(opts.cursor.sessionId);
    conds.push(
      `(datetime < {curDt:UInt64} OR (datetime = {curDt:UInt64} AND session_id < {curSid:UInt32}))`,
    );
  }
  const where = conds.join(" AND ");
  params.limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 25)));

  const listSql = `
    SELECT session_id, platform, country, os, browser, release,
           duration_ms, errors_count, rage_count, start_path, datetime
    FROM replay.sessions FINAL
    WHERE ${where}
    ORDER BY datetime DESC, session_id DESC
    LIMIT {limit:UInt32}`;
  // Distinct sessions AND distinct identified users (user_id != '' excludes
  // anonymous units) — so "how many USERS did X" dedupes instead of conflating
  // sessions with users. uniqExact dedupes by id, so FINAL isn't needed here.
  const countSql =
    `SELECT uniqExact(session_id) AS c, uniqExactIf(user_id, user_id != '') AS u ` +
    `FROM replay.sessions WHERE ${countWhere}`;

  const [listRes, countRes] = await Promise.all([
    client.query({ query: listSql, format: "JSONEachRow", query_params: params }),
    client.query({ query: countSql, format: "JSONEachRow", query_params: params }),
  ]);
  const raw = (await listRes.json()) as Array<Record<string, string | number>>;
  const countRows = (await countRes.json()) as Array<{ c: string; u: string }>;
  const sessions: QueriedSession[] = raw.map((s) => ({
    session_id: Number(s.session_id),
    platform: String(s.platform ?? ""),
    country: String(s.country ?? ""),
    os: String(s.os ?? ""),
    browser: String(s.browser ?? ""),
    release: String(s.release ?? ""),
    duration_ms: Number(s.duration_ms ?? 0),
    errors_count: Number(s.errors_count ?? 0),
    rage_count: Number(s.rage_count ?? 0),
    start_path: String(s.start_path ?? ""),
    datetime: Number(s.datetime ?? 0),
  }));
  return {
    sessions,
    total: Number(countRows[0]?.c ?? 0),
    distinctUsers: Number(countRows[0]?.u ?? 0),
  };
}

/**
 * Recordings free-text search → the matching session ids for this workspace.
 *
 * Access pattern: ONE workspace-pinned columnar scan of replay.sessions. The
 * table's ORDER BY (workspace_id, session_id) primary index prunes the read to
 * this tenant; GROUP BY session_id dedupes ReplacingMergeTree parts WITHOUT
 * FINAL (start_url / browser / … are stable per session, so duplicate parts are
 * identical); ORDER BY max(datetime) DESC keeps the NEWEST matches when the LIMIT
 * caps, matching the Recordings list's default startedAt-desc order. Bounded by
 * {limit}; every value is a bound param. This is why the recordings keyword
 * search scales to millions of sessions per workspace WITHOUT a pg_trgm GIN on
 * the hot Postgres Session table: the substring match runs on ClickHouse's
 * columnar store, and the caller drops the returned ids into an indexed
 * `Session.id IN (…)` (Session.id == CH session_id).
 *
 * Matches URL (start_url/start_path/referrer), device tech (browser/os/device/
 * device_model), city, and the identify() user_id. It intentionally does NOT
 * match `country` (stored ISO-2, so a country NAME wouldn't match) or the
 * end-user email/name (no such CH column — the caller keeps that branch on the
 * Postgres EndUser trigram indexes).
 */
export async function searchSessionIds(opts: {
  workspaceId: number;
  term: string;
  limit: number;
}): Promise<number[]> {
  const term = (opts.term ?? "").trim();
  if (!term) return [];
  const client = getClickHouseClient();
  const params = {
    ws: opts.workspaceId,
    q: `%${escapeLikePattern(term)}%`,
    limit: Math.max(1, Math.min(10_000, Math.floor(opts.limit))),
  };
  const sql = `
    SELECT session_id
    FROM replay.sessions
    WHERE workspace_id = {ws:UInt32}
      AND ( start_url    ILIKE {q:String}
         OR start_path   ILIKE {q:String}
         OR referrer     ILIKE {q:String}
         OR browser      ILIKE {q:String}
         OR os           ILIKE {q:String}
         OR device       ILIKE {q:String}
         OR device_model ILIKE {q:String}
         OR city         ILIKE {q:String}
         OR user_id      ILIKE {q:String} )
    GROUP BY session_id
    ORDER BY max(datetime) DESC
    LIMIT {limit:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<{ session_id: string | number }>;
  return rows.map((r) => Number(r.session_id));
}

export interface AdhocFunnelStep {
  event: string;
  sessions: number;
}

/**
 * AD-HOC funnel over an ordered list of tracked event NAMES — no pre-defined
 * funnel required. Answers "where do users drop off between add_to_cart and
 * payment_success?" directly from `session_events`. One ClickHouse pass:
 * `windowFunnel` computes, per session, the deepest ordered prefix of the steps
 * it fired; the outer `countIf(flevel >= k)` gives the sessions that reached each
 * step (monotonically non-increasing = the drop-off). Set-based, partition-
 * pruned by workspace_id + time; scales to millions — never a per-session walk.
 * Capped at 8 steps. The planner gets the event names from events.discover /
 * topTrackEvents, then calls this in the right order.
 */
export async function adhocFunnel(opts: {
  workspaceId: number;
  events: string[];
  sinceDays?: number;
  /** Per-session completion window (ms). Default 24h — generous for a session. */
  windowMs?: number;
}): Promise<{
  steps: AdhocFunnelStep[];
  enteredSessions: number;
  sinceDays: number;
}> {
  // Preserve the caller's event names for the returned steps (they feed the
  // narrator and the "create this funnel" prefill), but match case-INSENSITIVELY
  // against the stored `message` — mirroring querySessions' `lower(message) = …`.
  // Without this, a workspace that tracks camelCase/PascalCase events
  // (e.g. `AddToCart`) never matches and the funnel reports 100% drop-off.
  const events = (opts.events ?? [])
    .map((e) => String(e).trim())
    .filter(Boolean)
    .slice(0, 8);
  // Always bound the scan to a lookback window so ClickHouse prunes partitions
  // (session_events is partitioned by month) — never a full-history scan.
  // Defaults to 90d when the caller doesn't pass an explicit range; the effective
  // value is RETURNED so the caller (→ narrator) can disclose the window instead
  // of letting the user assume the funnel covers all sessions.
  const sinceDays =
    Number.isFinite(Number(opts.sinceDays)) && Number(opts.sinceDays) > 0
      ? Number(opts.sinceDays)
      : 90;
  if (events.length < 2) return { steps: [], enteredSessions: 0, sinceDays };
  const client = getClickHouseClient();
  const params: Record<string, unknown> = { ws: opts.workspaceId };
  params.sinceMs = Math.floor(Date.now() - sinceDays * 86_400_000);
  const timeWhere = "AND timestamp >= {sinceMs:UInt64}";
  const conds = events.map((e, i) => {
    params[`ev${i}`] = e.toLowerCase();
    return `lower(message) = {ev${i}:String}`;
  });
  const messageList = events.map((_, i) => `{ev${i}:String}`).join(", ");
  const stepCols = events
    .map((_, i) => `countIf(flevel >= ${i + 1}) AS s${i}`)
    .join(", ");
  const window = Math.max(1000, Math.floor(opts.windowMs ?? 86_400_000));
  const sql = `
    SELECT ${stepCols}
    FROM (
      SELECT session_id,
             windowFunnel(${window})(timestamp, ${conds.join(", ")}) AS flevel
      FROM replay.session_events
      WHERE workspace_id = {ws:UInt32} AND kind = 'custom' AND level = 'track'
            AND lower(message) IN (${messageList}) ${timeWhere}
      GROUP BY session_id
    )`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const row = ((await res.json()) as Array<Record<string, string>>)[0] ?? {};
  const steps = events.map((event, i) => ({
    event,
    sessions: Number(row[`s${i}`] ?? 0),
  }));
  return { steps, enteredSessions: steps[0]?.sessions ?? 0, sinceDays };
}

/**
 * Top endpoint PATHS that returned a 2xx for a workspace, ranked by distinct
 * sessions — the candidate list for defining a conversion by "endpoint+status"
 * (e.g. POST /charge → 200 = payment success). `q` biases toward a pattern
 * (e.g. "pay|charge|checkout|order"). Partition-pruned + workspace-indexed;
 * groups by `path(url)` so query strings collapse. Scales.
 */
export async function topSuccessEndpoints(opts: {
  workspaceId: number;
  q?: string;
  limit?: number;
}): Promise<Array<{ value: string; count: number }>> {
  const client = getClickHouseClient();
  const sinceMs = Math.floor(Date.now() - 30 * 86_400_000);
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs,
    limit: Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10))),
  };
  let where =
    `workspace_id = {ws:UInt32} AND timestamp >= {sinceMs:UInt64} ` +
    `AND status_code >= 200 AND status_code < 300 AND url != ''`;
  if (opts.q) {
    params.q = opts.q;
    where += ` AND match(lower(url), {q:String})`;
  }
  const sql = `
    SELECT path(url) AS value, uniqExact(session_id) AS c
    FROM replay.session_events
    WHERE ${where}
    GROUP BY value
    HAVING value != ''
    ORDER BY c DESC, value ASC
    LIMIT {limit:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<{ value: string; c: string }>;
  return rows.map((r) => ({ value: r.value, count: Number(r.c) }));
}

/**
 * Top tracked custom-event NAMES for a workspace (`kind='custom' level='track'`;
 * the event name is the `message`), ranked by how many DISTINCT sessions fired
 * each. This is the candidate list the agent offers when it must ask "which event
 * marks X?" (ask-with-candidates) — and the basis for events.discover (task #9).
 * Partition-pruned to the recent window, workspace-indexed; one columnar
 * group-by with `uniqExact` (approximate-safe distinct) → scales.
 */
export async function topTrackEvents(opts: {
  workspaceId: number;
  q?: string;
  limit?: number;
}): Promise<Array<{ value: string; count: number }>> {
  const client = getClickHouseClient();
  const sinceMs = Math.floor(Date.now() - 30 * 86_400_000);
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs,
    limit: Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10))),
  };
  let where =
    `workspace_id = {ws:UInt32} AND timestamp >= {sinceMs:UInt64} ` +
    `AND kind = 'custom' AND level = 'track' AND message != ''`;
  if (opts.q) {
    params.q = `%${opts.q}%`;
    where += ` AND message ILIKE {q:String}`;
  }
  const sql = `
    SELECT message AS value, uniqExact(session_id) AS c
    FROM replay.session_events
    WHERE ${where}
    GROUP BY value
    ORDER BY c DESC, value ASC
    LIMIT {limit:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<{ value: string; c: string }>;
  return rows.map((r) => ({ value: r.value, count: Number(r.c) }));
}

/**
 * Distinct step-value autocomplete for the funnel builder, read over the SAME
 * `session_events` column a step of this `kind` matches against (funnelColumn) —
 * so the picker and the `windowFunnel` computation always agree. Custom-event
 * names are constrained to `kind='custom' AND level='track'` to mirror how an
 * `event` step matches (and topTrackEvents). One set-based, workspace-pinned,
 * day-partition-pruned pass, frequency-ranked (sessions desc), capped at `limit`.
 * Scales: bounded by the lookback window + LIMIT — never scans the whole table.
 * `col` is a fixed whitelist (route|ui_value|message) from funnelColumn, so its
 * interpolation into SQL is safe; the value filter is a bound param.
 */
export async function suggestFunnelStepValues(opts: {
  workspaceId: number;
  kind: string;
  q?: string;
  sinceMs?: number;
  limit?: number;
}): Promise<Array<{ value: string; count: number }>> {
  const client = getClickHouseClient();
  const col = funnelColumn(opts.kind);
  // 30-day default lookback — matches the sibling suggests (topTrackEvents) and
  // keeps the columnar scan to the fewest day-partitions. Callers can widen it.
  const sinceMs = Math.floor(opts.sinceMs ?? Date.now() - 30 * 86_400_000);
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs,
    limit: Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10))),
  };
  let where = `workspace_id = {ws:UInt32} AND timestamp >= {sinceMs:UInt64} AND ${col} != ''`;
  if (opts.kind === "event") {
    // Only real user-defined events. Hide SDK-reserved/internal names
    // ($console, $exception, …) emitted on the same custom/track channel — they
    // shouldn't clutter the picker (a user who really wants one can still type
    // it; the funnel match isn't $-filtered).
    where += ` AND kind = 'custom' AND level = 'track' AND message NOT LIKE '$%'`;
  }
  if (opts.q) {
    // Escape LIKE metachars so a typed % or _ is a literal substring, not a
    // wildcard — same as suggestDimensionValues. Value stays a bound param.
    params.q = `%${escapeLikePattern(opts.q)}%`;
    where += ` AND ${col} ILIKE {q:String}`;
  }
  const sql = `
    SELECT ${col} AS value, uniqExact(session_id) AS c
    FROM replay.session_events
    WHERE ${where}
    GROUP BY value
    ORDER BY c DESC, value ASC
    LIMIT {limit:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<{ value: string; c: string }>;
  return rows.map((r) => ({ value: r.value, count: Number(r.c) }));
}

/**
 * Funnel conversion split by a dimension in ONE ClickHouse pass (the reference's
 * funnel breakdown). The inner query computes each session's `windowFunnel`
 * level + carries its dimension value; the outer groups by that value to count
 * entered / converted / per-stage sessions per bucket, ordered by entered desc
 * and capped at `topN`. Event-resident dimensions need no join; session/user
 * dimensions INNER JOIN `replay.sessions`. Returns [] for an unknown dimension
 * rather than risking an unsafe column.
 */
export async function funnelBreakdown(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  dimension: string;
  topN?: number;
  segment?: FunnelSegment;
  metric?: "session" | "user";
}): Promise<FunnelBreakdownBucket[]> {
  const eventCol = FUNNEL_BREAKDOWN_COLUMNS[opts.dimension];
  const sessionCol = FUNNEL_BREAKDOWN_SESSION_COLUMNS[opts.dimension];
  if (!eventCol && !sessionCol) return [];
  const isUser = opts.metric === "user";
  const n = opts.steps.length;
  const client = getClickHouseClient();
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    topN: Math.max(1, Math.min(100, Math.floor(opts.topN ?? 20))),
  };
  // Events aliased `e` so the optional sessions JOIN is unambiguous.
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  // The user metric (needs user_id) OR a session-resident dimension OR a segment
  // filter needs the sessions JOIN.
  const needsJoin =
    isUser || (!eventCol && !!sessionCol) || segConds.length > 0;
  const dimCol = !eventCol && sessionCol ? `s.${sessionCol}` : `e.${eventCol}`;
  // Session metric: one row per session (dim via any()). User metric: one row
  // per (dim, user) so the outer counts DISTINCT users per bucket — the
  // reference's MetricFormatUserCount breakdown (anonymous excluded).
  const innerDim = isUser ? dimCol : `any(${dimCol})`;
  const innerGroupBy = isUser ? "dim, s.user_id" : "e.session_id";
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  let where = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    where += ` AND e.timestamp < {untilMs:UInt64}`;
  }
  let from = `replay.session_events AS e`;
  if (needsJoin) {
    // The two traffic-source dims that aren't raw columns are materialised here
    // as ref_domain / channel so FUNNEL_BREAKDOWN_SESSION_COLUMNS can map to a
    // plain `s.<col>` like every other dimension (same exprs as the analytics
    // breakdown). Only computed on the session-JOIN path, once per session row.
    from += ` INNER JOIN (SELECT *, ${REFERRER_DOMAIN_EXPR} AS ref_domain, ${CHANNEL_EXPR} AS channel FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32}${opts.untilMs ? " AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}" : " AND datetime >= {sinceMs:UInt64}"}) AS s ON e.session_id = s.session_id`;
    if (isUser) where += ` AND s.user_id != ''`;
    if (segConds.length > 0) where += ` AND ${segConds.join(" AND ")}`;
  }
  const stageCols = opts.steps
    .map((_, i) => `countIf(flevel >= ${i + 1}) AS s${i + 1}`)
    .join(", ");
  const sql = `
    SELECT dim,
           count() AS total,
           countIf(flevel >= 1) AS entered,
           countIf(flevel >= ${n}) AS converted,
           ${stageCols}
    FROM (
      SELECT ${innerDim} AS dim,
             windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel
      FROM ${from}
      WHERE ${where}
      GROUP BY ${innerGroupBy}
    )
    GROUP BY dim
    ORDER BY entered DESC, total DESC
    LIMIT {topN:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    value: String(r.dim ?? ""),
    total: Number(r.total ?? 0),
    entered: Number(r.entered ?? 0),
    converted: Number(r.converted ?? 0),
    stages: opts.steps.map((_, i) => Number(r[`s${i + 1}`] ?? 0)),
  }));
}

/** Per-release network latency (Release Intelligence). */
export interface ReleaseLatency {
  release: string;
  avg_ms: number;
  p95_ms: number;
  calls: number;
}

/**
 * Average + p95 network latency per release for a workspace. Clean GROUP BY on
 * the denormalised `release` column — no cross-store join, scales. Rows with an
 * empty release (pre-denormalisation / untagged builds) are excluded.
 */
export async function releaseLatency(
  workspaceId: number,
): Promise<ReleaseLatency[]> {
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT release,
             round(avg(duration_ms)) AS avg_ms,
             round(quantile(0.95)(duration_ms)) AS p95_ms,
             count() AS calls
      FROM replay.session_events
      WHERE workspace_id = {ws:UInt32} AND kind = 'network' AND release != ''
      GROUP BY release`,
    format: "JSONEachRow",
    query_params: { ws: workspaceId },
  });
  const rows = (await result.json()) as Array<{
    release: string;
    avg_ms: string;
    p95_ms: string;
    calls: string;
  }>;
  return rows.map((r) => ({
    release: r.release,
    avg_ms: Number(r.avg_ms),
    p95_ms: Number(r.p95_ms),
    calls: Number(r.calls),
  }));
}

/** One UTC day's API-latency rollup for a workspace, from network events. */
export interface LatencyDailyRow {
  workspace_id: number;
  calls: number;
  p95_ms: number;
  avg_ms: number;
  max_ms: number;
  slow_calls: number;
  samples: number[];
}

/**
 * Per-workspace API-latency aggregates for a single UTC day window, grouped over
 * ALL workspaces in ONE pass (mirrors releaseLatency's `kind='network'`
 * predicate). Backs `WorkspaceLatencyDaily` so the Overview's API-health
 * subsystem reads a daily series instead of scanning session_events at serve
 * time. Partition-pruned by the [sinceMs, untilMs) timestamp bound; ONE grouped
 * query per day, never a per-workspace loop. `samples` is a ≤1000-value reservoir
 * of duration_ms so a 7d/30d window p95 can be recombined from the daily rows.
 */
export async function latencyDaily(opts: {
  sinceMs: number;
  untilMs: number;
  slowMs?: number;
}): Promise<LatencyDailyRow[]> {
  const client = getClickHouseClient();
  const params = {
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
    slowMs: Math.max(1, Math.floor(opts.slowMs ?? 1000)),
  };
  const res = await client.query({
    query: `
      SELECT workspace_id,
             count() AS calls,
             round(quantile(0.95)(duration_ms)) AS p95_ms,
             round(avg(duration_ms)) AS avg_ms,
             max(duration_ms) AS max_ms,
             countIf(duration_ms > {slowMs:UInt32}) AS slow_calls,
             groupArraySample(1000)(duration_ms) AS samples
      FROM replay.session_events
      WHERE kind = 'network'
            AND timestamp >= {sinceMs:UInt64} AND timestamp < {untilMs:UInt64}
      GROUP BY workspace_id`,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    workspace_id: Number(r.workspace_id),
    calls: Number(r.calls),
    p95_ms: Number(r.p95_ms),
    avg_ms: Number(r.avg_ms),
    max_ms: Number(r.max_ms),
    slow_calls: Number(r.slow_calls),
    samples: Array.isArray(r.samples)
      ? (r.samples as unknown[]).map(Number)
      : [],
  }));
}

/** One UTC day's engagement rollup for a workspace (DAU + trailing-30d MAU). */
export interface EngagementDailyRow {
  workspace_id: number;
  dau: number;
  mau: number;
  sessions: number;
  new_users: number;
}

/**
 * Per-workspace daily engagement aggregates, grouped over ALL workspaces in ONE
 * pass. Backs `WorkspaceEngagementDaily` so experienceHealth()'s Engagement
 * subsystem reads persisted DAU + stickiness (DAU/MAU) instead of the live
 * OverviewUserMetrics prior-window approximation. A "user" is the identified
 * user_id, else the anonymous device id, else the session id (mirrors
 * overviewUserMetrics), so anon visitors count once. The scan spans the trailing
 * `mauDays` (default 30) so `mau` = distinct users AS-OF dayEnd and `dau` =
 * distinct users on [dayStart, dayEnd) fall out of the SAME grouped scan via
 * uniqExactIf. Partition-pruned by [mauStart, dayEnd); one query per day.
 */
export async function engagementDaily(opts: {
  dayStartMs: number;
  dayEndMs: number;
  mauDays?: number;
}): Promise<EngagementDailyRow[]> {
  const client = getClickHouseClient();
  const dayMs = 86_400_000;
  const mauDays = Math.max(1, Math.floor(opts.mauDays ?? 30));
  const params = {
    dayStart: Math.floor(opts.dayStartMs),
    dayEnd: Math.floor(opts.dayEndMs),
    mauStart: Math.floor(opts.dayEndMs - mauDays * dayMs),
  };
  const res = await client.query({
    query: `
      SELECT workspace_id,
             uniqExactIf(uid, datetime >= {dayStart:UInt64} AND datetime < {dayEnd:UInt64}) AS dau,
             uniqExact(uid) AS mau,
             countIf(datetime >= {dayStart:UInt64} AND datetime < {dayEnd:UInt64}) AS sessions,
             uniqExactIf(uid,
               datetime >= {dayStart:UInt64} AND datetime < {dayEnd:UInt64}
               AND first_seen_at >= {dayStart:UInt64} AND first_seen_at < {dayEnd:UInt64}) AS new_users
      FROM (
        SELECT workspace_id,
               if(user_id != '', user_id, if(anonymous_id != '', anonymous_id, toString(session_id))) AS uid,
               datetime, first_seen_at
        FROM replay.sessions FINAL
        WHERE datetime >= {mauStart:UInt64} AND datetime < {dayEnd:UInt64}
      )
      GROUP BY workspace_id`,
    format: "JSONEachRow",
    query_params: params,
  });
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    workspace_id: Number(r.workspace_id),
    dau: Number(r.dau),
    mau: Number(r.mau),
    sessions: Number(r.sessions),
    new_users: Number(r.new_users),
  }));
}

/** DAU/WAU/MAU + window aggregates for the Overview's Level-1 metric strip. */
export interface OverviewUserMetrics {
  /** Distinct active users in trailing 1d / 7d / 30d windows, current vs the
   *  immediately-preceding window of the same length. */
  dau: [number, number];
  wau: [number, number];
  mau: [number, number];
  /** For the selected range vs the preceding equal window. */
  activeUsers: [number, number];
  avgDurationMs: [number, number];
  /** Returning users (first seen before the window) ÷ active users, %. */
  returningPct: [number, number];
  /** New users (first seen INSIDE the window) — current vs preceding window.
   *  Distinct people whose first-ever session lands in the window. */
  newUsers: [number, number];
  /** Returning users (first seen BEFORE the window) as a raw count — current vs
   *  preceding window. The counterpart to `newUsers`; `returningPct` is this
   *  over active users. */
  returningUsers: [number, number];
  /** Daily series over the selected range (oldest→newest) for sparklines. */
  spark: Array<{
    day: number;
    activeUsers: number;
    sessions: number;
    avgDurationMs: number;
    /** Distinct users active that day whose first-ever session is in-window. */
    newUsers: number;
    /** Distinct users active that day first seen before the window. */
    returningUsers: number;
  }>;
  /** Rolling distinct-user series aligned to `spark` days (oldest→newest), for
   *  the WAU/MAU tile sparklines: wauSpark[i] = distinct users active in the 7
   *  days ending spark[i].day; mauSpark[i] = the trailing 30 days. */
  wauSpark: number[];
  mauSpark: number[];
}

/**
 * Level-1 user metrics from the per-session `replay.sessions` table — DAU/WAU/MAU
 * (windowed `uniqExact`), plus active-users / avg-duration / returning-rate for
 * the selected range and the preceding equal window, plus a daily series for
 * sparklines. A "user" is the identified `user_id`, falling back to the
 * `anonymous_id` device id, so anonymous visitors still count once. One grouped
 * scan over a workspace's sessions in [mauPrevStart, untilMs] — set-based,
 * scales. `nowMs` is passed in (callers stamp time) so DAU/WAU/MAU anchor to it.
 */
export async function overviewUserMetrics(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  nowMs: number;
}): Promise<OverviewUserMetrics> {
  const client = getClickHouseClient();
  const day = 86_400_000;
  const { workspaceId, sinceMs, untilMs, nowMs } = opts;
  const len = Math.max(day, untilMs - sinceMs);
  const params: Record<string, unknown> = {
    ws: workspaceId,
    sinceMs: Math.floor(sinceMs),
    untilMs: Math.floor(untilMs),
    prevStart: Math.floor(sinceMs - len),
    dau: Math.floor(nowMs - day),
    dauPrev: Math.floor(nowMs - 2 * day),
    wau: Math.floor(nowMs - 7 * day),
    wauPrev: Math.floor(nowMs - 14 * day),
    mau: Math.floor(nowMs - 30 * day),
    mauPrev: Math.floor(nowMs - 60 * day),
    scanStart: Math.floor(Math.min(sinceMs - len, nowMs - 60 * day)),
    // Rolling WAU/MAU need up to 30 days of lookback BEFORE the spark range, so
    // an early day's trailing-30 window still sees the users active before it.
    rollStart: Math.floor(sinceMs - 30 * day),
  };
  // `uid` = identified user, else anonymous device id, else the session id —
  // so every session maps to a stable "person" and anon visitors count once.
  const base = `
    FROM (
      SELECT if(user_id != '', user_id, if(anonymous_id != '', anonymous_id, toString(session_id))) AS uid,
             datetime, duration_ms, first_seen_at
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32} AND datetime >= {scanStart:UInt64}
    )`;
  const aggSql = `
    SELECT
      uniqExactIf(uid, datetime >= {dau:UInt64}) AS dau,
      uniqExactIf(uid, datetime >= {dauPrev:UInt64} AND datetime < {dau:UInt64}) AS dau_prev,
      uniqExactIf(uid, datetime >= {wau:UInt64}) AS wau,
      uniqExactIf(uid, datetime >= {wauPrev:UInt64} AND datetime < {wau:UInt64}) AS wau_prev,
      uniqExactIf(uid, datetime >= {mau:UInt64}) AS mau,
      uniqExactIf(uid, datetime >= {mauPrev:UInt64} AND datetime < {mau:UInt64}) AS mau_prev,
      uniqExactIf(uid, datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}) AS au,
      uniqExactIf(uid, datetime >= {prevStart:UInt64} AND datetime < {sinceMs:UInt64}) AS au_prev,
      round(avgIf(duration_ms, datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64})) AS dur,
      round(avgIf(duration_ms, datetime >= {prevStart:UInt64} AND datetime < {sinceMs:UInt64})) AS dur_prev,
      uniqExactIf(uid, datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64} AND first_seen_at > 0 AND first_seen_at < {sinceMs:UInt64}) AS ret,
      uniqExactIf(uid, datetime >= {prevStart:UInt64} AND datetime < {sinceMs:UInt64} AND first_seen_at > 0 AND first_seen_at < {prevStart:UInt64}) AS ret_prev,
      uniqExactIf(uid, datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64} AND first_seen_at >= {sinceMs:UInt64}) AS new_u,
      uniqExactIf(uid, datetime >= {prevStart:UInt64} AND datetime < {sinceMs:UInt64} AND first_seen_at >= {prevStart:UInt64} AND first_seen_at < {sinceMs:UInt64}) AS new_u_prev
    ${base}`;
  const sparkSql = `
    SELECT intDiv(datetime, 86400000) * 86400000 AS day,
           uniqExact(uid) AS active_users,
           count() AS sessions,
           round(avg(duration_ms)) AS avg_dur,
           uniqExactIf(uid, first_seen_at >= {sinceMs:UInt64}) AS new_users,
           uniqExactIf(uid, first_seen_at > 0 AND first_seen_at < {sinceMs:UInt64}) AS returning_users
    FROM (
      SELECT if(user_id != '', user_id, if(anonymous_id != '', anonymous_id, toString(session_id))) AS uid,
             datetime, duration_ms, first_seen_at
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}
    )
    GROUP BY day ORDER BY day ASC`;
  // Rolling WAU/MAU per day WITHOUT a per-day loop: reduce to DISTINCT
  // (uid, active-day), then ARRAY JOIN each active-day across the 30 forward days
  // it belongs to a rolling window of. WAU[day] = distinct uid that reached it
  // via an offset < 7 (active in the trailing 7d); MAU[day] = all 30. One
  // set-based scan — scales like the rest of this file.
  const rollingSql = `
    SELECT actday + off * 86400000 AS day,
           uniqExactIf(uid, off < 7) AS wau,
           uniqExact(uid) AS mau
    FROM (
      SELECT DISTINCT
             if(user_id != '', user_id, if(anonymous_id != '', anonymous_id, toString(session_id))) AS uid,
             intDiv(datetime, 86400000) * 86400000 AS actday
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32} AND datetime >= {rollStart:UInt64} AND datetime < {untilMs:UInt64}
    )
    ARRAY JOIN range(30) AS off
    WHERE (actday + off * 86400000) >= {sinceMs:UInt64} AND (actday + off * 86400000) < {untilMs:UInt64}
    GROUP BY day ORDER BY day ASC`;
  const [aggRes, sparkRes, rollRes] = await Promise.all([
    client.query({
      query: aggSql,
      format: "JSONEachRow",
      query_params: params,
    }),
    client.query({
      query: sparkSql,
      format: "JSONEachRow",
      query_params: params,
    }),
    client.query({
      query: rollingSql,
      format: "JSONEachRow",
      query_params: params,
    }),
  ]);
  const [a] = (await aggRes.json()) as Array<Record<string, unknown>>;
  const sparkRows = (await sparkRes.json()) as Array<Record<string, unknown>>;
  const rollRows = (await rollRes.json()) as Array<Record<string, unknown>>;
  const rollMap = new Map<number, { wau: number; mau: number }>();
  for (const r of rollRows)
    rollMap.set(Number(r.day), { wau: Number(r.wau), mau: Number(r.mau) });
  const n = (k: string) => Number(a?.[k] ?? 0);
  const pct = (ret: number, au: number) =>
    au > 0 ? Math.round((ret / au) * 1000) / 10 : 0;
  return {
    dau: [n("dau"), n("dau_prev")],
    wau: [n("wau"), n("wau_prev")],
    mau: [n("mau"), n("mau_prev")],
    activeUsers: [n("au"), n("au_prev")],
    avgDurationMs: [n("dur"), n("dur_prev")],
    returningPct: [pct(n("ret"), n("au")), pct(n("ret_prev"), n("au_prev"))],
    newUsers: [n("new_u"), n("new_u_prev")],
    returningUsers: [n("ret"), n("ret_prev")],
    spark: sparkRows.map((r) => ({
      day: Number(r.day),
      activeUsers: Number(r.active_users),
      sessions: Number(r.sessions),
      avgDurationMs: Number(r.avg_dur),
      newUsers: Number(r.new_users),
      returningUsers: Number(r.returning_users),
    })),
    // Aligned to the spark days so the WAU/MAU tiles draw the same day axis.
    wauSpark: sparkRows.map((r) => rollMap.get(Number(r.day))?.wau ?? 0),
    mauSpark: sparkRows.map((r) => rollMap.get(Number(r.day))?.mau ?? 0),
  };
}

/* ==========================================================================
   Activity chart — REAL per-dimension, per-bucket series (breakdown/time/
   granularity/compare/segment/rule-filters). Replaces the client-side
   synthesized breakdown. Every query here is ONE workspace-scoped,
   partition-pruned, set-based scan of replay.sessions.
   ========================================================================== */

/** Chart breakdown/rule dimension key → replay.sessions column. A FIXED Map
 *  (never a Record) so a caller key can't reach an inherited property and inject
 *  a column name — same guard as SUGGEST_DIMENSION_COLS. */
const ACTIVITY_DIM_COLS = new Map<string, string>([
  ["browser", "browser"],
  ["platform", "platform"],
  ["os", "os"],
  ["osVersion", "os_version"],
  ["country", "country"],
  ["device", "device"],
  ["deviceModel", "device_model"],
  ["release", "release"],
  ["plan", "plan"],
  ["page", "start_path"],
]);
/** Every dimension the Activity chart can break down / filter by. */
export const ACTIVITY_DIMENSIONS: string[] = [...ACTIVITY_DIM_COLS.keys()];

export type ActivityDimMetric =
  | "activeUsers"
  | "sessions"
  | "newUsers"
  | "returningUsers"
  | "avgDuration";
export type ActivityDimRow = { bucket: number; band: string; value: number };
export type ActivityDimBandTotal = { band: string; value: number };
export type ActivityDimResult = {
  bands: string[];
  rows: ActivityDimRow[];
  /**
   * Per-band aggregate over the WHOLE window, computed by the same query in the
   * same scan (a second GROUPING SET), NOT by summing `rows`.
   *
   * Summing the buckets is only correct for additive metrics. `activeUsers`,
   * `newUsers` and `returningUsers` are uniqExact over the bucket, so summing
   * them counts a user once per bucket they appeared in — "sum of daily
   * actives", which on real data ran 2.4×–4.3× the true number of people and
   * disagreed with the unique count /metrics prints on the same page.
   * `avgDuration` was worse still: a sum of averages, which means nothing.
   */
  totals: ActivityDimBandTotal[];
  /**
   * The metric across ALL bands over the whole window — and NOT the sum of
   * `totals` either, because for a unique metric the bands overlap: one person
   * browsing on Chrome and on mobile Safari is in two bands but is one user.
   * Measured on ws1/30d: bands summed to 81,217 where the true union is 49,027.
   */
  grandTotal: number;
};

const ACT_UID_EXPR = `if(user_id != '', user_id, if(anonymous_id != '', anonymous_id, toString(session_id)))`;

/** The per-bucket aggregate for the selected chart metric. */
function activityMetricAgg(metric: ActivityDimMetric): string {
  switch (metric) {
    case "sessions":
      return `count()`;
    case "newUsers":
      return `uniqExactIf(uid, first_seen_at >= {sinceMs:UInt64})`;
    case "returningUsers":
      return `uniqExactIf(uid, first_seen_at > 0 AND first_seen_at < {sinceMs:UInt64})`;
    case "avgDuration":
      return `round(avgIf(duration_ms, duration_ms > 0))`;
    case "activeUsers":
    default:
      return `uniqExact(uid)`;
  }
}

/** Segment key → an extra WHERE fragment on the base scan. Column-only + literals
 *  from a fixed switch (no caller value interpolated → injection-safe). `power`
 *  is handled separately (needs a subquery); segments with no measurable column
 *  (internal/beta) are not offered and fall through to no filter. */
function activitySegmentClause(segment: string | null | undefined): string {
  switch (segment) {
    case "anon":
      return ` AND user_id = ''`;
    case "logged":
      return ` AND user_id != ''`;
    case "paying":
      return ` AND plan != '' AND lower(plan) NOT IN ('free', 'trial')`;
    case "enterprise":
      return ` AND lower(plan) = 'enterprise'`;
    default:
      return ``;
  }
}

/**
 * Per-(bucket, dimension-band) series for the Activity chart. `dimension` null →
 * a single 'total' band. Bands are the global top-N values (ranked by active
 * users over the whole window), with the long tail folded into 'Other' and empty
 * into 'Unknown' — INSIDE one statement via `dim IN top_vals` (evaluated once, no
 * per-value loop → no N+1). For a compare window, pass the current window's
 * `bands` so both series share bands and the overlay lines up.
 *
 * Access pattern: workspace_id is the ORDER BY prefix (pins the tenant) and
 * PARTITION BY day prunes [sinceMs,untilMs); FINAL dedups ReplacingMergeTree so
 * count()/avg() are exact. Set-based, scales to millions.
 */
export async function activityDimSeries(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  bucketMs: number;
  /** When true, bucket by calendar month (variable width) instead of bucketMs. */
  monthly?: boolean;
  dimension?: string | null;
  metric: ActivityDimMetric;
  topN?: number;
  segment?: string | null;
  rules?: { dim: string; value: string }[];
  /** Bind the exact band set (compare window → align to the current window). */
  bands?: string[] | null;
}): Promise<ActivityDimResult> {
  const client = getClickHouseClient();
  const { workspaceId, sinceMs, untilMs, metric } = opts;
  const bucketMs = Math.max(1, Math.floor(opts.bucketMs || 86_400_000));
  const topN = Math.max(1, Math.min(12, Math.floor(opts.topN ?? 6)));
  const dimCol = opts.dimension
    ? ACTIVITY_DIM_COLS.get(opts.dimension)
    : undefined;

  const params: Record<string, unknown> = {
    ws: workspaceId,
    sinceMs: Math.floor(sinceMs),
    untilMs: Math.floor(untilMs),
    bucketMs,
    topN,
  };

  // Rule filters → AND col = value (col from the whitelist, value parameterized).
  const ruleClauses: string[] = [];
  (opts.rules ?? []).forEach((r, i) => {
    const col = ACTIVITY_DIM_COLS.get(r.dim);
    if (!col || r.value == null || r.value === "") return;
    const p = `rule${i}`;
    params[p] = r.value;
    ruleClauses.push(`AND ${col} = {${p}:String}`);
  });

  // Segment WHERE (+ power via a distinct-uid HAVING subquery over the window).
  let segClause = activitySegmentClause(opts.segment);
  if (opts.segment === "power") {
    segClause += ` AND ${ACT_UID_EXPR} IN (
      SELECT ${ACT_UID_EXPR} AS uid FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32}
        AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}
      GROUP BY uid HAVING count() >= {powerMin:UInt32})`;
    params.powerMin = 5;
  }

  const bucketExpr = opts.monthly
    ? `toInt64(toUnixTimestamp(toStartOfMonth(toDateTime(intDiv(datetime, 1000))))) * 1000`
    : `intDiv(datetime, {bucketMs:UInt64}) * {bucketMs:UInt64}`;
  const agg = activityMetricAgg(metric);
  const filters = `${segClause} ${ruleClauses.join(" ")}`;

  // No breakdown → single 'total' band.
  if (!dimCol) {
    // GROUPING SETS gives us the per-bucket series AND the window-wide total in
    // ONE pass over the same rows: (bucket, band) is the series, (band) alone is
    // the total. The total row cannot be derived by summing the series for any
    // unique- or average-based metric, and re-querying for it would double the
    // scan — see the comment on ActivityDimResult.totals.
    const sql = `
      SELECT ${bucketExpr} AS bucket, 'total' AS band, ${agg} AS value,
             grouping(bucket) AS is_total
      FROM (
        SELECT ${ACT_UID_EXPR} AS uid, datetime, duration_ms, first_seen_at
        FROM replay.sessions FINAL
        WHERE workspace_id = {ws:UInt32}
          AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}${filters}
      )
      GROUP BY GROUPING SETS ((bucket, band), (band))
      ORDER BY is_total ASC, bucket ASC`;
    const res = await client.query({
      query: sql,
      format: "JSONEachRow",
      query_params: params,
    });
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    const rows: ActivityDimRow[] = [];
    const totals: ActivityDimBandTotal[] = [];
    for (const r of raw) {
      if (Number(r.is_total) === 1) {
        totals.push({ band: "total", value: Number(r.value) });
      } else {
        rows.push({
          bucket: Number(r.bucket),
          band: "total",
          value: Number(r.value),
        });
      }
    }
    // One band, so the band total IS the grand total — no third grouping set.
    return {
      bands: ["total"],
      rows,
      totals,
      grandTotal: totals[0]?.value ?? 0,
    };
  }

  // Breakdown. Bands: a global top-N (ranked by active users), or the caller's
  // bound bands for a compare window. The long tail folds into 'Other', empty
  // into 'Unknown' — all inside one statement.
  const bound = Array.isArray(opts.bands) && opts.bands.length > 0;
  if (bound) params.bands = opts.bands;
  const bandExpr = bound
    ? `multiIf(dim = '', 'Unknown', has({bands:Array(String)}, dim), dim, 'Other')`
    : `multiIf(dim = '', 'Unknown', dim IN top_vals, dim, 'Other')`;
  const topCte = bound
    ? ``
    : `, top_vals AS (
        SELECT dim FROM base WHERE dim != ''
        GROUP BY dim ORDER BY uniqExact(uid) DESC, count() DESC
        LIMIT {topN:UInt32})`;

  const sql = `
    WITH base AS (
      SELECT ${ACT_UID_EXPR} AS uid, ${dimCol} AS dim, datetime, duration_ms, first_seen_at
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32}
        AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}${filters}
    )${topCte}
    SELECT ${bucketExpr} AS bucket, ${bandExpr} AS band, ${agg} AS value,
           grouping(bucket) AS is_total, grouping(band) AS is_grand
    FROM base
    GROUP BY GROUPING SETS ((bucket, band), (band), ())
    ORDER BY is_grand ASC, is_total ASC, bucket ASC, value DESC`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  const out: ActivityDimRow[] = [];
  const totals: ActivityDimBandTotal[] = [];
  let grandTotal = 0;
  for (const r of raw) {
    // is_grand marks the () set — the metric over every band at once. is_total
    // (without is_grand) marks the (band) set — one row per band. Everything
    // else is the (bucket, band) series.
    if (Number(r.is_grand) === 1) {
      grandTotal = Number(r.value);
    } else if (Number(r.is_total) === 1) {
      totals.push({ band: String(r.band), value: Number(r.value) });
    } else {
      out.push({
        bucket: Number(r.bucket),
        band: String(r.band),
        value: Number(r.value),
      });
    }
  }

  // Band order (stack order): caller-bound, else by WINDOW total desc with
  // Other/Unknown pinned last. Ranking on the true per-band total rather than a
  // sum of buckets also fixes the stack order itself: a band whose users return
  // day after day used to out-rank a genuinely larger band purely by being
  // counted repeatedly.
  let bands: string[];
  if (bound) {
    bands = opts.bands as string[];
  } else {
    const tot = new Map(totals.map((t) => [t.band, t.value]));
    bands = [...tot.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([b]) => b)
      .filter((b) => b !== "Other" && b !== "Unknown");
    if (tot.has("Other")) bands.push("Other");
    if (tot.has("Unknown")) bands.push("Unknown");
  }
  return { bands, rows: out, totals, grandTotal };
}

/** One row of the signal-derivation aggregate, per session. */
export interface SessionSignalAgg {
  session_id: number;
  /** Count of network events that came back 5xx. */
  backend_failures: number;
  /** Count of network events slower than the slow-API threshold. */
  slow_apis: number;
  /** Count of fatal crash error events (`kind='error' AND error='crash'`). */
  crashes: number;
  /** Count of form input events (`kind='custom' AND level='input'`). */
  inputs: number;
  /** Count of conversion track events (`kind='custom' AND level='track'` whose
   *  name matches the conversion pattern). */
  conversions: number;
  /** Count of conversion-intent events (flow started). */
  intents: number;
  /** A representative failing endpoint URL, for screen attribution. */
  worst_fail_url: string;
  /** A representative slow endpoint URL, for screen attribution. */
  worst_slow_url: string;
  /** Screen/route where the session's rage happened (latest rage event). */
  rage_route: string;
  /** UI element the session raged on (latest rage event). */
  rage_element: string;
  /** Count of dead clicks (clicks on an element that did nothing). */
  dead_clicks: number;
  /** The element the session dead-clicked (selector) — unmet-demand locus. */
  dead_element: string;
  /** Screen where the dead click happened. */
  dead_route: string;
}

/** Default conversion-event name pattern (re2, case-insensitive via lower()).
 *  Completion-flavoured terms only, to avoid counting flow *starts* as wins.
 *  A per-workspace override is a future setting. */
const CONVERSION_PATTERN =
  "purchase|payment_success|order_placed|order_complete|checkout_complete|subscribed|subscription_started|signup_complete|sign_up_complete|registration_complete|conversion|booking_confirmed|upgrade_complete";

/** Conversion-INTENT event names (the flow started). A session with intent but
 *  no conversion → conversion_failure (drop-off). Default pattern; a future
 *  per-workspace funnel definition can override this. */
const CONVERSION_INTENT_PATTERN =
  "begin_checkout|checkout_started|started_checkout|initiate_checkout|add_to_cart|start_trial|signup_started|sign_up_started|started_registration|begin_signup|cart_viewed";

/**
 * Aggregate the signal-bearing facts for a batch of sessions in ONE pass.
 *
 * Used by the Overview signal-derivation job (Slice 0). Critically this is a
 * single grouped query over the supplied session ids — never one query per
 * session. The finalize hook (ids = [one]) is exactly one round-trip; the
 * nightly keyset-paged backfill pages by global session id, so a page costs
 * one round-trip per DISTINCT workspace it touches, never one per session.
 *
 * Access pattern: ONE query, `WHERE workspace_id = ? AND session_id IN (…)`,
 * with the `countIf` conditions evaluated during that read. `workspace_id` is
 * the LEADING column of the `session_events` ORDER BY key `(workspace_id,
 * session_id, sequence, timestamp)` and `session_id` is the second, so the
 * pair is a true PK-prefix seek rather than a scan — binding `session_id`
 * alone would leave the prefix unconstrained and ClickHouse could not seek at
 * all.
 *
 * The `workspace_id` bind is also the tenant boundary: without it a foreign
 * session id would read another workspace's rows. Callers whose batch spans
 * workspaces must group by workspace and call once per group; the signals
 * caller already groups that way to resolve each workspace's OWN conversion
 * and intent patterns.
 */
export async function aggregateSignalsForSessions(opts: {
  workspaceId: number;
  sessionIds: number[];
  slowApiMs: number;
  conversionRe?: string;
  intentRe?: string;
}): Promise<SessionSignalAgg[]> {
  if (opts.sessionIds.length === 0) {
    return [];
  }
  // Per-workspace conversion/intent patterns (the caller derives them from the
  // workspace's OWN funnel goals — so "conversion" means what it means for THAT
  // product, not a hardcoded store pattern). Falls back to the generic defaults
  // only when a caller passes nothing. The caller is responsible for passing a
  // RE2-safe alternation (funnel event names, escaped).
  const conversionRe = opts.conversionRe ?? CONVERSION_PATTERN;
  const intentRe = opts.intentRe ?? CONVERSION_INTENT_PATTERN;
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        session_id,
        countIf(kind = 'network' AND status_code >= 500) AS backend_failures,
        countIf(kind = 'network' AND duration_ms >= {slowMs:UInt32}) AS slow_apis,
        countIf(kind = 'error' AND error IN ('crash', 'signal', 'uncaught', 'promise')) AS crashes,
        countIf(kind = 'custom' AND level = 'input') AS inputs,
        countIf(kind = 'custom' AND level = 'track' AND match(lower(message), '${conversionRe}')) AS conversions,
        countIf(kind = 'custom' AND level = 'track' AND match(lower(message), '${intentRe}')) AS intents,
        argMaxIf(url, status_code, kind = 'network' AND status_code >= 500) AS worst_fail_url,
        argMaxIf(url, duration_ms, kind = 'network' AND duration_ms >= {slowMs:UInt32}) AS worst_slow_url,
        argMaxIf(route, offset_ms, level = 'rage') AS rage_route,
        argMaxIf(ui_value, offset_ms, level = 'rage') AS rage_element,
        countIf(level = 'dead_click') AS dead_clicks,
        argMaxIf(coalesce(nullIf(ui_value, ''), JSONExtractString(raw, 'selector')), offset_ms, level = 'dead_click') AS dead_element,
        argMaxIf(route, offset_ms, level = 'dead_click') AS dead_route
      FROM replay.session_events
      WHERE workspace_id = {workspaceId:UInt32}
        AND session_id IN {sessionIds:Array(UInt32)}
      GROUP BY session_id`,
    format: "JSONEachRow",
    query_params: {
      workspaceId: opts.workspaceId,
      sessionIds: opts.sessionIds,
      slowMs: Math.max(0, Math.floor(opts.slowApiMs)),
    },
  });
  const rows = (await result.json()) as Array<{
    session_id: number;
    backend_failures: string;
    slow_apis: string;
    crashes: string;
    inputs: string;
    conversions: string;
    intents: string;
    worst_fail_url: string;
    worst_slow_url: string;
    rage_route: string;
    rage_element: string;
    dead_clicks: string;
    dead_element: string;
    dead_route: string;
  }>;
  return rows.map((r) => ({
    session_id: Number(r.session_id),
    backend_failures: Number(r.backend_failures),
    slow_apis: Number(r.slow_apis),
    crashes: Number(r.crashes),
    inputs: Number(r.inputs),
    conversions: Number(r.conversions),
    intents: Number(r.intents),
    worst_fail_url: r.worst_fail_url ?? "",
    worst_slow_url: r.worst_slow_url ?? "",
    rage_route: r.rage_route ?? "",
    rage_element: r.rage_element ?? "",
    dead_clicks: Number(r.dead_clicks),
    dead_element: r.dead_element ?? "",
    dead_route: r.dead_route ?? "",
  }));
}

/** One raw error/crash event, as needed to compute an Issue fingerprint. */
export interface SessionErrorEvent {
  session_id: number;
  /** 1 = FATAL crash — every unhandled variant: 'crash', native 'signal'
   *  (SIGSEGV…), 'uncaught' JS, or 'promise' rejection. 0 = handled/non-fatal:
   *  the caught 'exception' (captureException) or a plain web 'error'. (Was
   *  'crash' alone, which undercounted native + JS crashes.) */
  is_crash: number;
  /** The raw `error` discriminator slug ('crash'|'signal'|'uncaught'|'promise'|
   *  'exception'|'error') — lets the caller derive the fine-grained errorClass. */
  error_kind: string;
  message: string;
  stack: string;
  /** Route (native) or URL (web) it fired on — for display, not grouping. */
  screen: string;
  release: string;
  /** Structured extras the web SDK ships inside `raw`; empty on legacy /
   *  mobile events (the fingerprinter then parses `stack`). */
  name: string;
  frames_json: string;
  /** Event time in ms. */
  timestamp: number;
}

/** One failing/slow request, rolled up per session + endpoint. */
export interface FailingNetworkRow {
  session_id: number;
  method: string;
  url: string;
  status_code: number;
  /** Worst (highest) duration seen for this session+method+url+status. */
  duration_ms: number;
  /** How many times that session hit it. */
  hits: number;
}

/**
 * The failing / slow requests inside a batch of sessions, already GROUPED —
 * the network half of the evidence behind an incident investigation.
 *
 * Access pattern: ONE query, `WHERE workspace_id = ? AND session_id IN (…) AND
 * kind = 'network' AND (status_code >= 500 OR duration_ms >= slowMs)`.
 * `workspace_id` is the LEADING column of the `session_events` ORDER BY key
 * `(workspace_id, session_id, sequence, timestamp)` and `session_id` is the
 * second, so the pair is a true PK-prefix seek rather than a scan — binding
 * `session_id` alone would leave the prefix unconstrained and ClickHouse could
 * not seek at all. Aggregation happens IN ClickHouse, so rows returned are
 * distinct (session, endpoint) pairs bounded by `limit`, never raw events.
 * Never called per session.
 */
export async function failingNetworkForSessions(opts: {
  workspaceId: number;
  sessionIds: number[];
  slowMs?: number;
  limit?: number;
}): Promise<FailingNetworkRow[]> {
  if (opts.sessionIds.length === 0) {
    return [];
  }
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        session_id,
        method,
        url,
        status_code,
        -- Aliased worst_duration_ms, NOT duration_ms. Naming the aggregate after
        -- the column it aggregates makes ClickHouse resolve the WHERE clause's
        -- bare \`duration_ms\` to this alias instead of the raw column, and an
        -- aggregate in WHERE is illegal:
        --   "Aggregate function max(duration_ms) AS duration_ms is found in WHERE"
        -- which 500s the whole investigation report. Keep the names distinct.
        max(duration_ms) AS worst_duration_ms,
        count()          AS hits
      FROM replay.session_events
      WHERE workspace_id = {workspaceId:UInt32}
        AND session_id IN {sessionIds:Array(UInt32)}
        AND kind = 'network'
        AND (status_code >= 500 OR duration_ms >= {slowMs:UInt32})
      GROUP BY session_id, method, url, status_code
      ORDER BY session_id ASC, status_code DESC, worst_duration_ms DESC
      LIMIT {limit:UInt32}`,
    format: "JSONEachRow",
    query_params: {
      workspaceId: opts.workspaceId,
      sessionIds: opts.sessionIds,
      slowMs: opts.slowMs ?? 3000,
      limit: Math.min(Math.max(opts.limit ?? 60, 1), 500),
    },
  });
  const rows = (await result.json()) as Array<{
    session_id: number;
    method: string;
    url: string;
    status_code: number;
    worst_duration_ms: number;
    hits: number;
  }>;
  return rows.map((r) => ({
    session_id: Number(r.session_id),
    method: r.method ?? "",
    url: r.url ?? "",
    status_code: Number(r.status_code),
    // maps back to the interface's duration_ms — the SQL alias differs on purpose
    duration_ms: Number(r.worst_duration_ms),
    hits: Number(r.hits),
  }));
}

/**
 * Read the individual error/crash events for a set of sessions, with just
 * the columns Issue-fingerprinting needs. One query for the whole batch —
 * never a per-session loop.
 *
 * Access pattern: ONE query, `WHERE workspace_id = ? AND session_id IN (…)
 * AND kind = 'error'`. `workspace_id` is the LEADING column of the
 * `session_events` ORDER BY key `(workspace_id, session_id, sequence,
 * timestamp)` and `session_id` is the second, so the pair is a true PK-prefix
 * seek rather than a scan — binding `session_id` alone would leave the prefix
 * unconstrained and ClickHouse could not seek at all. Result size is bounded
 * by the (small) number of error events across the batch.
 *
 * The `workspace_id` bind is also the tenant boundary: without it a foreign
 * session id would read another workspace's rows. Callers whose batch spans
 * workspaces must group by workspace and call once per group.
 */
export async function errorEventsForSessions(opts: {
  workspaceId: number;
  sessionIds: number[];
}): Promise<SessionErrorEvent[]> {
  if (opts.sessionIds.length === 0) {
    return [];
  }
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        session_id,
        if(error IN ('crash', 'signal', 'uncaught', 'promise'), 1, 0) AS is_crash,
        error AS error_kind,
        message,
        stack,
        if(route != '', route, url) AS screen,
        release,
        JSONExtractString(raw, 'name') AS name,
        JSONExtractRaw(raw, 'frames') AS frames_json,
        timestamp
      FROM replay.session_events
      WHERE workspace_id = {workspaceId:UInt32}
        AND session_id IN {sessionIds:Array(UInt32)}
        AND kind = 'error'
      ORDER BY session_id, timestamp`,
    format: "JSONEachRow",
    query_params: {
      workspaceId: opts.workspaceId,
      sessionIds: opts.sessionIds,
    },
  });
  const rows = (await result.json()) as Array<{
    session_id: number;
    is_crash: number;
    error_kind: string;
    message: string;
    stack: string;
    screen: string;
    release: string;
    name: string;
    frames_json: string;
    timestamp: string;
  }>;
  return rows.map((r) => ({
    session_id: Number(r.session_id),
    is_crash: Number(r.is_crash),
    error_kind: r.error_kind ?? "error",
    message: r.message ?? "",
    stack: r.stack ?? "",
    screen: r.screen ?? "",
    release: r.release ?? "",
    name: r.name ?? "",
    frames_json: r.frames_json ?? "",
    timestamp: Number(r.timestamp),
  }));
}

/** One UI-freeze (app-not-responding) occurrence, as needed to derive a
 *  freeze Issue. These live in the perf stream (`kind='perf'`,
 *  `method='anr_ms'`), NOT the error stream, so they need their own read. */
export interface SessionAnrEvent {
  session_id: number;
  /** Freeze duration in ms — the ×1000 storage scaling (see the `perf` note at
   *  the top of this file) is undone here so callers get real milliseconds. */
  duration_ms: number;
  /** Main-thread stack captured by the watchdog (Android). '' on iOS and on
   *  any stack-less sample — the fingerprinter then falls back to the route. */
  stack: string;
  /** Route/screen the freeze fired on — the grouping fallback when there's no
   *  stack. */
  screen: string;
  release: string;
  /** Event time in ms. */
  timestamp: number;
}

/**
 * Read the UI-freeze (ANR) occurrences for a batch of sessions, with just the
 * columns freeze-Issue derivation needs. One query for the whole batch — never
 * a per-session loop.
 *
 * Access pattern: ONE query, `WHERE workspace_id = ? AND session_id IN (…) AND
 * kind = 'perf' AND method = 'anr_ms'`. `workspace_id` is the LEADING column of
 * the `session_events` ORDER BY key `(workspace_id, session_id, sequence,
 * timestamp)` and `session_id` is the second, so the (workspace, sessions) pair
 * is a true PK-prefix seek, not a scan; the `kind`/`method` predicates then
 * filter the tiny per-session slice. Result size is bounded by the (small)
 * number of freezes across the batch. The `workspace_id` bind is also the
 * tenant boundary — callers whose batch spans workspaces group by workspace
 * and call once per group (same contract as errorEventsForSessions).
 */
export async function anrEventsForSessions(opts: {
  workspaceId: number;
  sessionIds: number[];
}): Promise<SessionAnrEvent[]> {
  if (opts.sessionIds.length === 0) {
    return [];
  }
  const client = getClickHouseClient();
  const result = await client.query({
    query: `
      SELECT
        session_id,
        intDiv(duration_ms, 1000) AS duration_ms,
        stack,
        if(route != '', route, url) AS screen,
        release,
        timestamp
      FROM replay.session_events
      WHERE workspace_id = {workspaceId:UInt32}
        AND session_id IN {sessionIds:Array(UInt32)}
        AND kind = 'perf'
        AND method = 'anr_ms'
      ORDER BY session_id, timestamp`,
    format: "JSONEachRow",
    query_params: {
      workspaceId: opts.workspaceId,
      sessionIds: opts.sessionIds,
    },
  });
  const rows = (await result.json()) as Array<{
    session_id: number;
    duration_ms: number;
    stack: string;
    screen: string;
    release: string;
    timestamp: string;
  }>;
  return rows.map((r) => ({
    session_id: Number(r.session_id),
    duration_ms: Number(r.duration_ms),
    stack: r.stack ?? "",
    screen: r.screen ?? "",
    release: r.release ?? "",
    timestamp: Number(r.timestamp),
  }));
}

/* ===========================================================================
   ANALYTICS SECTION (/v1/analytics) — set-based ClickHouse readers for the
   Trends / Retention / Web-Vitals / Breakdowns / Events explorer. Every query
   here leads its WHERE with `workspace_id = {ws}` (the ORDER BY prefix on all
   three tables) and bounds `datetime`/`timestamp` to the requested window (the
   day PARTITION key), so each read is a tenant-bounded, partition-pruned range
   scan — one grouped pass, no per-row / per-bucket loop, scales to millions.
   =========================================================================== */

/**
 * Marketing "Channel" — the bucket growth teams actually live in, DERIVED from
 * the utm_* tags + the browser referrer, using the standard marketing-channel
 * grouping. A fixed whitelist SQL
 * expression (no user string ever reaches it). It ALWAYS classifies — every
 * session has a channel, including 'Direct' — so it never folds to 'Unknown'.
 * Precedence: explicit paid/email/social utm_medium → any utm present
 * (Campaign) → search/social referrer → empty referrer (Direct) → else Referral.
 */
const CHANNEL_EXPR = `multiIf(
  lower(utm_medium) IN ('cpc','ppc','paid','paidsearch','paid-search','cpm','display'), 'Paid',
  lower(utm_medium) IN ('email','newsletter','e-mail'), 'Email',
  lower(utm_medium) IN ('social','social-media','social-network','sm','paid-social'), 'Social',
  utm_source != '' OR utm_medium != '' OR utm_campaign != '', 'Campaign',
  match(lower(domain(referrer)), 'google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|brave'), 'Organic Search',
  match(lower(domain(referrer)), 'facebook|twitter|linkedin|instagram|reddit|youtube|pinterest|tiktok|t\\\\.co|x\\\\.com'), 'Social',
  referrer = '', 'Direct',
  'Referral')`;

// The clean referring HOST from the raw `referrer` column (unqualified, so it
// works inside any single-table replay.sessions scan): prepend a scheme when the
// stored value is a bare host so domain() resolves, cutWWW folds www.x → x, and
// lowerUTF8 case-folds so Host and host don't split. Shared by the funnel
// breakdown's computed ref_domain column.
const REFERRER_DOMAIN_EXPR = `lowerUTF8(cutWWW(domain(if(referrer != '' AND position(referrer, '://') = 0, concat('http://', referrer), referrer))))`;

/** Breakdown dimension → replay.sessions column OR derived expression (whitelist
 *  — the ONLY value ever interpolated into the SQL, so it can never carry a user
 *  string). */
const ANALYTICS_BREAKDOWN_COLS = new Map<string, string>([
  ["browser", "browser"],
  ["country", "country"],
  ["device", "device"],
  ["deviceModel", "device_model"],
  ["os", "os"],
  ["osVersion", "os_version"],
  ["platform", "platform"],
  ["plan", "plan"],
  ["release", "release"],
  ["path", "start_path"],
  ["referrer", "referrer"],
  // Referring domain: the host of the browser referrer ("www.google.com"), a
  // cleaner cut than the full landing URL. domain('') = '' so empty still folds
  // to 'Unknown'. A fixed whitelist expression — never a user string.
  ["referrerDomain", "domain(referrer)"],
  // Marketing attribution the marketer declares on the link, already captured
  // at session start (parseUtm) and stored on replay.sessions. Distinct from
  // `referrer` (the browser-observed path) — a session can be referrer=google
  // yet utm_source=<campaign>, and the utm* is the intended source.
  ["utmSource", "utm_source"],
  ["utmMedium", "utm_medium"],
  ["utmCampaign", "utm_campaign"],
  ["channel", CHANNEL_EXPR],
]);
export const ANALYTICS_BREAKDOWN_DIMENSIONS: string[] = [
  ...ANALYTICS_BREAKDOWN_COLS.keys(),
];

export type AnalyticsBreakdownMeasure = "sessions" | "users";
export type AnalyticsBreakdownRow = { key: string; count: number; prev: number };

/**
 * One dimension's distribution for the Breakdowns section: the top-N bands by
 * the current-window measure (the tail folded into 'Other', empty into
 * 'Unknown') with, in the SAME scan, the equivalent PRIOR-window count for the
 * period-over-period delta.
 *
 * Access pattern & why it scales: both reads are `workspace_id = {ws}` (ORDER BY
 * prefix → tenant range) and bounded on `datetime` (day PARTITION → only the
 * window's partitions are touched). The top-N bands are chosen by an inline
 * subquery over the current window and folded via `has(top_bands, dim)` — a set
 * membership evaluated once, NOT a per-value loop (no N+1). `users` uses
 * uniqExact (HLL, bounded memory) and the Other/Unknown fold happens IN SQL so
 * uniques are never summed. Two partition-pruned grouped passes total.
 */
export async function analyticsBreakdown(opts: {
  workspaceId: number;
  dimension: string;
  measure: AnalyticsBreakdownMeasure;
  sinceMs: number;
  untilMs: number;
  priorSinceMs: number;
  priorUntilMs: number;
  topN?: number;
}): Promise<AnalyticsBreakdownRow[]> {
  const col = ANALYTICS_BREAKDOWN_COLS.get(opts.dimension);
  if (!col) return [];
  const client = getClickHouseClient();
  const topN = Math.max(1, Math.min(50, Math.floor(opts.topN ?? 12)));
  const users = opts.measure === "users";
  // current-window band ranking (excludes empty — empty always folds to Unknown)
  const rankAgg = users ? `uniqExact(${ACT_UID_EXPR})` : `count()`;
  const curAgg = users ? `uniqExactIf(uid, in_cur)` : `countIf(in_cur)`;
  const prevAgg = users ? `uniqExactIf(uid, in_prev)` : `countIf(in_prev)`;

  const sql = `
    SELECT multiIf(dim = '', 'Unknown', has(top_bands, dim), dim, 'Other') AS key,
           ${curAgg} AS count,
           ${prevAgg} AS prev
    FROM (
      SELECT ${col} AS dim, ${ACT_UID_EXPR} AS uid,
             (datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}) AS in_cur,
             (datetime >= {priorSinceMs:UInt64} AND datetime < {priorUntilMs:UInt64}) AS in_prev
      FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32}
        AND datetime >= {priorSinceMs:UInt64} AND datetime < {untilMs:UInt64}
    ) AS base
    CROSS JOIN (
      SELECT groupArray(band) AS top_bands FROM (
        SELECT ${col} AS band, ${rankAgg} AS v
        FROM replay.sessions FINAL
        WHERE workspace_id = {ws:UInt32}
          AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}
          AND ${col} != ''
        GROUP BY band ORDER BY v DESC, band ASC LIMIT {topN:UInt32}
      )
    ) AS ranked
    GROUP BY key
    ORDER BY count DESC, key ASC`;

  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: {
      ws: opts.workspaceId,
      sinceMs: Math.floor(opts.sinceMs),
      untilMs: Math.floor(opts.untilMs),
      priorSinceMs: Math.floor(opts.priorSinceMs),
      priorUntilMs: Math.floor(opts.priorUntilMs),
      topN,
    },
  });
  const rows = (await res.json()) as Array<{
    key: string;
    count: string;
    prev: string;
  }>;
  return rows.map((r) => ({
    key: r.key,
    count: Number(r.count),
    prev: Number(r.prev),
  }));
}

/* ---- Trends: arbitrary metric time-series (with breakdown / filters) ------- */

/** Trends filter key → replay.sessions column (whitelist). */
const ANALYTICS_FILTER_COLS = new Map<string, string>([
  ["urlPath", "start_path"],
  ["referrerUrl", "referrer"],
  ["browser", "browser"],
  ["device", "device"],
  ["os", "os"],
  ["country", "country"],
  ["plan", "plan"],
]);
export const ANALYTICS_FILTER_KEYS: string[] = [...ANALYTICS_FILTER_COLS.keys()];

/** Numeric session property key → column (for sum/avg/median/p95 measures). */
const ANALYTICS_NUMERIC_COLS = new Map<string, string>([
  ["duration", "duration_ms"],
  ["pages", "pages_count"],
  ["errors", "errors_count"],
  ["rage", "rage_count"],
  ["dead", "dead_count"],
]);
export const ANALYTICS_NUMERIC_PROPS: string[] = [...ANALYTICS_NUMERIC_COLS.keys()];

/** Autocaptured pseudo-event token → session_events.kind (whitelist). */
const ANALYTICS_AUTO_EVENT_KINDS = new Set([
  "screen",
  "tap",
  "network",
  "error",
  "console",
  "perf",
]);

/** Compile ONE Trends filter to a bound predicate. `col` is already a whitelist
 *  column; only the operator branches, and the value is a typed placeholder —
 *  no caller string ever reaches the SQL text. */
function analyticsFilterCond(col: string, op: string, p: string): string {
  switch (op) {
    case "isNot":
      return `${col} != {${p}:String}`;
    case "contains":
      return `position(${col}, {${p}:String}) > 0`;
    case "notContains":
      return `position(${col}, {${p}:String}) = 0`;
    case "startsWith":
      return `startsWith(${col}, {${p}:String})`;
    case "endsWith":
      return `endsWith(${col}, {${p}:String})`;
    case "is":
    default:
      return `${col} = {${p}:String}`;
  }
}

export type AnalyticsSeriesSource =
  | { kind: "session" }
  | { kind: "event"; name: string }
  | { kind: "autoEvent"; chKind: string };
export type AnalyticsSeriesMetric =
  | { agg: "count" | "uniqueUsers" }
  | { agg: "sum" | "avg" | "median" | "p95"; prop: string };
export type AnalyticsSeriesFilter = { key: string; op: string; val: string };
export type AnalyticsSeriesRow = {
  bucket: number;
  band: string;
  value: number;
  isTotal: number;
};
export type AnalyticsSeriesResult = { bands: string[]; rows: AnalyticsSeriesRow[] };

/**
 * One Trends series as a time-bucketed grouped scan: per-bucket value plus the
 * window-wide total per band in the SAME pass (GROUPING SETS — a unique/quantile
 * total is NOT the sum of buckets, so it must be measured, not derived).
 *
 * Source: a session pseudo-event (replay.sessions), a named custom event or an
 * autocaptured kind (replay.session_events). `breakdown` splits into the top-N
 * dimension bands (tail → 'Other', empty → 'Unknown') folded IN SQL via a bound
 * array — no per-band query. `bands` pins a fixed band set so a prior/compare
 * window lines up with the current one.
 *
 * Access pattern: every read is `workspace_id = {ws}` (ORDER BY prefix) bounded
 * on datetime/timestamp (day PARTITION), so it prunes to the window's partitions
 * for one tenant — set-based, scales to millions, no N+1.
 */
export async function analyticsSeries(opts: {
  workspaceId: number;
  source: AnalyticsSeriesSource;
  metric: AnalyticsSeriesMetric;
  sinceMs: number;
  untilMs: number;
  bucketMs: number;
  monthly?: boolean;
  filters?: AnalyticsSeriesFilter[];
  breakdown?: string | null;
  topN?: number;
  bands?: string[] | null;
}): Promise<AnalyticsSeriesResult> {
  const client = getClickHouseClient();
  const isEvent = opts.source.kind !== "session";
  const bucketMs = Math.max(1, Math.floor(opts.bucketMs || 86_400_000));
  const topN = Math.max(1, Math.min(12, Math.floor(opts.topN ?? 6)));
  const monthly = !!opts.monthly;

  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
    bucketMs,
  };

  // Resolve filters + breakdown to whitelisted columns (unknowns dropped, so no
  // caller string is ever interpolated).
  const filterConds: string[] = [];
  const neededSessCols = new Set<string>();
  (opts.filters ?? []).forEach((f, i) => {
    const col = ANALYTICS_FILTER_COLS.get(f.key);
    if (!col || f.val == null) return;
    const p = `f${i}`;
    params[p] = f.val;
    neededSessCols.add(col);
    filterConds.push(
      "AND " + analyticsFilterCond(isEvent ? `s.${col}` : col, f.op, p),
    );
  });
  const bcol = opts.breakdown
    ? ANALYTICS_BREAKDOWN_COLS.get(opts.breakdown) ?? null
    : null;
  if (bcol) neededSessCols.add(bcol);

  const numeric = opts.metric.agg !== "count" && opts.metric.agg !== "uniqueUsers";
  const needUser = opts.metric.agg === "uniqueUsers";
  const needJoin =
    isEvent && (needUser || filterConds.length > 0 || !!bcol);

  const uidExpr = isEvent
    ? needJoin
      ? `if(s.user_id != '', s.user_id, if(s.anonymous_id != '', s.anonymous_id, toString(e.session_id)))`
      : `toString(e.session_id)`
    : ACT_UID_EXPR;

  // metric aggregate (numeric measures are session-only; on events → count)
  let agg: string;
  if (opts.metric.agg === "uniqueUsers") {
    agg = `uniqExact(${uidExpr})`;
  } else if (!numeric || isEvent) {
    agg = `count()`;
  } else {
    const col =
      ANALYTICS_NUMERIC_COLS.get((opts.metric as { prop: string }).prop) ??
      "duration_ms";
    switch (opts.metric.agg) {
      case "sum":
        agg = `round(sum(${col}))`;
        break;
      case "avg":
        agg = `round(avgIf(${col}, ${col} > 0))`;
        break;
      case "median":
        agg = `round(quantileExact(0.5)(${col}))`;
        break;
      case "p95":
      default:
        agg = `round(quantileExact(0.95)(${col}))`;
        break;
    }
  }

  const tsCol = isEvent ? "e.timestamp" : "datetime";
  const bucketExpr = monthly
    ? `toInt64(toUnixTimestamp(toStartOfMonth(toDateTime(intDiv(${tsCol}, 1000))))) * 1000`
    : `intDiv(${tsCol}, {bucketMs:UInt64}) * {bucketMs:UInt64}`;

  // FROM + base WHERE (tenant + window; event predicate; optional sessions join)
  let from: string;
  let where: string;
  if (isEvent) {
    let evWhere =
      `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64} AND e.timestamp < {untilMs:UInt64}`;
    if (opts.source.kind === "event") {
      params.evName = opts.source.name;
      evWhere += ` AND e.kind = 'custom' AND e.level = 'track' AND e.message = {evName:String}`;
    } else if (opts.source.kind === "autoEvent") {
      const chKind = ANALYTICS_AUTO_EVENT_KINDS.has(opts.source.chKind)
        ? opts.source.chKind
        : "screen";
      params.chKind = chKind;
      evWhere += ` AND e.kind = {chKind:String}`;
    }
    if (needJoin) {
      const cols = ["session_id", "user_id", "anonymous_id", ...neededSessCols].join(
        ", ",
      );
      from =
        `replay.session_events e INNER JOIN (` +
        `SELECT ${cols} FROM replay.sessions FINAL ` +
        `WHERE workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}` +
        `) AS s ON e.session_id = s.session_id`;
    } else {
      from = `replay.session_events e`;
    }
    where = evWhere + " " + filterConds.join(" ");
  } else {
    from = `replay.sessions FINAL`;
    where =
      `workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64} ` +
      filterConds.join(" ");
  }

  // Band expression — breakdown → top-N dimension value; else a single 'total'.
  const bandCol = bcol ? (isEvent && needJoin ? `s.${bcol}` : bcol) : null;
  let bandExpr = `'total'`;
  if (bandCol) {
    let bands = opts.bands ?? null;
    if (!bands) {
      const rankAgg =
        opts.metric.agg === "uniqueUsers" ? `uniqExact(${uidExpr})` : `count()`;
      const rankSql =
        `SELECT ${bandCol} AS band, ${rankAgg} AS v FROM ${from} ` +
        `WHERE ${where} AND ${bandCol} != '' GROUP BY band ` +
        `ORDER BY v DESC, band ASC LIMIT {topN:UInt32}`;
      const rr = await client.query({
        query: rankSql,
        format: "JSONEachRow",
        query_params: { ...params, topN },
      });
      bands = ((await rr.json()) as Array<{ band: string }>).map((r) => r.band);
    }
    params.bands = bands;
    bandExpr = `multiIf(${bandCol} = '', 'Unknown', has({bands:Array(String)}, ${bandCol}), ${bandCol}, 'Other')`;
  }

  const sql = `
    SELECT ${bucketExpr} AS bucket, ${bandExpr} AS band, ${agg} AS value,
           grouping(bucket) AS is_total
    FROM ${from}
    WHERE ${where}
    GROUP BY GROUPING SETS ((bucket, band), (band))
    ORDER BY is_total ASC, bucket ASC`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const raw = (await res.json()) as Array<Record<string, unknown>>;

  const bandSet = new Set<string>();
  const rows: AnalyticsSeriesRow[] = raw.map((r) => {
    const band = String(r.band);
    bandSet.add(band);
    return {
      bucket: Number(r.bucket),
      band,
      value: Number(r.value),
      isTotal: Number(r.is_total),
    };
  });
  return { bands: [...bandSet], rows };
}

/* ---- Retention: first-activity cohort × return-offset grid ---------------- */

export type AnalyticsRetentionResult = {
  /** distinct users first-seen in each cohort period (the denominator). */
  sizes: { cohort: number; size: number }[];
  /** distinct users active at each offset within [0, cols). */
  cells: { cohort: number; offset: number; users: number }[];
};

/**
 * Cohort-retention grid: users are cohorted by the period of their FIRST
 * activity (first_seen_at), then counted at each subsequent return offset. Two
 * partition-pruned passes — cohort sizes (the denominator) and per-offset active
 * users — because the size must count ALL first-seen users while the cells are
 * bounded to [0, cols); a single WHERE can't do both without undercounting.
 *
 * Access pattern: both reads are `workspace_id = {ws}` (ORDER BY prefix) bounded
 * on datetime AND first_seen_at (the cohort must START in-window), so they prune
 * to the window's day-partitions for one tenant. One grouped pass each — the
 * cohort×offset matrix is computed set-based, never a query per cohort.
 */
export async function analyticsRetention(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  gran: "day" | "week" | "month";
  cols: number;
  /** Returning ACTION: null/"any" → any session; else a custom event name — a
   *  user is "retained" in a period only if they fired that event in it. */
  action?: string | null;
}): Promise<AnalyticsRetentionResult> {
  const client = getClickHouseClient();
  const cols = Math.max(2, Math.min(24, Math.floor(opts.cols || 8)));
  const monthly = opts.gran === "month";
  const periodMs = opts.gran === "week" ? 7 * 86_400_000 : 86_400_000;
  const action = opts.action && opts.action !== "any" ? opts.action : null;
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
    periodMs,
    cols,
  };
  if (action) params.action = action;

  // cohort/return bucket from a `first_seen_at`/timestamp column pair.
  const bucketOf = (col: string) =>
    monthly
      ? `toInt64(toUnixTimestamp(toStartOfMonth(toDateTime(intDiv(${col}, 1000))))) * 1000`
      : `intDiv(${col}, {periodMs:UInt64}) * {periodMs:UInt64}`;
  const offsetOf = (cohortCol: string, activeCol: string) =>
    monthly
      ? `dateDiff('month', toStartOfMonth(toDateTime(intDiv(${cohortCol}, 1000))), toStartOfMonth(toDateTime(intDiv(${activeCol}, 1000))))`
      : `intDiv(${activeCol}, {periodMs:UInt64}) - intDiv(${cohortCol}, {periodMs:UInt64})`;

  const base =
    `FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32} ` +
    `AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64} ` +
    `AND first_seen_at >= {sinceMs:UInt64} AND first_seen_at < {untilMs:UInt64}`;

  // cohort SIZE is always the users first-seen in each period, regardless of the
  // returning action (the denominator = who started).
  const sizesSql = `SELECT ${bucketOf("first_seen_at")} AS cohort, uniqExact(${ACT_UID_EXPR}) AS size ${base} GROUP BY cohort ORDER BY cohort DESC`;

  // CELLS: for "any" a session in the period counts; for a specific action the
  // user must have FIRED that event in the period (session_events ⋈ sessions).
  const cellsSql = action
    ? `SELECT cohort, offset, uniqExact(uid) AS users FROM (` +
      `SELECT if(s.user_id != '', s.user_id, if(s.anonymous_id != '', s.anonymous_id, toString(e.session_id))) AS uid, ` +
      `${bucketOf("s.first_seen_at")} AS cohort, ${offsetOf("s.first_seen_at", "e.timestamp")} AS offset ` +
      `FROM replay.session_events e INNER JOIN (` +
      `SELECT session_id, first_seen_at, user_id, anonymous_id FROM replay.sessions FINAL ` +
      `WHERE workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64} ` +
      `AND first_seen_at >= {sinceMs:UInt64} AND first_seen_at < {untilMs:UInt64}) AS s ON e.session_id = s.session_id ` +
      `WHERE e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64} AND e.timestamp < {untilMs:UInt64} ` +
      `AND e.kind = 'custom' AND e.level = 'track' AND e.message = {action:String}` +
      `) WHERE offset >= 0 AND offset < {cols:UInt32} GROUP BY cohort, offset`
    : `SELECT cohort, offset, uniqExact(uid) AS users FROM (` +
      `SELECT ${ACT_UID_EXPR} AS uid, ${bucketOf("first_seen_at")} AS cohort, ${offsetOf("first_seen_at", "datetime")} AS offset ${base}` +
      `) WHERE offset >= 0 AND offset < {cols:UInt32} GROUP BY cohort, offset`;

  const [sr, cr] = await Promise.all([
    client.query({ query: sizesSql, format: "JSONEachRow", query_params: params }),
    client.query({ query: cellsSql, format: "JSONEachRow", query_params: params }),
  ]);
  const sizes = ((await sr.json()) as Array<{ cohort: string; size: string }>).map(
    (r) => ({ cohort: Number(r.cohort), size: Number(r.size) }),
  );
  const cells = (
    (await cr.json()) as Array<{ cohort: string; offset: string; users: string }>
  ).map((r) => ({
    cohort: Number(r.cohort),
    offset: Number(r.offset),
    users: Number(r.users),
  }));
  return { sizes, cells };
}

/* ---- Web Vitals: per-page LCP/INP/CLS/FCP/TTFB (CH-native) ----------------- */

const WV_METRIC_KEYS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type WvMetricKey = (typeof WV_METRIC_KEYS)[number];
export const WV_METRICS: readonly string[] = WV_METRIC_KEYS;

export type AnalyticsWebVitalCell = {
  n: number;
  value: number;
  good: number;
  poor: number;
};
export type AnalyticsWebVitalRow = {
  path: string;
  isTotal: number;
  metrics: Record<string, AnalyticsWebVitalCell>;
};

/**
 * Core Web Vitals per page — CH-NATIVE from replay.session_events (kind='perf',
 * method=metric, duration_ms=value, level=rating), joined to web sessions for
 * the page path + device filter. One grouped pass with GROUPING SETS gives the
 * top pages AND the pageview-weighted summary row together (the p75 over all
 * samples = the summary; every sample is one measured pageview). Web-only
 * (platform='web'); native mobile sessions are excluded.
 *
 * Access pattern: workspace_id leads the sort key on both tables and the
 * timestamp/datetime windows prune day-partitions, so it range-scans one
 * tenant's perf events + sessions — set-based, no per-page query, scales.
 */
export async function analyticsWebVitals(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  device?: "all" | "desktop" | "mobile";
  limit?: number;
}): Promise<AnalyticsWebVitalRow[]> {
  const client = getClickHouseClient();
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 50)));
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
    limit: limit + 1, // + the summary row
  };
  let deviceCond = "";
  if (opts.device === "desktop" || opts.device === "mobile") {
    params.dev = opts.device;
    // Unqualified `device` — this predicate lives INSIDE the sessions subquery,
    // where the `s` alias (which names the subquery result) is not yet in scope;
    // `s.device` here throws UNKNOWN_IDENTIFIER and empties the whole result.
    deviceCond = " AND lower(device) = {dev:String}";
  }

  // method literals come from the fixed WV_METRIC_KEYS constant — never a caller
  // string — so they are safe to interpolate.
  const cols = WV_METRIC_KEYS.flatMap((m) => [
    `countIf(method = '${m}') AS ${m}_n`,
    `round(quantileExactIf(0.75)(duration_ms, method = '${m}')) AS ${m}_v`,
    `countIf(method = '${m}' AND level = 'good') AS ${m}_g`,
    `countIf(method = '${m}' AND level = 'poor') AS ${m}_p`,
  ]);

  const sql = `
    SELECT s.start_path AS path, grouping(s.start_path) AS is_total, ${cols.join(", ")}
    FROM replay.session_events e
    INNER JOIN (
      SELECT session_id, start_path, device FROM replay.sessions FINAL
      WHERE workspace_id = {ws:UInt32}
        AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}
        AND platform = 'web'${deviceCond}
    ) AS s ON e.session_id = s.session_id
    WHERE e.workspace_id = {ws:UInt32}
      AND e.timestamp >= {sinceMs:UInt64} AND e.timestamp < {untilMs:UInt64}
      AND e.kind = 'perf' AND e.method IN ('lcp','inp','cls','fcp','ttfb')
    GROUP BY GROUPING SETS ((path), ())
    ORDER BY is_total DESC, lcp_n DESC
    LIMIT {limit:UInt32}`;
  const res = await client.query({
    query: sql,
    format: "JSONEachRow",
    query_params: params,
  });
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((r) => {
    const metrics: Record<string, AnalyticsWebVitalCell> = {};
    for (const m of WV_METRIC_KEYS) {
      metrics[m] = {
        n: Number(r[`${m}_n`] ?? 0),
        value: Number(r[`${m}_v`] ?? 0),
        good: Number(r[`${m}_g`] ?? 0),
        poor: Number(r[`${m}_p`] ?? 0),
      };
    }
    return { path: String(r.path ?? ""), isTotal: Number(r.is_total), metrics };
  });
}

/* ---- Events & properties catalogue ---------------------------------------- */

export type AnalyticsEventCatalogRow = {
  name: string;
  grp: "custom" | "auto";
  occ: number;
  sess: number;
  last: number;
  /** Daily occurrence sparkline over the window (one point per day). */
  trend: number[];
};

/**
 * Event catalogue: named custom (replay.track) events + the autocaptured kinds,
 * each with occurrences, distinct sessions, last-seen and a REAL daily-occurrence
 * sparkline. Four partition-pruned grouped passes (custom by message, autocaptured
 * by kind, total sessions for the seen-% denominator, and per-(event,day) counts
 * for the trend) — never a query per event.
 */
export async function analyticsEventCatalog(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  limit?: number;
}): Promise<{ events: AnalyticsEventCatalogRow[]; totalSessions: number }> {
  const client = getClickHouseClient();
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const sinceMs = Math.floor(opts.sinceMs);
  const untilMs = Math.floor(opts.untilMs);
  const params = { ws: opts.workspaceId, sinceMs, untilMs, limit };
  const evWindow = `workspace_id = {ws:UInt32} AND timestamp >= {sinceMs:UInt64} AND timestamp < {untilMs:UInt64}`;
  const customSql =
    `SELECT message AS name, 'custom' AS grp, count() AS occ, uniqExact(session_id) AS sess, max(timestamp) AS last ` +
    `FROM replay.session_events WHERE ${evWindow} AND kind = 'custom' AND level = 'track' AND message != '' ` +
    `GROUP BY name ORDER BY occ DESC LIMIT {limit:UInt32}`;
  const autoSql =
    `SELECT kind AS name, 'auto' AS grp, count() AS occ, uniqExact(session_id) AS sess, max(timestamp) AS last ` +
    `FROM replay.session_events WHERE ${evWindow} AND kind IN ('screen','tap','network','error','console') ` +
    `GROUP BY kind ORDER BY occ DESC`;
  const totSql = `SELECT count() AS c FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}`;
  // per-(event, day) daily counts in ONE scan — name is the message (custom) or
  // the kind (autocaptured); grp keeps the two namespaces apart.
  const trendSql =
    `SELECT multiIf(kind = 'custom' AND level = 'track', message, kind) AS name, ` +
    `if(kind = 'custom' AND level = 'track', 'custom', 'auto') AS grp, ` +
    `intDiv(timestamp, 86400000) * 86400000 AS day, count() AS c ` +
    `FROM replay.session_events WHERE ${evWindow} AND ` +
    `((kind = 'custom' AND level = 'track' AND message != '') OR kind IN ('screen','tap','network','error','console')) ` +
    `GROUP BY name, grp, day`;

  const [cr, ar, tr, dr] = await Promise.all([
    client.query({ query: customSql, format: "JSONEachRow", query_params: params }),
    client.query({ query: autoSql, format: "JSONEachRow", query_params: params }),
    client.query({ query: totSql, format: "JSONEachRow", query_params: params }),
    client.query({ query: trendSql, format: "JSONEachRow", query_params: params }),
  ]);

  // day grid for the sparkline (one slot per day of the window)
  const dayMs = 86_400_000;
  const startDay = Math.floor(sinceMs / dayMs) * dayMs;
  const nDays = Math.max(1, Math.min(90, Math.ceil((untilMs - startDay) / dayMs)));
  const trendMap = new Map<string, number[]>();
  for (const r of (await dr.json()) as Array<{ name: string; grp: string; day: string; c: string }>) {
    const key = r.grp + ":" + r.name;
    let arr = trendMap.get(key);
    if (!arr) {
      arr = new Array(nDays).fill(0);
      trendMap.set(key, arr);
    }
    const i = Math.floor((Number(r.day) - startDay) / dayMs);
    if (i >= 0 && i < nDays) arr[i] = Number(r.c);
  }

  const parse = (rows: Array<Record<string, unknown>>): AnalyticsEventCatalogRow[] =>
    rows.map((r) => {
      const grp = r.grp === "auto" ? "auto" : ("custom" as const);
      const name = String(r.name ?? "");
      return {
        name,
        grp,
        occ: Number(r.occ ?? 0),
        sess: Number(r.sess ?? 0),
        last: Number(r.last ?? 0),
        trend: trendMap.get(grp + ":" + name) ?? new Array(nDays).fill(0),
      };
    });
  const custom = parse((await cr.json()) as Array<Record<string, unknown>>);
  const auto = parse((await ar.json()) as Array<Record<string, unknown>>);
  const totalSessions = Number(
    (((await tr.json()) as Array<{ c: string }>)[0]?.c ?? 0),
  );
  return { events: [...auto, ...custom], totalSessions };
}

/** Session/person properties the analytics UI can enumerate (key → column). */
const ANALYTICS_PROPERTY_COLS = new Map<string, string>([
  ["browser", "browser"],
  ["os", "os"],
  ["device", "device"],
  ["deviceModel", "device_model"],
  ["country", "country"],
  ["plan", "plan"],
  ["referrer", "referrer"],
  ["urlPath", "start_path"],
  ["utmSource", "utm_source"],
  ["utmMedium", "utm_medium"],
  ["utmCampaign", "utm_campaign"],
  ["release", "release"],
]);
export const ANALYTICS_PROPERTY_KEYS: string[] = [
  ...ANALYTICS_PROPERTY_COLS.keys(),
];

export type AnalyticsPropertyRow = {
  key: string;
  volume: number;
  lastSeen: number;
  values: { value: string; count: number }[];
};

/**
 * Property catalogue: for each whitelisted session/person property, the count of
 * sessions carrying it, the most-recent occurrence and its top values. One
 * partition-pruned grouped pass per property, run concurrently (Promise.all —
 * never a sequential loop). Every property is a fixed column from the whitelist,
 * so nothing caller-supplied is interpolated.
 */
export async function analyticsProperties(opts: {
  workspaceId: number;
  sinceMs: number;
  untilMs: number;
  topValues?: number;
}): Promise<AnalyticsPropertyRow[]> {
  const client = getClickHouseClient();
  const topValues = Math.max(1, Math.min(50, Math.floor(opts.topValues ?? 12)));
  const params = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
    untilMs: Math.floor(opts.untilMs),
    lim: topValues + 1, // + the window-total (GROUPING SETS) row
  };
  const base = `FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32} AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}`;

  const rows = await Promise.all(
    [...ANALYTICS_PROPERTY_COLS.entries()].map(async ([key, col]) => {
      // top values + a window-total row (GROUPING SETS) in one pass per property
      const sql =
        `SELECT ${col} AS value, uniqExact(session_id) AS count, max(datetime) AS last, grouping(${col}) AS is_total ` +
        `${base} AND ${col} != '' ` +
        `GROUP BY GROUPING SETS ((value), ()) ORDER BY is_total DESC, count DESC LIMIT {lim:UInt32}`;
      const res = await client.query({
        query: sql,
        format: "JSONEachRow",
        query_params: params,
      });
      const raw = (await res.json()) as Array<Record<string, unknown>>;
      let volume = 0;
      let lastSeen = 0;
      const values: { value: string; count: number }[] = [];
      for (const r of raw) {
        if (Number(r.is_total) === 1) {
          volume = Number(r.count ?? 0);
          lastSeen = Number(r.last ?? 0);
        } else {
          values.push({ value: String(r.value ?? ""), count: Number(r.count ?? 0) });
        }
      }
      return { key, volume, lastSeen, values };
    }),
  );
  return rows;
}

/* ---- Funnel influence: events & properties correlated with conversion ----- */

export type FunnelInfluenceFeature = {
  kind: "event" | "property";
  label: string;
  prop?: string;
  value?: string;
  withTotal: number;
  withConv: number;
};
export type FunnelInfluenceResult = {
  entered: number;
  converted: number;
  features: FunnelInfluenceFeature[];
};

/** Session columns tested for conversion influence (unpivoted via ARRAY JOIN). */
const INFLUENCE_PROP_COLS: [string, string][] = [
  ["browser", "browser"],
  ["country", "country"],
  ["device", "device"],
  ["os", "os"],
  ["plan", "plan"],
  ["referrer", "referrer"],
  ["deviceModel", "device_model"],
];

/**
 * "What's influencing conversion" — the events and person-properties most
 * correlated with COMPLETING a funnel. Reuses the funnel's own step conditions
 * (buildFunnelConds) + saved segment (buildSegmentConds) to compute a per-session
 * conversion flag once (windowFunnel `conv` CTE), then measures each candidate
 * feature's with-vs-without conversion in bounded feature-presence passes:
 *   1) baseline entered/converted,
 *   2) events  — DISTINCT (session, custom-event) joined to conv,
 *   3) props   — session dimensions unpivoted (ARRAY JOIN) joined to conv.
 * Candidates are floored at `minSupport` (HAVING) and capped at `topN` so the
 * scan is bounded — never an enumerate-everything or a query-per-candidate loop.
 *
 * Access pattern: every pass is `workspace_id = {ws}` + the funnel time window
 * (day PARTITION prune), so it range-scans one tenant's events/sessions — three
 * grouped windowFunnel/JOIN passes total, scales to millions.
 */
export async function funnelInfluence(opts: {
  workspaceId: number;
  steps: FunnelStepCond[];
  windowMs: number;
  sinceMs: number;
  untilMs?: number;
  segment?: FunnelSegment;
  topN?: number;
}): Promise<FunnelInfluenceResult> {
  const client = getClickHouseClient();
  const n = opts.steps.length;
  const topN = Math.max(4, Math.min(60, Math.floor(opts.topN ?? 40)));
  const windowMs = Math.max(1000, Math.floor(opts.windowMs));
  const params: Record<string, unknown> = {
    ws: opts.workspaceId,
    sinceMs: Math.floor(opts.sinceMs),
  };
  const conds = buildFunnelConds(opts.steps, params, "e.");
  const segConds = opts.segment ? buildSegmentConds(opts.segment, params) : [];
  let evWhere = `e.workspace_id = {ws:UInt32} AND e.timestamp >= {sinceMs:UInt64}`;
  const winSess = opts.untilMs
    ? `AND datetime >= {sinceMs:UInt64} AND datetime < {untilMs:UInt64}`
    : `AND datetime >= {sinceMs:UInt64}`;
  if (opts.untilMs) {
    params.untilMs = Math.floor(opts.untilMs);
    evWhere += ` AND e.timestamp < {untilMs:UInt64}`;
  }
  let convFrom = `replay.session_events AS e`;
  if (segConds.length > 0) {
    convFrom += ` INNER JOIN (SELECT * FROM replay.sessions FINAL WHERE workspace_id = {ws:UInt32} ${winSess}) AS s ON e.session_id = s.session_id`;
    evWhere += ` AND ${segConds.join(" AND ")}`;
  }
  const convCte = `conv AS (SELECT e.session_id AS sid, windowFunnel(${windowMs})(e.timestamp, ${conds.join(", ")}) AS flevel FROM ${convFrom} WHERE ${evWhere} GROUP BY sid)`;

  // 1) baseline entered/converted (needed before the support floor is known)
  const baseSql = `WITH ${convCte} SELECT countIf(flevel >= 1) AS entered, countIf(flevel >= ${n}) AS converted FROM conv`;
  const baseRes = await client.query({
    query: baseSql,
    format: "JSONEachRow",
    query_params: params,
  });
  const base =
    ((await baseRes.json()) as Array<{ entered: string; converted: string }>)[0] ??
    { entered: "0", converted: "0" };
  const entered = Number(base.entered);
  const converted = Number(base.converted);
  if (entered < 2) return { entered, converted, features: [] };

  // Exclude the funnel's OWN step events from the candidate drivers. A step event
  // trivially "correlates" with conversion (it IS part of the funnel), so it would
  // always surface as a 100%/61%… vs 0% driver and drown out the real, actionable
  // signals — the events/properties that are NOT part of the funnel definition.
  const stepEventNames = Array.from(
    new Set(opts.steps.filter((s) => s.kind === "event").map((s) => s.value).filter(Boolean)),
  );
  const stepExcl = stepEventNames.length
    ? " AND e2.message NOT IN {stepEvents:Array(String)}"
    : "";
  const minSupport = Math.max(20, Math.floor(entered * 0.03));
  const p2: Record<string, unknown> = { ...params, minSupport, topN };
  if (stepEventNames.length) p2.stepEvents = stepEventNames;

  const evWindow2 = opts.untilMs
    ? `e2.workspace_id = {ws:UInt32} AND e2.timestamp >= {sinceMs:UInt64} AND e2.timestamp < {untilMs:UInt64}`
    : `e2.workspace_id = {ws:UInt32} AND e2.timestamp >= {sinceMs:UInt64}`;
  const eventsSql =
    `WITH ${convCte} ` +
    `SELECT f.message AS feature, count() AS with_total, countIf(c.flevel >= ${n}) AS with_conv ` +
    `FROM (SELECT DISTINCT e2.session_id AS sid, e2.message FROM replay.session_events e2 ` +
    `WHERE ${evWindow2} AND e2.kind = 'custom' AND e2.level = 'track' AND e2.message != '' AND e2.message NOT LIKE '$%'${stepExcl}) f ` +
    `INNER JOIN conv c ON c.sid = f.sid WHERE c.flevel >= 1 ` +
    `GROUP BY feature HAVING with_total >= {minSupport:UInt32} ORDER BY with_total DESC LIMIT {topN:UInt32}`;

  const tuples = INFLUENCE_PROP_COLS.map(
    ([key, col]) => `('${key}', toString(s2.${col}))`,
  ).join(", ");
  const sessWindow2 = opts.untilMs
    ? `s2.workspace_id = {ws:UInt32} AND s2.datetime >= {sinceMs:UInt64} AND s2.datetime < {untilMs:UInt64}`
    : `s2.workspace_id = {ws:UInt32} AND s2.datetime >= {sinceMs:UInt64}`;
  const propsSql =
    `WITH ${convCte} ` +
    `SELECT p.prop AS prop, p.value AS value, count() AS with_total, countIf(c.flevel >= ${n}) AS with_conv ` +
    `FROM (SELECT s2.session_id AS sid, pv.1 AS prop, pv.2 AS value FROM replay.sessions AS s2 FINAL ARRAY JOIN [${tuples}] AS pv WHERE ${sessWindow2}) p ` +
    `INNER JOIN conv c ON c.sid = p.sid WHERE c.flevel >= 1 AND p.value != '' ` +
    `GROUP BY prop, value HAVING with_total >= {minSupport:UInt32} ORDER BY with_total DESC LIMIT {topN:UInt32}`;

  const [er, pr] = await Promise.all([
    client.query({ query: eventsSql, format: "JSONEachRow", query_params: p2 }),
    client.query({ query: propsSql, format: "JSONEachRow", query_params: p2 }),
  ]);
  const evRows = (await er.json()) as Array<{
    feature: string;
    with_total: string;
    with_conv: string;
  }>;
  const prRows = (await pr.json()) as Array<{
    prop: string;
    value: string;
    with_total: string;
    with_conv: string;
  }>;

  const features: FunnelInfluenceFeature[] = [
    ...evRows.map((r) => ({
      kind: "event" as const,
      label: r.feature,
      withTotal: Number(r.with_total),
      withConv: Number(r.with_conv),
    })),
    ...prRows.map((r) => ({
      kind: "property" as const,
      label: r.value,
      prop: r.prop,
      value: r.value,
      withTotal: Number(r.with_total),
      withConv: Number(r.with_conv),
    })),
  ];
  return { entered, converted, features };
}
