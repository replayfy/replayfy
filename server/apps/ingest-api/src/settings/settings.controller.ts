import {
  Body,
  Controller,
  Get,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { SettingsService } from "./settings.service";
import { LlmService } from "../llm/llm.service";
import {
  SetAiModeDto,
  SetBusinessDto,
  SetIntelIntervalDto,
  SetLlmDto,
  SetMaskingDto,
  SetRecordingDto,
  SetRegionDto,
  SetRetentionDto,
  SetSamplingDto,
} from "./settings.dto";

// Every PATCH here mutates workspace-wide configuration. VIEWER is
// strictly read-only across all settings; the guard rejects with 403
// before the handler runs.
@Controller("v1/settings")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    private readonly llm: LlmService,
  ) {}

  @Get("recording")
  @RequiresRole("MEMBER")
  getRecording(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getRecording(workspaceId);
  }
  @Patch("recording")
  @RequiresRole("ADMIN")
  setRecording(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetRecordingDto,
  ) {
    return this.service.setRecording(workspaceId, body);
  }

  @Get("masking")
  @RequiresRole("MEMBER")
  getMasking(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getMasking(workspaceId);
  }
  @Patch("masking")
  @RequiresRole("ADMIN")
  setMasking(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetMaskingDto,
  ) {
    return this.service.setMasking(workspaceId, body);
  }

  @Get("retention")
  @RequiresRole("MEMBER")
  getRetention(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getRetention(workspaceId);
  }
  @Patch("retention")
  @RequiresRole("ADMIN")
  setRetention(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetRetentionDto,
  ) {
    return this.service.setRetention(workspaceId, body);
  }

  // Deployment region (data residency) — write-once, set during onboarding.
  // ADMIN-gated like other owner/admin-level workspace concerns.
  @Get("region")
  @RequiresRole("MEMBER")
  getRegion(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getRegion(workspaceId);
  }
  @Patch("region")
  @RequiresRole("ADMIN")
  setRegion(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetRegionDto,
  ) {
    return this.service.setRegion(workspaceId, body.dataRegion);
  }

  @Get("sampling")
  @RequiresRole("MEMBER")
  getSampling(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getSampling(workspaceId);
  }
  @Patch("sampling")
  @RequiresRole("ADMIN")
  setSampling(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetSamplingDto,
  ) {
    return this.service.setSampling(workspaceId, body);
  }

  // AI intelligence layer on/off (owner/admin only — ADMIN covers ADMIN+OWNER).
  @Get("ai-mode")
  @RequiresRole("MEMBER")
  getAiMode(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getAiMode(workspaceId);
  }
  @Patch("ai-mode")
  @RequiresRole("ADMIN")
  setAiMode(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetAiModeDto,
  ) {
    return this.service.setAiMode(workspaceId, body);
  }

  // How often the AI intelligence pass regenerates the storyline + insights (hrs;
  // 0 = off). Numbers still refresh ~5-min regardless.
  @Get("intel-interval")
  @RequiresRole("MEMBER")
  getIntelInterval(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getIntelInterval(workspaceId);
  }
  @Patch("intel-interval")
  @RequiresRole("ADMIN")
  setIntelInterval(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetIntelIntervalDto,
  ) {
    return this.service.setIntelInterval(workspaceId, body);
  }

  @Get("business")
  @RequiresRole("MEMBER")
  getBusiness(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getBusiness(workspaceId);
  }
  @Patch("business")
  @RequiresRole("ADMIN")
  setBusiness(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetBusinessDto,
  ) {
    return this.service.setBusiness(workspaceId, body);
  }

  // LLM provider config (doc 10 §3). The key is write-only — GET never returns
  // it, only its last 4. mode = DISABLED | PLATFORM | BYOK.
  @Get("llm")
  @RequiresRole("MEMBER")
  getLlm(@CurrentWorkspaceId() workspaceId: number) {
    return this.llm.getPublicConfig(workspaceId);
  }
  @Patch("llm")
  @RequiresRole("ADMIN")
  setLlm(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: SetLlmDto,
  ) {
    return this.llm.setConfig(workspaceId, body);
  }

  @Get("integrations")
  @RequiresRole("MEMBER")
  getIntegrations(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.getIntegrations(workspaceId);
  }

  /**
   * AI token/cost audit for the workspace owner — total tokens + estimated cost
   * broken down by surface (ask, guard, narrate, …) over the last `days`
   * (default 30), plus the most recent line items.
   */
  @Get("ai/usage")
  @RequiresRole("MEMBER")
  aiUsage(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("days") days?: string,
  ) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.llm.usage(workspaceId, {
      sinceMs: Date.now() - d * 24 * 60 * 60 * 1000,
    });
  }
}
