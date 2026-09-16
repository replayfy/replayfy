/**
 * ONE-TIME historical reconcile of the daily signal rollup
 * (WorkspaceSignalDaily). The rollup only auto-recomputes its trailing
 * RECONCILE_DAYS (3) each night, so any OLDER day that lost sessions to a
 * pre-decoupling retention purge (or the old incremental-bump double-count) kept
 * an inflated `sessions` value — which is why the Overview "Sessions" total
 * could read HIGHER than the live "Recordings" count. This recomputes every day
 * from RECONCILE_FROM (default 1970-01-01 — the epoch, so it also sweeps sentinel
 * rows written with a zero/epoch date) forward, absolutely and idempotently
 * (SETS/deletes, never adds), so historical rows match the true current Session
 * table. The recompute is one set-based pass regardless of how far back it runs.
 *
 * Run ONCE after deploying the retention-decoupling change. Safe to re-run.
 * One set-based INSERT…SELECT…ON CONFLICT per touched workspace-day — never
 * per-row, so it scales to full history.
 *
 *   RECONCILE_FROM=2020-01-01 node apps/ingest-api/dist/reconcile-signal-daily-history.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const fromStr = process.env.RECONCILE_FROM ?? "1970-01-01";
  const from = new Date(`${fromStr}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) {
    process.stderr.write(`invalid RECONCILE_FROM: ${fromStr}\n`);
    process.exit(1);
  }

  const { AppModule } = await import("./app.module");
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });

  const { WorkspaceSignalDailyService } = await import(
    "./workspace-signal-daily/workspace-signal-daily.service"
  );
  const signalDaily = app.get(WorkspaceSignalDailyService);

  const t0 = Date.now();
  // All-workspace absolute recompute from `from` forward.
  const touched = await signalDaily.reconcileSince(from);
  process.stdout.write(
    `reconciled ${touched} workspace-days from ${from.toISOString()} ` +
      `(${Date.now() - t0}ms)\n`,
  );

  // Surface the corrected rollup on the Overview PROMPTLY. The windowed
  // "Sessions" tile / Pulse are served from the WorkspacePrecompute snapshot
  // (WorkspaceSnapshot JSON + Redis ws:snapshot:<id>), which a rollup write does
  // NOT invalidate — so a backfill alone leaves the Overview showing the stale
  // count until the ~1h stale-clause fires. Bumping lastActivityAt past
  // snapshotAt marks each workspace dirty, so the 5-min tickPrecompute recomputes
  // it. (One-time cost: a recompute pass over all snapshotted workspaces.)
  const { getPostgresClient } = await import("@replay/db-postgres");
  const dirtied = await getPostgresClient().$executeRawUnsafe(
    `UPDATE "WorkspaceSnapshot" SET "lastActivityAt" = now() WHERE "snapshotAt" IS NOT NULL`,
  );
  process.stdout.write(
    `marked ${dirtied} workspace snapshots dirty (Overview refreshes within ~5 min)\n`,
  );

  await app.close();
  // ScheduleModule/Redis/BullMQ keep open handles that stall a clean exit; the
  // work is done, so hard-exit rather than hang.
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(
    `reconcile-signal-daily-history failed: ${
      e instanceof Error ? e.stack : String(e)
    }\n`,
  );
  process.exit(1);
});
