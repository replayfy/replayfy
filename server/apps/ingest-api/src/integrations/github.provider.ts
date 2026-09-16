import { Injectable, Logger } from "@nestjs/common";

export interface GithubTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires. GitHub OAuth-App tokens do NOT
   *  expire by default (only if the app opts into expiring tokens), so we store
   *  a far-future sentinel and the refresh grace never fires. */
  expiresInSec: number;
  scope?: string;
}

export interface GithubIssueInput {
  title: string;
  body?: string;
  labels?: string[];
}

export interface GithubCreatedIssue {
  url: string;
  number: number;
}

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** Least privilege that can still open issues in the repos the user picks. `repo`
 *  covers public + private; a public-only install can downgrade to `public_repo`. */
const SCOPES = ["repo"];
/** OAuth-App tokens are non-expiring by default → ~100y so we never "refresh". */
const NON_EXPIRING_SEC = 100 * 365 * 24 * 3600;

/**
 * GitHub API client — the transport half of the GitHub integration, mirroring
 * LinearProvider. Holds NO credentials of its own beyond the instance-level
 * OAuth APP registration (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET from env); the
 * per-workspace access token is passed in by IntegrationsService, which owns
 * storage. There is deliberately no API-key path — every workspace connects its
 * OWN GitHub via OAuth. Verified against GitHub's OAuth-App + REST Issues docs
 * (authorize/token URLs, SPACE-separated scopes, Bearer header, DELETE token
 * revoke via Basic app auth). Global fetch.
 */
@Injectable()
export class GithubProvider {
  private readonly logger = new Logger(GithubProvider.name);
  private readonly clientId = process.env.GITHUB_CLIENT_ID ?? "";
  private readonly clientSecret = process.env.GITHUB_CLIENT_SECRET ?? "";

  /** True when the OAuth APP is configured on this instance (not per-workspace —
   *  that's a stored token). Without it, no workspace can connect GitHub. */
  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** The redirect URI — must EXACTLY match the one registered in the GitHub app. */
  redirectUri(): string {
    const explicit = process.env.GITHUB_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/github/callback`;
  }

  /** The GitHub authorize URL. GitHub scopes are SPACE-separated. */
  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      scope: SCOPES.join(" "),
      state,
      allow_signup: "false",
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string): Promise<GithubTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
  }

  /** Refresh an expiring access token (only relevant if the app opted into
   *  expiring tokens; otherwise never called). */
  async refresh(refreshToken: string): Promise<GithubTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
  }

  /** Revoke a token on disconnect (best-effort): DELETE the OAuth-App grant's
   *  token via Basic app auth. */
  async revoke(token: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/applications/${this.clientId}/token`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Basic ${Buffer.from(
            `${this.clientId}:${this.clientSecret}`,
          ).toString("base64")}`,
          "User-Agent": "replay-api",
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: JSON.stringify({ access_token: token }),
      });
    } catch (e) {
      this.logger.warn(`GitHub revoke failed: ${(e as Error).message}`);
    }
  }

  /** The most recently pushed repo the token can see — the default target for new
   *  issues (mirrors Linear's firstTeamId). Empty string if none is visible. */
  async firstRepoFullName(accessToken: string): Promise<string> {
    const res = await fetch(
      `${API_BASE}/user/repos?sort=pushed&per_page=1&affiliation=owner,collaborator,organization_member`,
      { headers: this.apiHeaders(accessToken) },
    );
    if (!res.ok) return "";
    const repos = (await res.json()) as Array<{ full_name?: string }>;
    return repos[0]?.full_name ?? "";
  }

  /** Create an issue with a workspace's token. Returns null if GitHub rejects it. */
  async createIssue(
    accessToken: string,
    repoFullName: string,
    input: GithubIssueInput,
  ): Promise<GithubCreatedIssue | null> {
    const slash = repoFullName.indexOf("/");
    const owner = slash > 0 ? repoFullName.slice(0, slash) : "";
    const repo = slash > 0 ? repoFullName.slice(slash + 1) : "";
    if (!owner || !repo) return null;
    const res = await fetch(
      `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        repo,
      )}/issues`,
      {
        method: "POST",
        headers: {
          ...this.apiHeaders(accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title.slice(0, 250),
          body: (input.body ?? "").slice(0, 60000),
          labels: (input.labels ?? []).slice(0, 20),
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`GitHub issue create HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as { html_url?: string; number?: number };
    if (!j.html_url) return null;
    return { url: j.html_url, number: j.number ?? 0 };
  }

  private apiHeaders(accessToken: string): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "replay-api",
      "X-GitHub-Api-Version": API_VERSION,
    };
  }

  private async tokenRequest(
    body: Record<string, string>,
  ): Promise<GithubTokens> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      throw new Error(`GitHub token HTTP ${res.status}`);
    }
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!j.access_token) {
      throw new Error(
        j.error_description || j.error || "GitHub token response missing access_token",
      );
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresInSec: j.expires_in ?? NON_EXPIRING_SEC,
      scope: j.scope,
    };
  }
}
