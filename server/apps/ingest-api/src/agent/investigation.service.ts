import { Injectable } from "@nestjs/common";
import { DashboardService } from "../dashboard/dashboard.service";
import { IssuesService } from "../issues/issues.service";

/** Minimal shapes we read from the (larger) dashboard payloads. */
interface MetricRow {
  key: string;
  label: string;
  value: number;
  prev?: number;
  deltaPct?: number;
}
interface IncidentRow {
  title: string;
  signalType?: string;
  screen?: string | null;
  userCount?: number;
  sessionCount?: number;
  deltaPctX100?: number;
  platform?: string | null;
  release?: string | null;
  linkedIssue?: {
    title: string;
    users: number;
    recording: string | null;
  } | null;
}

/**
 * The Investigation Engine. Replayfy — NOT Claude — gathers the evidence.
 *
 * For "why did X change / what's going on" questions, this runs a broad,
 * DETERMINISTIC sweep across the workspace's precomputed intelligence (health
 * pulse, period-over-period metric deltas, correlated incidents, grouped
 * crashes/errors + their release correlation, failing journeys) and packages it
 * into STRUCTURED evidence with a DERIVED confidence — affected users, release
 * correlation, change magnitude — never invented. The narrator then reasons
 * over this evidence; it never sees raw events and never computes a number.
 */
@Injectable()
export class InvestigationService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly issues: IssuesService,
  ) {}

  async diagnose(workspaceId: number, range = "7d") {
    const [overviewRaw, metricsRaw, issues] = await Promise.all([
      this.dashboard.overview(workspaceId, range),
      this.dashboard.metrics(workspaceId, range),
      // list() now returns a paginated envelope; this caller wants the rows.
      this.issues.list(workspaceId, { limit: 8 }).then((r) => r.items),
    ]);
    const overview = overviewRaw as unknown as {
      pulse?: unknown;
      storyline?: unknown;
      incidents?: { problems?: IncidentRow[]; opportunities?: IncidentRow[] };
      topFailedJourneys?: unknown[];
    };
    const metrics = metricsRaw as unknown as { metrics?: MetricRow[] };

    // What changed (period-over-period), strongest first.
    const metricsChanged = (metrics.metrics ?? [])
      .map((m) => ({
        key: m.key,
        label: m.label,
        value: m.value,
        prev: m.prev ?? null,
        deltaPct: m.deltaPct ?? 0,
        direction:
          (m.deltaPct ?? 0) > 0 ? "up" : (m.deltaPct ?? 0) < 0 ? "down" : "flat",
      }))
      .filter((m) => Math.abs(m.deltaPct) >= 1)
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

    const problems = (overview.incidents?.problems ?? []).map((i) => ({
      title: i.title,
      type: i.signalType,
      screen: i.screen ?? null,
      users: i.userCount ?? 0,
      sessions: i.sessionCount ?? 0,
      changePct: Math.round((i.deltaPctX100 ?? 0) / 100),
      platform: i.platform ?? null,
      release: i.release ?? null,
      linkedCrash: i.linkedIssue
        ? {
            title: i.linkedIssue.title,
            users: i.linkedIssue.users,
            recording: i.linkedIssue.recording,
          }
        : null,
    }));

    const opportunities = (overview.incidents?.opportunities ?? []).map((i) => ({
      title: i.title,
      users: i.userCount ?? 0,
      sessions: i.sessionCount ?? 0,
    }));

    const topIssues = issues.map((is) => ({
      title: is.title,
      kind: is.isCrash ? "crash" : "error",
      users: is.userCount,
      sessions: is.sessionCount,
      occurrences: is.occurrenceCount,
      firstRelease: is.firstRelease,
      lastRelease: is.lastRelease,
      // Release correlation: it appeared/regressed across releases.
      regressed: !!(
        is.firstRelease &&
        is.lastRelease &&
        is.firstRelease !== is.lastRelease
      ),
      recording: is.lastPublicId,
    }));

    const failingJourneys = (overview.topFailedJourneys ?? []).slice(0, 5);

    return {
      pulse: overview.pulse ?? null,
      storyline: overview.storyline ?? null,
      metricsChanged,
      problems,
      opportunities,
      topIssues,
      failingJourneys,
      confidence: this.confidence(problems, topIssues, metricsChanged),
    };
  }

  /** Confidence is DERIVED from evidence factors — affected users, release
   *  correlation, change magnitude — and returned WITH its factors, so the
   *  narrator explains it and never fabricates a number. */
  private confidence(
    problems: Array<{
      title: string;
      users: number;
      sessions: number;
      changePct: number;
      release: string | null;
    }>,
    topIssues: Array<{
      title: string;
      users: number;
      sessions: number;
      regressed: boolean;
    }>,
    metricsChanged: Array<{ deltaPct: number }>,
  ) {
    const factors: Array<{
      finding: string;
      affectedUsers: number;
      affectedSessions: number;
      releaseCorrelated: boolean;
      level: string;
    }> = [];
    for (const p of problems.slice(0, 3)) {
      factors.push({
        finding: p.title,
        affectedUsers: p.users,
        affectedSessions: p.sessions,
        releaseCorrelated: !!p.release,
        level: this.level(p.users, !!p.release, p.changePct),
      });
    }
    for (const is of topIssues.slice(0, 3)) {
      factors.push({
        finding: is.title,
        affectedUsers: is.users,
        affectedSessions: is.sessions,
        releaseCorrelated: is.regressed,
        level: this.level(is.users, is.regressed, 0),
      });
    }
    const biggestChange = metricsChanged[0]?.deltaPct ?? 0;
    return {
      note:
        "Derived from affected users, release correlation, and change magnitude — not fabricated.",
      biggestChangePct: biggestChange,
      factors,
    };
  }

  private level(
    users: number,
    releaseCorrelated: boolean,
    changePct: number,
  ): string {
    let score = 0;
    if (users >= 50) score += 2;
    else if (users >= 10) score += 1;
    if (releaseCorrelated) score += 1;
    if (Math.abs(changePct || 0) >= 30) score += 1;
    return score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  }
}
