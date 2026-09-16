import { Injectable } from "@nestjs/common";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import {
  INCIDENT_SCOPE_CAP,
  resolveIncidentSessionIds,
  resolveIssueSessionIds,
} from "../common/incident-scope";

/**
 * The DETERMINISTIC investigation behind one incident — everything Replayfy can
 * state as measured fact, before any model is involved. Feeds the investigation
 * panel's Evidence, Related signals and Recommended actions.
 *
 * Access pattern (per repo rule: never an N+1, never an unbounded scan):
 *   - ONE grouped UNION over `Signal → Session` returns every breakdown
 *     (platform / browser / country / release) aggregated IN SQL, so the row
 *     count is the number of distinct VALUES, never the number of sessions.
 *     Index-served by Signal @@index([incidentId]) then a PK join to Session.
 *   - ONE grouped join to `IssueOccurrence → Issue` for crashes sharing this
 *     incident's sessions.
 *   - ONE self-join on `Signal` for incidents sharing sessions (correlation),
 *     plus a single bounded findMany to resolve their titles.
 *   - ONE indexed findMany for prior instances of the same cluster key.
 * Five bounded round trips for the whole panel — never one per row.
 *
 * Window caveat: `Signal.incidentId` is stamped only for the CURRENT window (see
 * incidents.service.ts), so these breakdowns describe THIS instance of the
 * incident. All-time questions must match the cluster key instead, which is what
 * `similarHistorical` does.
 */

interface DimRow {
  dim: string;
  val: string;
  sessions: number;
}
interface CrashRow {
  id: number;
  title: string;
  errorType: string;
  isCrash: boolean;
  /// True = a BEHAVIOURAL issue, re-clustered from the SAME signals as this
  /// incident rather than from a thrown error. Carried through (not filtered
  /// out) because it is still a real related cluster — but any consumer
  /// treating it as INDEPENDENT corroboration would be counting one
  /// measurement twice, so the flag has to travel with the row.
  behavioral: boolean;
  occurrenceCount: number;
  shared: number;
}
interface CorrRow {
  id: number;
  shared: number;
}

export interface Breakdown {
  value: string;
  sessions: number;
  pct: number;
}

@Injectable()
export class IncidentInvestigationService {
  private readonly db = getPostgresClient();

  /** Top-N of a breakdown, with "unknown" pushed last so it never leads. */
  private static top(rows: DimRow[], dim: string, n = 4): Breakdown[] {
    const of = rows.filter((r) => r.dim === dim && r.sessions > 0);
    const total = of.reduce((a, r) => a + r.sessions, 0);
    if (total === 0) return [];
    return of
      .sort((a, b) =>
        a.val === "unknown"
          ? 1
          : b.val === "unknown"
            ? -1
            : b.sessions - a.sessions,
      )
      .slice(0, n)
      .map((r) => ({
        value: r.val,
        sessions: r.sessions,
        pct: Math.round((r.sessions / total) * 100),
      }));
  }

  /**
   * The one-line incident header — what the Recordings `?incident=` banner needs
   * and nothing more. Deliberately separate from `detail` above: that is five
   * queries for a whole panel, and paying it to render a banner string would be
   * absurd. Two bounded, index-served reads here, run concurrently.
   *
   * Returns null (→ 404) when the incident does not belong to this workspace.
   * The `{ id, workspaceId }` findFirst is the tenant guard: `id` is
   * caller-supplied and `workspaceId` is JWT-derived, so a foreign id resolves
   * to nothing rather than leaking a title.
   *
   * `attributedSessions` is the number of sessions the scope ACTUALLY resolves
   * to right now — deliberately NOT `Incident.sessionCount`. The two disagree
   * routinely and by design: the clusterer stamps `Signal.incidentId` for the
   * current window only, while `sessionCount` is counted over every signal in
   * that window including ones already stamped to a predecessor incident. The
   * banner must state the number that matches the rows underneath it, so it
   * reports this one and the UI reconciles the difference in words.
   */
  async summary(workspaceId: number, incidentId: number) {
    if (!Number.isFinite(incidentId)) return null;
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      select: {
        id: true,
        title: true,
        status: true,
        screen: true,
        element: true,
        sessionCount: true,
      },
    });
    if (!incident) return null;
    // Same resolver the list scope uses, so the count in the banner and the
    // rows beneath it are one answer, and `scopeCapped` cannot claim a
    // truncation the list did not apply (or hide one it did).
    const scope = await resolveIncidentSessionIds(
      this.db,
      workspaceId,
      incidentId,
    );
    return {
      ...incident,
      attributedSessions: scope.ids.length,
      scopeCapped: scope.truncated,
      scopeCap: INCIDENT_SCOPE_CAP,
    };
  }

  async detail(workspaceId: number, incidentId: number) {
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      select: {
        id: true,
        title: true,
        signalType: true,
        polarity: true,
        screen: true,
        element: true,
        status: true,
        sessionCount: true,
        userCount: true,
        deltaPctX100: true,
        impactCents: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    });
    if (!incident) return null;

    // The release expression is the codebase's canonical one: web ships `revId`,
    // mobile ships appVersion/appBuild.
    const [dims, crashes, corr, historical] = await Promise.all([
      this.db.$queryRaw<DimRow[]>`
        SELECT 'platform' AS dim, COALESCE(NULLIF(s.platform,''),'unknown') AS val,
               count(DISTINCT s.id)::int AS sessions
        FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."workspaceId" = ${workspaceId} AND sig."incidentId" = ${incidentId}
        GROUP BY 2
        UNION ALL
        SELECT 'browser', COALESCE(NULLIF(s.browser,''),'unknown'), count(DISTINCT s.id)::int
        FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."workspaceId" = ${workspaceId} AND sig."incidentId" = ${incidentId}
        GROUP BY 2
        UNION ALL
        SELECT 'country', COALESCE(NULLIF(s.country,''),'unknown'), count(DISTINCT s.id)::int
        FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."workspaceId" = ${workspaceId} AND sig."incidentId" = ${incidentId}
        GROUP BY 2
        UNION ALL
        SELECT 'release', COALESCE(NULLIF(s."appVersion",''), NULLIF(s."revId",''),
                                   NULLIF(s."appBuild",''), 'unknown'),
               count(DISTINCT s.id)::int
        FROM "Signal" sig JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."workspaceId" = ${workspaceId} AND sig."incidentId" = ${incidentId}
        GROUP BY 2`,

      this.db.$queryRaw<CrashRow[]>`
        SELECT i.id, i.title, i."errorType", i."isCrash", i.behavioral,
               i."occurrenceCount",
               count(DISTINCT sig."sessionId")::int AS shared
        FROM "Signal" sig
        JOIN "IssueOccurrence" io ON io."sessionId" = sig."sessionId"
        JOIN "Issue" i ON i."workspaceId" = io."workspaceId" AND i.fingerprint = io.fingerprint
        WHERE sig."workspaceId" = ${workspaceId} AND sig."incidentId" = ${incidentId}
        GROUP BY 1,2,3,4,5,6
        ORDER BY shared DESC
        LIMIT 5`,

      // Correlation by SHARED SESSIONS — a stronger signal than time overlap.
      this.db.$queryRaw<CorrRow[]>`
        SELECT s2."incidentId" AS id, count(DISTINCT s2."sessionId")::int AS shared
        FROM "Signal" s1
        JOIN "Signal" s2 ON s2."sessionId" = s1."sessionId"
        WHERE s1."workspaceId" = ${workspaceId}
          AND s1."incidentId" = ${incidentId}
          AND s2."incidentId" IS NOT NULL
          AND s2."incidentId" <> ${incidentId}
        GROUP BY 1
        ORDER BY shared DESC
        LIMIT 5`,

      // Prior instances of the SAME cluster key — rides the unique key's prefix.
      this.db.incident.findMany({
        where: {
          workspaceId,
          signalType: incident.signalType,
          screen: incident.screen,
          element: incident.element,
          id: { not: incidentId },
        },
        orderBy: { lastSeenAt: "desc" },
        take: 4,
        select: {
          id: true,
          title: true,
          status: true,
          sessionCount: true,
          firstSeenAt: true,
          lastSeenAt: true,
        },
      }),
    ]);

    const corrIds = corr.map((c) => c.id);
    const corrRows =
      corrIds.length > 0
        ? await this.db.incident.findMany({
            where: { workspaceId, id: { in: corrIds } },
            select: {
              id: true,
              title: true,
              signalType: true,
              polarity: true,
              sessionCount: true,
              deltaPctX100: true,
            },
          })
        : [];
    const byId = new Map(corrRows.map((r) => [r.id, r]));

    return {
      incident,
      breakdowns: {
        platforms: IncidentInvestigationService.top(dims, "platform"),
        browsers: IncidentInvestigationService.top(dims, "browser"),
        countries: IncidentInvestigationService.top(dims, "country"),
        releases: IncidentInvestigationService.top(dims, "release"),
      },
      relatedCrashes: crashes.map((c) => ({
        id: c.id,
        title: c.title,
        errorType: c.errorType,
        isCrash: c.isCrash,
        behavioral: c.behavioral,
        occurrences: c.occurrenceCount,
        sharedSessions: c.shared,
      })),
      correlated: corr
        .map((c) => {
          const r = byId.get(c.id);
          return r ? { ...r, sharedSessions: c.shared } : null;
        })
        .filter(Boolean),
      similarHistorical: historical,
    };
  }

  /**
   * The DETERMINISTIC investigation behind one ISSUE — the crash/error twin of
   * `detail` above, and deliberately a different shape.
   *
   * An incident is a behavioural cluster, so its evidence is comparative
   * (deltas, correlated incidents) and "why" is inferential. An issue is a
   * fingerprint group, so its evidence is FORENSIC and largely conclusive on its
   * own: `culprit` names the code, and firstRelease→lastRelease brackets the
   * regression. That is a stronger answer than a model inferring one, which is
   * why this path has no AI report attached to it — the panel states the
   * evidence rather than narrating it.
   *
   * Access pattern: the session set comes from the shared issue resolver
   * (index-served by IssueOccurrence @@index([workspaceId, fingerprint])), then
   * ONE grouped UNION for the breakdowns and ONE self-join for the incidents
   * sharing those sessions — the Crashlytics ↔ Signals bridge, which is the one
   * thing neither system shows on its own.
   */
  async issueDetail(workspaceId: number, issueId: number) {
    const issue = await this.db.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: {
        id: true,
        title: true,
        errorType: true,
        culprit: true,
        isCrash: true,
        behavioral: true,
        status: true,
        occurrenceCount: true,
        sessionCount: true,
        userCount: true,
        firstRelease: true,
        lastRelease: true,
        firstSeenAt: true,
        lastSeenAt: true,
        lastPublicId: true,
      },
    });
    if (!issue) return null;

    const scope = await resolveIssueSessionIds(this.db, workspaceId, issueId);
    const ids = scope.ids;
    if (ids.length === 0) {
      return {
        issue,
        breakdowns: { platforms: [], browsers: [], countries: [], releases: [] },
        relatedIncidents: [],
        scopeCapped: scope.truncated,
      };
    }

    const [dims, corr] = await Promise.all([
      this.db.$queryRaw<DimRow[]>`
        SELECT 'platform' AS dim, COALESCE(NULLIF(s.platform,''),'unknown') AS val,
               count(DISTINCT s.id)::int AS sessions
        FROM "Session" s WHERE s."workspaceId" = ${workspaceId}
          AND s.id IN (${Prisma.join(ids)}) GROUP BY 2
        UNION ALL
        SELECT 'browser', COALESCE(NULLIF(s.browser,''),'unknown'), count(DISTINCT s.id)::int
        FROM "Session" s WHERE s."workspaceId" = ${workspaceId}
          AND s.id IN (${Prisma.join(ids)}) GROUP BY 2
        UNION ALL
        SELECT 'country', COALESCE(NULLIF(s.country,''),'unknown'), count(DISTINCT s.id)::int
        FROM "Session" s WHERE s."workspaceId" = ${workspaceId}
          AND s.id IN (${Prisma.join(ids)}) GROUP BY 2
        UNION ALL
        SELECT 'release', COALESCE(NULLIF(s."appVersion",''), NULLIF(s."revId",''),
                                   NULLIF(s."appBuild",''), 'unknown'),
               count(DISTINCT s.id)::int
        FROM "Session" s WHERE s."workspaceId" = ${workspaceId}
          AND s.id IN (${Prisma.join(ids)}) GROUP BY 2`,

      // The bridge: behavioural incidents occurring in the SAME sessions as this
      // crash. A crash that co-occurs with a conversion drop is the most useful
      // thing this panel can say, and neither system surfaces it alone.
      this.db.$queryRaw<CorrRow[]>`
        SELECT sig."incidentId" AS id, count(DISTINCT sig."sessionId")::int AS shared
        FROM "Signal" sig
        WHERE sig."workspaceId" = ${workspaceId}
          AND sig."incidentId" IS NOT NULL
          AND sig."sessionId" IN (${Prisma.join(ids)})
        GROUP BY 1 ORDER BY shared DESC LIMIT 5`,
    ]);

    const corrIds = corr.map((c) => c.id);
    const corrRows =
      corrIds.length > 0
        ? await this.db.incident.findMany({
            where: { workspaceId, id: { in: corrIds } },
            select: {
              id: true,
              title: true,
              signalType: true,
              polarity: true,
              sessionCount: true,
              deltaPctX100: true,
            },
          })
        : [];
    const byId = new Map(corrRows.map((r) => [r.id, r]));

    return {
      issue,
      breakdowns: {
        platforms: IncidentInvestigationService.top(dims, "platform"),
        browsers: IncidentInvestigationService.top(dims, "browser"),
        countries: IncidentInvestigationService.top(dims, "country"),
        releases: IncidentInvestigationService.top(dims, "release"),
      },
      relatedIncidents: corr
        .map((c) => {
          const r = byId.get(c.id);
          return r ? { ...r, sharedSessions: c.shared } : null;
        })
        .filter(Boolean),
      scopeCapped: scope.truncated,
    };
  }
}
