import { Injectable, Logger } from "@nestjs/common";

export interface LinearTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires (Linear ≈ 86399 = 24h). */
  expiresInSec: number;
  scope?: string;
}

export interface LinearIssueInput {
  title: string;
  description?: string;
}

export interface LinearCreatedIssue {
  url: string;
  identifier: string;
}

interface GqlResponse {
  data?: {
    issueCreate?: {
      success?: boolean;
      issue?: { identifier?: string; url?: string };
    };
    teams?: { nodes?: Array<{ id?: string }> };
  };
  errors?: Array<{ message?: string }>;
}

const AUTH_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const GRAPHQL_URL = "https://api.linear.app/graphql";
/** Least privilege: read (to resolve teams) + issues:create. */
const SCOPES = ["read", "issues:create"];

/**
 * Linear API client — the transport half of the Linear integration. Holds NO
 * credentials of its own beyond the instance-level OAuth APP registration
 * (LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET from env); the per-workspace access
 * token is passed in by IntegrationsService, which owns storage + refresh. There
 * is deliberately no API-key path — every workspace connects its OWN Linear via
 * OAuth. Verified against Linear's OAuth 2.0 docs (authorize/token/revoke URLs,
 * comma-separated scopes, 24h tokens + refresh, Bearer header). Global fetch.
 */
@Injectable()
export class LinearProvider {
  private readonly logger = new Logger(LinearProvider.name);
  private readonly clientId = process.env.LINEAR_CLIENT_ID ?? "";
  private readonly clientSecret = process.env.LINEAR_CLIENT_SECRET ?? "";

  /** True when the OAuth APP is configured on this instance (not per-workspace —
   *  that's a stored token). Without it, no workspace can connect Linear. */
  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** The redirect URI — must EXACTLY match the one registered in the Linear app. */
  redirectUri(): string {
    const explicit = process.env.LINEAR_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/linear/callback`;
  }

  /** The Linear authorize URL. scope is COMMA-separated; actor=app so issues are
   *  attributed to the Replayfy app rather than the connecting user. */
  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: SCOPES.join(","),
      state,
      actor: "app",
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(code: string): Promise<LinearTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
  }

  /** Refresh an expiring access token (Linear rotates the refresh token too). */
  async refresh(refreshToken: string): Promise<LinearTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
  }

  /** Revoke a token on disconnect (best-effort). */
  async revoke(token: string): Promise<void> {
    try {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch (e) {
      this.logger.warn(`Linear revoke failed: ${(e as Error).message}`);
    }
  }

  /** The first team id the token can see — the default board for new issues. */
  async firstTeamId(accessToken: string): Promise<string> {
    const r = await this.gql(
      accessToken,
      `query { teams(first: 1) { nodes { id } } }`,
      {},
    );
    return r.data?.teams?.nodes?.[0]?.id ?? "";
  }

  /** Create an issue with a workspace's token. Returns null if Linear rejects it. */
  async createIssue(
    accessToken: string,
    teamId: string,
    input: LinearIssueInput,
  ): Promise<LinearCreatedIssue | null> {
    const r = await this.gql(
      accessToken,
      `mutation IssueCreate($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { identifier url } }
       }`,
      {
        input: {
          title: input.title.slice(0, 250),
          description: (input.description ?? "").slice(0, 20000),
          teamId,
        },
      },
    );
    const issue = r.data?.issueCreate?.issue;
    if (!r.data?.issueCreate?.success || !issue?.url) {
      const msg = r.errors?.[0]?.message;
      if (msg) this.logger.warn(`Linear issueCreate rejected: ${msg}`);
      return null;
    }
    return { url: issue.url, identifier: issue.identifier ?? "" };
  }

  private async tokenRequest(
    body: Record<string, string>,
  ): Promise<LinearTokens> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      throw new Error(`Linear token HTTP ${res.status}`);
    }
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!j.access_token) {
      throw new Error("Linear token response missing access_token");
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresInSec: j.expires_in ?? 86399,
      scope: j.scope,
    };
  }

  private async gql(
    accessToken: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GqlResponse> {
    const r = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) {
      throw new Error(`Linear HTTP ${r.status}`);
    }
    return (await r.json()) as GqlResponse;
  }
}
