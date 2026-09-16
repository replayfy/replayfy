import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";

/**
 * Clusters sessions by their navigation path and records how often each journey
 * "fails" — the Overview "top failed journeys" health widget (doc 09 §9 /
 * 10 Slice 4).
 *
 * Runs nightly as ONE set-based statement (no per-session loop): a CTE builds
 * each session's normalized screen sequence from SessionPath, flags whether the
 * session carried any negative signal, groups by (workspace, day, sequence),
 * and upserts a JourneyCluster idempotently. A journey's pathKey is the md5 of
 * its sequence so the unique key stays fixed-length.
 */
@Injectable()
export class JourneyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(JourneyService.name);

  /** Cluster sessions finalized within this trailing window. */
  private static readonly WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  /** Noise floor: a path needs at least this many sessions to be a cluster. */
  private static readonly MIN_SESSIONS = 3;

  @Cron("50 2 * * *")
  async runNightly(): Promise<void> {
    try {
      const n = await this.clusterRecent();
      this.logger.log(`journey clusterer upserted ${n} cluster-rows`);
    } catch (e) {
      this.logger.warn(`journey clusterer failed: ${(e as Error).message}`);
    }
  }

  /**
   * Build/refresh journey clusters for the trailing window. Idempotent — the
   * ON CONFLICT refreshes counts in place. Returns rows written.
   *
   * - `paths`   : per-session normalized screen sequence (host/scheme + query
   *               stripped), bucketed by the session's UTC day.
   * - `flagged` : marks a session failed if it carried any NEGATIVE signal.
   * - `grouped` : counts sessions + failures per (workspace, day, sequence),
   *               keeping a representative (preferably failed) session, with the
   *               MIN_SESSIONS noise floor.
   */
  async clusterRecent(): Promise<number> {
    const windowStart = new Date(Date.now() - JourneyService.WINDOW_MS);
    const minSessions = JourneyService.MIN_SESSIONS;

    return this.db.$executeRaw`
      WITH paths AS (
        SELECT
          s."workspaceId" AS workspace_id,
          sp."sessionId"  AS session_id,
          (s."endedAt" AT TIME ZONE 'UTC')::date AS day,
          string_agg(
            split_part(split_part(regexp_replace(sp.url, '^https?://[^/]+', ''), '?', 1), '#', 1),
            ' → ' ORDER BY sp.sequence
          ) AS path_label
        FROM "SessionPath" sp
        JOIN "Session" s ON s.id = sp."sessionId"
        WHERE s.status = 'COMPLETED' AND s."endedAt" >= ${windowStart}
        GROUP BY s."workspaceId", sp."sessionId", (s."endedAt" AT TIME ZONE 'UTC')::date
      ),
      flagged AS (
        SELECT
          p.workspace_id, p.session_id, p.day, p.path_label,
          EXISTS (
            SELECT 1 FROM "Signal" sig
            WHERE sig."sessionId" = p.session_id
              AND sig.polarity = 'NEGATIVE'::"SignalPolarity"
          ) AS failed,
          EXISTS (
            SELECT 1 FROM "Signal" sig
            WHERE sig."sessionId" = p.session_id
              AND sig.type = 'conversion_success'
          ) AS succeeded
        FROM paths p
        WHERE p.path_label <> ''
      ),
      grouped AS (
        SELECT
          workspace_id, day, path_label,
          count(*) AS sessions,
          count(*) FILTER (WHERE failed) AS fails,
          count(*) FILTER (WHERE succeeded) AS successes,
          COALESCE(max(session_id) FILTER (WHERE failed), max(session_id)) AS example_session,
          max(session_id) FILTER (WHERE succeeded) AS example_success_session
        FROM flagged
        GROUP BY workspace_id, day, path_label
        HAVING count(*) >= ${minSessions}
      )
      INSERT INTO "JourneyCluster" (
        "workspaceId","day","pathKey","label","sessionCount","failCount","failRate",
        "successCount","successRate","exampleSessionId","exampleSuccessSessionId"
      )
      SELECT
        g.workspace_id, g.day, md5(g.path_label), left(g.path_label, 200),
        g.sessions, g.fails,
        round(g.fails::float8 / g.sessions * 100)::int,
        g.successes,
        round(g.successes::float8 / g.sessions * 100)::int,
        g.example_session, g.example_success_session
      FROM grouped g
      ON CONFLICT ("workspaceId","day","pathKey") DO UPDATE SET
        "label"                   = EXCLUDED."label",
        "sessionCount"            = EXCLUDED."sessionCount",
        "failCount"               = EXCLUDED."failCount",
        "failRate"                = EXCLUDED."failRate",
        "successCount"            = EXCLUDED."successCount",
        "successRate"             = EXCLUDED."successRate",
        "exampleSessionId"        = EXCLUDED."exampleSessionId",
        "exampleSuccessSessionId" = EXCLUDED."exampleSuccessSessionId"
    `;
  }
}
