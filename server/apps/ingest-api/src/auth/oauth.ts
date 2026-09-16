import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * OAuth 2.0 helpers shared by every provider (Google today, GitHub /
 * GitLab to follow). Two things this module gives us:
 *
 *   1) `signState` / `verifyState` — HMAC over a random nonce + the
 *      requested redirect URL, so CSRF can't trick a user into
 *      completing a login that lands somewhere they didn't pick.
 *
 *   2) `getProviderConfig` — central place to read env vars and produce
 *      a normalised config blob for the controller. Each provider knows
 *      its auth + token + userinfo URLs and which fields to read.
 */

/** OAuth-state signing key — lazy + fail-closed, no insecure default (mirrors
 *  auth/jwt.ts). A forgeable state secret lets an attacker forge the CSRF token
 *  the callback trusts. */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "JWT_SECRET must be set to a strong value (>=16 chars); refusing to sign/verify OAuth state with an insecure default.",
    );
  }
  return s;
}

export type OAuthProvider = "google" | "github" | "gitlab";

export interface ProviderConfig {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  /** Per-provider mapping from userinfo response → our normalized profile. */
  extractProfile: (raw: unknown) => OAuthProfile | null;
  /** Some providers need a separate fetch for the verified email. */
  fetchEmailIfMissing?: (accessToken: string) => Promise<string | null>;
}

export interface OAuthProfile {
  providerUserId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified: boolean;
}

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? "http://127.0.0.1:5180";
}

export function callbackUrl(provider: OAuthProvider): string {
  // Backend is on :4000, dashboard on :5180. Google calls the backend
  // because it owns the client secret + the user-finding logic — the
  // backend then 302s the browser to the dashboard with a session JWT.
  const apiBase = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
  return `${apiBase}/v1/auth/oauth/${provider}/callback`;
}

/** Sign a random nonce so we can verify the round trip is ours. */
export function signState(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, n: randomBytes(8).toString("hex") })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(state: string): Record<string, string> | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, string>;
  } catch {
    return null;
  }
}

export function getProviderConfig(provider: OAuthProvider): ProviderConfig | null {
  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      provider,
      clientId,
      clientSecret,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "openid email profile",
      extractProfile: (raw) => {
        const r = raw as { sub?: string; email?: string; name?: string; picture?: string; email_verified?: boolean };
        if (!r?.sub || !r.email) return null;
        return {
          providerUserId: r.sub,
          email: r.email.toLowerCase(),
          name: r.name,
          avatarUrl: r.picture,
          emailVerified: !!r.email_verified
        };
      }
    };
  }
  if (provider === "github") {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      provider,
      clientId,
      clientSecret,
      authUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      userinfoUrl: "https://api.github.com/user",
      scope: "read:user user:email",
      extractProfile: (raw) => {
        const r = raw as { id?: number; email?: string | null; login?: string; name?: string; avatar_url?: string };
        if (!r?.id) return null;
        return {
          providerUserId: String(r.id),
          // GitHub returns null if the primary email is private. The
          // controller calls fetchEmailIfMissing to recover it.
          email: (r.email ?? "").toLowerCase(),
          name: r.name || r.login,
          avatarUrl: r.avatar_url,
          emailVerified: true // GitHub already verified the email it gives us
        };
      },
      fetchEmailIfMissing: async (accessToken) => {
        const res = await fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "replay-api" }
        });
        if (!res.ok) return null;
        const emails = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        return primary?.email?.toLowerCase() ?? null;
      }
    };
  }
  if (provider === "gitlab") {
    const clientId = process.env.GITLAB_CLIENT_ID;
    const clientSecret = process.env.GITLAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return {
      provider,
      clientId,
      clientSecret,
      authUrl: "https://gitlab.com/oauth/authorize",
      tokenUrl: "https://gitlab.com/oauth/token",
      userinfoUrl: "https://gitlab.com/oauth/userinfo",
      scope: "openid email profile",
      extractProfile: (raw) => {
        const r = raw as { sub?: string; email?: string; name?: string; picture?: string; email_verified?: boolean };
        if (!r?.sub || !r.email) return null;
        return {
          providerUserId: r.sub,
          email: r.email.toLowerCase(),
          name: r.name,
          avatarUrl: r.picture,
          emailVerified: !!r.email_verified
        };
      }
    };
  }
  return null;
}

export function dashboardSuccessUrl(token: string): string {
  // Hash routing — the dashboard's auth bootstrap looks for #token=...
  // on first paint and persists it before clearing the fragment.
  return `${appBaseUrl()}/?token=${encodeURIComponent(token)}`;
}

export function dashboardErrorUrl(reason: string): string {
  return `${appBaseUrl()}/?oauth_error=${encodeURIComponent(reason)}`;
}
