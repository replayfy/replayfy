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
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import {
  CurrentAuth,
  CurrentWorkspaceId,
  type AuthContext,
} from "../common/auth.context";
import { PlaylistsService } from "./playlists.service";
import {
  AddSessionDto,
  CreatePlaylistDto,
  UpdatePlaylistDto,
} from "./playlists.dto";

@Controller("v1/playlists")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class PlaylistsController {
  constructor(private readonly service: PlaylistsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("filter") filter?: string,
  ) {
    return this.service.list(auth.workspaceId, auth.userId, {
      cursor,
      limit,
      filter,
    });
  }

  @Post()
  @RequiresRole("MEMBER")
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreatePlaylistDto,
  ) {
    return this.service.create(auth.workspaceId, auth.userId, body);
  }

  @Get(":id")
  get(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.get(workspaceId, id);
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  update(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdatePlaylistDto,
  ) {
    return this.service.update(workspaceId, id, body);
  }

  @Delete(":id")
  @RequiresRole("MEMBER")
  remove(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.remove(workspaceId, id);
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

  @Post(":id/sessions")
  @RequiresRole("MEMBER")
  addSession(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: AddSessionDto,
  ) {
    return this.service.addSession(workspaceId, id, body.sessionId);
  }

  @Delete(":id/sessions/:sessionId")
  @RequiresRole("MEMBER")
  removeSession(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Param("sessionId", ParseIntPipe) sessionId: number,
  ) {
    return this.service.removeSession(workspaceId, id, sessionId);
  }
}
