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
import { CommentsService } from "./comments.service";
import { CreateCommentDto, UpdateCommentDto } from "./comments.dto";

@Controller("v1/comments")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  listFeed(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listForWorkspace(workspaceId, cursor, limit);
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  update(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateCommentDto,
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
}

@Controller("v1/sessions/:publicId/comments")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SessionCommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listForSession(workspaceId, publicId, cursor, limit);
  }

  @Post()
  @RequiresRole("MEMBER")
  create(
    @CurrentAuth() auth: AuthContext,
    @Param("publicId") publicId: string,
    @Body() body: CreateCommentDto,
  ) {
    return this.service.create(auth.workspaceId, auth.userId, publicId, body);
  }
}
