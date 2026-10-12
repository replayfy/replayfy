/**
 * One-time repair of native (mobile) sessions recorded before /v1/mobile/start
 * corrected device clock skew. Their startedAt is the device's clock, so a
 * phone hours fast shows its sessions as "just now" at the top of the
 * recordings list (and a slow one buries them and ages their replay out early).
 *
 * Covers sessions created by /v1/mobile/start only (sdkName replay-ios /
 * replay-android / replay-react-native / replay-flutter): there createdAt is
 * the server time the row was written at /start, so startedAt - createdAt is
 * the device's skew. (Legacy JSON-path native rows are excluded: their gap also
 * holds upload and queue delay.)
 *
 * For each such session whose startedAt and createdAt disagree by more than
 * the live tolerance, in one transaction per primary-key range:
 *   Session          clockSkewMs = startedAt - createdAt (device minus server)
 *                    startedAt   = createdAt
 *                    endedAt     moved onto server time and capped at now
 *   IssueOccurrence  occurredAt shifted by the skew (it came from the device
 *                    clock), then the touched Issues' first/last-seen recomputed
 *   ClickHouse       replay.sessions and replay.session_cards rewritten with the
 *                    corrected datetime, older versions deleted (they can sit in
 *                    another day's partition, where merges would never drop them)
 * A ClickHouse failure rolls the range's Postgres changes back, so a re-run
 * redoes it. Rows already carrying clockSkewMs are skipped, so the relative
 * shifts happen exactly once. replay.session_events keeps device-clock
 * timestamps (offsets are unaffected). The original start stays recoverable as
 * startedAt + clockSkewMs.
 *
 *   npm run build && npm run backfill:mobile-clock-skew            (dry run)
 *   BACKFILL_APPLY=1 npm run backfill:mobile-clock-skew            (write)
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import {
  getPostgresClient,
  disconnectPostgres,
  Prisma,
} from "@replay/db-postgres";
import {
  ensureClickHouseSchema,
  getClickHouseClient,
  insertSessionRows,
  disconnectClickHouse,
} from "@replay/db-clickhouse";
import { SESSION_ROW_SELECT, toSessionRow } from "../common/ch-session-row";

loadEnv();
loadEnv({ path: ".env.local", override: true });

/** Same tolerance as the live correction in MobileService.createSession. */
const TOLERANCE_SECONDS = 120;
/** Primary-key span per transaction. */
const RANGE = Number(process.env.BACKFILL_RANGE ?? 5000);
const APPLY = process.env.BACKFILL_APPLY === "1";
const START_SDKS = ["replay-ios", "replay-android", "replay-react-native", "replay-flutter"];

type Fixed = { id: number; workspaceId: number; clockSkewMs: bigint };

async function main() {
  const db = getPostgresClient();
  if (APPLY) await ensureClickHouseSchema();

  const [{ max }] = await db.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(id) AS max FROM "Session"`;
  let fixed = 0;

  for (let lo = 0; lo < (max ?? 0); lo += RANGE) {
    const hi = lo + RANGE;
    // Access pattern: a primary-key range scan (id > lo AND id <= hi); the other
    // predicates are evaluated on that range's rows only, so each statement
    // touches at most RANGE rows through the PK index and needs no new index.
    const filter = Prisma.sql`
      id > ${lo} AND id <= ${hi}
      AND platform IN ('ios', 'android')
      AND "sdkName" IN (${Prisma.join(START_SDKS)})
      AND "clockSkewMs" IS NULL
      AND ABS(EXTRACT(EPOCH FROM ("startedAt" - "createdAt"))) > ${TOLERANCE_SECONDS}`;

    if (!APPLY) {
      const ids = await db.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Session" WHERE ${filter}`;
      if (ids.length) {
        fixed += ids.length;
        process.stdout.write(`  would fix ${ids.length} session(s) in ids (${lo}, ${hi}]\n`);
      }
      continue;
    }

    const count = await db.$transaction(
      async (tx) => {
        // The SET expressions read the pre-update row. endedAt: a value nothing
        // ever moved off the device clock (still equal to the old start, or in
        // the future) becomes createdAt + duration; otherwise keep the later of
        // the two. Never in the future.
        const rows = await tx.$queryRaw<Fixed[]>`
          UPDATE "Session" SET
            "clockSkewMs" = ROUND(EXTRACT(EPOCH FROM ("startedAt" - "createdAt")) * 1000)::bigint,
            "startedAt"   = "createdAt",
            "endedAt"     = LEAST(now(), CASE
              WHEN "endedAt" > now() OR "endedAt" = "startedAt"
                THEN "createdAt" + (COALESCE("durationMs", 0) * INTERVAL '1 millisecond')
              ELSE GREATEST("endedAt", "createdAt" + (COALESCE("durationMs", 0) * INTERVAL '1 millisecond'))
            END)
          WHERE ${filter}
          RETURNING id, "workspaceId", "clockSkewMs"`;
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);

        // Issue occurrences took their time from the device clock. Shift them
        // once (this runs only for rows fixed in this transaction). Access
        // pattern: IssueOccurrence by sessionId IN (ids), on its sessionId index.
        const touched = await tx.$queryRaw<{ workspaceId: number; fingerprint: string }[]>`
          UPDATE "IssueOccurrence" o
             SET "occurredAt" = o."occurredAt" - (s."clockSkewMs" * INTERVAL '1 millisecond')
            FROM "Session" s
           WHERE o."sessionId" IN (${Prisma.join(ids)}) AND s.id = o."sessionId"
          RETURNING o."workspaceId", o.fingerprint`;
        if (touched.length) {
          // Recompute first/last seen of just those issues from their (now
          // corrected) occurrences: a separate statement, so it sees the shift.
          // Access pattern: Issue + IssueOccurrence by (workspaceId, fingerprint),
          // on the unique key and the occurrence index.
          const keys = [...new Map(touched.map((t) => [`${t.workspaceId}\0${t.fingerprint}`, t])).values()];
          await tx.$executeRaw`
            UPDATE "Issue" i
               SET "firstSeenAt" = agg.first_seen, "lastSeenAt" = agg.last_seen
              FROM (
                SELECT o."workspaceId", o.fingerprint,
                       MIN(o."occurredAt") AS first_seen, MAX(o."occurredAt") AS last_seen
                  FROM "IssueOccurrence" o
                 WHERE (o."workspaceId", o.fingerprint) IN (${Prisma.join(
                   keys.map((k) => Prisma.sql`(${k.workspaceId}, ${k.fingerprint})`),
                 )})
                 GROUP BY o."workspaceId", o.fingerprint
              ) agg
             WHERE i."workspaceId" = agg."workspaceId" AND i.fingerprint = agg.fingerprint`;
        }

        // ClickHouse, inside the transaction so a failure rolls Postgres back.
        // Every write sets absolute values from Postgres, so a re-run converges.
        const sessions = await tx.session.findMany({
          where: { id: { in: ids } },
          select: SESSION_ROW_SELECT,
        });
        const version = Date.now();
        await insertSessionRows(sessions.map((s) => toSessionRow(s, version)));
        const ch = getClickHouseClient();
        const byWs = new Map<number, typeof sessions>();
        for (const s of sessions) byWs.set(s.workspaceId, [...(byWs.get(s.workspaceId) ?? []), s]);
        for (const [ws, list] of byWs) {
          const sessionIds = list.map((s) => s.id);
          const datetimes = list.map((s) => s.startedAt.getTime());
          const params = { ws, ids: sessionIds, dts: datetimes, v: version };
          // Cards copy their datetime from replay.sessions: re-write them with
          // the corrected one. Access pattern: the (workspace_id, session_id)
          // sort-key prefix, a few granules per session.
          await ch.command({
            query: `INSERT INTO replay.session_cards
                    SELECT * REPLACE (
                      transform(session_id, {ids:Array(UInt32)}, {dts:Array(UInt64)}, datetime) AS datetime,
                      {v:UInt64} AS _version)
                    FROM replay.session_cards FINAL
                    WHERE workspace_id = {ws:UInt32} AND session_id IN {ids:Array(UInt32)}`,
            query_params: params,
          });
          // Drop the superseded rows. They may sit in another day's partition,
          // where ReplacingMergeTree merges would never remove them.
          for (const table of ["replay.sessions", "replay.session_cards"]) {
            await ch.command({
              query: `ALTER TABLE ${table} DELETE
                      WHERE workspace_id = {ws:UInt32} AND session_id IN {ids:Array(UInt32)} AND _version < {v:UInt64}`,
              query_params: params,
              clickhouse_settings: { mutations_sync: "2" },
            });
          }
        }
        return rows.length;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    if (count) {
      fixed += count;
      process.stdout.write(`  fixed ${count} session(s) in ids (${lo}, ${hi}]\n`);
    }
  }

  process.stdout.write(
    `\n${APPLY ? "Repaired" : "Dry run: would repair"} ${fixed} native session(s) with device clock skew > ${TOLERANCE_SECONDS}s\n`,
  );
  await disconnectPostgres();
  if (APPLY) await disconnectClickHouse();
}

main().catch(async (e) => {
  process.stderr.write(
    `Backfill failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  await disconnectPostgres();
  await disconnectClickHouse();
  process.exit(1);
});
