import { createHmac, randomBytes, timingSafeEqual } from "crypto";

interface JwtPayload {
  userId: number;
  email: string;
  /** null until onboarding creates the user's first workspace. */
  workspaceId: number | null;
  iat: number;
  exp: number;
}

const ALG_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * The session-token signing key. Resolved LAZILY (per call, after dotenv has
 * loaded) and FAIL-CLOSED: there is no insecure default, so a deploy with
 * JWT_SECRET unset cannot sign or verify a token — it throws instead of falling
 * back to a public constant anyone could forge with. bootstrap.ts also asserts
 * it at boot so the failure is a clear startup error, not a first-request 500.
 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "JWT_SECRET must be set to a strong value (>=16 chars); refusing to sign/verify tokens with an insecure default.",
    );
  }
  return s;
}

export function signJwt(payload: Omit<JwtPayload, "iat" | "exp">): string {
  const iat = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat, exp: iat + TTL_SECONDS };
  const bodyEncoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signing = `${ALG_HEADER}.${bodyEncoded}`;
  const sig = createHmac("sha256", secret()).update(signing).digest("base64url");
  return `${signing}.${sig}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JwtPayload;
    if (decoded.exp * 1000 < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function generateRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
