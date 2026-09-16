import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { EndUsersService } from "./end-users.service";

@Controller("v1/end-users")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class EndUsersController {
  constructor(private readonly service: EndUsersService) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("plan") plan?: string,
    @Query("online") online?: string,
    @Query("sort") sort?: string,
    @Query("cohortId") cohortId?: string,
    @Query("country") country?: string,
    @Query("platform") platform?: string,
    @Query("userType") userType?: string,
    @Query("lastSeenDays") lastSeenDays?: string,
  ) {
    return this.service.list({
      workspaceId,
      cursor,
      limit,
      search,
      plan,
      online,
      sort,
      cohortId,
      country,
      platform,
      userType,
      lastSeenDays,
    });
  }

  /**
   * CSV export — streams the full filtered set in 1000-row pages so a
   * cohort with 50k members doesn't have to be buffered in memory or
   * paged client-side. Browser receives `text/csv` + an attachment
   * disposition, triggering a native download.
   */
  @Get("export.csv")
  async exportCsv(
    @CurrentWorkspaceId() workspaceId: number,
    @Res() res: Response,
    @Query("search") search?: string,
    @Query("plan") plan?: string,
    @Query("online") online?: string,
    @Query("cohortId") cohortId?: string,
    // Same column filters the table sends, so the download equals the on-screen
    // filtered set (streamCsv shares list's buildWhere). Without these, exporting
    // a view narrowed by country/platform/etc. produced a wider file than shown.
    @Query("country") country?: string,
    @Query("platform") platform?: string,
    @Query("userType") userType?: string,
    @Query("lastSeenDays") lastSeenDays?: string,
  ) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    await this.service.streamCsv(
      {
        workspaceId,
        search,
        plan,
        online,
        cohortId,
        country,
        platform,
        userType,
        lastSeenDays,
      },
      (chunk) => res.write(chunk),
    );
    res.end();
  }

  @Get(":id")
  get(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.get(workspaceId, id);
  }

  @Get(":id/sessions")
  sessions(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listSessions(workspaceId, id, cursor, limit);
  }

  @Get(":id/activity")
  activity(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.activity(workspaceId, id, cursor, limit);
  }

  @Get(":id/activity-chart")
  activityChart(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("days") days?: string,
    // Absolute custom window (epoch ms) from the header DatePicker's custom pick;
    // wins over `days` in the service. Named presets send `days` only.
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.service.activityChart(
      workspaceId,
      id,
      days ? Number(days) : 7,
      from ? Number(from) : undefined,
      to ? Number(to) : undefined,
    );
  }

  @Delete(":id")
  @RequiresRole("MEMBER")
  forget(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.forget(workspaceId, id);
  }
}
