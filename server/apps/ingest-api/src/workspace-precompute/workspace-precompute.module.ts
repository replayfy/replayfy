import { Module, forwardRef } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { DashboardModule } from "../dashboard/dashboard.module";
import { WorkspacePrecomputeService } from "./workspace-precompute.service";
import { WorkspacePrecomputeController } from "./workspace-precompute.controller";

/**
 * Owns the dirty-gated L1 precompute (cron) + the manual recompute trigger.
 * Imports DashboardModule for the deterministic overview/metrics rollups it
 * caches, and ScheduleModule.forRoot() (idempotent across modules) for the
 * sweep cron. Exports the service so a future AI "recompute this workspace"
 * action can drive it directly.
 */
@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => DashboardModule)],
  controllers: [WorkspacePrecomputeController],
  providers: [WorkspacePrecomputeService],
  exports: [WorkspacePrecomputeService],
})
export class WorkspacePrecomputeModule {}
