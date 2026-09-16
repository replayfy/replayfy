import { Injectable, Logger } from "@nestjs/common";

/**
 * The stored Slack connection. With the `incoming-webhook` scope the user picks
 * ONE channel during OAuth and Slack returns a webhook URL bound to it — that URL
 * IS the per-channel POST credential (stored ENCRYPTED, like an access token).
 */
export interface SlackConnection {
  /** The incoming-webhook URL we POST notifications to (secret → encrypted). */
  webhookUrl: string;
  /** The user-chosen channel, e.g. "#alerts" (display + audit; not a secret). */
  channel: string;
  teamName?: string;
  scope?: string;
}

export interface SlackMessageInput {
  title: string;
  summary?: string;
  impact?: string;
  confidence?: string;
  release?: string;
  platforms?: string[];
  sessions?: string[];
  nextSteps?: string[];
}

const AUTH_URL = "https://slack.com/oauth/v2/authorize";
const TOKEN_URL = "https://slack.com/api/oauth.v2.access";
/** incoming-webhook = the user picks a channel during OAuth; the token response
 *  returns a webhook URL bound to it that we post notifications to. Slack has no
 *  "issues", so the Slack action is a rich Block-Kit notification. */
const SCOPES = ["incoming-webhook"];

/**
 * Slack API client — the transport half of the Slack integration, mirroring
 * LinearProvider. Holds NO credentials of its own beyond the instance-level
 * OAuth APP registration (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET from env); the
 * per-workspace webhook is passed in by IntegrationsService, which owns storage.
 * There is deliberately no API-key path — every workspace connects its OWN Slack
 * via OAuth. Verified against Slack OAuth v2 (authorize/oauth.v2.access, COMMA-
 * separated scopes, incoming_webhook.url in the token response) + incoming
 * webhook Block-Kit payloads. Global fetch.
 */
@Injectable()
export class SlackProvider {
  private readonly logger = new Logger(SlackProvider.name);
  private readonly clientId = process.env.SLACK_CLIENT_ID ?? "";
  private readonly clientSecret = process.env.SLACK_CLIENT_SECRET ?? "";

  /** True when the OAuth APP is configured on this instance (not per-workspace —
   *  that's a stored webhook). Without it, no workspace can connect Slack. */
  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** The redirect URI — must EXACTLY match the one registered in the Slack app. */
  redirectUri(): string {
    const explicit = process.env.SLACK_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/slack/callback`;
  }

  /** The Slack authorize URL. Slack scopes are COMMA-separated. */
  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      scope: SCOPES.join(","),
      redirect_uri: this.redirectUri(),
      state,
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  /** Exchange an authorization code for the connection (webhook + channel). */
  async exchangeCode(code: string): Promise<SlackConnection> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri(),
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Slack token HTTP ${res.status}`);
    }
    const j = (await res.json()) as {
      ok?: boolean;
      error?: string;
      scope?: string;
      team?: { name?: string };
      incoming_webhook?: { url?: string; channel?: string };
    };
    if (!j.ok || !j.incoming_webhook?.url) {
      throw new Error(j.error || "Slack OAuth did not return an incoming webhook");
    }
    return {
      webhookUrl: j.incoming_webhook.url,
      channel: j.incoming_webhook.channel ?? "",
      teamName: j.team?.name,
      scope: j.scope,
    };
  }

  /**
   * Best-effort disconnect. Incoming webhooks have no token-revoke endpoint (the
   * owner removes the app from the workspace to invalidate it); deleting the
   * stored URL is what actually severs our ability to post. No-op kept so the
   * service can revoke uniformly across providers.
   */
  async revoke(_webhookUrl: string): Promise<void> {
    /* incoming webhooks are revoked by removing the app in Slack, not via API */
  }

  /** Post a rich Block-Kit message to a workspace's connected channel. Returns
   *  false if Slack rejects it (incoming webhooks reply with a plain "ok" body). */
  async postMessage(
    webhookUrl: string,
    input: SlackMessageInput,
  ): Promise<boolean> {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input.title.slice(0, 150),
        blocks: this.buildBlocks(input),
      }),
    });
    if (!res.ok) {
      this.logger.warn(`Slack postMessage HTTP ${res.status}`);
      return false;
    }
    return true;
  }

  /**
   * Build a rich Slack Block-Kit payload from the investigation evidence — a
   * header, the summary + business impact, a facts context line, replay links,
   * and suggested next steps — so the channel gets an actionable notification.
   */
  private buildBlocks(input: SlackMessageInput): unknown[] {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const arr = (v: unknown): string[] =>
      Array.isArray(v)
        ? (v.filter((x) => typeof x === "string") as string[])
        : [];
    const mrkdwn = (text: string) => ({
      type: "section",
      text: { type: "mrkdwn", text: text.slice(0, 2900) },
    });
    const blocks: unknown[] = [
      {
        type: "header",
        text: { type: "plain_text", text: str(input.title).slice(0, 150) || "Replayfy alert" },
      },
    ];
    if (str(input.summary)) blocks.push(mrkdwn(str(input.summary)));
    if (str(input.impact)) blocks.push(mrkdwn(`*Business impact*\n${str(input.impact)}`));

    const facts: string[] = [];
    if (str(input.confidence)) facts.push(`*Confidence:* ${str(input.confidence)}`);
    if (str(input.release)) facts.push(`*Release:* ${str(input.release)}`);
    if (arr(input.platforms).length)
      facts.push(`*Platforms:* ${arr(input.platforms).join(", ")}`);
    if (facts.length) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: facts.join("   |   ") }],
      });
    }

    const sessions = arr(input.sessions).slice(0, 10);
    if (sessions.length) {
      const base = (process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
      const links = sessions.map((s) =>
        base ? `<${base}/sessions/${s}|${s}>` : `session:${s}`,
      );
      blocks.push(mrkdwn(`*Replays*\n${links.join("  ·  ")}`));
    }

    const steps = arr(input.nextSteps);
    if (steps.length)
      blocks.push(mrkdwn(`*Suggested next steps*\n${steps.map((s) => `• ${s}`).join("\n")}`));

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Sent by Replayfy AI" }],
    });
    return blocks;
  }
}
