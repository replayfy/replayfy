import {
  BadRequestException,
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
import { CurrentWorkspaceId, CurrentUserId } from "../common/auth.context";
import { AlertsService } from "./alerts.service";
import {
  AlertFromFunnelDto,
  AlertFromSignalDto,
  CreateAlertDto,
  UpdateAlertDto,
} from "./alerts.dto";

/**
 * Alert CRUD for the dashboard. Every route is workspace-scoped by the JWT — a
 * tenant only ever sees or touches its own alerts. The AI creates alerts through
 * the agent's alert.create capability (create-only); the human uses these routes
 * to edit / pause / delete, which the AI is not permitted to do.
 */
@Controller("v1/alerts")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Post()
  @RequiresRole("MEMBER")
  create(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: CreateAlertDto,
  ) {
    return this.alerts.create(workspaceId, userId, body);
  }

  /**
   * "Create alert" from a dashboard Signal. A signal is backed by an Incident or
   * an Issue — pass whichever id the signal carries and this binds a recurrence
   * alert to it (fires when that signal is active/recurring again).
   */
  @Post("from-signal")
  @RequiresRole("MEMBER")
  fromSignal(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: AlertFromSignalDto,
  ) {
    if (typeof body?.incidentId === "number") {
      return this.alerts.watchIncident(
        workspaceId,
        userId,
        body.incidentId,
        body.name,
        body.emailEnabled ?? false,
      );
    }
    if (typeof body?.issueId === "number") {
      return this.alerts.watchIssue(
        workspaceId,
        userId,
        body.issueId,
        body.name,
        body.emailEnabled ?? false,
      );
    }
    throw new BadRequestException("A signal incidentId or issueId is required.");
  }

  /**
   * "Alert on this funnel" from the funnel builder. Watches the saved funnel's
   * overall conversion — DROP_PCT (relative drop vs the prior window) or
   * ABOVE/BELOW a fixed conversion %. Evaluated daily off the conversion rollup.
   */
  @Post("from-funnel")
  @RequiresRole("MEMBER")
  fromFunnel(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: AlertFromFunnelDto,
  ) {
    return this.alerts.createFunnelAlert(workspaceId, userId, body);
  }

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.alerts.list(workspaceId, {
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }

  /**
   * Edit an alert — pause/resume (`active`), retune the threshold, or change
   * where it routes (`destinations`). Only the supplied fields change.
   */
  @Patch(":id")
  @RequiresRole("MEMBER")
  update(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateAlertDto,
  ) {
    return this.alerts.update(workspaceId, id, body);
  }

  @Delete(":id")
  @RequiresRole("MEMBER")
  remove(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.alerts.remove(workspaceId, id);
  }
}
