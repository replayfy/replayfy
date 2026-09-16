import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceLatencyDailyService } from "./workspace-latency-daily.service";

/**
 * Owns the daily API-latency rollup (WorkspaceLatencyDaily). Exports the service
 * so experienceHealth() (0b) can read windowSummary() and a backfill script can
 * seed the spark window. ScheduleModule.forRoot() is idempotent across modules.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceLatencyDailyService],
  exports: [WorkspaceLatencyDailyService],
})
export class WorkspaceLatencyDailyModule {}
