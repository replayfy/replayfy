import {
  Injectable,
  Logger,
  BadRequestException,
  BadGatewayException,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { getPostgresClient, IntegrationProvider } from "@replay/db-postgres";
import { encryptSecret, decryptSecret } from "../llm/llm-crypto";
import { signState, verifyState } from "../auth/oauth";
import { LinearProvider } from "./linear.provider";
import { GithubProvider } from "./github.provider";
import { SlackProvider, type SlackMessageInput } from "./slack.provider";
import { PagerDutyProvider, type PagerDutyEvent } from "./pagerduty.provider";
import { WebhookProvider } from "./webhook.provider";
import { JiraProvider } from "./jira.provider";
import { LarkProvider } from "./lark.provider";
import { SentryProvider } from "./sentry.provider";
import { buildIssueBody } from "./issue-format.util";

export interface LinearIssueResult {
  created: boolean;
  /** false = this workspace hasn't connected Linear (OAuth) yet. */
  connected: boolean;
  url?: string;
  identifier?: string;
  message?: string;
}

export interface GithubIssueResult {
  created: boolean;
  /** false = this workspace hasn't connected GitHub (OAuth) yet. */
  connected: boolean;
  url?: string;
  number?: number;
  message?: string;
}

export interface SlackMessageResult {
  posted: boolean;
  /** false = this workspace hasn't connected Slack (OAuth) yet. */
  connected: boolean;
  channel?: string;
  message?: string;
}

interface StoredTokenRow {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: Date | null;
}

/** The projected session facts the deterministic session-issue action needs to
 *  build a title + body. Kept narrow so the lookup selects only these columns. */
interface SessionIssueFacts {
  publicId: string;
  startUrl: string | null;
  durationMs: number;
  errorCount: number;
  rageCount: number;
  platform: string | null;
  endUser: { name: string | null; email: string | null } | null;
}

/**
 * Integration Intelligence backend — owns per-workspace OAuth connections to
 * external services (Linear today; Slack/GitHub/Jira later, same shape). Tokens
 * are AES-256-GCM encrypted at rest (llm-crypto) and decrypted only at call
 * time. Every workspace connects its OWN external account, so a company with
 * many workspaces (each with a different Linear) stays isolated — there is NO
 * shared API key. The agent's linear.createIssue capability calls
 * createLinearIssue(workspaceId, …); the workspaceId is injected server-side.
 */
@Injectable()
export class IntegrationsService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IntegrationsService.name);
  /** Refresh the access token this long before it actually expires. */
  private static readonly REFRESH_GRACE_MS = 30 * 60 * 1000;

  constructor(
    private readonly linear: LinearProvider,
    private readonly github: GithubProvider,
    private readonly slack: SlackProvider,
    private readonly pagerduty: PagerDutyProvider,
    private readonly webhook: WebhookProvider,
    private readonly jira: JiraProvider,
    private readonly lark: LarkProvider,
    private readonly sentry: SentryProvider,
  ) {}

  /** Whether this workspace has connected the provider. */
  async isConnected(
    workspaceId: number,
    provider: IntegrationProvider,
  ): Promise<boolean> {
    const n = await this.db.workspaceIntegration.count({
      where: { workspaceId, provider },
    });
    return n > 0;
  }

  /** A workspace's connections — provider + status only, NEVER tokens. */
  async list(workspaceId: number) {
    const rows = await this.db.workspaceIntegration.findMany({
      where: { workspaceId },
      select: { provider: true, scope: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => ({
      provider: r.provider,
      connected: true,
      scope: r.scope,
      connectedAt: r.createdAt,
    }));
  }

  /** The Linear authorize URL for this workspace+user, with a CSRF-safe signed
   *  state that binds the callback to the workspace (verified server-side). */
  linearConnectUrl(workspaceId: number, userId: number): string {
    if (!this.linear.configured) {
      throw new BadRequestException(
        "Linear OAuth isn't configured on this server.",
      );
    }
    const state = signState({
      w: String(workspaceId),
      u: String(userId),
      p: "linear",
    });
    return this.linear.authorizeUrl(state);
  }

  /**
   * Handle the OAuth callback: verify the signed state, exchange the code for
   * tokens, and upsert the workspace's encrypted connection. The workspace comes
   * from the STATE (the callback has no JWT), so a tampered state can't bind
   * another tenant. Returns the workspaceId for the post-connect redirect.
   */
  async handleLinearCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "linear" || !claims.w) {
      throw new BadRequestException("Invalid OAuth state.");
    }
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const tokens = await this.linear.exchangeCode(code);
    const teamId = await this.linear
      .firstTeamId(tokens.accessToken)
      .catch(() => "");
    const data = {
      accessTokenEnc: this.enc(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken
        ? this.enc(tokens.refreshToken)
        : null,
      expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
      scope: tokens.scope ?? null,
      externalTeamId: teamId || null,
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: "LINEAR" } },
      create: {
        workspaceId,
        provider: "LINEAR",
        connectedById: userId,
        ...data,
      },
      update: { connectedById: userId, ...data },
    });
    return workspaceId;
  }

  /** Disconnect: revoke at Linear (best-effort) + delete the stored connection. */
  async disconnectLinear(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "LINEAR" } },
    });
    if (!row) return { disconnected: false };
    await this.linear
      .revoke(this.dec(row.accessTokenEnc))
      .catch(() => undefined);
    await this.db.workspaceIntegration.delete({
      where: { workspaceId_provider: { workspaceId, provider: "LINEAR" } },
    });
    return { disconnected: true };
  }

  /**
   * Create a Linear issue for a workspace using ITS OWN stored token (refreshing
   * first if it's near expiry). Never throws — returns a result the agent relays.
   */
  async createLinearIssue(
    workspaceId: number,
    input: { title: string; description?: string },
  ): Promise<LinearIssueResult> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "LINEAR" } },
    });
    if (!row) {
      return {
        created: false,
        connected: false,
        message:
          "Linear isn't connected for this workspace. Connect it in Settings → Integrations.",
      };
    }
    try {
      const accessToken = await this.freshAccessToken(workspaceId, row);
      const teamId =
        row.externalTeamId || (await this.linear.firstTeamId(accessToken));
      if (!teamId) {
        return {
          created: false,
          connected: true,
          message: "No Linear team is available to create the issue in.",
        };
      }
      const issue = await this.linear.createIssue(accessToken, teamId, input);
      if (!issue) {
        return {
          created: false,
          connected: true,
          message: "Linear rejected the issue.",
        };
      }
      return {
        created: true,
        connected: true,
        url: issue.url,
        identifier: issue.identifier,
      };
    } catch (e) {
      this.logger.warn(
        `Linear createIssue failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      return {
        created: false,
        connected: true,
        message: "Could not reach Linear.",
      };
    }
  }

  // ── GitHub ────────────────────────────────────────────────────────────────

  /** The GitHub authorize URL for this workspace+user, with a CSRF-safe signed
   *  state that binds the callback to the workspace (verified server-side). */
  githubConnectUrl(workspaceId: number, userId: number): string {
    if (!this.github.configured) {
      throw new BadRequestException(
        "GitHub OAuth isn't configured on this server.",
      );
    }
    const state = signState({
      w: String(workspaceId),
      u: String(userId),
      p: "github",
    });
    return this.github.authorizeUrl(state);
  }

  /** Handle the GitHub OAuth callback: verify the signed state, exchange the code,
   *  resolve the default repo, and upsert the encrypted connection. */
  async handleGithubCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "github" || !claims.w) {
      throw new BadRequestException("Invalid OAuth state.");
    }
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const tokens = await this.github.exchangeCode(code);
    const repo = await this.github
      .firstRepoFullName(tokens.accessToken)
      .catch(() => "");
    const data = {
      accessTokenEnc: this.enc(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken
        ? this.enc(tokens.refreshToken)
        : null,
      expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
      scope: tokens.scope ?? null,
      externalTeamId: repo || null,
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: "GITHUB" } },
      create: { workspaceId, provider: "GITHUB", connectedById: userId, ...data },
      update: { connectedById: userId, ...data },
    });
    return workspaceId;
  }

  /** Disconnect: revoke at GitHub (best-effort) + delete the stored connection. */
  async disconnectGithub(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "GITHUB" } },
    });
    if (!row) return { disconnected: false };
    await this.github
      .revoke(this.dec(row.accessTokenEnc))
      .catch(() => undefined);
    await this.db.workspaceIntegration.delete({
      where: { workspaceId_provider: { workspaceId, provider: "GITHUB" } },
    });
    return { disconnected: true };
  }

  /**
   * Create a GitHub issue for a workspace using ITS OWN stored token in ITS
   * connected repo. GitHub OAuth-App tokens don't expire, so we decrypt directly
   * (no refresh path). Never throws — returns a result the agent relays.
   */
  async createGithubIssue(
    workspaceId: number,
    input: { title: string; body?: string; labels?: string[] },
  ): Promise<GithubIssueResult> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "GITHUB" } },
    });
    if (!row) {
      return {
        created: false,
        connected: false,
        message:
          "GitHub isn't connected for this workspace. Connect it in Settings → Integrations.",
      };
    }
    try {
      const accessToken = this.dec(row.accessTokenEnc);
      const repo =
        row.externalTeamId ||
        (await this.github.firstRepoFullName(accessToken));
      if (!repo) {
        return {
          created: false,
          connected: true,
          message: "No GitHub repository is available to create the issue in.",
        };
      }
      const issue = await this.github.createIssue(accessToken, repo, input);
      if (!issue) {
        return {
          created: false,
          connected: true,
          message: "GitHub rejected the issue.",
        };
      }
      return {
        created: true,
        connected: true,
        url: issue.url,
        number: issue.number,
      };
    } catch (e) {
      this.logger.warn(
        `GitHub createIssue failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      return {
        created: false,
        connected: true,
        message: "Could not reach GitHub.",
      };
    }
  }

  // ── Slack ─────────────────────────────────────────────────────────────────

  /** The Slack authorize URL for this workspace+user, with a CSRF-safe signed
   *  state that binds the callback to the workspace (verified server-side). */
  slackConnectUrl(workspaceId: number, userId: number): string {
    if (!this.slack.configured) {
      throw new BadRequestException(
        "Slack OAuth isn't configured on this server.",
      );
    }
    const state = signState({
      w: String(workspaceId),
      u: String(userId),
      p: "slack",
    });
    return this.slack.authorizeUrl(state);
  }

  /** Handle the Slack OAuth callback: verify the signed state, exchange the code
   *  for the incoming-webhook + channel, and upsert the encrypted connection. The
   *  webhook URL (the POST credential) is stored in accessTokenEnc; the channel
   *  name in externalTeamId. */
  async handleSlackCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "slack" || !claims.w) {
      throw new BadRequestException("Invalid OAuth state.");
    }
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const conn = await this.slack.exchangeCode(code);
    const data = {
      accessTokenEnc: this.enc(conn.webhookUrl),
      refreshTokenEnc: null,
      // Incoming webhooks don't expire; null keeps the refresh grace from firing.
      expiresAt: null,
      scope: conn.scope ?? null,
      externalTeamId: conn.channel || null,
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
      create: { workspaceId, provider: "SLACK", connectedById: userId, ...data },
      update: { connectedById: userId, ...data },
    });
    return workspaceId;
  }

  /** Disconnect Slack: delete the stored webhook (severs our ability to post).
   *  Incoming webhooks have no token-revoke API — removing the app in Slack does. */
  async disconnectSlack(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    });
    if (!row) return { disconnected: false };
    await this.slack.revoke(this.dec(row.accessTokenEnc)).catch(() => undefined);
    await this.db.workspaceIntegration.delete({
      where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    });
    return { disconnected: true };
  }

  /**
   * Post a rich message to a workspace's connected Slack channel using ITS OWN
   * stored webhook. Never throws — returns a result the agent relays.
   */
  async postSlackMessage(
    workspaceId: number,
    input: SlackMessageInput,
  ): Promise<SlackMessageResult> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    });
    if (!row) {
      return {
        posted: false,
        connected: false,
        message:
          "Slack isn't connected for this workspace. Connect it in Settings → Integrations.",
      };
    }
    try {
      const webhookUrl = this.dec(row.accessTokenEnc);
      const ok = await this.slack.postMessage(webhookUrl, input);
      if (!ok) {
        return {
          posted: false,
          connected: true,
          message: "Slack rejected the message.",
        };
      }
      return {
        posted: true,
        connected: true,
        channel: row.externalTeamId ?? undefined,
      };
    } catch (e) {
      this.logger.warn(
        `Slack postMessage failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      return {
        posted: false,
        connected: true,
        message: "Could not reach Slack.",
      };
    }
  }

  // ── PagerDuty (signal alerts — Events API v2 integration key, no OAuth) ─────

  /** Store a workspace's PagerDuty service integration key (encrypted). Verifies
   *  the key works (a trigger+resolve test) before saving so a bad key fails at
   *  connect time, not at first alert. */
  async configurePagerDuty(
    workspaceId: number,
    userId: number,
    integrationKey: string,
  ): Promise<{ connected: true }> {
    const key = (integrationKey ?? "").trim();
    if (!key) throw new BadRequestException("A PagerDuty integration key is required.");
    const ok = await this.pagerduty.verify(key);
    if (!ok) {
      throw new BadRequestException(
        "PagerDuty rejected that integration key. Copy the Events API v2 key from your service's Integrations tab.",
      );
    }
    const data = {
      accessTokenEnc: this.enc(key),
      refreshTokenEnc: null,
      expiresAt: null,
      scope: "events_v2",
      externalTeamId: null,
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: "PAGERDUTY" } },
      create: { workspaceId, provider: "PAGERDUTY", connectedById: userId, ...data },
      update: { connectedById: userId, ...data },
    });
    return { connected: true };
  }

  async disconnectPagerDuty(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const n = await this.db.workspaceIntegration.deleteMany({
      where: { workspaceId, provider: "PAGERDUTY" },
    });
    return { disconnected: n.count > 0 };
  }

  /** Open/dedup a PagerDuty incident for a workspace's connected service. Never
   *  throws — the signal-alert dispatcher relays the result. */
  async sendPagerDutyAlert(
    workspaceId: number,
    ev: PagerDutyEvent,
  ): Promise<{ sent: boolean; connected: boolean; dedupKey?: string }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "PAGERDUTY" } },
    });
    if (!row) return { sent: false, connected: false };
    try {
      const dedupKey = await this.pagerduty.trigger(
        this.dec(row.accessTokenEnc),
        ev,
      );
      return { sent: !!dedupKey, connected: true, dedupKey: dedupKey ?? undefined };
    } catch (e) {
      this.logger.warn(
        `PagerDuty alert failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      return { sent: false, connected: true };
    }
  }

  // ── Webhook (outgoing JSON POST + HMAC, no OAuth) ───────────────────────────

  /** Store a workspace's outgoing-webhook URL (+ optional signing secret),
   *  encrypted as a single JSON blob in accessTokenEnc. */
  async configureWebhook(
    workspaceId: number,
    userId: number,
    url: string,
  ): Promise<{ connected: true; signingSecret: string }> {
    const trimmed = (url ?? "").trim();
    if (!this.webhook.validUrl(trimmed)) {
      throw new BadRequestException("Enter a valid http(s) webhook URL.");
    }
    // The signing secret is NOT a user choice — we mint a strong one so every
    // POST is always signed. Reuse the existing secret when the workspace only
    // edits its URL, so their verification keeps working; mint on first connect.
    const existing = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "WEBHOOK" } },
      select: { accessTokenEnc: true },
    });
    let secret = "";
    if (existing) {
      try {
        secret =
          (JSON.parse(this.dec(existing.accessTokenEnc)) as { secret?: string })
            .secret ?? "";
      } catch {
        secret = "";
      }
    }
    if (!secret) secret = this.newSigningSecret();
    const data = {
      accessTokenEnc: this.enc(JSON.stringify({ url: trimmed, secret })),
      refreshTokenEnc: null,
      expiresAt: null,
      scope: null,
      // Store the host for display without decrypting the full blob.
      externalTeamId: (() => {
        try {
          return new URL(trimmed).host;
        } catch {
          return null;
        }
      })(),
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider: "WEBHOOK" } },
      create: { workspaceId, provider: "WEBHOOK", connectedById: userId, ...data },
      update: { connectedById: userId, ...data },
    });
    return { connected: true, signingSecret: secret };
  }

  /** The connected webhook's URL + signing secret, so the dashboard can reveal
   *  the secret again after the one-time connect modal is closed. Decrypts the
   *  blob — MEMBER-guarded at the controller. Single indexed unique lookup. */
  async webhookConfig(
    workspaceId: number,
  ): Promise<{ connected: boolean; url?: string; host?: string; signingSecret?: string }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "WEBHOOK" } },
      select: { accessTokenEnc: true, externalTeamId: true },
    });
    if (!row) return { connected: false };
    try {
      const { url, secret } = JSON.parse(this.dec(row.accessTokenEnc)) as {
        url: string;
        secret?: string;
      };
      return {
        connected: true,
        url,
        host: row.externalTeamId ?? undefined,
        signingSecret: secret || undefined,
      };
    } catch {
      return { connected: true, host: row.externalTeamId ?? undefined };
    }
  }

  /** A strong, URL-safe webhook signing secret (whsec_ + 32 hex bytes). */
  private newSigningSecret(): string {
    return `whsec_${randomBytes(32).toString("hex")}`;
  }

  async disconnectWebhook(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const n = await this.db.workspaceIntegration.deleteMany({
      where: { workspaceId, provider: "WEBHOOK" },
    });
    return { disconnected: n.count > 0 };
  }

  /** POST an event to a workspace's connected webhook. Never throws. */
  async sendWebhookEvent(
    workspaceId: number,
    payload: unknown,
  ): Promise<{ sent: boolean; connected: boolean }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "WEBHOOK" } },
    });
    if (!row) return { sent: false, connected: false };
    try {
      const { url, secret } = JSON.parse(this.dec(row.accessTokenEnc)) as {
        url: string;
        secret?: string;
      };
      const ok = await this.webhook.send(url, secret || undefined, payload);
      return { sent: ok, connected: true };
    } catch (e) {
      this.logger.warn(
        `Webhook send failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      return { sent: false, connected: true };
    }
  }

  /**
   * Fan a single fired alert out to its configured external channels. A thin
   * orchestrator over the three self-resolving send* methods above — each takes
   * workspaceId, resolves its own per-workspace connection, and returns
   * {sent/posted, connected} without throwing, so this needs no try/catch and a
   * not-connected destination simply no-ops. All destinations dispatch
   * concurrently (Promise.allSettled), never awaited in series. The connection
   * secrets/URLs live in WorkspaceIntegration and are resolved inside each send*.
   */
  async notifyAlert(
    workspaceId: number,
    msg: {
      title: string;
      detail: string;
      severity: "critical" | "error" | "warning" | "info";
      dedupKey: string;
      url?: string;
    },
    destinations: Array<{
      provider: "PAGERDUTY" | "WEBHOOK" | "SLACK";
      severity?: "critical" | "error" | "warning" | "info";
    }>,
  ): Promise<void> {
    const tasks = destinations.map((d) => {
      if (d.provider === "PAGERDUTY") {
        return this.sendPagerDutyAlert(workspaceId, {
          summary: msg.title,
          severity: d.severity ?? msg.severity,
          source: "Replayfy alerts",
          dedupKey: msg.dedupKey,
          links: msg.url ? [{ href: msg.url, text: "Open in Replayfy" }] : undefined,
          customDetails: { detail: msg.detail },
        });
      }
      if (d.provider === "SLACK") {
        return this.postSlackMessage(workspaceId, {
          title: msg.title,
          summary: msg.detail,
        });
      }
      return this.sendWebhookEvent(workspaceId, {
        event: "alert.triggered",
        workspaceId,
        alert: {
          title: msg.title,
          detail: msg.detail,
          severity: d.severity ?? msg.severity,
          url: msg.url,
        },
      });
    });
    await Promise.allSettled(tasks);
  }

  // ── Jira / Lark / Sentry (per-workspace OAuth — same shape as above) ────────
  // These follow the Linear/GitHub/Slack pattern: connect → authorize URL,
  // callback → verify state + exchange + upsert encrypted token, disconnect →
  // drop it. Owner-activated (needs each provider's *_CLIENT_ID/SECRET). Token
  // refresh for Jira/Lark is a follow-up — connect stores a fresh token.

  jiraConnectUrl(workspaceId: number, userId: number): string {
    if (!this.jira.configured)
      throw new BadRequestException("Jira OAuth isn't configured on this server.");
    return this.jira.authorizeUrl(
      signState({ w: String(workspaceId), u: String(userId), p: "jira" }),
    );
  }
  async handleJiraCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "jira" || !claims.w)
      throw new BadRequestException("Invalid OAuth state.");
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const tokens = await this.jira.exchangeCode(code);
    const target = await this.jira.firstTarget(tokens.accessToken).catch(() => "");
    await this.oauthUpsert(workspaceId, userId, "JIRA", tokens, target);
    return workspaceId;
  }
  async disconnectJira(workspaceId: number): Promise<{ disconnected: boolean }> {
    const n = await this.db.workspaceIntegration.deleteMany({
      where: { workspaceId, provider: "JIRA" },
    });
    return { disconnected: n.count > 0 };
  }

  larkConnectUrl(workspaceId: number, userId: number): string {
    if (!this.lark.configured)
      throw new BadRequestException("Lark OAuth isn't configured on this server.");
    return this.lark.authorizeUrl(
      signState({ w: String(workspaceId), u: String(userId), p: "lark" }),
    );
  }
  async handleLarkCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "lark" || !claims.w)
      throw new BadRequestException("Invalid OAuth state.");
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const tokens = await this.lark.exchangeCode(code);
    const chatId = await this.lark.firstChatId(tokens.accessToken).catch(() => "");
    await this.oauthUpsert(workspaceId, userId, "LARK", tokens, chatId);
    return workspaceId;
  }
  async disconnectLark(workspaceId: number): Promise<{ disconnected: boolean }> {
    const n = await this.db.workspaceIntegration.deleteMany({
      where: { workspaceId, provider: "LARK" },
    });
    return { disconnected: n.count > 0 };
  }

  sentryConnectUrl(workspaceId: number, userId: number): string {
    if (!this.sentry.configured)
      throw new BadRequestException("Sentry OAuth isn't configured on this server.");
    return this.sentry.authorizeUrl(
      signState({ w: String(workspaceId), u: String(userId), p: "sentry" }),
    );
  }
  async handleSentryCallback(code: string, state: string): Promise<number> {
    const claims = verifyState(state);
    if (!claims || claims.p !== "sentry" || !claims.w)
      throw new BadRequestException("Invalid OAuth state.");
    const workspaceId = Number(claims.w);
    const userId = Number(claims.u);
    const tokens = await this.sentry.exchangeCode(code);
    const org = await this.sentry.firstOrgSlug(tokens.accessToken).catch(() => "");
    await this.oauthUpsert(workspaceId, userId, "SENTRY", tokens, org);
    return workspaceId;
  }
  async disconnectSentry(
    workspaceId: number,
  ): Promise<{ disconnected: boolean }> {
    const n = await this.db.workspaceIntegration.deleteMany({
      where: { workspaceId, provider: "SENTRY" },
    });
    return { disconnected: n.count > 0 };
  }

  /** Shared upsert for the OAuth trio — encrypts the token set + default target. */
  private async oauthUpsert(
    workspaceId: number,
    userId: number,
    provider: IntegrationProvider,
    tokens: { accessToken: string; refreshToken?: string; expiresInSec: number; scope?: string },
    externalTeamId: string,
  ): Promise<void> {
    const data = {
      accessTokenEnc: this.enc(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.enc(tokens.refreshToken) : null,
      expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
      scope: tokens.scope ?? null,
      externalTeamId: externalTeamId || null,
    };
    await this.db.workspaceIntegration.upsert({
      where: { workspaceId_provider: { workspaceId, provider } },
      create: { workspaceId, provider, connectedById: userId, ...data },
      update: { connectedById: userId, ...data },
    });
  }

  /** Create a Jira issue in the workspace's connected site/project. */
  async createJiraIssue(
    workspaceId: number,
    input: { title: string; description?: string },
  ): Promise<{ created: boolean; connected: boolean; url?: string; ref?: string; message?: string }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "JIRA" } },
    });
    if (!row) return { created: false, connected: false, message: "Jira isn't connected." };
    if (!row.externalTeamId)
      return { created: false, connected: true, message: "No Jira project resolved on connect." };
    try {
      const issue = await this.jira.createIssue(
        this.dec(row.accessTokenEnc),
        row.externalTeamId,
        input,
      );
      if (!issue) return { created: false, connected: true, message: "Jira rejected the issue." };
      return { created: true, connected: true, url: issue.url, ref: issue.key };
    } catch (e) {
      this.logger.warn(`Jira createIssue failed (ws ${workspaceId}): ${(e as Error).message}`);
      return { created: false, connected: true, message: "Could not reach Jira." };
    }
  }

  /** Post a message to the workspace's connected Lark chat. */
  async postLarkMessage(
    workspaceId: number,
    input: { title: string; text: string },
  ): Promise<{ posted: boolean; connected: boolean; message?: string }> {
    const row = await this.db.workspaceIntegration.findUnique({
      where: { workspaceId_provider: { workspaceId, provider: "LARK" } },
    });
    if (!row) return { posted: false, connected: false, message: "Lark isn't connected." };
    try {
      const ok = await this.lark.postMessage(
        this.dec(row.accessTokenEnc),
        row.externalTeamId ?? "",
        input,
      );
      return { posted: ok, connected: true, message: ok ? undefined : "Lark rejected the message." };
    } catch (e) {
      this.logger.warn(`Lark postMessage failed (ws ${workspaceId}): ${(e as Error).message}`);
      return { posted: false, connected: true, message: "Could not reach Lark." };
    }
  }

  // ── Session-issue (deterministic share action — NOT via the AI agent) ───────

  /**
   * File an issue / post a notification about ONE specific session, directly
   * (this is the recordings share-menu action — deterministic, not the agent).
   * Resolves the session INSIDE the caller's workspace, builds a title + rich
   * body from the session facts (reusing the shared buildIssueBody + Slack
   * Block-Kit deep-link format, so it matches an agent-filed issue), and
   * dispatches to the matching provider. Throws 404 if the session isn't in this
   * workspace, 400 if the provider isn't connected, 502 if the provider rejects
   * the call. Returns the created artifact's { url, ref }.
   */
  async createSessionIssue(
    workspaceId: number,
    provider: string,
    body: { sessionPublicId?: string; title?: string },
  ): Promise<{ url?: string; ref?: string }> {
    const normalized = (provider ?? "").toLowerCase();
    const supported = ["linear", "github", "slack", "jira", "lark"] as const;
    if (!(supported as readonly string[]).includes(normalized)) {
      throw new BadRequestException(
        `Unknown integration provider "${provider}". Use ${supported.join(", ")}.`,
      );
    }
    const publicId = body?.sessionPublicId?.trim();
    if (!publicId) {
      throw new BadRequestException("sessionPublicId is required.");
    }
    // Single indexed lookup: publicId is UNIQUE (its own btree index) and we also
    // scope by workspaceId so a caller can only ever file an issue about a session
    // in their OWN workspace. One findFirst resolving through the unique publicId
    // index — no table scan, no N+1 — so it scales to millions of Session rows.
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: {
        publicId: true,
        startUrl: true,
        durationMs: true,
        errorCount: true,
        rageCount: true,
        platform: true,
        endUser: { select: { name: true, email: true } },
      },
    });
    if (!session) {
      throw new NotFoundException("Session not found.");
    }
    return this.dispatchSessionIssue(
      workspaceId,
      normalized as "linear" | "github" | "slack" | "jira" | "lark",
      session,
      body.title,
    );
  }

  /** Route a resolved session to the right provider (Linear/GitHub issue or Slack
   *  message) and normalise the result to { url, ref }. A not-connected provider
   *  becomes a 400; an upstream provider failure becomes a 502. */
  private async dispatchSessionIssue(
    workspaceId: number,
    provider: "linear" | "github" | "slack" | "jira" | "lark",
    session: SessionIssueFacts,
    providedTitle?: string,
  ): Promise<{ url?: string; ref?: string }> {
    const title = this.sessionIssueTitle(session, providedTitle);
    const platforms = session.platform ? [session.platform] : [];
    const sessions = [session.publicId];
    const footer = "_Filed from a Replayfy recording._";

    if (provider === "jira") {
      const r = await this.createJiraIssue(workspaceId, {
        title,
        description: this.sessionSummary(session, ""),
      });
      if (!r.connected) throw new BadRequestException(r.message);
      if (!r.created)
        throw new BadGatewayException(r.message ?? "Jira rejected the issue.");
      return { url: r.url, ref: r.ref };
    }

    if (provider === "lark") {
      const r = await this.postLarkMessage(workspaceId, {
        title,
        text: this.sessionSummary(session, ""),
      });
      if (!r.connected) throw new BadRequestException(r.message);
      if (!r.posted)
        throw new BadGatewayException(r.message ?? "Lark rejected the message.");
      return { url: undefined, ref: undefined };
    }

    if (provider === "linear") {
      const r = await this.createLinearIssue(workspaceId, {
        title,
        description: buildIssueBody(
          { summary: this.sessionSummary(session, "**"), platforms, sessions },
          footer,
        ),
      });
      if (!r.connected) throw new BadRequestException(r.message);
      if (!r.created) {
        throw new BadGatewayException(r.message ?? "Linear rejected the issue.");
      }
      return { url: r.url, ref: r.identifier };
    }

    if (provider === "github") {
      const r = await this.createGithubIssue(workspaceId, {
        title,
        body: buildIssueBody(
          { summary: this.sessionSummary(session, "**"), platforms, sessions },
          footer,
        ),
        labels: ["replayfy"],
      });
      if (!r.connected) throw new BadRequestException(r.message);
      if (!r.created) {
        throw new BadGatewayException(r.message ?? "GitHub rejected the issue.");
      }
      return { url: r.url, ref: r.number != null ? `#${r.number}` : undefined };
    }

    // slack — a rich Block-Kit notification (Slack has no "issues").
    const r = await this.postSlackMessage(workspaceId, {
      title,
      summary: this.sessionSummary(session, "*"),
      platforms,
      sessions,
    });
    if (!r.connected) throw new BadRequestException(r.message);
    if (!r.posted) {
      throw new BadGatewayException(r.message ?? "Slack rejected the message.");
    }
    // Incoming webhooks return no message ts/permalink, so ref is the target
    // channel and url is left undefined (there is no per-message URL).
    return { url: undefined, ref: r.channel };
  }

  /** The share-menu title, falling back to a session summary line when the caller
   *  didn't supply one: "Session <shortId> — N errors, M rage clicks on <path>". */
  private sessionIssueTitle(
    session: SessionIssueFacts,
    providedTitle?: string,
  ): string {
    const explicit = providedTitle?.trim();
    if (explicit) return explicit.slice(0, 250);
    const shortId = session.publicId.slice(0, 8);
    const path = this.urlPath(session.startUrl);
    const errors = `${session.errorCount} error${session.errorCount === 1 ? "" : "s"}`;
    const rage = `${session.rageCount} rage click${session.rageCount === 1 ? "" : "s"}`;
    return `Session ${shortId} — ${errors}, ${rage}${
      path ? ` on ${path}` : ""
    }`.slice(0, 250);
  }

  /** The body's lead block — user/anon, URL, duration, error + rage counts — as
   *  newline-separated emphasised lines. `bold` is the emphasis token ("**" for
   *  the Linear/GitHub Markdown body, "*" for Slack mrkdwn) so both render bold. */
  private sessionSummary(session: SessionIssueFacts, bold: string): string {
    const user =
      session.endUser?.name?.trim() ||
      session.endUser?.email?.trim() ||
      "Anonymous user";
    return [
      "Filed from a session recording.",
      "",
      `${bold}User:${bold} ${user}`,
      `${bold}URL:${bold} ${session.startUrl ?? "—"}`,
      `${bold}Duration:${bold} ${this.formatDuration(session.durationMs)}`,
      `${bold}Errors:${bold} ${session.errorCount}`,
      `${bold}Rage clicks:${bold} ${session.rageCount}`,
    ].join("\n");
  }

  /** Human duration from ms ("1m 23s" / "45s"). */
  private formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round((ms ?? 0) / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  /** The path (+query) of a session's start URL for the title; the raw string if
   *  it doesn't parse as a URL, empty when absent. */
  private urlPath(startUrl: string | null): string {
    if (!startUrl) return "";
    try {
      const u = new URL(startUrl);
      return `${u.pathname}${u.search}`;
    } catch {
      return startUrl;
    }
  }

  /** A valid access token, refreshing + persisting if within the grace window of
   *  expiry. Falls back to the stored token when there's no refresh token. */
  private async freshAccessToken(
    workspaceId: number,
    row: StoredTokenRow,
  ): Promise<string> {
    const nearExpiry =
      !!row.expiresAt &&
      row.expiresAt.getTime() - Date.now() <
        IntegrationsService.REFRESH_GRACE_MS;
    if (!nearExpiry || !row.refreshTokenEnc) {
      return this.dec(row.accessTokenEnc);
    }
    const tokens = await this.linear.refresh(this.dec(row.refreshTokenEnc));
    await this.db.workspaceIntegration.update({
      where: { workspaceId_provider: { workspaceId, provider: "LINEAR" } },
      data: {
        accessTokenEnc: this.enc(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken
          ? this.enc(tokens.refreshToken)
          : row.refreshTokenEnc,
        expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
    });
    return tokens.accessToken;
  }

  /** AES-256-GCM encrypt → `iv.tag.cipher` hex (llm-crypto / LLM_KMS_KEY). */
  private enc(plaintext: string): string {
    const { cipher, iv, tag } = encryptSecret(plaintext);
    return `${iv.toString("hex")}.${tag.toString("hex")}.${cipher.toString("hex")}`;
  }

  private dec(blob: string): string {
    const [iv, tag, cipher] = blob.split(".");
    return decryptSecret({
      iv: Buffer.from(iv, "hex"),
      tag: Buffer.from(tag, "hex"),
      cipher: Buffer.from(cipher, "hex"),
    });
  }
}
