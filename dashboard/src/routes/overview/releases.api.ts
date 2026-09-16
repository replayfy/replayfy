import { api } from "@/api/client";
import type { Release } from "./overview.data";

/* ============================================================================
   releases.api — the REAL Release Intelligence behind the Stability "Releases"
   ledger. Reads /v1/dashboard/releases (ReleaseService.intelligence): one row
   per release with SQL-exact session/user/crash counts, a weighted health
   score, release-over-release deltas, and a regression flag.

   Imports the base `api` client directly (not the endpoints barrel) so this
   slice stays self-contained and never collides with unrelated edits in
   api/endpoints.ts.
   ========================================================================== */

/** One release row as returned by ReleaseService.intelligence (newest first). */
export interface ReleaseRow {
  release: string;
  sessions: number;
  users: number;
  avgScore: number;
  health: number; // 0–100 weighted health
  conversionRate: number | null;
  frustrated: number;
  crashes: number;
  errors: number;
  avgLatencyMs: number | null;
  firstSeen: string; // ISO
  lastSeen: string; // ISO
  healthDelta: number | null; // vs the previous (older) release
  crashesDelta: number | null;
  isRegression: boolean;
}

export interface ReleasesResp {
  releases: ReleaseRow[];
}

export function fetchReleases() {
  // Returns Promise<ApiResult<ReleasesResp>>; useApi unwraps `.data`.
  return api.get<ReleasesResp>(`/v1/dashboard/releases`);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Jun 19" from an ISO timestamp. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "6d ago" / "4h ago" / "12m ago" from an ISO timestamp. */
function ago(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A deterministic, honest one-liner — health (+ its delta) · sessions · crashes.
 *  No fabricated percentages; only what the aggregate carries. */
function note(r: ReleaseRow): string {
  let head = `${r.health}/100 health`;
  if (r.healthDelta != null && r.healthDelta !== 0) {
    head += ` (${r.healthDelta > 0 ? "+" : ""}${r.healthDelta})`;
  }
  const parts = [head, `${r.sessions} session${r.sessions === 1 ? "" : "s"}`];
  if (r.crashes > 0) {
    parts.push(`${r.crashes} crash${r.crashes === 1 ? "" : "es"}`);
  }
  return parts.join(" · ");
}

/**
 * Adapt the release rows to the `Release` shape the Stability ledger renders.
 * `bad` = the deterministic regression flag; `corr` is left undefined so no
 * fake AI-correlation line appears for real data. Returns null when a workspace
 * has no releases yet, so Overview can fall back to the demo fixture.
 */
export function adaptReleases(resp: ReleasesResp | undefined): Release[] | null {
  const rows = resp?.releases;
  if (!rows || rows.length === 0) return null;
  return rows.slice(0, 6).map(
    (r): Release => ({
      v: r.release || "—",
      date: fmtDate(r.lastSeen),
      ago: ago(r.lastSeen),
      note: note(r),
      bad: r.isRegression,
    }),
  );
}
