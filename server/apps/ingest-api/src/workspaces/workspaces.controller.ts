import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard, JwtUserGuard } from "../common/auth.guard";
import {
  RequiresRole,
  WorkspaceRoleGuard,
  WorkspacePathId,
} from "../common/role.guard";
import {
  CurrentAuth,
  CurrentUser,
  type AuthContext,
  type UserAuthContext,
} from "../common/auth.context";
import { WorkspacesService } from "./workspaces.service";
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  UpdateMemberRoleDto,
  CreateInviteDto,
} from "./workspaces.dto";

// Guards are per-route, not class-wide: the first three routes run during
// onboarding, before the caller has any workspace, so JwtAuthGuard's
// membership lookup would 401 them. They authenticate the user only and key
// off userId. Everything below acts on an existing workspace and keeps the
// workspace-scoped pair.
// Every `:id`-scoped route here targets a WORKSPACE by id. @WorkspacePathId()
// makes WorkspaceRoleGuard confine `:id` to the caller's authenticated
// workspace, so a member of one workspace can't read/mutate another by id
// (the cross-tenant BOLA on /v1/workspaces/:id/members and siblings).
@WorkspacePathId()
@Controller("v1/workspaces")
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  @UseGuards(JwtUserGuard)
  list(@CurrentUser() user: UserAuthContext) {
    return this.service.listForUser(user.userId);
  }

  // Not role-gated: the caller becomes OWNER of a brand-new workspace, so the
  // role on their *current* one is irrelevant — and they may have none.
  @Post()
  @UseGuards(JwtUserGuard)
  create(
    @CurrentUser() user: UserAuthContext,
    @Body() body: CreateWorkspaceDto,
  ) {
    return this.service.createForUser(user.userId, body);
  }

  // Must stay above @Get(":id") — Nest matches in declaration order and the
  // id route would claim "slug-available" first.
  @Get("slug-available")
  @UseGuards(JwtUserGuard)
  slugAvailable(@Query("slug") slug?: string) {
    return this.service.slugAvailable(slug ?? "");
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  get(@CurrentAuth() auth: AuthContext, @Param("id", ParseIntPipe) id: number) {
    return this.service.get(id, auth.userId);
  }

  @Patch(":id")
  // Renaming the workspace is changing a setting — "Admin: can also change settings".
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  update(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateWorkspaceDto,
  ) {
    return this.service.update(id, auth.userId, body);
  }

  @Delete(":id")
  // OWNER, not ADMIN: workspaces.service.remove() demands ["OWNER"], and a
  // decorator looser than the service it fronts is how the dashboard came to
  // offer an admin a Delete button the service would refuse.
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("OWNER")
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    await this.service.remove(id, auth.userId);
    return { id };
  }

  @Get(":id/members")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  members(
    @Param("id", ParseIntPipe) id: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listMembers({ workspaceId: id, cursor, limit });
  }

  @Patch(":id/members/:memberId")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  updateMember(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Param("memberId", ParseIntPipe) memberId: number,
    @Body() body: UpdateMemberRoleDto,
  ) {
    return this.service.updateMemberRole(id, auth.userId, memberId, body.role);
  }

  @Delete(":id/members/:memberId")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Param("memberId", ParseIntPipe) memberId: number,
  ) {
    return this.service.removeMember(id, auth.userId, memberId);
  }

  // Leave the workspace yourself. MEMBER-gated: any member may leave (the guard
  // only confirms you belong here); the service blocks the last owner from
  // orphaning it. Acts strictly on the caller's own membership.
  @Post(":id/leave")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  leave(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.leaveWorkspace(id, auth.userId);
  }

  @Get(":id/invites")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  invites(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.listInvites(id, auth.userId);
  }

  @Post(":id/invites")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  createInvite(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: CreateInviteDto,
  ) {
    return this.service.createInvite(id, auth.userId, body);
  }

  @Post(":id/invites/:inviteId/resend")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  async resendInvite(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Param("inviteId", ParseIntPipe) inviteId: number,
  ) {
    await this.service.resendInvite(id, auth.userId, inviteId);
    return { id: inviteId, resent: true };
  }

  @Delete(":id/invites/:inviteId")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("ADMIN")
  async cancelInvite(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Param("inviteId", ParseIntPipe) inviteId: number,
  ) {
    await this.service.cancelInvite(id, auth.userId, inviteId);
    return { id: inviteId, cancelled: true };
  }
}
