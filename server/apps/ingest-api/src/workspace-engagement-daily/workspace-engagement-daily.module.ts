import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceEngagementDailyService } from "./workspace-engagement-daily.service";

/**
 * Owns the daily engagement rollup (WorkspaceEngagementDaily). Exports the
 * service so experienceHealth() (0b) reads windowSummary() and a backfill script
 * seeds the spark window.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceEngagementDailyService],
  exports: [WorkspaceEngagementDailyService],
})
export class WorkspaceEngagementDailyModule {}
