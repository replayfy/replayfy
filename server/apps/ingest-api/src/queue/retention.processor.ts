import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { PlaylistsService } from "../playlists/playlists.service";
import { CohortsService } from "../cohorts/cohorts.service";
import { StorageService } from "../storage/storage.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { framesGzKey } from "../frames/frames.constants";
import {
  bookmarkedRetentionDays,
  planRetentionDays,
} from "../billing/plan-catalog";
import {
  RETENTION_QUEUE,
  RETENTION_JOB_PURGE,
  RETENTION_JOB_REFRESH_PLAYLISTS,
  RETENTION_JOB_REFRESH_COHORTS,
} from "./queue.constants";
import type { RetentionJob } from "./queue.types";

/**
 * Bull processor for the retention queue. Each job is per-workspace + per-kind
 * so a single slow workspace doesn't block the whole sweep. Failures get
 * exponential-backoff retries via Bull's built-in attempts config (see
 * QueueService.enqueueRetention).
 */
@Processor(RETENTION_QUEUE)
export class RetentionProcessor {
  private readonly logger = new Logger(RetentionProcessor.name);
  private readonly pg = getPostgresClient();
  private readonly mongo = getMongoClient();

  constructor(
    private readonly playlists: PlaylistsService,
    private readonly cohorts: CohortsService,
    private readonly storage: StorageService,
    private readonly stats: WorkspaceStatsService,
  ) {}

  @Process(RETENTION_JOB_PURGE)
  async purge(job: Job<RetentionJob>) {
    const { workspaceId } = job.data;
    const ws = await this.pg.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        retentionDays: true,
        deletedAt: true,
        plan: true,
        retentionConfig: true,
      },
    });
    if (!ws || ws.deletedAt) return;
    // Effective retention is the plan ceiling if the stored setting exceeds it —
    // so a workspace that downgraded (and whose setting was never re-clamped)
    // is purged on its new, shorter plan rather than its old allowance.
    const planMax = planRetentionDays(ws.plan);
    const effectiveDays =
      planMax != null ? Math.min(ws.retentionDays, planMax) : ws.retentionDays;
    const cutoff = new Date(Date.now() - effectiveDays * 24 * 60 * 60 * 1000);

    // Bookmarked sessions get their own, longer cutoff. This loop used to filter
    // `bookmarked: false` outright, which meant a bookmark bought UNLIMITED
    // retention on every plan and the `extendBookmarked` setting was read by
    // nothing at all. Now the extension is honoured — and clamped to the same
    // plan ceiling as the default, so starring a session is no longer a way to
    // hold storage past what the plan sells. null = genuinely keep forever,
    // which only an uncapped (Enterprise) plan can return.
    const extras =
      (ws.retentionConfig as { extendBookmarked?: string } | null) ?? {};
    const bookmarkDays = bookmarkedRetentionDays(
      ws.plan,
      ws.retentionDays,
      extras.extendBookmarked,
    );
    const bookmarkCutoff =
      bookmarkDays == null
        ? null
        : new Date(Date.now() - bookmarkDays * 24 * 60 * 60 * 1000);

    // PRUNE, not delete: drop only the WATCHABLE replay — Mongo rrweb blobs +
    // R2 frames — and mark the session `replayPrunedAt`. The Session row and ALL
    // of its ClickHouse analytics (funnels, retention, DAU/MAU, session counts)
    // are KEPT, so aggregate analytics stay accurate indefinitely. Batch in
    // pages so a workspace with 100k+ stale sessions never holds a cursor for
    // minutes; each page is its own unit of work so progress survives a restart.
    let totalPruned = 0;
    for (;;) {
      // Access pattern: workspace-scoped range on the new
      // @@index([workspaceId, replayPrunedAt, startedAt]) — equality on
      // workspaceId, IS NULL on replayPrunedAt, range on startedAt — so each
      // page visits ONLY not-yet-pruned rows older than the (looser) cutoff, not
      // every aged session on every hourly run. `take: 500` bounds the page, so
      // this scales to millions of expired rows by paging. `replayPrunedAt: null`
      // also makes the loop terminate: once a page is marked it drops out of the
      // predicate. bookmarkCutoff <= cutoff, so the single startedAt range covers
      // both the default and the (longer) bookmark class.
      const expired = await this.pg.session.findMany({
        where: {
          workspaceId,
          replayPrunedAt: null,
          startedAt: { lt: cutoff },
          ...(bookmarkCutoff == null
            ? { bookmarked: false }
            : {
                OR: [
                  { bookmarked: false },
                  { startedAt: { lt: bookmarkCutoff } },
                ],
              }),
        },
        select: { id: true, publicId: true, dataSizeBytes: true },
        take: 500,
      });
      if (expired.length === 0) break;
      const publicIds = expired.map((s) => s.publicId);
      const ids = expired.map((s) => s.id);

      // Web replay: rrweb batches in Mongo.
      await this.mongo.replayBatch.deleteMany({
        where: { sessionId: { in: publicIds } },
      });
      // Mobile replay: R2 frames archive (frames/<pid>.gz), one object per
      // session, chunked so we don't fan out 500 removals at once.
      const CHUNK = 20;
      for (let i = 0; i < publicIds.length; i += CHUNK) {
        await Promise.all(
          publicIds
            .slice(i, i + CHUNK)
            .map((pid) => this.storage.remove(framesGzKey(pid))),
        );
      }
      // Mark pruned + zero the stored bytes (the blobs are gone). We KEEP the
      // Session row AND its ClickHouse analytics — this is the decoupling.
      await this.pg.session.updateMany({
        where: { id: { in: ids } },
        data: { replayPrunedAt: new Date(), dataSizeBytes: 0 },
      });
      // Return only the freed STORAGE. sessionsTotal is deliberately untouched:
      // the session still exists for analytics, so the "Recordings" total must
      // not drop — and the daily rollup must not drift — just because a replay
      // aged out.
      const freedBytes = expired.reduce(
        (a, e) => a + (e.dataSizeBytes ?? 0n),
        0n,
      );
      this.stats
        .bump(workspaceId, { storageBytes: -freedBytes })
        .catch(() => {});
      totalPruned += expired.length;
      await job.progress(
        Math.min(99, (totalPruned / Math.max(totalPruned + 1, 1)) * 100),
      );
    }
    if (totalPruned > 0) {
      this.logger.log(
        `Pruned replay for ${totalPruned} sessions ws=${workspaceId} ` +
          `(replay retention ${ws.retentionDays}d; analytics kept)`,
      );
    }
  }

  @Process(RETENTION_JOB_REFRESH_PLAYLISTS)
  async refreshPlaylists(job: Job<RetentionJob>) {
    const { workspaceId } = job.data;
    const r = await this.playlists.refreshAllAuto(workspaceId).catch((e) => {
      this.logger.warn(
        `Playlist refresh failed ws=${workspaceId}: ${(e as Error).message}`,
      );
      return null;
    });
    if (r && r.playlists > 0) {
      this.logger.log(
        `Refreshed ${r.playlists} AUTO playlists ws=${workspaceId} (${r.totalMembers} members)`,
      );
    }
  }

  @Process(RETENTION_JOB_REFRESH_COHORTS)
  async refreshCohorts(job: Job<RetentionJob>) {
    const { workspaceId } = job.data;
    // BEHAVIORAL cohorts only — attribute-only cohorts are maintained
    // incrementally by the dirty-drainer, so re-scanning them here would be
    // wasted work. The nightly reconcile still full-refreshes everything.
    const r = await this.cohorts
      .refreshBehavioralCohorts(workspaceId)
      .catch((e) => {
        this.logger.warn(
          `Cohort refresh failed ws=${workspaceId}: ${(e as Error).message}`,
        );
        return null;
      });
    if (r && r.cohorts > 0) {
      this.logger.log(
        `Refreshed ${r.cohorts} behavioral cohorts ws=${workspaceId} (${r.totalMembers} members)`,
      );
    }
  }
}
