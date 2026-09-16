import { WorkspaceStatsModule } from "../workspace-stats/workspace-stats.module";
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { ScheduleModule } from "@nestjs/schedule";
import { ReplayPersistenceModule } from "../replay/replay-persistence.module";
import { PlaylistsModule } from "../playlists/playlists.module";
import { CohortsModule } from "../cohorts/cohorts.module";
import { SignalsModule } from "../signals/signals.module";
import { WorkspacePrecomputeModule } from "../workspace-precompute/workspace-precompute.module";
import {
  REPLAY_QUEUE,
  WORKSPACE_DELETE_QUEUE,
  RETENTION_QUEUE,
  INTELLIGENCE_QUEUE,
} from "./queue.constants";
import { QueueService } from "./queue.service";
import { QueueBreakerService } from "./queue-breaker.service";
import { ReplayBatchProcessor } from "./replay-batch.processor";
import { WorkspaceDeleteProcessor } from "./workspace-delete.processor";
import { RetentionProcessor } from "./retention.processor";
import { IntelligenceProcessor } from "./intelligence.processor";

/**
 * Bull connection is configured once in AppModule (BullModule.forRootAsync).
 * Each consumer module just registers the queue names it owns against that
 * shared root. One registerQueue call covers all four queues — used to be
 * three duplicate registerQueueAsync calls that each re-parsed REDIS_URL.
 */
@Module({
  imports: [
    // forRoot() is idempotent across modules — powers the breaker's @Interval
    // health probe (runs on the worker node regardless of the cron role).
    ScheduleModule.forRoot(),
    BullModule.registerQueue(
      { name: REPLAY_QUEUE },
      { name: WORKSPACE_DELETE_QUEUE },
      { name: RETENTION_QUEUE },
      { name: INTELLIGENCE_QUEUE },
    ),
    ReplayPersistenceModule,
    // Retention processor pulls in playlists + cohorts services.
    PlaylistsModule,
    CohortsModule,
    WorkspaceStatsModule,
    // Intelligence processor calls the derive + precompute work services. These
    // modules do NOT import QueueModule (the scheduler that enqueues does), so
    // there's no cycle — same producer↔worker split retention uses.
    SignalsModule,
    WorkspacePrecomputeModule,
  ],
  providers: [
    QueueService,
    QueueBreakerService,
    ReplayBatchProcessor,
    WorkspaceDeleteProcessor,
    RetentionProcessor,
    IntelligenceProcessor,
  ],
  exports: [QueueService],
})
export class QueueModule {}
