import { Injectable, Logger } from "@nestjs/common";

export interface SentryTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope?: string;
}

const AUTH_URL = "https://sentry.io/oauth/authorize/";
const TOKEN_URL = "https://sentry.io/oauth/token/";
const API_BASE = "https://sentry.io/api/0";
/** Read-only: resolve the org + read issues/events. Sentry is a monitoring
 *  SOURCE (errors flow in from it), not an issue-creation target, so no write. */
const SCOPES = ["org:read", "project:read", "event:read"];

/**
 * Sentry OAuth client — mirrors the other providers. Instance app registration
 * is SENTRY_CLIENT_ID / SENTRY_CLIENT_SECRET; the per-workspace token is owned by
 * IntegrationsService. Connect stores the token + the first org slug; there is no
 * create-issue action (Sentry issues are ingested from errors, not created via
 * API) — the connection is for reading/linking. Endpoints per Sentry's OAuth
 * docs; not live-verified (owner registers the app). Global fetch.
 */
@Injectable()
export class SentryProvider {
  private readonly logger = new Logger(SentryProvider.name);
  private readonly clientId = process.env.SENTRY_CLIENT_ID ?? "";
  private readonly clientSecret = process.env.SENTRY_CLIENT_SECRET ?? "";

  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  redirectUri(): string {
    const explicit = process.env.SENTRY_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/sentry/callback`;
  }

  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(code: string): Promise<SentryTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri(),
    });
  }

  async refresh(refreshToken: string): Promise<SentryTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });
  }

  /** No first-party token revoke; dropping the stored token severs access. */
  async revoke(): Promise<void> {
    /* no-op */
  }

  /** First org slug the token can see — stored for later read/linking. */
  async firstOrgSlug(accessToken: string): Promise<string> {
    try {
      const r = await fetch(`${API_BASE}/organizations/`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return "";
      const orgs = (await r.json()) as Array<{ slug?: string }>;
      return orgs[0]?.slug ?? "";
    } catch {
      return "";
    }
  }

  private async tokenRequest(
    body: Record<string, string>,
  ): Promise<SentryTokens> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) throw new Error(`Sentry token HTTP ${res.status}`);
    const j = (await res.json()) as {
      access_token?: string;
      refreshToken?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!j.access_token) throw new Error("Sentry token response missing access_token");
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? j.refreshToken,
      expiresInSec: j.expires_in ?? 8 * 3600,
      scope: j.scope,
    };
  }
}
