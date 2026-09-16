import { Global, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspacePerfDailyService } from "./workspace-perf-daily.service";

/**
 * Daily web-vitals rollup module. @Global so the ingest persistence
 * path can call bumpForSession() without re-importing.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspacePerfDailyService],
  exports: [WorkspacePerfDailyService],
})
export class WorkspacePerfDailyModule {}
