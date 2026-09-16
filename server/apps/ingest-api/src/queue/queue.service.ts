import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import {
  REPLAY_QUEUE,
  REPLAY_JOB_PROCESS_BATCH,
  WORKSPACE_DELETE_QUEUE,
  WORKSPACE_DELETE_JOB,
  RETENTION_QUEUE,
  RETENTION_JOB_PURGE,
  RETENTION_JOB_REFRESH_PLAYLISTS,
  RETENTION_JOB_REFRESH_COHORTS,
  INTELLIGENCE_QUEUE,
  INTEL_JOB_DERIVE_SIGNALS,
  INTEL_JOB_PRECOMPUTE_WORKSPACE,
} from "./queue.constants";
import type {
  ReplayBatchJob,
  RetentionJob,
  WorkspaceDeleteJob,
  DeriveSignalsJob,
  PrecomputeWorkspaceJob,
} from "./queue.types";

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(REPLAY_QUEUE)
    private readonly replayQueue: Queue<ReplayBatchJob>,
    @InjectQueue(WORKSPACE_DELETE_QUEUE)
    private readonly deleteQueue: Queue<WorkspaceDeleteJob>,
    @InjectQueue(RETENTION_QUEUE)
    private readonly retentionQueue: Queue<RetentionJob>,
    @InjectQueue(INTELLIGENCE_QUEUE)
    private readonly intelQueue: Queue<DeriveSignalsJob | PrecomputeWorkspaceJob>,
  ) {}

  async enqueueBatch(job: ReplayBatchJob): Promise<void> {
    await this.replayQueue.add(REPLAY_JOB_PROCESS_BATCH, job, {
      jobId: `${job.envelope.sessionId}:${job.envelope.sequence}`,
      // Resilience budget for a store outage. The circuit breaker
      // (queue-breaker.service.ts) is the primary defense — it pauses the queue
      // so jobs WAIT rather than fail — but these are the backstop for the few
      // in-flight jobs that error before the breaker trips, and for any window
      // where it can't pause: more attempts + a wider capped backoff keep them
      // out of the failed set, and a 72h retention makes a manual requeue viable
      // even for a long, unnoticed incident (was 3 attempts / 24h; 524 jobs were
      // stranded when Atlas filled).
      attempts: 6,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // 72h window for a slow manual requeue, but capped by COUNT too: these
      // payloads carry the full rrweb events[] blob, so an unbounded age-only
      // failed set could balloon Redis (noeviction → rejected writes) if a
      // NON-infra failure storm (bad deploy / malformed envelopes) ever bypasses
      // the breaker. count trims oldest-first past the cap.
      removeOnFail: { age: 3 * 86_400, count: 5_000 },
    });
  }

  async enqueueWorkspaceDelete(job: WorkspaceDeleteJob): Promise<void> {
    await this.deleteQueue.add(WORKSPACE_DELETE_JOB, job, {
      jobId: `workspace-delete:${job.workspaceId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400 },
    });
  }

  /**
   * Enqueue a single per-workspace retention job. Kept for callers that
   * only have one workspace in hand; the cron sweeps use the bulk variant
   * below so a fleet of N workspaces costs O(pages) round trips, not N.
   */
  async enqueueRetention(job: RetentionJob): Promise<void> {
    await this.retentionQueue.add(
      this.retentionJobName(job.kind),
      job,
      this.retentionJobOpts(job),
    );
  }

  /**
   * Bulk-enqueue a page of per-workspace retention jobs in ONE round trip
   * (Bull `addBulk`). The retention crons keyset-paginate active workspaces
   * and hand each page here, so we never `await`-add in a per-workspace
   * loop. No-ops on an empty page.
   */
  async enqueueRetentionBulk(jobs: RetentionJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.retentionQueue.addBulk(
      jobs.map((job) => ({
        name: this.retentionJobName(job.kind),
        data: job,
        opts: this.retentionJobOpts(job),
      })),
    );
  }

  /**
   * Enqueue one derive-signals job = one keyset page of session ids. The
   * scheduler pages the scan and hands each page here, so we never `await`-add
   * per session. The idempotent jobId (per source + id-range + coarse 5-min
   * bucket) lets Bull dedupe a page re-scanned inside the same tick window; the
   * derive is idempotent, so a cross-tick duplicate is at worst cheap. No-ops on
   * an empty page.
   */
  async enqueueDeriveSignals(job: DeriveSignalsJob): Promise<void> {
    if (job.sessionIds.length === 0) return;
    const first = job.sessionIds[0];
    const last = job.sessionIds[job.sessionIds.length - 1];
    await this.intelQueue.add(INTEL_JOB_DERIVE_SIGNALS, job, {
      jobId: `${job.source}:${first}-${last}:${Math.floor(job.enqueuedAt / 300_000)}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    });
  }

  /**
   * Bulk-enqueue a page of per-workspace precompute jobs in ONE round trip
   * (Bull `addBulk`). The dirty-gated sweep keyset-paginates dirty workspaces
   * and hands each page here — never an `await`-add per workspace. The
   * idempotent jobId (per workspace + coarse 5-min bucket) dedupes a workspace
   * still queued from the same tick; recompute is idempotent. No-ops on empty.
   */
  async enqueuePrecomputeWorkspaceBulk(
    jobs: PrecomputeWorkspaceJob[],
  ): Promise<void> {
    if (jobs.length === 0) return;
    await this.intelQueue.addBulk(
      jobs.map((job) => ({
        name: INTEL_JOB_PRECOMPUTE_WORKSPACE,
        data: job,
        opts: {
          jobId: `precompute:${job.workspaceId}:${Math.floor(job.enqueuedAt / 300_000)}`,
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 10_000 },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86_400 },
        },
      })),
    );
  }

  /** Bull job name for a retention kind. */
  private retentionJobName(kind: RetentionJob["kind"]): string {
    return kind === "purge"
      ? RETENTION_JOB_PURGE
      : kind === "refreshPlaylists"
        ? RETENTION_JOB_REFRESH_PLAYLISTS
        : RETENTION_JOB_REFRESH_COHORTS;
  }

  /** Shared Bull options for a retention job — idempotent jobId so Bull
   *  dedupes within the 60s tick window and a stuck worker can't pile up
   *  duplicates. */
  private retentionJobOpts(job: RetentionJob) {
    return {
      jobId: `${job.kind}:${job.workspaceId}:${Math.floor(job.enqueuedAt / 60_000)}`,
      attempts: 3,
      backoff: { type: "exponential" as const, delay: 10_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    };
  }
}
