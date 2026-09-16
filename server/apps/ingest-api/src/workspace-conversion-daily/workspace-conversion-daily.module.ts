import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceConversionDailyService } from "./workspace-conversion-daily.service";

/**
 * Owns the daily saved-funnel conversion rollup (WorkspaceConversionDaily).
 * Exports the service so experienceHealth() (0b) reads windowSummary() and a
 * backfill script seeds the spark window.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceConversionDailyService],
  exports: [WorkspaceConversionDailyService],
})
export class WorkspaceConversionDailyModule {}
