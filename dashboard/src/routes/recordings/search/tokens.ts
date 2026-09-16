/* ============================================================================
   Filter tokens → GET /v1/sessions query params.

   The rail used to carry a TODO admitting these tokens were never mapped onto
   the list — the search built chips and the list kept returning the newest
   unfiltered page. This is that mapping.

   The contract with the rest of the UI: a token this file cannot express as a
   real param comes back in `unapplied` and the caller must SAY SO. Dropping it
   silently would render an unfiltered list under a filter chip, which reads as
   "your filter matched everything" — the most expensive kind of wrong answer a
   session search can give.
   ========================================================================== */
import type { FilterToken } from "./search.data";

export type SessionListParams = Record<string, string | number | undefined>;

export type MappedTokens = {
  params: SessionListParams;
  /** Tokens with no real param behind them — surfaced, never swallowed. */
  unapplied: FilterToken[];
};

/** `has:` values → the boolean list param each one sets. */
const HAS_PARAM: Record<string, string> = {
  error: "hasErrors",
  rage: "hasRage",
  "dead click": "hasDead",
  "slow lcp": "hasSlowLcp",
  "long tasks": "hasLongTasks",
};

/** Keys the list filters by exact value, and whose param takes a CSV of them. */
const CSV_PARAM: Record<string, string> = {
  browser: "browser",
  device: "device",
  model: "deviceModel",
  platform: "platform",
  country: "country",
};

/** "30s" | "1m" | "2m" → ms. Returns null for anything unparseable. */
function durationMs(v: string): number | null {
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

/**
 * Map the active chips onto the params GET /v1/sessions already accepts.
 *
 * Scale note (server-side, but this is what decides it): every param emitted
 * here is one the list applies as a residual filter on its existing
 * workspace-scoped, keyset-paginated index walk (@@index([workspaceId, id
 * desc])) — none of them re-sorts or widens the scan. `search` is the one
 * unanchored ILIKE, so at most ONE search-consuming token is ever sent.
 */
export function tokensToParams(tokens: FilterToken[]): MappedTokens {
  const params: SessionListParams = {};
  const unapplied: FilterToken[] = [];
  const csv: Record<string, string[]> = {};
  // `search` is a single param backed by one OR-ed ILIKE across publicId /
  // startUrl / endUser — two search-consuming tokens cannot be AND-ed into it,
  // so the first wins and the rest are reported rather than dropped.
  let searchTaken = false;
  const takeSearch = (t: FilterToken, value: string) => {
    if (searchTaken) return unapplied.push(t);
    params.search = value;
    searchTaken = true;
  };

  for (const t of tokens) {
    const value = String(t.value ?? "").trim();
    if (!value) {
      unapplied.push(t);
      continue;
    }
    // The list ANDs every param and has no negation, so `≠` is unrepresentable.
    // (RvSearch no longer offers it — this is the backstop for a token restored
    // from a recent query that predates that.)
    //
    // Duration passes with ANY operator (not just `>`): it maps to minDurationMs
    // regardless, so a legacy `duration<30s` / `duration:1m` recent applies as a
    // minimum-length filter instead of landing in `unapplied` as a dead chip.
    if (t.op !== ":" && t.key !== "duration") {
      unapplied.push(t);
      continue;
    }
    switch (t.key) {
      case "has": {
        const p = HAS_PARAM[value.toLowerCase()];
        if (p) params[p] = "1";
        else unapplied.push(t);
        break;
      }
      case "browser":
      case "device":
      case "model":
      case "platform":
      case "country": {
        const p = CSV_PARAM[t.key];
        (csv[p] ??= []).push(value);
        break;
      }
      case "user": {
        // Prefer the id the suggestion carried: endUserId is an indexed
        // equality on the session's own column, where `search` is a substring
        // match that would also hit a startUrl containing the same text.
        if (typeof t.endUserId === "number") params.endUserId = t.endUserId;
        else takeSearch(t, value);
        break;
      }
      // page → `search`, which matches Session.startUrl by substring. "/checkout"
      // therefore matches "https://acme.io/checkout" — the suggest returns paths,
      // the column stores full URLs.
      case "page":
      case "session":
      case "text":
        takeSearch(t, value);
        break;
      case "duration": {
        const ms = durationMs(value);
        if (ms) params.minDurationMs = ms;
        else unapplied.push(t);
        break;
      }
      default:
        unapplied.push(t);
    }
  }
  for (const [p, vals] of Object.entries(csv)) params[p] = vals.join(",");
  return { params, unapplied };
}
