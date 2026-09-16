/**
 * Server-side redaction for network bodies and headers. Runs *before* we
 * persist to ClickHouse so secrets never touch durable storage. The SDK
 * does a best-effort scrub on the client, but we never trust that — if a
 * customer ships a broken SDK or rolls their own ingester, we still need to
 * keep tokens out of the database.
 *
 * Redacted output is stable: same input → same output, so consumers can
 * still diff requests across sessions.
 */

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-session-token",
]);

const SENSITIVE_JSON_KEYS =
  /^(?:password|pass|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|authorization|auth|session[_-]?id|ssn|cvv|card[_-]?number)$/i;

const TOKENISH_VALUE_PATTERNS = [
  // JWT
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Bearer tokens in headers
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  // sk_/pk_ style API keys
  /\b(?:sk|pk|rk|prod|test)_[A-Za-z0-9]{16,}\b/g,
  // Long base64 hex blobs that look key-like
  /\b[A-Fa-f0-9]{40,}\b/g,
  // Generic 24+ char tokens that follow `token=` or `api_key=`
  /\b(?:token|api[_-]?key|access[_-]?token|refresh[_-]?token)=[A-Za-z0-9._-]{16,}\b/gi,
  // 16-digit credit card numbers (Luhn-ish, but loose)
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
];

const MASK = "[REDACTED]";

export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_KEYS.has(k.toLowerCase())
      ? MASK
      : redactString(v);
  }
  return out;
}

export function redactBody(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Try JSON first — we can do precise key-level redaction.
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(redactJson(parsed));
  } catch {
    // Fall through — treat as opaque string, scrub tokenish substrings.
    return redactString(raw);
  }
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_JSON_KEYS.test(k) ? MASK : redactJson(v);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

function redactString(s: string): string {
  let out = s;
  for (const pattern of TOKENISH_VALUE_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

/**
 * URL-aware host filter. If `allowedHosts` is set on the workspace, ingest
 * rejects any network event whose hostname doesn't match (case-insensitive
 * exact match or wildcard subdomain match via leading "*.").
 */
export function isHostAllowed(
  url: string,
  allowedHosts: string[] | null | undefined,
): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // can't parse → don't block, log will reveal it later
  }
  for (const pattern of allowedHosts) {
    const p = pattern.trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith("*.")) {
      const suffix = p.slice(1); // ".example.com"
      if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
    } else if (host === p) {
      return true;
    }
  }
  return false;
}
