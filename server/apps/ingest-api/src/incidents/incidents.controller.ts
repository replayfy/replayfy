import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentUserId, CurrentWorkspaceId } from "../common/auth.context";
import { IncidentCauseService } from "./incident-cause.service";
import { IncidentsService } from "./incidents.service";
import { IncidentInvestigationService } from "./incident-investigation.service";
import { IncidentFunnelService } from "./incident-funnel.service";
import { IncidentReportService } from "./incident-report.service";
import { SetIncidentStatusDto } from "./incidents.dto";

/**
 * Workspace-authed incident operations. The cause endpoint is the on-demand
 * (card-open) trigger for the LLM "likely cause"; the status PATCH backs the
 * Acknowledge / Resolve actions on an incident card.
 */
@Controller("v1/dashboard/incidents")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class IncidentsController {
  constructor(
    private readonly cause: IncidentCauseService,
    private readonly incidents: IncidentsService,
    private readonly investigation: IncidentInvestigationService,
    private readonly report: IncidentReportService,
    private readonly funnelProposer: IncidentFunnelService,
  ) {}

  /** Propose a funnel from this incident and create it. WRITE — gated to MEMBER,
   *  the SAME role the real POST /v1/funnels create requires, so this is not a
   *  weaker path to a write. The model proposes steps; the server validates them
   *  against the closed vocabulary and creates via the shared FunnelsService. */
  @Post(":id/funnel")
  @RequiresRole("MEMBER")
  createFunnel(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Param("id") id: string,
  ) {
    return this.funnelProposer.proposeAndCreate(workspaceId, userId, Number(id));
  }

  /** The DETERMINISTIC investigation — measured facts only, no model. Read-only,
   *  so VIEWER is enough (the cause endpoint below spends tokens and needs MEMBER). */
  /** The ISSUE twin — deterministic only, no AI report. See issueDetail. */
  @Get("issue/:id/investigation")
  @RequiresRole("VIEWER")
  async investigateIssue(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
  ) {
    const r = await this.investigation.issueDetail(workspaceId, Number(id));
    if (!r) throw new NotFoundException("issue not found");
    return r;
  }

  @Get(":id/investigation")
  @RequiresRole("VIEWER")
  async investigate(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
  ) {
    const r = await this.investigation.detail(workspaceId, Number(id));
    if (!r) throw new NotFoundException("incident not found");
    return r;
  }

  /**
   * The incident HEADER — id, title, status and how many sessions are currently
   * attributed to it. Backs the Recordings `?incident=` scope banner, which
   * needs a label and an honest count, not the whole investigation panel.
   *
   * Read-only, so VIEWER matches the investigation route above. The title is
   * resolved here rather than carried in the URL on purpose: it is a
   * server-owned column the clusterer regenerates on every upsert, so a link
   * pasted into chat would otherwise render a title the incident no longer has,
   * and the banner would confidently disagree with the rows beneath it.
   */
  @Get(":id")
  @RequiresRole("VIEWER")
  async summary(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
  ) {
    const r = await this.investigation.summary(workspaceId, Number(id));
    if (!r) throw new NotFoundException("incident not found");
    return r;
  }

  /**
   * The AI INVESTIGATION REPORT — the richer successor to `:id/cause`, which is
   * left in place so an older client keeps working (its `{cause, confidence}`
   * shape is not a subset of this one).
   *
   * MEMBER, not VIEWER: this spends the workspace's AI credits, so it sits with
   * the other token-spending route rather than with the read-only investigation
   * endpoint above. `?refresh=1` bypasses the cached report.
   */
  @Post(":id/report")
  @RequiresRole("MEMBER")
  generateReport(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
    @Query("refresh") refresh?: string,
  ) {
    return this.report.reportFor(workspaceId, Number(id), {
      refresh: refresh === "1",
    });
  }

  @Post(":id/cause")
  @RequiresRole("MEMBER")
  generateCause(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
    @Query("refresh") refresh?: string,
  ) {
    return this.cause.causeFor(workspaceId, Number(id), {
      refresh: refresh === "1",
    });
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  setStatus(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
    @Body() body: SetIncidentStatusDto,
  ) {
    return this.incidents.setStatus(
      workspaceId,
      Number(id),
      body?.status ?? "ACK",
    );
  }
}
