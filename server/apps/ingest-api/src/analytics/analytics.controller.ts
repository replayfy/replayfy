import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { AnalyticsService } from "./analytics.service";
import { TrendsSeriesDto } from "./analytics.dto";

/**
 * Analytics section reads (Trends / Retention / Web Vitals / Breakdowns /
 * Events). All routes are workspace-scoped via the guards — workspaceId is
 * server-derived from the authenticated membership, never a query param — and
 * every underlying query is a tenant-bounded, partition-pruned ClickHouse scan.
 */
@Controller("v1/analytics")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get("breakdown")
  breakdown(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("dimension") dimension?: string,
    @Query("measure") measure?: string,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.breakdown(workspaceId, {
      dimension,
      measure,
      range,
      from,
      to,
    });
  }

  @Post("series")
  series(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: TrendsSeriesDto,
  ) {
    return this.service.series(workspaceId, body);
  }

  @Get("retention")
  retention(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("action") action?: string,
    @Query("granularity") granularity?: string,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.retention(workspaceId, {
      action,
      granularity,
      range,
      from,
      to,
    });
  }

  @Get("web-vitals")
  webVitals(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("device") device?: string,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.webVitals(workspaceId, { device, range, from, to });
  }

  @Get("events")
  events(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.events(workspaceId, { range, from, to });
  }

  @Get("properties")
  properties(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.properties(workspaceId, { range, from, to });
  }

  @Get("schema")
  schema(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.schema(workspaceId, { range, from, to });
  }
}
