import { api, qs } from "@/api/client";
import type { CrashSev, PooledCrash } from "./drawers/drawers.data";
import { crashCatOf } from "./drawers/drawers.data";
import type { Crash } from "./overview.data";

/* ============================================================================
   crashlytics.api — the REAL crash/error groups behind the Stability section
   and the "All crashes" drawer. Reads the deterministic Issue aggregates
   (/v1/dashboard/issues), NOT the AI incidents feed: one row per fingerprint
   with SQL-exact occurrence / session / user counts.

   Imports the base `api` client directly (not the endpoints barrel) so this
   crashlytics slice stays self-contained and never collides with unrelated
   edits in api/endpoints.ts.
   ========================================================================== */

export type IssueStatus = "OPEN" | "RESOLVED" | "IGNORED" | "REGRESSED";

/** One aggregated Issue row as returned by IssuesService.list (narrow select). */
export interface CrashIssue {
  id: number;
  isCrash: boolean;
  /** Fine-grained kind: 'crash' | 'exception' | 'error' | 'anr' (freeze). */
  errorClass: string;
  behavioral: boolean;
  errorType: string;
  title: string;
  message: string;
  culprit: string;
  platform: string;
  status: IssueStatus;
  occurrenceCount: number;
  sessionCount: number;
  userCount: number;
  firstRelease: string | null;
  lastRelease: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastPublicId: string | null;
  lastSessionId: number | null;
  /** 14 daily occurrence counts (oldest → today) for the row trend sparkline.
   *  Empty on older cached reads that predate the field. */
  trend?: number[];
}

/** The Crashlytics list/count filter language (mirrors the backend). Category is
 *  the CrashCat the UI speaks ('freeze'); the wire maps it to errorClass 'anr'. */
export interface CrashListFilters {
  status?: string; // "ALL" | one status | comma list
  category?: string; // "" | crash | exception | freeze | error
  search?: string;
  platform?: string; // comma list
  release?: string; // comma list
  since?: number; // epoch ms — issues seen since
  until?: number; // epoch ms — issues seen up to (date-range upper bound)
  limit?: number;
  cursor?: string; // keyset cursor (infinite scroll)
  /** "recent" = lastSeenAt DESC (Crashlytics default); else rank DESC. */
  sort?: string;
}

// 'freeze' is the UI's word for a UI-thread ANR; the Issue.errorClass is 'anr'.
function toWireCategory(category?: string): string | undefined {
  if (!category) return undefined;
  return category === "freeze" ? "anr" : category;
}

/**
 * The crash/error groups, ranked. `behavioral=false` asks the API to exclude
 * behavioral signal-Issues (frustration, form abandonment, …) server-side, so
 * this is strictly "crashes & errors" and no crash is ever pushed past the
 * limit by a busier behavioral group. Keyset-paginated (pass `cursor` for the
 * next page); every filter is applied server-side, so search/category/facets
 * span the WHOLE workspace, not just the rows already scrolled into memory.
 */
export function listCrashIssues(opts?: CrashListFilters) {
  // Returns Promise<ApiResult<CrashIssue[]>>; useApi unwraps `.data`, and
  // useApiInfinite reads `page.next_cursor` / `page.total` off the envelope.
  return api.get<CrashIssue[]>(
    `/v1/dashboard/issues${qs({
      behavioral: false,
      status: opts?.status,
      category: toWireCategory(opts?.category),
      search: opts?.search,
      platform: opts?.platform,
      release: opts?.release,
      since: opts?.since,
      until: opts?.until,
      sort: opts?.sort,
      limit: opts?.limit ?? 60,
      cursor: opts?.cursor,
    })}`,
  );
}

/** Per-category counts for the stat strip — one set-based GROUP BY on the
 *  server, honouring the same filter as the list (minus the category tab).
 *  Never a client-side tally of a paginated page. */
export interface CrashCategoryCounts {
  all: number;
  crash: number;
  exception: number;
  freeze: number;
  error: number;
}
export function crashCategoryCounts(opts?: CrashListFilters) {
  return api.get<CrashCategoryCounts>(
    `/v1/dashboard/issues/category-counts${qs({
      behavioral: false,
      status: opts?.status,
      search: opts?.search,
      platform: opts?.platform,
      release: opts?.release,
      since: opts?.since,
    })}`,
  );
}

/** Distinct platform + release values for the filter dropdowns. */
export interface CrashFacets {
  platforms: string[];
  releases: string[];
}
export function crashFacets() {
  return api.get<CrashFacets>(`/v1/dashboard/issues/facets`);
}

/** Crashes-by-version / by-platform summary for the Crashlytics header band.
 *  `occurrences` = total crash events in that bucket; `issues` = distinct
 *  issue groups. Two set-based groupBy aggregates on the backend (no scan). */
export interface CrashBreakdownRow {
  key: string;
  occurrences: number;
  issues: number;
  /** Affected users in this bucket (present on version rows). */
  users?: number;
}
export interface CrashBreakdown {
  version: CrashBreakdownRow[];
  platform: CrashBreakdownRow[];
}
export function crashBreakdown(from?: number, to?: number) {
  return api.get<CrashBreakdown>(
    `/v1/dashboard/issues/breakdown${qs({ from, to })}`,
  );
}

/** Per-category rollup (event volume + affected users) for the header metric
 *  row. One set-based groupBy on the backend (no scan). */
export interface CrashStatBucket {
  events: number;
  groups: number;
  users: number;
  /** Trailing 30-day daily counts (chronological) for the metric-row spark. */
  spark: number[];
  /** Last-30d vs prior-30d %, or null when there's no prior baseline. */
  deltaPct: number | null;
}
export interface CrashStats {
  crashes: CrashStatBucket;
  exceptions: CrashStatBucket;
  freezes: CrashStatBucket;
  errors: CrashStatBucket;
  affectedUsers: number;
}
export function crashStats(from?: number, to?: number) {
  return api.get<CrashStats>(`/v1/dashboard/issues/stats${qs({ from, to })}`);
}

/** One recent occurrence of an issue, each linking to the session it fired in. */
export interface CrashOccurrence {
  sessionId: number;
  publicId: string | null;
  screen: string;
  release: string;
  occurredAt: string;
  count: number;
}

/** One rendered stack frame — `fn` at `loc`, `inApp` = the customer's own code. */
export interface StackFrame {
  fn: string;
  loc: string;
  inApp: boolean;
}

/** A failing / slow request around the crash. */
export interface CrashNetworkRow {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  hits: number;
}

/** One event in the run-up to the crash. */
export interface Breadcrumb {
  kind: string;
  label: string;
  offsetMs: number;
}

/** One value of a dimension (browser / os / country) + its share of sessions. */
export interface DimStat {
  val: string;
  pct: number;
}

/** The Issue detail read: the full aggregate + its most-recent occurrences + a
 *  representative parsed stack trace. `issue` carries every column
 *  (message/culprit/fingerprint/…), a superset of the list's narrow select. */
export interface CrashIssueDetail {
  issue: CrashIssue & { message: string; fingerprint?: string };
  occurrences: CrashOccurrence[];
  stack: StackFrame[];
  network: CrashNetworkRow[];
  breadcrumbs: Breadcrumb[];
  device: { browser: DimStat[]; os: DimStat[]; country: DimStat[] };
}

/** GET one issue + its recent occurrences — the investigation drawer's read. */
export function getCrashIssue(id: number) {
  return api.get<CrashIssueDetail>(`/v1/dashboard/issues/${id}`);
}

/** Human status action (Resolve / Ignore / Reopen). MEMBER+ on the server. */
export function setIssueStatus(
  id: number,
  status: "OPEN" | "RESOLVED" | "IGNORED",
) {
  return api.patch<{ updated: number }>(`/v1/dashboard/issues/${id}`, {
    status,
  });
}

/** Severity is derived from category + blast radius: a fatal CRASH is always
 *  Critical; a handled exception or a UI freeze is never Critical — it escalates
 *  with the number of distinct users it hit. (Previously keyed off `isCrash`,
 *  which mislabelled any non-fatal group the backend still flagged.) */
function severityFor(iss: CrashIssue): CrashSev {
  if (crashCatOf(iss.errorClass) === "crash") return "Critical";
  if (iss.userCount >= 20) return "High";
  if (iss.userCount >= 5) return "Medium";
  return "Low";
}

/**
 * Adapt the Issue rows to the PooledCrash shape the crash ledger/drawer render.
 * Fields the deterministic list doesn't carry — a period-over-period delta and
 * a per-day sparkline — are left empty (the renderer hides them) rather than
 * fabricated. Returns null when there are no real crashes, so callers can fall
 * back to the demo fixture exactly like adaptCrashes(overview) ?? CRASHES.
 */
export function issuesToPooledCrashes(
  issues: CrashIssue[] | undefined,
): PooledCrash[] | null {
  if (!issues || issues.length === 0) return null;
  return issues.map(
    (iss): PooledCrash => ({
      _id: iss.id,
      n: iss.errorType || iss.title || "Error",
      s: iss.culprit || iss.message || "",
      p: [iss.platform, iss.lastRelease].filter(Boolean).join(" · ") || "—",
      sev: severityFor(iss),
      cat: crashCatOf(iss.errorClass),
      c: iss.occurrenceCount,
      d: "", // no trend in the list read — renderer omits the delta chip
      down: false,
      rec: iss.sessionCount,
      users: iss.userCount,
      sp: [], // no per-day series in the list read — renderer omits the spark
    }),
  );
}

/**
 * Adapt the same Issue rows to the compact `Crash` shape the Stability
 * "Top crashes" ledger renders. Same honesty rule: no fabricated delta/spark.
 * Returns null when empty so Overview can fall back to adaptCrashes(overview)
 * ?? CRASHES.
 */
export function issuesToCrashes(
  issues: CrashIssue[] | undefined,
): Crash[] | null {
  if (!issues || issues.length === 0) return null;
  return issues.map(
    (iss): Crash => ({
      n: iss.errorType || iss.title || "Error",
      s: iss.culprit || iss.message || "",
      p: [iss.platform, iss.lastRelease].filter(Boolean).join(" · ") || "—",
      cat: crashCatOf(iss.errorClass),
      c: iss.occurrenceCount,
      d: "", // no period-over-period delta in the list read
      down: false,
      note: "",
      sp: [],
    }),
  );
}

/* ── Stability density-strip chart (DayBars) ──────────────────────────────── */

/** One day of the /metrics `series` (the fields the Stability chart reads). */
export interface StabilityDaily {
  day: number; // epoch ms, day-aligned
  crashes: number;
  frustrated: number;
  slowApi: number;
  backendFail: number;
}

interface DayLine {
  name: string;
  color: string;
  data: number[];
}
export interface StabilityChart {
  primary: DayLine;
  secondary: DayLine[];
  labels: string[];
  deploys: { i: number; v: string }[];
}

const CHART_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Build the real Stability chart from the /metrics daily series + the release
 * rows (for deploy markers). Primary = crashes/day; secondary = the other
 * stability signals read out on hover; deploys pin each release's first-seen day
 * to its nearest bucket. Returns null when there's no series (empty workspace →
 * caller keeps the demo fixture).
 */
export function adaptStabilityChart(
  series: StabilityDaily[] | undefined,
  releases: { release: string; firstSeen: string }[] | undefined,
): StabilityChart | null {
  if (!series || series.length === 0) return null;
  const sorted = [...series].sort((a, b) => a.day - b.day);
  const days = sorted.map((s) => s.day);
  const labels = days.map((d) => {
    const dt = new Date(d);
    return `${CHART_MONTHS[dt.getMonth()]} ${dt.getDate()}`;
  });

  // Pin each release's first-seen day to the nearest bucket (within ~1.5 days,
  // i.e. it actually landed inside the window). One marker per bucket.
  const deploys: { i: number; v: string }[] = [];
  const used = new Set<number>();
  for (const r of releases ?? []) {
    const t = new Date(r.firstSeen).getTime();
    if (Number.isNaN(t) || !r.release || r.release === "unknown") continue;
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < days.length; i++) {
      const diff = Math.abs(days[i] - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (best >= 0 && bestDiff <= 36 * 3600 * 1000 && !used.has(best)) {
      deploys.push({ i: best, v: r.release });
      used.add(best);
    }
  }

  return {
    primary: { name: "Crashes", color: "var(--red)", data: sorted.map((s) => s.crashes) },
    secondary: [
      { name: "Frustration", color: "#c08a3e", data: sorted.map((s) => s.frustrated) },
      { name: "Slow API", color: "#3b76b0", data: sorted.map((s) => s.slowApi) },
      { name: "Backend errors", color: "#9aa1ac", data: sorted.map((s) => s.backendFail) },
    ],
    labels,
    deploys,
  };
}
