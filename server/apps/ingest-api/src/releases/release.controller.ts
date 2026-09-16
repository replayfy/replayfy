import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { ReleaseService } from "./release.service";

/**
 * Release Intelligence — releases as first-class entities with health +
 * release-over-release deltas + regression detection. The dashboard's Release
 * widget reads this; drill-to-sessions happens client-side via the recordings
 * release filter.
 */
@Controller("v1/dashboard/releases")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ReleaseController {
  constructor(private readonly releases: ReleaseService) {}

  @Get()
  intelligence(@CurrentWorkspaceId() workspaceId: number) {
    return this.releases.intelligence(workspaceId);
  }
}
