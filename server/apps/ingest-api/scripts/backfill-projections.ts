/**
 * Backfill ClickHouse `replay.session_events` from existing Mongo
 * `ReplayBatch` documents.
 *
 * Why this exists — the Phase A projection added persistence
 * branches for `tap`, `custom`, `screen`, `performance`, and
 * `native_snapshot` events. Sessions ingested BEFORE the new
 * branches landed (or that for any reason skipped the live
 * projection) carry those events only in Mongo. Dashboard panels
 * that source from ClickHouse (Events, Network, Crashes, Screens,
 * Perf) come up empty for those sessions even though the data is
 * sitting in Mongo.
 *
 * This script re-runs the projection logic for every Mongo batch,
 * deduplicating against rows already in ClickHouse via the
 * `(session_id, sequence, event_id)` key — safe to re-run.
 *
 * Run:  npx ts-node apps/ingest-api/scripts/backfill-projections.ts
 *
 * Doesn't touch Mongo / Postgres state. Read-only on source; only
 * INSERT on ClickHouse.
 */

import { PrismaClient as MongoClient } from "@replay/db-mongo";
import { PrismaClient as PgClient } from "@replay/db-postgres";
import { insertProjectionRows } from "@replay/db-clickhouse";
import type { ProjectionRow, ProjectionKind } from "@replay/db-clickhouse";

const mongo = new MongoClient();
const pg = new PgClient();

// Default-empty row template — covers every column the ClickHouse
// table declares so the JSONEachRow insert doesn't error on
// missing fields for non-network / non-tap rows.
const EMPTY = {
  request_headers: "",
  response_headers: "",
  request_body: "",
  response_body: "",
  connection_rtt: 0,
  connection_effective_type: "",
  ui_class: "",
  ui_value: "",
  ui_id: "",
  ui_type: "",
  bounds_x: 0,
  bounds_y: 0,
  bounds_w: 0,
  bounds_h: 0,
  point_x: 0,
  point_y: 0,
  is_sensitive: 0,
  gesture: "",
  pinch_scale_x1000: 0,
  route: "",
};

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  // BSON Long: { high, low, unsigned }. Reconstruct as a single
  // Number — JS only has 53-bit ints but session timestamps fit
  // comfortably (Date.now() is 41 bits in 2026).
  if (v && typeof v === "object" && "high" in v && "low" in v) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hi = (v as any).high;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lo = (v as any).low >>> 0;
    return hi * 0x1_0000_0000 + lo;
  }
  return 0;
}

interface MongoEvent {
  id: string;
  ts: unknown;
  offsetMs: unknown;
  type: string;
  source?: string;
  data?: unknown;
}

async function backfillBatch(
  batch: {
    sessionId: string;
    sequence: number;
    events: unknown[];
  },
  workspaceId: number,
  sessionRowId: number,
): Promise<number> {
  let currentRoute = "";
  const rows: ProjectionRow[] = [];
  for (const raw of batch.events) {
    const event = raw as MongoEvent;
    const ts = asNumber(event.ts);
    const offsetMs = asNumber(event.offsetMs);
    const base = {
      workspace_id: workspaceId,
      session_id: sessionRowId,
      session_public_id: batch.sessionId,
      sequence: batch.sequence,
      event_id: event.id,
      event_type: event.type,
      timestamp: ts,
      offset_ms: offsetMs,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (event.data ?? {}) as any;
    if (event.type === "console") {
      rows.push({
        ...base,
        ...EMPTY,
        kind: "console" as ProjectionKind,
        level: d.level ?? "",
        message: d.message ?? "",
        method: "",
        url: "",
        status_code: 0,
        duration_ms: 0,
        error: "",
        stack: d.stack ?? "",
        raw: JSON.stringify(d),
      });
    } else if (event.type === "network") {
      rows.push({
        ...base,
        ...EMPTY,
        kind: "network" as ProjectionKind,
        level: "",
        message: "",
        method: d.method ?? "",
        url: d.url ?? "",
        status_code: d.statusCode ?? 0,
        duration_ms: d.durationMs ?? 0,
        error: d.error ?? "",
        stack: "",
        raw: "",
        request_headers: JSON.stringify(d.requestHeaders ?? {}),
        response_headers: JSON.stringify(d.responseHeaders ?? {}),
        request_body: d.requestBody ?? "",
        response_body: d.responseBody ?? "",
        connection_rtt: d.connectionRtt ?? 0,
        connection_effective_type: d.connectionEffectiveType ?? "",
      });
    } else if (event.type === "tap") {
      currentRoute = d.route ?? currentRoute;
      rows.push({
        ...base,
        ...EMPTY,
        kind: "tap" as ProjectionKind,
        level: "",
        message: "",
        method: "",
        url: "",
        status_code: 0,
        duration_ms: 0,
        error: "",
        stack: "",
        raw: JSON.stringify(d),
        ui_class: d.isSensitive ? "" : (d.uiClass ?? ""),
        ui_value: d.isSensitive ? "" : (d.uiValue ?? ""),
        ui_id: d.uiId ?? "",
        ui_type: d.uiType ?? "",
        bounds_x: d.bounds?.x ?? 0,
        bounds_y: d.bounds?.y ?? 0,
        bounds_w: d.bounds?.w ?? 0,
        bounds_h: d.bounds?.h ?? 0,
        point_x: d.point?.x ?? 0,
        point_y: d.point?.y ?? 0,
        is_sensitive: d.isSensitive ? 1 : 0,
        gesture: d.gesture ?? "tap",
        pinch_scale_x1000:
          typeof d.pinchScale === "number"
            ? Math.round(d.pinchScale * 1000)
            : 0,
        route: d.route ?? currentRoute,
      });
    } else if (event.type === "custom") {
      const customKind = d.kind ?? "track";
      const isScreen =
        customKind === "screen" ||
        (customKind === "session_property" && d.name === "screen");
      if (isScreen) {
        const screenName =
          typeof d.properties?.name === "string"
            ? d.properties.name
            : d.name;
        currentRoute = screenName ?? currentRoute;
      }
      rows.push({
        ...base,
        ...EMPTY,
        kind: (isScreen ? "screen" : "custom") as ProjectionKind,
        level: customKind,
        message: d.name ?? "",
        method: "",
        url: "",
        status_code: 0,
        duration_ms: 0,
        error: "",
        stack: "",
        raw: JSON.stringify(d),
        route: currentRoute,
      });
    } else if (event.type === "performance") {
      rows.push({
        ...base,
        ...EMPTY,
        kind: "perf" as ProjectionKind,
        level: d.rating ?? "",
        message: d.unit ?? "",
        method: d.metric ?? "",
        url: "",
        status_code: 0,
        duration_ms: Math.round((d.value ?? 0) * 1000),
        error: "",
        stack: d.details ?? "",
        raw: JSON.stringify(d),
        route: currentRoute,
      });
    } else if (event.type === "error") {
      rows.push({
        ...base,
        ...EMPTY,
        kind: "error" as ProjectionKind,
        level: "",
        message: d.message ?? "",
        method: "",
        url: "",
        status_code: 0,
        duration_ms: 0,
        error: d.kind ?? "error",
        stack: d.stack ?? "",
        raw: JSON.stringify(d),
        route: currentRoute,
      });
    }
    // Other event types (session_start, session_end,
    // native_snapshot, identify) intentionally skipped — they're
    // not surfaced through the per-kind ClickHouse query path.
  }
  if (rows.length === 0) return 0;
  await insertProjectionRows(rows);
  return rows.length;
}

async function main() {
  // Map sessionPublicId → Session.id (ClickHouse stores the
  // numeric session_id alongside the publicId for joinless query
  // performance).
  const sessions = await pg.session.findMany({
    select: { id: true, publicId: true, workspaceId: true },
  });
  const idMap = new Map(
    sessions.map((s) => [
      s.publicId,
      { sessionRowId: s.id, workspaceId: s.workspaceId },
    ]),
  );

  // eslint-disable-next-line no-console
  console.log(`Found ${sessions.length} sessions in Postgres`);

  const batches = await mongo.replayBatch.findMany({
    orderBy: [{ sessionId: "asc" }, { sequence: "asc" }],
  });
  // eslint-disable-next-line no-console
  console.log(`Found ${batches.length} batches in Mongo`);

  let totalRows = 0;
  let skipped = 0;
  for (const b of batches) {
    const mapped = idMap.get(b.sessionId);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    const n = await backfillBatch(
      {
        sessionId: b.sessionId,
        sequence: b.sequence,
        events: b.events as unknown[],
      },
      mapped.workspaceId,
      mapped.sessionRowId,
    );
    totalRows += n;
  }
  // eslint-disable-next-line no-console
  console.log(
    `Backfilled ${totalRows} projection rows · skipped ${skipped} orphan batches`,
  );
  await mongo.$disconnect();
  await pg.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
