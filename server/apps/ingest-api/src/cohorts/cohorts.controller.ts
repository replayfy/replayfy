import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import type { CohortKind } from "@replay/db-postgres";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentAuth, CurrentWorkspaceId, type AuthContext } from "../common/auth.context";
import { CohortsService } from "./cohorts.service";
import { AddCohortMembersDto, CreateCohortDto, PreviewCohortDto, UpdateCohortDto } from "./cohorts.dto";

@Controller("v1/cohorts")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CohortsController {
  constructor(private readonly service: CohortsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("kind") kind?: CohortKind,
    @Query("search") search?: string
  ) {
    return this.service.list(auth.workspaceId, auth.userId, { cursor, limit, kind, search });
  }

  @Post()
  @RequiresRole("MEMBER")
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateCohortDto) {
    return this.service.create(auth.workspaceId, auth.userId, body);
  }

  @Get(":id")
  get(@CurrentWorkspaceId() workspaceId: number, @Param("id", ParseIntPipe) id: number) {
    return this.service.get(workspaceId, id);
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  update(@CurrentWorkspaceId() workspaceId: number, @Param("id", ParseIntPipe) id: number, @Body() body: UpdateCohortDto) {
    return this.service.update(workspaceId, id, body);
  }

  @Delete(":id")
  @RequiresRole("MEMBER")
  remove(@CurrentWorkspaceId() workspaceId: number, @Param("id", ParseIntPipe) id: number) {
    return this.service.remove(workspaceId, id);
  }

  @Get(":id/members")
  members(@CurrentWorkspaceId() workspaceId: number, @Param("id", ParseIntPipe) id: number, @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.service.listMembers(workspaceId, id, cursor, limit);
  }

  /** Add one or more EndUsers to a MANUAL cohort. Idempotent — duplicates
   * are dropped silently. AUTO cohorts ignore this and recompute via filter. */
  @Post(":id/members")
  @RequiresRole("MEMBER")
  addMembers(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: AddCohortMembersDto
  ) {
    return this.service.addMembers(workspaceId, id, body?.userIds ?? []);
  }

  @Delete(":id/members/:userId")
  @RequiresRole("MEMBER")
  removeMember(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Param("userId", ParseIntPipe) userId: number
  ) {
    return this.service.removeMember(workspaceId, id, userId);
  }

  @Post(":id/refresh")
  @RequiresRole("MEMBER")
  refresh(@CurrentWorkspaceId() workspaceId: number, @Param("id", ParseIntPipe) id: number) {
    return this.service.refresh(workspaceId, id);
  }

  @Post("preview")
  preview(@CurrentWorkspaceId() workspaceId: number, @Body() body: PreviewCohortDto) {
    return this.service.preview(workspaceId, (body?.filter ?? { type: "and", groups: [] }) as unknown as Parameters<typeof this.service.preview>[1]);
  }
}
