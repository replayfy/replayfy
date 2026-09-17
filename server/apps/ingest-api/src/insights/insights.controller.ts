import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { InsightsService } from "./insights.service";

@Controller("v1/insights")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class InsightsController {
  constructor(private readonly service: InsightsService) {}

  @Get("kpis")
  kpis(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
  ) {
    return this.service.kpis(workspaceId, range);
  }

  @Get("funnel")
  funnel(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("steps") steps?: string,
  ) {
    return this.service.funnel(workspaceId, range, steps);
  }

  @Get("top-errors")
  topErrors(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.topErrors(workspaceId, range, cursor, limit);
  }

  @Get("friction-by-page")
  friction(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.frictionByPage(workspaceId, range, limit);
  }

  /**
   * Slowest pages by median LCP across the workspace's sessions in the
   * range. Powers the Insights → Friction → "Slow pages" widget.
   */
  @Get("slow-pages")
  slowPages(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.slowPages(workspaceId, range, limit);
  }
}
