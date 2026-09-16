import { Module, forwardRef } from "@nestjs/common";
import { PresenceModule } from "../presence/presence.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { WorkspaceHealthModule } from "../workspace-health/workspace-health.module";
import { IntelModule } from "../intel/intel.module";
import { WorkspacePrecomputeModule } from "../workspace-precompute/workspace-precompute.module";

@Module({
  imports: [
    PresenceModule,
    WorkspaceHealthModule,
    IntelModule,
    forwardRef(() => WorkspacePrecomputeModule),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
