/**
 * Shared helpers for turning raw captured session events into evidence safe to
 * put in front of a model (and, downstream, in front of an engineer).
 *
 * Lives in common/ rather than beside either caller because both the cause
 * hypothesis and the AI investigation report need the identical treatment, and
 * the repo forbids free functions inside a *.service.ts.
 *
 * Everything here treats its input as UNTRUSTED: these strings were captured
 * verbatim from arbitrary end users' browsers on customers' live sites.
 */

/** A captured event, narrowed to the fields these helpers read. */
interface EvidenceLike {
  message?: string;
  error?: string;
}

/**
 * The human-readable text of an error event.
 *
 * `ProjectionRow.error` is the row's DISCRIMINATOR — the ingest writes the
 * literal string "error" into it — so the obvious `e.error || e.message`
 * silently yields the word "error" for every row. Measured on the reference
 * workspace: all 32 error rows carried `error = "error"`, with the real text
 * ("TypeError: Cannot read properties of undefined …") in `message`.
 *
 * So: prefer `message`, and treat a discriminator-shaped `error` as absent.
 */
export function errorText(e: EvidenceLike): string {
  const message = (e.message ?? "").trim();
  if (message) return message;
  const error = (e.error ?? "").trim();
  return error.toLowerCase() === "error" ? "" : error;
}

/**
 * A captured request URL reduced to the part that is safe to show and safe to
 * reason about: its PATH.
 *
 * Strips, in order:
 *   - the query string and fragment — they routinely carry access tokens,
 *     session keys, emails and other personal data;
 *   - the scheme and HOST — `https://api.demo-co.example/api/checkout` names
 *     the customer's infrastructure, and a hostname echoed into a report reads
 *     like a code area when it is nothing of the sort.
 *
 * Returns "" when nothing path-shaped survives, so callers can drop the row
 * rather than emit a placeholder.
 */
export function safePath(rawUrl: string): string {
  const url = (rawUrl ?? "").trim();
  if (!url) return "";
  const withoutQuery = url.split(/[?#]/)[0];
  // Absolute URL → keep the path only. Relative → it is already a path.
  const afterScheme = withoutQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const slash = afterScheme.indexOf("/");
  const path = withoutQuery === afterScheme ? afterScheme : afterScheme.slice(slash);
  if (!path || !path.startsWith("/")) return "";
  return path.slice(0, 160);
}

/**
 * The first frame of a captured stack — the one that names the code that threw.
 * Trimmed of the leading "at " noise and capped, so it reads as an identifier
 * rather than a wall of framework frames.
 */
export function stackHead(rawStack: string): string {
  const first = (rawStack ?? "").split("\n")[0]?.trim() ?? "";
  if (!first) return "";
  return first.replace(/^at\s+/i, "").slice(0, 120);
}
