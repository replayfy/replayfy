import { Global, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { WorkspaceStatsService } from "./workspace-stats.service";

/**
 * Counters module. @Global so every write path (sessions, playlists,
 * cohorts, comments, funnels, end-users) can inject the service
 * without each one re-importing.
 *
 * Imports ScheduleModule so the 30-minute reconcile cron registers.
 * ScheduleModule.forRoot() is idempotent — safe even though the
 * retention module already calls it.
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [WorkspaceStatsService],
  exports: [WorkspaceStatsService],
})
export class WorkspaceStatsModule {}
