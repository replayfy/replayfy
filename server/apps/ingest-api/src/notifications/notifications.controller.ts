import {
  Controller,
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
import { CurrentAuth, type AuthContext } from "../common/auth.context";
import { NotificationsService } from "./notifications.service";

@Controller("v1/notifications")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("unread") unread?: string,
  ) {
    return this.service.list(auth.userId, auth.workspaceId, {
      cursor,
      limit,
      unread,
    });
  }

  @Patch(":id/read")
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.markRead(auth.userId, id);
  }

  @Post("mark-all-read")
  markAll(@CurrentAuth() auth: AuthContext) {
    return this.service.markAllRead(auth.userId, auth.workspaceId);
  }
}
