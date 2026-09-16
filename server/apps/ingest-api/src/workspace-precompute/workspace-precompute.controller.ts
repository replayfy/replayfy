import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { WorkspacePrecomputeService } from "./workspace-precompute.service";
import { SetStorylineIntervalDto } from "./workspace-precompute.dto";

/**
 * Manual recompute trigger + cached-snapshot read. Both are workspace-scoped by
 * the JWT — a tenant can only recompute or read its own snapshot.
 */
@Controller("v1/dashboard")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class WorkspacePrecomputeController {
  constructor(private readonly precompute: WorkspacePrecomputeService) {}

  /**
   * Recompute this workspace's L1 snapshot NOW and reset its hour — backs the
   * dashboard "refresh" action. The next sweep then leaves it alone until it's
   * dirty or stale again.
   */
  @Post("recompute")
  @RequiresRole("MEMBER")
  async recompute(@CurrentWorkspaceId() workspaceId: number) {
    await this.precompute.recomputeWorkspace(workspaceId);
    return { ok: true };
  }

  /** The cached L1 snapshot (overview + metrics) for an instant dashboard load. */
  @Get("snapshot")
  snapshot(@CurrentWorkspaceId() workspaceId: number) {
    return this.precompute.snapshot(workspaceId);
  }

  /**
   * Set how often the AI re-narrates the storyline (hours; 0 = off). Backs the
   * Settings → AI "Storyline refresh" control. The dashboard numbers stay
   * ~5-min fresh regardless — only the LLM narration cadence changes.
   */
  @Patch("storyline-interval")
  @RequiresRole("ADMIN")
  setStorylineInterval(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetStorylineIntervalDto,
  ) {
    return this.precompute.setStorylineInterval(
      workspaceId,
      Number(body?.hours ?? 12),
    );
  }
}
