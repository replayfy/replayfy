import { Injectable, Logger } from "@nestjs/common";

export interface LarkTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope?: string;
}
export interface LarkMessageInput {
  title: string;
  text: string;
}

const BASE = "https://open.larksuite.com/open-apis";
const AUTH_URL = `${BASE}/authen/v1/authorize`;

/**
 * Lark (Feishu) OAuth client — mirrors the other providers. Lark uses app_id /
 * app_secret (LARK_APP_ID / LARK_APP_SECRET): an app_access_token is fetched
 * first, then the auth code is exchanged for a per-user token. Connect resolves
 * the first group chat id (stored in externalTeamId) so postMessage can send to
 * it. Endpoints per Lark's authen v1 + im v1 docs; not live-verified (owner
 * registers the app). Global fetch.
 */
@Injectable()
export class LarkProvider {
  private readonly logger = new Logger(LarkProvider.name);
  private readonly appId = process.env.LARK_APP_ID ?? "";
  private readonly appSecret = process.env.LARK_APP_SECRET ?? "";

  get configured(): boolean {
    return !!(this.appId && this.appSecret);
  }

  redirectUri(): string {
    const explicit = process.env.LARK_REDIRECT_URI;
    if (explicit) return explicit;
    const api = (process.env.API_BASE_URL ?? "http://127.0.0.1:4000").replace(
      /\/$/,
      "",
    );
    return `${api}/v1/integrations/lark/callback`;
  }

  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      app_id: this.appId,
      redirect_uri: this.redirectUri(),
      state,
      response_type: "code",
    });
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(code: string): Promise<LarkTokens> {
    const appToken = await this.appAccessToken();
    return this.oidcToken(appToken, {
      grant_type: "authorization_code",
      code,
    });
  }

  async refresh(refreshToken: string): Promise<LarkTokens> {
    const appToken = await this.appAccessToken();
    return this.oidcToken(appToken, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  /** Lark has no user-token revoke endpoint; dropping the stored token severs it. */
  async revoke(): Promise<void> {
    /* no-op */
  }

  /** First group chat the user is in — the default message target. */
  async firstChatId(accessToken: string): Promise<string> {
    try {
      const r = await fetch(`${BASE}/im/v1/chats?page_size=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return "";
      const j = (await r.json()) as {
        data?: { items?: Array<{ chat_id?: string }> };
      };
      return j.data?.items?.[0]?.chat_id ?? "";
    } catch {
      return "";
    }
  }

  async postMessage(
    accessToken: string,
    chatId: string,
    input: LarkMessageInput,
  ): Promise<boolean> {
    if (!chatId) return false;
    const res = await fetch(
      `${BASE}/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({
            text: `${input.title}\n${input.text}`.slice(0, 4000),
          }),
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(`Lark message HTTP ${res.status}`);
      return false;
    }
    const j = (await res.json()) as { code?: number };
    return j.code === 0;
  }

  /** Internal-app token (needed to exchange the user auth code). */
  private async appAccessToken(): Promise<string> {
    const r = await fetch(`${BASE}/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!r.ok) throw new Error(`Lark app_access_token HTTP ${r.status}`);
    const j = (await r.json()) as { app_access_token?: string };
    if (!j.app_access_token) throw new Error("Lark app_access_token missing");
    return j.app_access_token;
  }

  private async oidcToken(
    appToken: string,
    body: Record<string, string>,
  ): Promise<LarkTokens> {
    const r = await fetch(`${BASE}/authen/v1/oidc/access_token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Lark token HTTP ${r.status}`);
    const j = (await r.json()) as {
      data?: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
    };
    const d = j.data;
    if (!d?.access_token) throw new Error("Lark token response missing access_token");
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresInSec: d.expires_in ?? 7200,
      scope: d.scope,
    };
  }
}
