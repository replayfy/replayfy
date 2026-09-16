import { Global, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceSignalDailyService } from "./workspace-signal-daily.service";

/**
 * Daily semantic-signal rollup module (Overview Pulse, Slice 2). @Global so the
 * finalize-derive path (SignalsService) can call bump() and DashboardService
 * can call pulse() without re-importing. Imports ScheduleModule.forRoot() for
 * the nightly reconcile cron.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceSignalDailyService],
  exports: [WorkspaceSignalDailyService],
})
export class WorkspaceSignalDailyModule {}
