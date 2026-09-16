import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";

/**
 * Correlates derived signals into Incidents — the middle of the Overview spine
 * (signals → incidents → storyline).
 *
 * Runs nightly, just after the signal backfill (02:15), as two set-based SQL
 * statements + one resolve sweep — never a per-incident or per-workspace query
 * loop:
 *   1. `cluster()` groups the recent window's signals by (workspace, type,
 *      screen) and upserts one Incident per group that clears the noise floor,
 *      computing rank + delta in SQL, then stamps each member signal's
 *      incidentId in a single UPDATE…FROM.
 *   2. `autoResolve()` flips OPEN incidents with no recent recurrence to
 *      RESOLVED in one UPDATE, freeing the unique slot so a genuine recurrence
 *      opens a fresh incident.
 */
@Injectable()
export class IncidentsService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IncidentsService.name);

  /** Current scoring window — "what's happening now". */
  private static readonly CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
  /** Total look-back (current + the comparable prior window for the delta). */
  private static readonly LOOKBACK_MS = 48 * 60 * 60 * 1000;
  /** Noise floor: distinct sessions in the current window before a group of
   *  signals is worth promoting to an incident. */
  private static readonly MIN_CLUSTER = 3;
  /** An OPEN incident not seen for this long auto-resolves. */
  private static readonly RESOLVE_AFTER_MS = 72 * 60 * 60 * 1000;

  @Cron("30 2 * * *")
  async runNightly(): Promise<void> {
    try {
      const { upserted, stamped } = await this.cluster();
      const resolved = await this.autoResolve();
      this.logger.log(
        `incident clusterer: ${upserted} candidate-rows upserted, ${stamped} member signals stamped, ${resolved} auto-resolved`,
      );
    } catch (e) {
      this.logger.warn(`incident clusterer failed: ${(e as Error).message}`);
    }
  }

  /**
   * Group the recent window's signals and upsert one Incident per qualifying
   * (workspace, type, screen) group. Single statement:
   *   - the CTE aggregates current vs prior session counts, distinct users
   *     (anonymous sessions count as distinct), severity (Σ weight), and the
   *     first/last-seen bounds, all in one grouped pass over a 48h slice;
   *   - the INSERT…SELECT computes the human title, the rank (severity × reach ×
   *     surprise × recency) and deltaPctX100 in SQL;
   *   - ON CONFLICT on the (workspace, type, screen, status=OPEN) unique key
   *     makes it idempotent — re-running UPDATEs the live incident, never dupes.
   * firstSeenAt is intentionally NOT updated on conflict (it's the incident's
   * true first appearance); lastSeenAt always advances.
   *
   * Severity multipliers (crash 5 > backend/conversion-fail 3 > slow 2 > rest 1)
   * and the new-incident surprise boost (3) live in the SQL CASEs below.
   */
  private async cluster(): Promise<{ upserted: number; stamped: number }> {
    const now = Date.now();
    const curStart = new Date(now - IncidentsService.CURRENT_WINDOW_MS);
    const lookbackStart = new Date(now - IncidentsService.LOOKBACK_MS);
    const minCluster = IncidentsService.MIN_CLUSTER;

    const upserted = await this.db.$executeRaw`
      WITH agg AS (
        SELECT
          sig."workspaceId" AS workspace_id,
          sig.type          AS signal_type,
          sig.polarity      AS polarity,
          COALESCE(sig.screen, '')  AS screen,
          COALESCE(sig.element, '') AS element,
          count(DISTINCT CASE WHEN sig."occurredAt" >= ${curStart} THEN sig."sessionId" END) AS cur_sessions,
          count(DISTINCT CASE WHEN sig."occurredAt" <  ${curStart} THEN sig."sessionId" END) AS prior_sessions,
          count(DISTINCT CASE WHEN sig."occurredAt" >= ${curStart}
                              THEN COALESCE(s."endUserId", -sig."sessionId") END)            AS users,
          sum(CASE WHEN sig."occurredAt" >= ${curStart} THEN sig.weight ELSE 0 END)          AS weight_sum,
          min(CASE WHEN sig."occurredAt" >= ${curStart} THEN sig."occurredAt" END)           AS first_seen,
          max(CASE WHEN sig."occurredAt" >= ${curStart} THEN sig."occurredAt" END)           AS last_seen
        FROM "Signal" sig
        JOIN "Session" s ON s.id = sig."sessionId"
        WHERE sig."occurredAt" >= ${lookbackStart}
        GROUP BY sig."workspaceId", sig.type, sig.polarity, COALESCE(sig.screen, ''), COALESCE(sig.element, '')
        HAVING count(DISTINCT CASE WHEN sig."occurredAt" >= ${curStart} THEN sig."sessionId" END) >= ${minCluster}
      )
      INSERT INTO "Incident" (
        "workspaceId", "title", "signalType", "polarity", "screen", "element", "status", "rank",
        "sessionCount", "userCount", "deltaPctX100", "impactCents", "firstSeenAt", "lastSeenAt"
      )
      SELECT
        a.workspace_id,
        -- Specific title: element-aware for frustration ("Rage clicks on the
        -- password field"), then a screen/endpoint locus when known.
        (CASE a.signal_type
           WHEN 'user_frustrated'    THEN CASE WHEN a.element <> '' THEN 'Rage clicks on the ' || a.element ELSE 'User frustration' END
           WHEN 'backend_failure'    THEN 'Backend failures'
           WHEN 'slow_api'           THEN 'Slow API responses'
           WHEN 'crash_detected'     THEN 'Crashes'
           WHEN 'form_abandonment'   THEN 'Form abandonment'
           WHEN 'navigation_loop'    THEN 'Navigation loops'
           WHEN 'conversion_success' THEN 'Conversion wins'
           WHEN 'conversion_failure' THEN 'Conversion drop-off'
           WHEN 'unmet_demand'       THEN CASE WHEN a.element <> '' THEN 'Unmet demand: ' || a.element ELSE 'Unmet demand' END
           ELSE a.signal_type END)
          || CASE WHEN a.screen <> '' THEN ' on ' || a.screen
                  WHEN a.element <> '' THEN ''
                  ELSE ' across the app' END,
        a.signal_type,
        a.polarity,
        a.screen,
        a.element,
        'OPEN'::"IncidentStatus",
        (
          (a.weight_sum * (CASE a.signal_type
             WHEN 'crash_detected'     THEN 5
             WHEN 'backend_failure'    THEN 3
             WHEN 'conversion_failure' THEN 3
             WHEN 'slow_api'           THEN 2
             ELSE 1 END))
          * ln(1 + a.users)
          * (CASE WHEN a.prior_sessions = 0 THEN 3.0
                  ELSE GREATEST(1.0, a.cur_sessions::float8 / a.prior_sessions) END)
          * exp(-(EXTRACT(EPOCH FROM (now() - a.last_seen)) / 3600.0) / 24.0)
        ),
        a.cur_sessions,
        a.users,
        (CASE WHEN a.prior_sessions = 0 THEN 10000
              ELSE round(((a.cur_sessions - a.prior_sessions)::float8 / a.prior_sessions) * 10000) END)::int,
        -- impactCents (doc 09 §7): affected users × a per-type loss factor ×
        -- the workspace AOV. NULL AOV → 0 (the dashboard then shows reach, not
        -- a fabricated dollar figure). Positive-polarity types get no loss.
        CASE WHEN w."avgOrderValueCents" IS NULL THEN 0
             ELSE round(a.users * w."avgOrderValueCents" * (CASE a.signal_type
               WHEN 'conversion_failure' THEN 0.8
               WHEN 'form_abandonment'   THEN 0.6
               WHEN 'crash_detected'     THEN 0.5
               WHEN 'backend_failure'    THEN 0.4
               WHEN 'navigation_loop'    THEN 0.3
               WHEN 'user_frustrated'    THEN 0.2
               WHEN 'slow_api'           THEN 0.2
               ELSE 0 END))::int END,
        a.first_seen,
        a.last_seen
      FROM agg a
      LEFT JOIN "Workspace" w ON w.id = a.workspace_id
      ON CONFLICT ("workspaceId", "signalType", "screen", "element", "status")
      DO UPDATE SET
        "rank"         = EXCLUDED."rank",
        "sessionCount" = EXCLUDED."sessionCount",
        "userCount"    = EXCLUDED."userCount",
        "deltaPctX100" = EXCLUDED."deltaPctX100",
        "impactCents"  = EXCLUDED."impactCents",
        "lastSeenAt"   = EXCLUDED."lastSeenAt",
        "title"        = EXCLUDED."title",
        "polarity"     = EXCLUDED."polarity"
    `;

    // Stamp the current-window member signals into their incident — one
    // set-based UPDATE…FROM joining Signal → its OPEN incident on the same
    // (workspace, type, screen) key. Only fills NULLs, so it never re-churns
    // already-stamped rows.
    //
    // Scope note: this deliberately stamps only the CURRENT window. Signals
    // older than curStart stay NULL — they belonged to earlier incident
    // instances (the unique key includes status, so a resolved incident frees
    // the slot and a recurrence opens a fresh row). So `incidentId` is never a
    // complete history; anything needing all-time membership must match on the
    // cluster key (type, screen, element) instead of joining the FK.
    const stamped = await this.db.$executeRaw`
      UPDATE "Signal" sig
      SET "incidentId" = inc.id
      FROM "Incident" inc
      WHERE inc."workspaceId" = sig."workspaceId"
        AND inc."signalType"  = sig.type
        AND inc.screen        = COALESCE(sig.screen, '')
        AND inc.element       = COALESCE(sig.element, '')
        AND inc.status        = 'OPEN'::"IncidentStatus"
        AND sig."occurredAt"  >= ${curStart}
        AND sig."incidentId" IS NULL
    `;

    // (Templated storyline generation removed — storyline is AI-generated now;
    // the AI intelligence pass writes it off these incidents.)
    return { upserted, stamped };
  }

  /**
   * Auto-resolve OPEN incidents with no recurrence inside the resolve window —
   * one set-based UPDATE, same shape as RetentionService's sweeps. Runs after
   * cluster() so freshly-active incidents (whose lastSeenAt just advanced) are
   * not swept.
   */
  private async autoResolve(): Promise<number> {
    const cutoff = new Date(Date.now() - IncidentsService.RESOLVE_AFTER_MS);
    return this.db.$executeRaw`
      UPDATE "Incident"
      SET "status" = 'RESOLVED'::"IncidentStatus", "resolvedAt" = now()
      WHERE "status" = 'OPEN'::"IncidentStatus" AND "lastSeenAt" < ${cutoff}
    `;
  }

  /**
   * Set an incident's status from the dashboard (Acknowledge / Resolve). Scoped
   * to the workspace so a caller can't touch another tenant's incidents.
   */
  async setStatus(
    workspaceId: number,
    incidentId: number,
    status: "OPEN" | "ACK" | "RESOLVED",
  ): Promise<{ ok: boolean }> {
    const res = await this.db.incident.updateMany({
      where: { id: incidentId, workspaceId },
      data: {
        status,
        resolvedAt: status === "RESOLVED" ? new Date() : null,
      },
    });
    return { ok: res.count > 0 };
  }

  /**
   * Manual trigger for the spot-check / on-demand recompute. Exposed so a script
   * or a future admin endpoint can run the nightly logic immediately without
   * waiting for the cron.
   */
  async clusterNow(): Promise<{
    upserted: number;
    stamped: number;
    resolved: number;
  }> {
    const { upserted, stamped } = await this.cluster();
    const resolved = await this.autoResolve();
    return { upserted, stamped, resolved };
  }
}
