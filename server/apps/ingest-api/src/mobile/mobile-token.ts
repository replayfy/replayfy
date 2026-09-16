import { createHmac, timingSafeEqual } from "crypto";

/**
 * Session-scoped bearer token for the mobile ingest endpoints.
 *
 * `/v1/mobile/start` mints one; `/v1/mobile/i`, `/images`, `/late`
 * verify it. It binds the caller to a single session + workspace so
 * the ingest endpoints don't need to re-resolve the project key on
 * every batch. HMAC-signed, no DB round-trip to verify.
 */

/** Mobile-ingest token signing key — lazy + fail-closed, no insecure default.
 *  Prefers a dedicated MOBILE_INGEST_SECRET, falls back to JWT_SECRET; refuses
 *  to run on a public default (a forgeable key lets anyone mint a session token
 *  for any workspace). */
function secret(): string {
  const s = process.env.MOBILE_INGEST_SECRET ?? process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "MOBILE_INGEST_SECRET or JWT_SECRET must be set to a strong value (>=16 chars); refusing to sign/verify mobile tokens with an insecure default.",
    );
  }
  return s;
}

export interface MobileTokenPayload {
  sid: string; // session publicId
  snum: number; // session row id (numeric, for ClickHouse session_id)
  wid: number; // workspaceId
  startedAt: number; // session start epoch-ms (frame ts → playhead offset)
}

export function signMobileToken(payload: MobileTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyMobileToken(
  token: string | undefined,
): MobileTokenPayload | null {
  if (!token) return null;
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", secret())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as MobileTokenPayload;
  } catch {
    return null;
  }
}
