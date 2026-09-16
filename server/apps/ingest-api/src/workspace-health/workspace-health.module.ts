import { Module } from "@nestjs/common";
import { WorkspaceHealthService } from "./workspace-health.service";

/**
 * Owns the deterministic hybrid Experience-Health score (0b). Reads the 0a daily
 * rollups directly, so it has no provider dependencies. Exported for the Overview
 * serving (0c) and the intel trigger (Phase 2).
 */
@Module({
  providers: [WorkspaceHealthService],
  exports: [WorkspaceHealthService],
})
export class WorkspaceHealthModule {}
