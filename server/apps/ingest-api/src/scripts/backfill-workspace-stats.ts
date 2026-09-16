/**
 * One-shot backfill for WorkspaceStats.
 *
 * The dashboard counts endpoint reads from WorkspaceStats with a live
 * .count() fallback when the row is missing. After deploying the
 * counter cache for the first time the rows don't exist, so every
 * dashboard poll triggers an inline reconcile until they're populated.
 *
 * This script populates every workspace's row up-front so all polls
 * hit the fast PK-lookup path immediately. Idempotent — re-running
 * just resets each row to authoritative counts.
 *
 * Reimplements `WorkspaceStatsService.reconcile` inline here instead
 * of booting the Nest container. The full AppModule pulls in Bull /
 * Redis / ClickHouse schema init / cron registration, which is
 * heavyweight + fragile for a one-shot script. The reconcile logic
 * itself is just counts + an upsert.
 *
 * Usage (after `npx tsc`):
 *   node apps/ingest-api/dist/scripts/backfill-workspace-stats.js
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { getPostgresClient } from "@replay/db-postgres";

loadEnv();
loadEnv({ path: ".env.local", override: true });

async function main() {
  const pg = getPostgresClient();

  const workspaces = await pg.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true },
  });

  process.stdout.write(`Reconciling ${workspaces.length} workspace(s)…\n`);
  let ok = 0;
  let failed = 0;

  for (const ws of workspaces) {
    try {
      const [
        sessionsTotal,
        playlistsTotal,
        usersTotal,
        cohortsTotal,
        commentsTotal,
        funnelsTotal,
        liveSessions,
        storageAgg,
      ] = await Promise.all([
        pg.session.count({ where: { workspaceId: ws.id } }),
        pg.playlist.count({ where: { workspaceId: ws.id } }),
        pg.endUser.count({ where: { workspaceId: ws.id } }),
        pg.cohort.count({ where: { workspaceId: ws.id } }),
        pg.comment.count({ where: { workspaceId: ws.id, deletedAt: null } }),
        pg.funnel.count({ where: { workspaceId: ws.id } }),
        pg.session.count({ where: { workspaceId: ws.id, status: "LIVE" } }),
        pg.session.aggregate({
          where: { workspaceId: ws.id },
          _sum: { dataSizeBytes: true },
        }),
      ]);
      const storageBytes = storageAgg._sum.dataSizeBytes ?? 0n;

      await pg.workspaceStats.upsert({
        where: { workspaceId: ws.id },
        create: {
          workspaceId: ws.id,
          sessionsTotal,
          playlistsTotal,
          usersTotal,
          cohortsTotal,
          commentsTotal,
          funnelsTotal,
          liveSessions,
          storageBytes,
        },
        update: {
          sessionsTotal,
          playlistsTotal,
          usersTotal,
          cohortsTotal,
          commentsTotal,
          funnelsTotal,
          liveSessions,
          storageBytes,
        },
      });
      process.stdout.write(
        `  ✓ ${ws.name} (#${ws.id}) — sessions=${sessionsTotal} ` +
          `playlists=${playlistsTotal} users=${usersTotal} ` +
          `cohorts=${cohortsTotal} comments=${commentsTotal} ` +
          `funnels=${funnelsTotal} live=${liveSessions} ` +
          `storage=${storageBytes}B\n`,
      );
      ok += 1;
    } catch (e) {
      process.stderr.write(
        `  ✗ ${ws.name} (#${ws.id}) — ${(e as Error).message}\n`,
      );
      failed += 1;
    }
  }

  process.stdout.write(`\nDone. ${ok} reconciled, ${failed} failed.\n`);
  await pg.$disconnect();
}

main().catch((e) => {
  process.stderr.write(
    `backfill-workspace-stats failed: ${(e as Error).message}\n`,
  );
  process.exit(1);
});
