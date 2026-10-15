import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { ReplayPersistenceService } from "../replay/replay-persistence.service";
import { REPLAY_QUEUE, REPLAY_JOB_PROCESS_BATCH } from "./queue.constants";
import type { ReplayBatchJob } from "./queue.types";
import { QueueBreakerService } from "./queue-breaker.service";
import { makeWellFormedInPlace } from "../common/well-formed";

@Processor(REPLAY_QUEUE)
export class ReplayBatchProcessor {
  private readonly logger = new Logger(ReplayBatchProcessor.name);

  constructor(
    private readonly persistence: ReplayPersistenceService,
    private readonly breaker: QueueBreakerService,
  ) {}

  @Process({
    name: REPLAY_JOB_PROCESS_BATCH,
    concurrency: Number(process.env.REPLAY_WORKER_CONCURRENCY ?? 4),
  })
  async handleBatch(job: Job<ReplayBatchJob>): Promise<void> {
    try {
      // Client strings can hold half an emoji (an SDK slice through one) or NUL,
      // and either makes the stores reject the whole batch on every retry.
      // Repair them once here, the single entry for every web replay job
      // (including failed jobs requeued after this shipped).
      const repaired = makeWellFormedInPlace(job.data);
      if (repaired > 0) {
        this.logger.warn(
          `replay-batch ${job.id}: repaired ${repaired} malformed string(s)`,
        );
      }
      const outcome = await this.persistence.persist(job.data);
      if (outcome === "duplicate") {
        // An SDK resend of a batch already fully persisted: nothing written.
        this.logger.debug(`replay-batch ${job.id}: already persisted, skipped`);
      }
    } catch (e) {
      // If this failure means a backing store is DOWN (not a bad payload), the
      // breaker pauses the queue so this + following jobs wait durably in Redis
      // instead of burning their attempts into the failed set. Fire-and-forget;
      // we still rethrow so Bull schedules the retry (which runs once resumed).
      this.breaker.reportFailure(e);
      this.logger.error(
        `replay-batch failed (${job.id}): ${(e as Error).message}`,
        (e as Error).stack,
      );
      throw e;
    }
  }
}
