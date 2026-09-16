import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { SignalsService } from "../signals/signals.service";
import { WorkspacePrecomputeService } from "../workspace-precompute/workspace-precompute.service";
import {
  INTELLIGENCE_QUEUE,
  INTEL_JOB_DERIVE_SIGNALS,
  INTEL_JOB_PRECOMPUTE_WORKSPACE,
} from "./queue.constants";
import type { DeriveSignalsJob, PrecomputeWorkspaceJob } from "./queue.types";

/**
 * Bull processor for the intelligence pipeline. The scheduler crons
 * (IntelligenceSchedulerService) stay tiny — they only SCAN + fan out — and the
 * heavy work runs here with Bull's retries, exponential backoff, and bounded
 * concurrency, instead of running the whole sweep synchronously in the API
 * process (which had no backpressure and double-fired on every replica).
 *
 *   · derive-signals       — one job per keyset page of sessions; runs the
 *                            signals→issues→cards chokepoint for that batch.
 *   · precompute-workspace — one job per dirty/stale workspace; rebuilds its
 *                            cached L1 snapshot + storyline narration.
 *
 * Concurrency is env-tunable PER job type so a derive backlog can't starve the
 * cheaper precompute jobs (they run on the same queue but separate slots).
 * Errors are logged and rethrown so Bull applies the configured attempts/backoff
 * from QueueService; a permanently-failed batch is re-covered by the nightly
 * backfill (which re-derives the whole recent window regardless of state).
 */
@Processor(INTELLIGENCE_QUEUE)
export class IntelligenceProcessor {
  private readonly logger = new Logger(IntelligenceProcessor.name);

  constructor(
    private readonly signals: SignalsService,
    private readonly precompute: WorkspacePrecomputeService,
  ) {}

  @Process({
    name: INTEL_JOB_DERIVE_SIGNALS,
    concurrency: Number(process.env.INTEL_DERIVE_CONCURRENCY ?? 4),
  })
  async deriveSignals(job: Job<DeriveSignalsJob>): Promise<void> {
    const { sessionIds, bumpDaily, markProcessedAt } = job.data;
    try {
      await this.signals.deriveBatch(sessionIds, {
        bumpDaily,
        markProcessedAt,
      });
    } catch (e) {
      this.logger.error(
        `derive-signals failed (job ${job.id}, ${sessionIds.length} sessions): ${(e as Error).message}`,
      );
      throw e;
    }
  }

  @Process({
    name: INTEL_JOB_PRECOMPUTE_WORKSPACE,
    concurrency: Number(process.env.INTEL_PRECOMPUTE_CONCURRENCY ?? 2),
  })
  async precomputeWorkspace(job: Job<PrecomputeWorkspaceJob>): Promise<void> {
    try {
      await this.precompute.recomputeWorkspace(job.data.workspaceId);
    } catch (e) {
      this.logger.error(
        `precompute-workspace failed (job ${job.id}, ws ${job.data.workspaceId}): ${(e as Error).message}`,
      );
      throw e;
    }
  }
}
