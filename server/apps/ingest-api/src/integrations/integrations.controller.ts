import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId, CurrentUserId } from "../common/auth.context";
import { IntegrationsService } from "./integrations.service";
import {
  ConfigurePagerDutyDto,
  ConfigureWebhookDto,
  CreateSessionIssueDto,
} from "./integrations.dto";

/**
 * Integration connect / status / disconnect (Linear, GitHub, Slack — same
 * per-workspace OAuth shape). The connect + list + disconnect routes are
 * JWT-guarded and workspace-scoped. The OAuth callback is deliberately PUBLIC —
 * the provider redirects the browser there without our session — and is secured
 * instead by the signed `state` (which binds it to a workspace).
 */
@Controller("v1/integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  list(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.list(workspaceId);
  }

  /** Returns the Linear authorize URL for the dashboard to redirect the user to. */
  @Get("linear/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectLinear(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return {
      authorizeUrl: this.integrations.linearConnectUrl(workspaceId, userId),
    };
  }

  /** OAuth callback (PUBLIC, state-verified). Stores the workspace's tokens and
   *  302s the browser back to the dashboard's integrations settings. */
  @Get("linear/callback")
  async linearCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    const base = (process.env.DASHBOARD_URL ?? "http://127.0.0.1:5180").replace(
      /\/$/,
      "",
    );
    if (error || !code || !state) {
      return res.redirect(`${base}/settings/integrations?linear=error`);
    }
    try {
      await this.integrations.handleLinearCallback(code, state);
      return res.redirect(`${base}/settings/integrations?linear=connected`);
    } catch {
      return res.redirect(`${base}/settings/integrations?linear=error`);
    }
  }

  @Delete("linear")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectLinear(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectLinear(workspaceId);
  }

  // ── GitHub ────────────────────────────────────────────────────────────────

  /** Returns the GitHub authorize URL for the dashboard to redirect the user to. */
  @Get("github/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectGithub(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return {
      authorizeUrl: this.integrations.githubConnectUrl(workspaceId, userId),
    };
  }

  /** OAuth callback (PUBLIC, state-verified). Stores the workspace's tokens and
   *  302s the browser back to the dashboard's integrations settings. */
  @Get("github/callback")
  async githubCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    const base = (process.env.DASHBOARD_URL ?? "http://127.0.0.1:5180").replace(
      /\/$/,
      "",
    );
    if (error || !code || !state) {
      return res.redirect(`${base}/settings/integrations?github=error`);
    }
    try {
      await this.integrations.handleGithubCallback(code, state);
      return res.redirect(`${base}/settings/integrations?github=connected`);
    } catch {
      return res.redirect(`${base}/settings/integrations?github=error`);
    }
  }

  @Delete("github")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectGithub(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectGithub(workspaceId);
  }

  // ── Slack ─────────────────────────────────────────────────────────────────

  /** Returns the Slack authorize URL for the dashboard to redirect the user to. */
  @Get("slack/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectSlack(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return {
      authorizeUrl: this.integrations.slackConnectUrl(workspaceId, userId),
    };
  }

  /** OAuth callback (PUBLIC, state-verified). Stores the workspace's webhook and
   *  302s the browser back to the dashboard's integrations settings. */
  @Get("slack/callback")
  async slackCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    const base = (process.env.DASHBOARD_URL ?? "http://127.0.0.1:5180").replace(
      /\/$/,
      "",
    );
    if (error || !code || !state) {
      return res.redirect(`${base}/settings/integrations?slack=error`);
    }
    try {
      await this.integrations.handleSlackCallback(code, state);
      return res.redirect(`${base}/settings/integrations?slack=connected`);
    } catch {
      return res.redirect(`${base}/settings/integrations?slack=error`);
    }
  }

  @Delete("slack")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectSlack(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectSlack(workspaceId);
  }

  // ── PagerDuty (signal alerts — integration key, no OAuth redirect) ──────────

  /** Store the workspace's PagerDuty Events API v2 integration key. Verified +
   *  encrypted server-side; MEMBER-guarded. */
  @Post("pagerduty/configure")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  configurePagerDuty(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: ConfigurePagerDutyDto,
  ) {
    return this.integrations.configurePagerDuty(
      workspaceId,
      userId,
      body?.integrationKey ?? "",
    );
  }

  @Delete("pagerduty")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectPagerDuty(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectPagerDuty(workspaceId);
  }

  // ── Webhook (outgoing JSON POST — URL config, no OAuth redirect) ────────────

  /** Store the workspace's outgoing webhook URL. The signing secret is minted
   *  server-side (never a user input) and returned once so the modal can show
   *  it — the caller verifies our X-Replayfy-Signature header with it. */
  @Post("webhook/configure")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  configureWebhook(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: ConfigureWebhookDto,
  ) {
    return this.integrations.configureWebhook(
      workspaceId,
      userId,
      body?.url ?? "",
    );
  }

  /** Reveal the connected webhook's URL + signing secret (MEMBER-guarded) so
   *  the dashboard can re-display the secret after the connect modal is closed. */
  @Get("webhook/config")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  webhookConfig(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.webhookConfig(workspaceId);
  }

  @Delete("webhook")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectWebhook(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectWebhook(workspaceId);
  }

  // ── Jira / Lark / Sentry (per-workspace OAuth — same shape as Linear) ───────

  @Get("jira/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectJira(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return { authorizeUrl: this.integrations.jiraConnectUrl(workspaceId, userId) };
  }
  @Get("jira/callback")
  async jiraCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    return this.oauthRedirect("jira", code, state, error, res, () =>
      this.integrations.handleJiraCallback(code, state),
    );
  }
  @Delete("jira")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectJira(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectJira(workspaceId);
  }

  @Get("lark/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectLark(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return { authorizeUrl: this.integrations.larkConnectUrl(workspaceId, userId) };
  }
  @Get("lark/callback")
  async larkCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    return this.oauthRedirect("lark", code, state, error, res, () =>
      this.integrations.handleLarkCallback(code, state),
    );
  }
  @Delete("lark")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectLark(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectLark(workspaceId);
  }

  @Get("sentry/connect")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  connectSentry(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
  ) {
    return {
      authorizeUrl: this.integrations.sentryConnectUrl(workspaceId, userId),
    };
  }
  @Get("sentry/callback")
  async sentryCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    return this.oauthRedirect("sentry", code, state, error, res, () =>
      this.integrations.handleSentryCallback(code, state),
    );
  }
  @Delete("sentry")
  @RequiresRole("MEMBER")
  @UseGuards(JwtAuthGuard)
  disconnectSentry(@CurrentWorkspaceId() workspaceId: number) {
    return this.integrations.disconnectSentry(workspaceId);
  }

  /** Shared OAuth callback → dashboard redirect (PUBLIC, state-verified). */
  private async oauthRedirect(
    provider: string,
    code: string,
    state: string,
    error: string,
    res: Response,
    handle: () => Promise<number>,
  ) {
    const base = (process.env.DASHBOARD_URL ?? "http://127.0.0.1:5180").replace(
      /\/$/,
      "",
    );
    if (error || !code || !state) {
      return res.redirect(`${base}/settings/integrations?${provider}=error`);
    }
    try {
      await handle();
      return res.redirect(`${base}/settings/integrations?${provider}=connected`);
    } catch {
      return res.redirect(`${base}/settings/integrations?${provider}=error`);
    }
  }

  // ── Session share action (deterministic — NOT the AI agent) ─────────────────

  /**
   * File a Linear/GitHub issue (or post a Slack notification) about ONE specific
   * recording, straight from the recordings share menu. `:provider` is
   * linear|github|slack. Workspace-scoped + MEMBER-guarded: the session is
   * resolved inside the caller's workspace (404 if not found), the provider must
   * be connected (400 otherwise), and the response is the created artifact's
   * { url, ref } (issue URL + key, or the Slack channel for an incoming webhook).
   */
  @Post(":provider/session-issue")
  @UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
  @RequiresRole("MEMBER")
  createSessionIssue(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("provider") provider: string,
    @Body() body: CreateSessionIssueDto,
  ) {
    return this.integrations.createSessionIssue(workspaceId, provider, body);
  }
}
