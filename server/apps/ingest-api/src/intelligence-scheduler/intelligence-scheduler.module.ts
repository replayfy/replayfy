import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { QueueModule } from "../queue/queue.module";
import { IntelligenceSchedulerService } from "./intelligence-scheduler.service";

/**
 * Owns the intelligence pipeline's cron PRODUCERS (nightly signal backfill,
 * mobile end-of-session trigger, dirty-gated precompute sweep). Imports
 * QueueModule for QueueService — the exact producer↔worker split RetentionModule
 * uses: this module enqueues, and IntelligenceProcessor (registered inside
 * QueueModule, calling SignalsService + WorkspacePrecomputeService) consumes.
 * Keeping the crons here — NOT in SignalsModule / WorkspacePrecomputeModule,
 * which QueueModule already imports for the processor — avoids a module cycle.
 */
@Module({
  imports: [ScheduleModule.forRoot(), QueueModule],
  providers: [IntelligenceSchedulerService],
})
export class IntelligenceSchedulerModule {}
