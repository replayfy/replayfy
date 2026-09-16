import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceMobilePerfDailyService } from "./workspace-mobile-perf-daily.service";

/**
 * Owns the daily mobile-perf rollup (WorkspaceMobilePerfDaily). Exports the
 * service so experienceHealth() (0b) reads windowSummary() and a backfill script
 * seeds the spark window.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceMobilePerfDailyService],
  exports: [WorkspaceMobilePerfDailyService],
})
export class WorkspaceMobilePerfDailyModule {}
