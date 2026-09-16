import { api, qs } from "@/api/client";
import { countryName, flagEmoji } from "@/lib/device-format";
import { stripScheme } from "@/lib/url-format";
import type { DistRow } from "./viz/DistBar";

/* ============================================================================
   segments.api — the REAL "where sessions come from" distributions behind the
   Overview Segments band: platform / browser / country shares over the window,
   from /v1/dashboard/segments (one GROUPING SETS scan of Session).

   Imports the base `api` client directly (not the endpoints barrel) so this
   slice stays self-contained and never collides with unrelated edits in
   api/endpoints.ts.
   ========================================================================== */

export interface SegmentRow {
  label: string;
  sessions: number;
  share: number; // percentage 0–100
}

export interface SegmentsResp {
  totalSessions: number;
  platform: SegmentRow[];
  browser: SegmentRow[];
  country: SegmentRow[];
  // Traffic sources (may be absent on an older API — treated as empty). referrer
  // = referring host; source/medium/campaign = utm_*.
  referrer?: SegmentRow[];
  source?: SegmentRow[];
  medium?: SegmentRow[];
  campaign?: SegmentRow[];
}

export interface SegmentsDims {
  platform: DistRow[];
  browser: DistRow[];
  country: DistRow[];
  referrer: DistRow[];
  source: DistRow[];
  medium: DistRow[];
  campaign: DistRow[];
  totalSessions: number;
}

export function fetchSegments(
  range: string,
  from?: number,
  to?: number,
  // `full` → the breakdown drawer's complete ranked list (every label, no
  // top-N cap / "Other"). Omitted on the compact Overview band poll.
  full?: boolean,
) {
  // Returns Promise<ApiResult<SegmentsResp>>; useApi unwraps `.data`.
  return api.get<SegmentsResp>(
    `/v1/dashboard/segments${qs({ range, from, to, full: full ? 1 : undefined })}`,
  );
}

/**
 * Adapt the API response to the DistBar row shape. `v` carries the share
 * percentage (DistBar shows `${v}%` and multiplies by totalSessions for the
 * count), `d` is left empty (DistBar renders no delta). The country dimension
 * arrives as ISO-3166 alpha-2 ("NG"); expand it to the full name ("Nigeria")
 * for display and derive its flag. Returns null when every dimension is empty
 * so the caller can fall back to the demo fixture.
 */
export function adaptSegments(
  resp: SegmentsResp | undefined,
): SegmentsDims | null {
  if (!resp) return null;
  // Browser is intentionally NOT counted — it's no longer rendered (its band was
  // replaced by the Traffic-sources panel), so a browser-only response must fold
  // to null rather than yield a truthy `data` that then shows the empty state.
  const nonEmpty =
    (resp.platform?.length ?? 0) +
    (resp.country?.length ?? 0) +
    (resp.referrer?.length ?? 0) +
    (resp.source?.length ?? 0) +
    (resp.medium?.length ?? 0) +
    (resp.campaign?.length ?? 0);
  if (nonEmpty === 0) return null;
  // Carry the EXACT session count (not just share%) so the full breakdown drawer
  // renders true counts — deriving `count = round(total * share/100)` collapses a
  // small tail row to 0 at large totals (e.g. 3 sessions in a 500k workspace).
  const toRows = (rows: SegmentRow[] | undefined): DistRow[] =>
    (rows ?? []).map((r) => ({
      label: r.label,
      v: r.share,
      d: "",
      raw: r.label,
      sessions: r.sessions,
    }));
  const toCountryRows = (rows: SegmentRow[] | undefined): DistRow[] =>
    (rows ?? []).map((r) => ({
      label: countryName(r.label),
      v: r.share,
      d: "",
      flag: flagEmoji(r.label),
      // Keep the raw ISO ("NG") — the recordings country filter matches the
      // stored code, not the display name ("Nigeria").
      raw: r.label,
      sessions: r.sessions,
    }));
  // Referring host: show it without the scheme/www (the display label), but keep
  // the exact backend value as `raw` so the favicon lookup uses the real host.
  const toRefRows = (rows: SegmentRow[] | undefined): DistRow[] =>
    (rows ?? []).map((r) => ({
      label: r.label === "Other" ? "Other" : stripScheme(r.label),
      v: r.share,
      d: "",
      raw: r.label,
      sessions: r.sessions,
    }));
  return {
    platform: toRows(resp.platform),
    browser: toRows(resp.browser),
    country: toCountryRows(resp.country),
    referrer: toRefRows(resp.referrer),
    source: toRows(resp.source),
    medium: toRows(resp.medium),
    campaign: toRows(resp.campaign),
    totalSessions: resp.totalSessions,
  };
}
