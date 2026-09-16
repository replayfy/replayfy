import { Injectable, Logger } from "@nestjs/common";

export interface JiraTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope?: string;
}
export interface JiraIssueInput {
  title: string;
  description?: string;
}
export interface JiraCreatedIssue {
  url: string;
  key: string;
}

const AUTH_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const API_BASE = "https://api.atlassian.com";
/** Least privilege to create issues + resolve the site/project, plus refresh. */
const SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
];

/**
 * Jira (Atlassian) OAuth 2.0 (3LO) client — mirrors LinearProvider/GithubProvider.
 * Instance-level app registration is JIRA_CLIENT_ID / JIRA_CLIENT_SECRET; the
 * per-workspace token is owned by IntegrationsService. The connect resolves the
 * first accessible site (cloudId) + its first project + browse URL and stores
 * them as "cloudId|projectKey|siteUrl" in externalTeamId, so createIssue can post
 * to /ex/jira/{cloudId}/rest/api/3/issue and return a browse link. Endpoints per
 * Atlassian's 3LO docs; not live-verified (owner registers the app). Global fetch.
 */
@Injectable()
export class JiraProvider {
  private readonly logger = new Logger(JiraProvider.name);
  private readonly clientId = process.env.JIRA_CLIENT_ID ?? "";
  private readonly clientSecret = process.env.JIRA_CLIENT_SECRET ?? "";

  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  redirectUri(): string {
    const explicit = process.env.JIRA_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/jira/callback`;
  }

  /** Atlassian scopes are SPACE-separated; audience + prompt=consent are required. */
  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: this.clientId,
      scope: SCOPES.join(" "),
      redirect_uri: this.redirectUri(),
      state,
      response_type: "code",
      prompt: "consent",
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(code: string): Promise<JiraTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri(),
    });
  }

  async refresh(refreshToken: string): Promise<JiraTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });
  }

  /** Atlassian has no first-party token-revoke endpoint; dropping the stored
   *  token (in IntegrationsService.disconnect) severs our access. */
  async revoke(): Promise<void> {
    /* no-op — see doc comment */
  }

  /** "cloudId|projectKey|siteUrl" for the first accessible site + project. */
  async firstTarget(accessToken: string): Promise<string> {
    try {
      const r = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
        headers: this.h(accessToken),
      });
      if (!r.ok) return "";
      const sites = (await r.json()) as Array<{ id?: string; url?: string }>;
      const site = sites[0];
      if (!site?.id) return "";
      const pr = await fetch(
        `${API_BASE}/ex/jira/${site.id}/rest/api/3/project/search?maxResults=1`,
        { headers: this.h(accessToken) },
      );
      const key = pr.ok
        ? ((await pr.json()) as { values?: Array<{ key?: string }> }).values?.[0]
            ?.key
        : "";
      return [site.id, key ?? "", site.url ?? ""].join("|");
    } catch {
      return "";
    }
  }

  async createIssue(
    accessToken: string,
    target: string,
    input: JiraIssueInput,
  ): Promise<JiraCreatedIssue | null> {
    const [cloudId, projectKey, siteUrl] = target.split("|");
    if (!cloudId || !projectKey) return null;
    const res = await fetch(
      `${API_BASE}/ex/jira/${cloudId}/rest/api/3/issue`,
      {
        method: "POST",
        headers: { ...this.h(accessToken), "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            summary: input.title.slice(0, 250),
            issuetype: { name: "Task" },
            description: this.adf(input.description ?? ""),
          },
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`Jira issue create HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { key?: string };
    if (!j.key) return null;
    const base = siteUrl?.replace(/\/$/, "") || `https://${cloudId}`;
    return { url: `${base}/browse/${j.key}`, key: j.key };
  }

  /** Jira description must be Atlassian Document Format, not plain text. */
  private adf(text: string) {
    return {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: text.slice(0, 30000) || " " }],
        },
      ],
    };
  }

  private h(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  }

  private async tokenRequest(body: Record<string, string>): Promise<JiraTokens> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jira token HTTP ${res.status}`);
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!j.access_token) throw new Error("Jira token response missing access_token");
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresInSec: j.expires_in ?? 3600,
      scope: j.scope,
    };
  }
}
