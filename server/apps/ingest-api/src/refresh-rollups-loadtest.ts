/**
 * LOAD-TEST SEEDER (rollup refresh leg). After the synthetic sessions land in
 * Postgres + ClickHouse, the daily-aggregate tables the Overview reads still
 * reflect the pre-seed world. This boots a Nest application context and invokes
 * each rollup's real backfill/reconcile entry point so DAU/MAU, the metric
 * strip, mobile-perf, conversion, latency, per-workspace stats and the
 * precomputed snapshot all recompute over the 90-day synthetic spread.
 *
 * Uses the SAME code paths the crons use — no re-derivation, no drift. Also a
 * genuine load test of those rollup queries at volume.
 *
 *   SEED_WS=1,2 SEED_DAYS=95 node apps/ingest-api/dist/refresh-rollups-loadtest.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { NestFactory } from "@nestjs/core";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const wsList = (process.env.SEED_WS ?? "1,2")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const days = parseInt(process.env.SEED_DAYS ?? "95", 10);

  const { AppModule } = await import("./app.module");
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });

  const t0 = Date.now();
  const step = async (label: string, fn: () => Promise<unknown>) => {
    const s = Date.now();
    await fn();
    process.stdout.write(`  ✓ ${label} (${Date.now() - s}ms)\n`);
  };

  // Lazy-require the service classes so a rename surfaces here, not at import top.
  const { WorkspaceEngagementDailyService } = await import(
    "./workspace-engagement-daily/workspace-engagement-daily.service"
  );
  const { WorkspaceSignalDailyService } = await import(
    "./workspace-signal-daily/workspace-signal-daily.service"
  );
  const { WorkspaceMobilePerfDailyService } = await import(
    "./workspace-mobile-perf-daily/workspace-mobile-perf-daily.service"
  );
  const { WorkspaceConversionDailyService } = await import(
    "./workspace-conversion-daily/workspace-conversion-daily.service"
  );
  const { WorkspaceLatencyDailyService } = await import(
    "./workspace-latency-daily/workspace-latency-daily.service"
  );
  const { WorkspaceStatsService } = await import(
    "./workspace-stats/workspace-stats.service"
  );
  const { WorkspacePrecomputeService } = await import(
    "./workspace-precompute/workspace-precompute.service"
  );

  const engagement = app.get(WorkspaceEngagementDailyService);
  const signalDaily = app.get(WorkspaceSignalDailyService);
  const mobilePerf = app.get(WorkspaceMobilePerfDailyService);
  const conversion = app.get(WorkspaceConversionDailyService);
  const latency = app.get(WorkspaceLatencyDailyService);
  const stats = app.get(WorkspaceStatsService);
  const precompute = app.get(WorkspacePrecomputeService);

  // Daily rollups are all-workspace, keyset-batched over `days` of history.
  await step(`engagement.backfill(${days})`, () => engagement.backfill(days));
  await step("signalDaily.reconcileRecent()", () =>
    signalDaily.reconcileRecent(),
  );
  await step(`mobilePerf.backfill(${days})`, () => mobilePerf.backfill(days));
  await step(`conversion.backfill(${days})`, () => conversion.backfill(days));
  await step(`latency.backfill(${days})`, () => latency.backfill(days));

  // Per-workspace: stats reconcile + precomputed snapshot for each target ws.
  for (const ws of wsList) {
    await step(`stats.reconcile(${ws})`, () => stats.reconcile(ws));
    await step(`precompute.recomputeWorkspace(${ws})`, () =>
      precompute.recomputeWorkspace(ws),
    );
  }

  process.stdout.write(`rollup refresh complete (${Date.now() - t0}ms)\n`);
  await app.close();
  // Nest's ScheduleModule/Redis/BullMQ keep open handles that stall a clean
  // exit; the work is done, so hard-exit rather than hang the orchestrator.
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(
    `refresh-rollups failed: ${e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(1);
});
