import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient, Prisma, IssueStatus } from "@replay/db-postgres";
import {
  errorEventsForSessions,
  anrEventsForSessions,
  failingNetworkForSessions,
  listEventsForSessions,
} from "@replay/db-clickhouse";
import {
  fingerprintError,
  fingerprintAnr,
  parseStackFrames,
  type DisplayFrame,
} from "./issue-fingerprint";

import { paginated } from "../common/api-response";
import {
  decodeCompositeCursor,
  encodeCompositeCursor,
} from "../common/cursor";

/** One value of a dimension (browser / os / country) with its share of the
 *  issue's affected sessions. */
export interface DimStat {
  val: string;
  pct: number;
}

/**
 * The Crashlytics list/count filter language. Every dimension here is either an
 * Issue COLUMN (status / platform / release / errorClass / lastSeenAt) or a
 * text search over columns — all index-served or a residual filter over a
 * workspace's small, bounded issue aggregate. Multi-value fields arrive
 * comma-separated (`status=OPEN,REGRESSED`) and become a Prisma `in`.
 *
 * Browser / OS / country are deliberately NOT filterable here: they are not
 * Issue columns (they're derived per-issue from IssueOccurrence⋈Session), so
 * filtering the list on them would mean a per-row join — an N+1 the aggregate
 * exists to avoid. They stay a drawer-only breakdown.
 */
export interface IssueListFilters {
  status?: string; // "ALL" | one status | comma list → { in }
  limit?: number;
  behavioral?: boolean;
  category?: string; // crash | exception | error | anr | all
  search?: string;
  cursor?: string;
  platform?: string; // comma list of platforms → { in }
  release?: string; // comma list of releases (matches lastRelease) → { in }
  since?: number; // epoch ms — keep issues seen since (lastSeenAt >= since)
  until?: number; // epoch ms — keep issues seen up to (lastSeenAt <= until)
  /** Sort order for the list. "recent" = lastSeenAt DESC (the Crashlytics
   *  triage default — freshest first); anything else = rank DESC (impact-ranked,
   *  used by the homepage "top crashes" ledger). */
  sort?: string;
}

/** One row of the Crashlytics breakdown band (crashes grouped by version or
 *  platform): the dimension value + its blast radius. `occurrences` = total
 *  crash events (sum of Issue.occurrenceCount, no double-counting); `issues` =
 *  distinct issue groups in that bucket. */
export interface CrashBreakdownRow {
  key: string;
  occurrences: number;
  issues: number;
  /** Affected users in this bucket (sum of per-issue userCount — an upper bound,
   *  a user hitting two issues counts twice). Present on version rows for the
   *  Release Health table; the FE labels it "affected", not "distinct". */
  users?: number;
}

/** One category's rollup for the Crashlytics metric row: crash EVENT volume
 *  (occurrenceCount), distinct issue GROUPS, affected users, plus a trailing
 *  30-day daily `spark` and a period `deltaPct` (last 30d vs the prior 30d;
 *  null when there is no prior baseline). */
export interface CrashStatBucket {
  events: number;
  groups: number;
  users: number;
  spark: number[];
  deltaPct: number | null;
}
/** Per-category rollup for the Crashlytics header metric row. `freeze` folds in
 *  the `anr` errorClass. */
export interface CrashStats {
  crashes: CrashStatBucket;
  exceptions: CrashStatBucket;
  freezes: CrashStatBucket;
  errors: CrashStatBucket;
  affectedUsers: number;
}

/**
 * Issue grouping for finalized sessions.
 *
 * Two levels, mirroring the Signal→Incident spine:
 *   • IssueOccurrence — the per-session derived fact. One row per
 *     (fingerprint, session); `count` holds repeats inside that session.
 *     Derivation is idempotent per session (delete-then-insert scoped to
 *     sessionId), so the finalize hook and any backfill can both run without
 *     double-counting.
 *   • Issue — the cross-session aggregate ("142× · 96 users"). Rebuilt
 *     SET-BASED from IssueOccurrence with a single INSERT…SELECT…ON CONFLICT,
 *     scoped to the fingerprints a batch actually touched (index-served via
 *     the (workspaceId, fingerprint) index) — never a whole-table scan, never
 *     a per-issue query loop.
 *
 * Numbers are 100% deterministic here (SQL aggregates). Any AI narration
 * happens elsewhere and only ever describes these precomputed figures.
 */
@Injectable()
export class IssuesService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IssuesService.name);

  /**
   * Derive (idempotently) the Issue occurrences for a batch of finalized
   * sessions, then re-aggregate only the Issues those sessions touched.
   * Fire-and-forget from the finalize path — must never reject into ingest.
   */
  async deriveForSessions(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    try {
      await this.deriveForSessionsInner(ids);
    } catch (e) {
      this.logger.warn(
        `issue derive failed (${ids.length} sessions): ${(e as Error).message}`,
      );
    }
  }

  private async deriveForSessionsInner(ids: number[]): Promise<void> {
    // (1) Anchors — workspace, platform, user, and the finalize time we use
    // when an event carries no usable timestamp.
    const anchors = await this.db.session.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        workspaceId: true,
        endUserId: true,
        platform: true,
        endedAt: true,
      },
    });
    const anchorById = new Map(anchors.map((a) => [a.id, a]));

    // (2) One grouped ClickHouse read of the batch's error/crash events. The
    // read is tenant-scoped, and `workspace_id` is the LEADING column of the
    // session_events sort key, so we group the batch by workspace and issue one
    // seek per DISTINCT workspace (finalize = 1) — never per session. Same
    // shape as SignalsService's wsGroups fan-out.
    const wsGroups = new Map<number, number[]>();
    for (const a of anchors) {
      const g = wsGroups.get(a.workspaceId);
      if (g) g.push(a.id);
      else wsGroups.set(a.workspaceId, [a.id]);
    }
    const events: Awaited<ReturnType<typeof errorEventsForSessions>> = [];
    const anrs: Awaited<ReturnType<typeof anrEventsForSessions>> = [];
    for (const [workspaceId, sessionIds] of wsGroups) {
      // Error/crash + UI-freeze reads for a workspace run CONCURRENTLY — each is
      // one bounded PK-prefix seek on session_events (see @replay/db-clickhouse),
      // never a per-session loop. Freezes live in the perf stream, not the error
      // stream, so they need their own read.
      const [errs, anrEvts] = await Promise.all([
        errorEventsForSessions({ workspaceId, sessionIds }),
        anrEventsForSessions({ workspaceId, sessionIds }),
      ]);
      events.push(...errs);
      anrs.push(...anrEvts);
    }

    // (3) Fingerprint each event and fold to one row per (session,
    // fingerprint), summing repeats and keeping the latest occurrence's
    // display fields. Keyed "sessionId:fingerprint".
    interface Folded {
      workspaceId: number;
      sessionId: number;
      endUserId: number | null;
      fingerprint: string;
      isCrash: boolean;
      errorClass: string;
      errorType: string;
      message: string;
      culprit: string;
      platform: string;
      screen: string;
      release: string;
      count: number;
      latestTs: number;
    }
    const folded = new Map<string, Folded>();
    for (const ev of events) {
      const anchor = anchorById.get(ev.session_id);
      if (!anchor) {
        continue;
      }
      const platform = anchor.platform ?? "";
      // Fine-grained category: a fatal crash, a handled exception (public
      // captureException → error_kind 'exception'), else a plain non-fatal error.
      const errorClass =
        ev.is_crash === 1
          ? "crash"
          : ev.error_kind === "exception"
            ? "exception"
            : "error";
      const fp = fingerprintError({
        isCrash: ev.is_crash === 1,
        platform,
        name: ev.name,
        message: ev.message,
        stack: ev.stack,
        framesJson: ev.frames_json,
      });
      const key = `${ev.session_id}:${fp.fingerprint}`;
      const existing = folded.get(key);
      if (existing) {
        existing.count += 1;
        if (ev.timestamp >= existing.latestTs) {
          existing.latestTs = ev.timestamp;
          existing.errorClass = errorClass;
          existing.message = fp.message;
          existing.culprit = fp.culprit;
          existing.screen = ev.screen;
          existing.release = ev.release;
        }
      } else {
        folded.set(key, {
          workspaceId: anchor.workspaceId,
          sessionId: ev.session_id,
          endUserId: anchor.endUserId ?? null,
          fingerprint: fp.fingerprint,
          isCrash: ev.is_crash === 1,
          errorClass,
          errorType: fp.errorType,
          message: fp.message,
          culprit: fp.culprit,
          platform,
          screen: ev.screen,
          release: ev.release,
          count: 1,
          latestTs: ev.timestamp,
        });
      }
    }

    // (3b) Fold UI freezes into the SAME per-(session,fingerprint) map. The ANR
    // fingerprint is namespaced "anr", so it can never collide with an error in
    // the same session — each freeze group is its own key. errorClass='anr' and
    // isCrash=false: a freeze is its own Crashlytics category, not a crash, so
    // it never inflates the crash-free rate.
    for (const ev of anrs) {
      const anchor = anchorById.get(ev.session_id);
      if (!anchor) {
        continue;
      }
      const platform = anchor.platform ?? "";
      const fp = fingerprintAnr({
        platform,
        stack: ev.stack,
        screen: ev.screen,
        durationMs: ev.duration_ms,
      });
      const key = `${ev.session_id}:${fp.fingerprint}`;
      const existing = folded.get(key);
      if (existing) {
        existing.count += 1;
        if (ev.timestamp >= existing.latestTs) {
          existing.latestTs = ev.timestamp;
          existing.message = fp.message;
          existing.culprit = fp.culprit;
          existing.screen = ev.screen;
          existing.release = ev.release;
        }
      } else {
        folded.set(key, {
          workspaceId: anchor.workspaceId,
          sessionId: ev.session_id,
          endUserId: anchor.endUserId ?? null,
          fingerprint: fp.fingerprint,
          isCrash: false,
          errorClass: "anr",
          errorType: fp.errorType,
          message: fp.message,
          culprit: fp.culprit,
          platform,
          screen: ev.screen,
          release: ev.release,
          count: 1,
          latestTs: ev.timestamp,
        });
      }
    }

    const rows: Prisma.IssueOccurrenceCreateManyInput[] = [];
    // (workspaceId → set of fingerprints touched) drives the scoped rebuild.
    const touched = new Map<number, Set<string>>();
    for (const f of folded.values()) {
      const occurredAt =
        f.latestTs > 0
          ? new Date(f.latestTs)
          : (anchorById.get(f.sessionId)?.endedAt ?? new Date());
      rows.push({
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        endUserId: f.endUserId,
        fingerprint: f.fingerprint,
        isCrash: f.isCrash,
        errorClass: f.errorClass,
        errorType: f.errorType,
        message: f.message,
        culprit: f.culprit,
        platform: f.platform,
        screen: f.screen,
        release: f.release,
        count: f.count,
        occurredAt,
      });
      let set = touched.get(f.workspaceId);
      if (!set) {
        set = new Set();
        touched.set(f.workspaceId, set);
      }
      set.add(f.fingerprint);
    }

    // (4) Idempotent delete-then-insert of this batch's occurrences.
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.db
        .$executeRaw`DELETE FROM "IssueOccurrence" WHERE "sessionId" IN (${Prisma.join(ids)})`,
    ];
    if (rows.length > 0) {
      ops.push(this.db.issueOccurrence.createMany({ data: rows }));
    }
    await this.db.$transaction(ops);

    // (5) Re-aggregate ONLY the Issues touched by this batch, per workspace.
    // Occurrences are committed above, so the rebuild reads consistent data.
    for (const [workspaceId, fps] of touched) {
      await this.rebuildIssues(workspaceId, [...fps]);
    }
  }

  /**
   * Re-aggregate the given fingerprints for one workspace into Issue rows —
   * one set-based INSERT…SELECT…ON CONFLICT. Recomputing from the source
   * occurrences (rather than incrementing) keeps it correct under
   * re-processing. Scoped by `fingerprint IN (…)` so it rides the
   * (workspaceId, fingerprint) index instead of scanning the table.
   *
   * Status: regression handling — a RESOLVED issue that receives a newer
   * occurrence than its resolvedAt reopens as REGRESSED; otherwise the human
   * status is preserved. A brand-new issue starts OPEN.
   */
  async rebuildIssues(
    workspaceId: number,
    fingerprints: string[],
  ): Promise<void> {
    if (fingerprints.length === 0) {
      return;
    }
    await this.db.$executeRaw`
      WITH agg AS (
        SELECT "workspaceId", fingerprint,
               SUM(count)                  AS occ,
               COUNT(DISTINCT "sessionId") AS sessions,
               COUNT(DISTINCT "endUserId") AS users,
               MIN("occurredAt")           AS first_seen,
               MAX("occurredAt")           AS last_seen
        FROM "IssueOccurrence"
        WHERE "workspaceId" = ${workspaceId}
          AND fingerprint IN (${Prisma.join(fingerprints)})
        GROUP BY "workspaceId", fingerprint
      ),
      rep AS (
        SELECT DISTINCT ON ("workspaceId", fingerprint)
               "workspaceId", fingerprint, "isCrash", "errorClass", "errorType",
               message, culprit, platform, release, "sessionId"
        FROM "IssueOccurrence"
        WHERE "workspaceId" = ${workspaceId}
          AND fingerprint IN (${Prisma.join(fingerprints)})
        ORDER BY "workspaceId", fingerprint, "occurredAt" DESC
      ),
      firstrel AS (
        SELECT DISTINCT ON ("workspaceId", fingerprint)
               "workspaceId", fingerprint, release AS first_release
        FROM "IssueOccurrence"
        WHERE "workspaceId" = ${workspaceId}
          AND fingerprint IN (${Prisma.join(fingerprints)})
        ORDER BY "workspaceId", fingerprint, "occurredAt" ASC
      )
      INSERT INTO "Issue" (
        "workspaceId", fingerprint, "isCrash", "errorClass", "errorType", title, message,
        culprit, platform, "firstRelease", "lastRelease", "occurrenceCount",
        "sessionCount", "userCount", "firstSeenAt", "lastSeenAt", status,
        rank, "lastPublicId", "lastSessionId"
      )
      SELECT
        agg."workspaceId", agg.fingerprint, rep."isCrash", rep."errorClass", rep."errorType",
        CASE WHEN rep.message LIKE rep."errorType" || '%'
             THEN left(rep.message, 500)
             ELSE left(rep."errorType" || ': ' || rep.message, 500) END,
        left(rep.message, 500), rep.culprit, rep.platform,
        firstrel.first_release, rep.release,
        agg.occ, agg.sessions, agg.users, agg.first_seen, agg.last_seen,
        'OPEN'::"IssueStatus",
        (CASE WHEN rep."isCrash" THEN 2 ELSE 1 END)::float
          * (agg.users * 100 + agg.sessions),
        sess."publicId", rep."sessionId"
      FROM agg
      JOIN rep      USING ("workspaceId", fingerprint)
      JOIN firstrel USING ("workspaceId", fingerprint)
      LEFT JOIN "Session" sess ON sess.id = rep."sessionId"
      ON CONFLICT ("workspaceId", fingerprint) DO UPDATE SET
        "occurrenceCount" = EXCLUDED."occurrenceCount",
        "sessionCount"    = EXCLUDED."sessionCount",
        "userCount"       = EXCLUDED."userCount",
        "lastSeenAt"      = EXCLUDED."lastSeenAt",
        "firstSeenAt"     = LEAST("Issue"."firstSeenAt", EXCLUDED."firstSeenAt"),
        message           = EXCLUDED.message,
        title             = EXCLUDED.title,
        culprit           = EXCLUDED.culprit,
        "errorType"       = EXCLUDED."errorType",
        "lastRelease"     = EXCLUDED."lastRelease",
        platform          = EXCLUDED.platform,
        "isCrash"         = EXCLUDED."isCrash",
        "errorClass"      = EXCLUDED."errorClass",
        rank              = EXCLUDED.rank,
        "lastPublicId"    = EXCLUDED."lastPublicId",
        "lastSessionId"   = EXCLUDED."lastSessionId",
        status = CASE
          WHEN "Issue".status = 'RESOLVED'
               AND EXCLUDED."lastSeenAt" > COALESCE("Issue"."resolvedAt", "Issue"."lastSeenAt")
            THEN 'REGRESSED'::"IssueStatus"
          ELSE "Issue".status
        END`;
  }

  /** Behavioral signal types that group into first-class Issues (no thrown
   *  error). Excludes crash_detected (already an error Issue) and the positive
   *  signals (conversion_success / unmet_demand). */
  private static readonly BEHAVIORAL_TYPES = [
    "user_frustrated",
    "form_abandonment",
    "navigation_loop",
    "backend_failure",
    "slow_api",
    "conversion_failure",
  ];

  /**
   * Group the batch's BEHAVIORAL signals into first-class Issues — so "100 users
   * can't upload their profile picture" surfaces as ONE Issue (100 users, 1k
   * sessions), not 1,000 loose signals. Keyed on (type, screen, element); the
   * fingerprint is namespaced "beh:" so it never collides with a crash/error.
   * Scoped to the (type,screen,element) groups the batch touched, then each is
   * recomputed set-based across ALL its signals for correct totals — the same
   * touched-fingerprint rebuild the error path uses. Fired from the signals
   * chokepoint after error grouping.
   */
  async deriveBehavioralIssues(sessionIds: number[]): Promise<void> {
    if (sessionIds.length === 0) return;
    try {
      const touched = await this.db.$queryRaw<
        Array<{ workspaceId: number; fingerprint: string }>
      >`
        SELECT DISTINCT s."workspaceId",
          'beh:' || s.type || ':' || coalesce(s.screen,'') || ':' || coalesce(s.element,'') AS fingerprint
        FROM "Signal" s
        WHERE s."sessionId" IN (${Prisma.join(sessionIds)})
          AND s.type IN (${Prisma.join(IssuesService.BEHAVIORAL_TYPES)})`;
      if (touched.length === 0) return;
      const byWs = new Map<number, string[]>();
      for (const t of touched) {
        const arr = byWs.get(t.workspaceId);
        if (arr) arr.push(t.fingerprint);
        else byWs.set(t.workspaceId, [t.fingerprint]);
      }
      for (const [workspaceId, fps] of byWs) {
        await this.rebuildBehavioralIssues(workspaceId, fps);
      }
    } catch (e) {
      this.logger.warn(
        `behavioral issue derive failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Recompute the given behavioral Issue fingerprints from the Signal table in
   * ONE set-based INSERT…SELECT…ON CONFLICT — distinct users/sessions, first/last
   * seen, a representative recording (most-recent), and a reach-weighted rank.
   * Mirrors rebuildIssues; the source is Signal (joined to Session for the user),
   * not IssueOccurrence.
   */
  async rebuildBehavioralIssues(
    workspaceId: number,
    fingerprints: string[],
  ): Promise<void> {
    if (fingerprints.length === 0) return;
    await this.db.$executeRaw`
      WITH agg AS (
        SELECT s."workspaceId",
               'beh:' || s.type || ':' || coalesce(s.screen,'') || ':' || coalesce(s.element,'') AS fingerprint,
               s.type                          AS sig_type,
               max(coalesce(s.screen,''))      AS screen,
               max(coalesce(s.element,''))     AS element,
               SUM(s.weight)::int              AS occ,
               COUNT(DISTINCT s."sessionId")   AS sessions,
               COUNT(DISTINCT sess."endUserId") AS users,
               MIN(s."occurredAt")             AS first_seen,
               MAX(s."occurredAt")             AS last_seen,
               (array_agg(sess."publicId" ORDER BY s."occurredAt" DESC))[1] AS last_public,
               (array_agg(s."sessionId"   ORDER BY s."occurredAt" DESC))[1] AS last_session
        FROM "Signal" s
        JOIN "Session" sess ON sess.id = s."sessionId"
        WHERE s."workspaceId" = ${workspaceId}
          AND s.type IN (${Prisma.join(IssuesService.BEHAVIORAL_TYPES)})
          AND ('beh:' || s.type || ':' || coalesce(s.screen,'') || ':' || coalesce(s.element,'')) IN (${Prisma.join(fingerprints)})
        GROUP BY s."workspaceId", fingerprint, s.type
      )
      INSERT INTO "Issue" (
        "workspaceId", fingerprint, behavioral, "isCrash", "errorType", title,
        message, culprit, platform, "firstRelease", "lastRelease",
        "occurrenceCount", "sessionCount", "userCount", "firstSeenAt",
        "lastSeenAt", status, rank, "lastPublicId", "lastSessionId"
      )
      SELECT
        agg."workspaceId", agg.fingerprint, true, false, agg.sig_type,
        left(
          initcap(replace(agg.sig_type, '_', ' '))
          || CASE WHEN nullif(agg.element,'') IS NOT NULL THEN ' on ' || agg.element ELSE '' END
          || CASE WHEN nullif(agg.screen,'')  IS NOT NULL THEN ' (' || agg.screen || ')' ELSE '' END,
          300),
        '', coalesce(nullif(agg.element,''), nullif(agg.screen,''), ''), '',
        '', '',
        agg.occ, agg.sessions, agg.users, agg.first_seen, agg.last_seen,
        'OPEN'::"IssueStatus",
        (agg.users * 100 + agg.sessions)::float,
        agg.last_public, agg.last_session
      FROM agg
      ON CONFLICT ("workspaceId", fingerprint) DO UPDATE SET
        "occurrenceCount" = EXCLUDED."occurrenceCount",
        "sessionCount"    = EXCLUDED."sessionCount",
        "userCount"       = EXCLUDED."userCount",
        "lastSeenAt"      = EXCLUDED."lastSeenAt",
        "firstSeenAt"     = LEAST("Issue"."firstSeenAt", EXCLUDED."firstSeenAt"),
        title             = EXCLUDED.title,
        culprit           = EXCLUDED.culprit,
        rank              = EXCLUDED.rank,
        "lastPublicId"    = EXCLUDED."lastPublicId",
        "lastSessionId"   = EXCLUDED."lastSessionId",
        status = CASE
          WHEN "Issue".status = 'RESOLVED'
               AND EXCLUDED."lastSeenAt" > COALESCE("Issue"."resolvedAt", "Issue"."lastSeenAt")
            THEN 'REGRESSED'::"IssueStatus"
          ELSE "Issue".status
        END`;
  }

  // ── Dashboard reads ────────────────────────────────────────────────────────

  /**
   * Build the shared Issue filter predicate for the Crashlytics list AND its
   * category-count strip, so the two can never drift. Every clause is a column
   * predicate (index-served, or a residual over the workspace's small issue
   * aggregate) — no join, no scan. `applyCategory` is false for the count strip
   * (which reports a number PER category) and true for the list (where the
   * category tab is an active filter).
   */
  private buildIssueWhere(
    workspaceId: number,
    opts: IssueListFilters,
    flags: { applyCategory: boolean },
  ): Prisma.IssueWhereInput {
    const where: Prisma.IssueWhereInput = { workspaceId };

    // Status — "ALL" clears it, a comma list becomes an `in`, else equality.
    // No status ⇒ the default "actively broken" view (OPEN + REGRESSED).
    if (opts.status && opts.status !== "ALL") {
      const statuses = opts.status
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean) as IssueStatus[];
      where.status =
        statuses.length > 1 ? { in: statuses } : (statuses[0] as IssueStatus);
    } else if (!opts.status) {
      where.status = { in: [IssueStatus.OPEN, IssueStatus.REGRESSED] };
    }

    if (opts.behavioral !== undefined) {
      where.behavioral = opts.behavioral;
    }
    if (flags.applyCategory && opts.category && opts.category !== "all") {
      where.errorClass = opts.category;
    }

    // Platform / release facets — multi-select, comma-separated → `in`.
    const platforms = opts.platform
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (platforms && platforms.length) {
      where.platform = platforms.length > 1 ? { in: platforms } : platforms[0];
    }
    const releases = opts.release
      ?.split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (releases && releases.length) {
      where.lastRelease =
        releases.length > 1 ? { in: releases } : releases[0];
    }

    // Time window — "seen in [since, until]", either bound optional (the
    // Crashlytics date-range picker sends both). lastSeenAt is index-backed
    // ((workspaceId, status, lastSeenAt) / (workspaceId, lastSeenAt)); a residual
    // range otherwise.
    const seenGte =
      opts.since && Number.isFinite(opts.since)
        ? new Date(opts.since)
        : undefined;
    const seenLte =
      opts.until && Number.isFinite(opts.until)
        ? new Date(opts.until)
        : undefined;
    if (seenGte || seenLte) {
      where.lastSeenAt = {
        ...(seenGte ? { gte: seenGte } : {}),
        ...(seenLte ? { lte: seenLte } : {}),
      };
    }

    // Free-text search — the text an engineer greps for, over the columns that
    // carry it. Runs on the workspace's already-narrowed set, not a global scan.
    const s = opts.search?.trim();
    if (s) {
      where.OR = [
        { title: { contains: s, mode: "insensitive" } },
        { message: { contains: s, mode: "insensitive" } },
        { culprit: { contains: s, mode: "insensitive" } },
        { errorType: { contains: s, mode: "insensitive" } },
      ];
    }
    return where;
  }

  /**
   * The Issues list, ranked. `WHERE workspaceId=? [AND status=?] ORDER BY rank
   * DESC` — served by the (workspaceId, status, rank) index, no scan/sort.
   * Default hides RESOLVED/IGNORED so the list shows what's actively broken.
   */
  async list(workspaceId: number, opts: IssueListFilters = {}) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    // ── Filters (these also drive the total count below). The category tab IS a
    // filter here (unlike categoryCounts, which reports a count per category). ──
    const where = this.buildIssueWhere(workspaceId, opts, {
      applyCategory: true,
    });
    // ── Keyset pagination. Two orderings, both index-served and both carrying a
    // composite (sortValue, id) cursor because neither sort key is unique:
    //   • "recent" → (lastSeenAt DESC, id DESC) — the Crashlytics triage default,
    //     freshest first; cursor sortValue is lastSeenAt epoch-ms. Backed by
    //     (workspaceId, status, lastSeenAt) / (workspaceId, lastSeenAt) for ALL.
    //   • else     → (rank DESC, id DESC) — impact-ranked (homepage ledger).
    //     Backed by (workspaceId, status, rank) / (workspaceId, rank) for ALL. ──
    const recent = opts.sort === "recent";
    const cur = decodeCompositeCursor(opts.cursor);
    const pageWhere: Prisma.IssueWhereInput =
      cur && typeof cur.sortValue === "number"
        ? {
            AND: [
              where,
              recent
                ? {
                    OR: [
                      { lastSeenAt: { lt: new Date(cur.sortValue) } },
                      { lastSeenAt: new Date(cur.sortValue), id: { lt: cur.id } },
                    ],
                  }
                : {
                    OR: [
                      { rank: { lt: cur.sortValue } },
                      { rank: cur.sortValue, id: { lt: cur.id } },
                    ],
                  },
            ],
          }
        : where;
    const rows = await this.db.issue.findMany({
      where: pageWhere,
      orderBy: recent
        ? [{ lastSeenAt: "desc" }, { id: "desc" }]
        : [{ rank: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        rank: true,
        isCrash: true,
        errorClass: true,
        behavioral: true,
        errorType: true,
        title: true,
        message: true,
        culprit: true,
        platform: true,
        status: true,
        occurrenceCount: true,
        sessionCount: true,
        userCount: true,
        firstRelease: true,
        lastRelease: true,
        firstSeenAt: true,
        lastSeenAt: true,
        lastPublicId: true,
        lastSessionId: true,
        // Internal only — `rank` seeds the cursor, `fingerprint` joins the trend
        // series below; both are stripped from the payload.
        fingerprint: true,
      },
    });
    const hasMore = rows.length > take;
    const issues = hasMore ? rows.slice(0, take) : rows;
    const last = issues[issues.length - 1];
    const nextCursor =
      hasMore && issues.length > 0
        ? encodeCompositeCursor(
            recent ? last.lastSeenAt.getTime() : last.rank,
            last.id,
          )
        : null;
    // Total for the current filters — computed on the FIRST page only (keyset
    // pages don't recount). Scoped by the filter `where`, not the page keyset.
    const total =
      cur === undefined
        ? { value: await this.db.issue.count({ where }), capped: false }
        : undefined;
    if (issues.length === 0) {
      return paginated([], null, total);
    }

    // Per-issue 14-day trend sparkline. ONE set-based read: daily occurrence
    // counts for exactly the fingerprints being returned (≤ take), index-served
    // by the (workspaceId, fingerprint) index on IssueOccurrence — never a scan,
    // never a per-issue loop. Day bucketing is done in SQL (CURRENT_DATE −
    // occurredAt::date) so it stays timezone-consistent with the DB.
    const DAYS = 14;
    const fps = issues.map((i) => i.fingerprint);
    const series = await this.db.$queryRaw<
      Array<{ fingerprint: string; days_ago: number; c: number }>
    >`
      SELECT fingerprint,
             (CURRENT_DATE - "occurredAt"::date)::int AS days_ago,
             COUNT(*)::int AS c
      FROM "IssueOccurrence"
      WHERE "workspaceId" = ${workspaceId}
        AND fingerprint IN (${Prisma.join(fps)})
        AND "occurredAt" >= CURRENT_DATE - ${DAYS - 1}::int
      GROUP BY fingerprint, days_ago`;
    const trends = new Map<string, number[]>();
    for (const i of issues) trends.set(i.fingerprint, new Array(DAYS).fill(0));
    for (const r of series) {
      const idx = DAYS - 1 - Number(r.days_ago); // index 0 = oldest, last = today
      if (idx >= 0 && idx < DAYS) {
        const arr = trends.get(r.fingerprint);
        if (arr) arr[idx] = Number(r.c);
      }
    }
    // Strip the internal fingerprint + rank; expose `trend` (14 daily counts).
    // `paginated()` wraps as { data, nextCursor, total } — the homepage's plain
    // `useApi` path reads `.data`, the crashlytics page pages via `nextCursor`.
    return paginated(
      issues.map(({ fingerprint, rank, ...rest }) => ({
        ...rest,
        trend: trends.get(fingerprint) ?? [],
      })),
      nextCursor,
      total,
    );
  }

  /**
   * Per-category counts for the Crashlytics stat strip (All / Crashes /
   * Exceptions / Freezes). ONE set-based GROUP BY over the workspace's issue
   * aggregate — never a page-by-page client tally, never a per-category query.
   * Honours the same status + search filter as the list so the strip and the
   * table always agree; `category` is intentionally NOT applied (it returns the
   * count FOR each category). Index-served by (workspaceId, status, rank) /
   * (workspaceId, rank) — a small per-workspace aggregate, so grouping is cheap.
   */
  async categoryCounts(
    workspaceId: number,
    opts: IssueListFilters = {},
  ): Promise<{
    all: number;
    crash: number;
    exception: number;
    freeze: number;
    error: number;
  }> {
    // Same filter as the list MINUS the category tab (we return a count PER
    // category, so applying it would zero the others). Platform/release/time/
    // search all still apply, so the strip tracks the active filter exactly.
    const where = this.buildIssueWhere(workspaceId, opts, {
      applyCategory: false,
    });
    const grouped = await this.db.issue.groupBy({
      by: ["errorClass"],
      where,
      _count: { _all: true },
    });
    // 'anr' is the stored errorClass for UI freezes; the strip labels it Freezes.
    const out = { all: 0, crash: 0, exception: 0, freeze: 0, error: 0 };
    for (const g of grouped) {
      const n = g._count._all;
      out.all += n;
      if (g.errorClass === "crash") out.crash += n;
      else if (g.errorClass === "exception") out.exception += n;
      else if (g.errorClass === "anr") out.freeze += n;
      else out.error += n;
    }
    return out;
  }

  /**
   * Distinct platform + release values that actually appear in this workspace's
   * issues — the options the Crashlytics filter dropdowns offer. Two set-based
   * DISTINCT scans over the small per-workspace aggregate (groupBy is a
   * hash-aggregate, no per-row work), each bounded to a sane cap so a workspace
   * with thousands of releases can't return an unbounded list. Ordered by the
   * blast radius (most-affected first) so the useful facets sort to the top.
   */
  async facets(
    workspaceId: number,
  ): Promise<{ platforms: string[]; releases: string[] }> {
    const [plat, rel] = await Promise.all([
      this.db.issue.groupBy({
        by: ["platform"],
        where: { workspaceId, platform: { not: "" } },
        _sum: { sessionCount: true },
        orderBy: { _sum: { sessionCount: "desc" } },
        take: 20,
      }),
      this.db.issue.groupBy({
        by: ["lastRelease"],
        where: { workspaceId, lastRelease: { not: "" } },
        _sum: { sessionCount: true },
        orderBy: { _sum: { sessionCount: "desc" } },
        take: 50,
      }),
    ]);
    return {
      platforms: plat.map((p) => p.platform).filter(Boolean),
      releases: rel
        .map((r) => r.lastRelease)
        .filter((v) => !!v && v !== "unknown"),
    };
  }

  /**
   * Crashlytics breakdown band — "which versions / platforms are crashing",
   * the summary band that opens the crash-reporting page. Two set-based groupBy
   * hash-aggregates over the small per-workspace Issue aggregate (one per
   * dimension, run in parallel), each summing total crash events and counting
   * distinct issue groups, ordered most-impactful-first and capped to a bounded
   * top list so a workspace with thousands of releases can't return an unbounded
   * result. Served by the workspaceId index; no per-row work, scales to millions
   * of issues. Mirrors facets() — a hash-aggregate, not a scan.
   */
  async breakdown(
    workspaceId: number,
    from?: number,
    to?: number,
  ): Promise<{ version: CrashBreakdownRow[]; platform: CrashBreakdownRow[] }> {
    // Range mode — same date-window scoping as the metric row: group the
    // in-window occurrences by release / platform (index range-scan by
    // (workspaceId, occurredAt)), so the Release-health + Platform bands track
    // the picker instead of showing all-time totals.
    if (
      from != null &&
      to != null &&
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      to > from
    ) {
      const fromD = new Date(from);
      const toD = new Date(to);
      const [ver, plat] = await Promise.all([
        this.db.$queryRaw<
          { key: string; occurrences: bigint; issues: bigint; users: bigint }[]
        >(Prisma.sql`
          SELECT release AS key,
                 count(*)::bigint AS occurrences,
                 count(DISTINCT fingerprint)::bigint AS issues,
                 count(DISTINCT "endUserId")::bigint AS users
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND release NOT IN ('', 'unknown')
            AND "occurredAt" >= ${fromD} AND "occurredAt" <= ${toD}
          GROUP BY 1 ORDER BY occurrences DESC LIMIT 6`),
        this.db.$queryRaw<
          { key: string; occurrences: bigint; issues: bigint }[]
        >(Prisma.sql`
          SELECT platform AS key,
                 count(*)::bigint AS occurrences,
                 count(DISTINCT fingerprint)::bigint AS issues
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND platform <> ''
            AND "occurredAt" >= ${fromD} AND "occurredAt" <= ${toD}
          GROUP BY 1 ORDER BY occurrences DESC LIMIT 6`),
      ]);
      return {
        version: ver.map((g) => ({
          key: g.key,
          occurrences: Number(g.occurrences),
          issues: Number(g.issues),
          users: Number(g.users),
        })),
        platform: plat.map((g) => ({
          key: g.key,
          occurrences: Number(g.occurrences),
          issues: Number(g.issues),
        })),
      };
    }

    // ── All-time mode (no range). ──
    const [ver, plat] = await Promise.all([
      this.db.issue.groupBy({
        by: ["lastRelease"],
        where: { workspaceId, lastRelease: { notIn: ["", "unknown"] } },
        _sum: { occurrenceCount: true, userCount: true },
        _count: { _all: true },
        orderBy: { _sum: { occurrenceCount: "desc" } },
        take: 6,
      }),
      this.db.issue.groupBy({
        by: ["platform"],
        where: { workspaceId, platform: { not: "" } },
        _sum: { occurrenceCount: true },
        _count: { _all: true },
        orderBy: { _sum: { occurrenceCount: "desc" } },
        take: 6,
      }),
    ]);
    return {
      version: ver.map((g) => ({
        key: g.lastRelease,
        occurrences: g._sum.occurrenceCount ?? 0,
        issues: g._count._all,
        users: g._sum.userCount ?? 0,
      })),
      platform: plat.map((g) => ({
        key: g.platform,
        occurrences: g._sum.occurrenceCount ?? 0,
        issues: g._count._all,
      })),
    };
  }

  /**
   * Per-category rollup for the Crashlytics header metric row (Crashes /
   * Exceptions / Freezes / Affected users). ONE set-based groupBy hash-aggregate
   * over the small per-workspace Issue aggregate (errorClass has ≤4 buckets),
   * summing crash EVENT volume + affected users + issue groups. Served by the
   * workspaceId index; no per-row work, scales to millions of issues (same shape
   * as categoryCounts()). `anr` folds into freezes.
   */
  async crashStats(
    workspaceId: number,
    from?: number,
    to?: number,
  ): Promise<CrashStats> {
    const SPARK_DAYS = 30; // trailing sparkline length; prior 30d backs the delta
    const bucketKeyOf = (ec: string): keyof CrashStats =>
      ec === "crash"
        ? "crashes"
        : ec === "exception"
          ? "exceptions"
          : ec === "anr"
            ? "freezes"
            : "errors";

    // ── Range mode. The Crashlytics date-range picker scopes the WHOLE page to
    // [from, to]: the metric row (events/groups/users), the per-day category
    // spark, and the period delta are ALL computed from IssueOccurrence inside
    // the window — an index range-scan by (workspaceId, occurredAt), never the
    // all-time Issue aggregate. "events" = occurrence rows so the header total
    // equals the sum of the trend chart's bars; the spark is aligned to the
    // window (index 0 = the `from` day) and the delta compares the immediately
    // preceding equal-length window. All four reads run in parallel. ──
    if (
      from != null &&
      to != null &&
      Number.isFinite(from) &&
      Number.isFinite(to) &&
      to > from
    ) {
      const DAY_MS = 86_400_000;
      const fromD = new Date(from);
      const toD = new Date(to);
      const nDays = Math.max(1, Math.floor((to - from) / DAY_MS) + 1);
      const priorFrom = new Date(from - nDays * DAY_MS);
      const [totals, series, prior, affected] = await Promise.all([
        this.db.$queryRaw<
          { errorClass: string; events: bigint; groups: bigint; users: bigint }[]
        >(Prisma.sql`
          SELECT "errorClass",
                 count(*)::bigint AS events,
                 count(DISTINCT fingerprint)::bigint AS groups,
                 count(DISTINCT "endUserId")::bigint AS users
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND "occurredAt" >= ${fromD} AND "occurredAt" <= ${toD}
          GROUP BY 1`),
        this.db.$queryRaw<{ day_idx: number; errorClass: string; n: bigint }[]>(
          Prisma.sql`
          SELECT floor(extract(epoch FROM ("occurredAt" - ${fromD})) / 86400)::int AS day_idx,
                 "errorClass",
                 count(*)::bigint AS n
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND "occurredAt" >= ${fromD} AND "occurredAt" <= ${toD}
          GROUP BY 1, 2`,
        ),
        this.db.$queryRaw<{ errorClass: string; events: bigint }[]>(Prisma.sql`
          SELECT "errorClass", count(*)::bigint AS events
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND "occurredAt" >= ${priorFrom} AND "occurredAt" < ${fromD}
          GROUP BY 1`),
        this.db.$queryRaw<{ users: bigint }[]>(Prisma.sql`
          SELECT count(DISTINCT "endUserId")::bigint AS users
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND "occurredAt" >= ${fromD} AND "occurredAt" <= ${toD}`),
      ]);
      const daily: Record<string, number[]> = {
        crashes: new Array(nDays).fill(0),
        exceptions: new Array(nDays).fill(0),
        freezes: new Array(nDays).fill(0),
        errors: new Array(nDays).fill(0),
      };
      for (const r of series) {
        const i = Number(r.day_idx);
        if (i >= 0 && i < nDays)
          daily[bucketKeyOf(r.errorClass)][i] += Number(r.n);
      }
      const priorEvents: Record<string, number> = {
        crashes: 0,
        exceptions: 0,
        freezes: 0,
        errors: 0,
      };
      for (const r of prior)
        priorEvents[bucketKeyOf(r.errorClass)] += Number(r.events);
      const out: CrashStats = {
        crashes: { events: 0, groups: 0, users: 0, spark: daily.crashes, deltaPct: null },
        exceptions: { events: 0, groups: 0, users: 0, spark: daily.exceptions, deltaPct: null },
        freezes: { events: 0, groups: 0, users: 0, spark: daily.freezes, deltaPct: null },
        errors: { events: 0, groups: 0, users: 0, spark: daily.errors, deltaPct: null },
        affectedUsers: Number(affected[0]?.users ?? 0),
      };
      for (const g of totals) {
        const bucket = out[bucketKeyOf(g.errorClass)] as CrashStatBucket;
        bucket.events += Number(g.events);
        bucket.groups += Number(g.groups);
        bucket.users += Number(g.users);
      }
      for (const key of ["crashes", "exceptions", "freezes", "errors"] as const) {
        const curEvents = out[key].events;
        const prevEvents = priorEvents[key];
        out[key].deltaPct =
          prevEvents > 0
            ? Math.round(((curEvents - prevEvents) / prevEvents) * 100)
            : null;
      }
      return out;
    }

    // ── All-time mode (no range): the original per-workspace read. ──
    const [grouped, trend] = await Promise.all([
      // (a) All-time per-category totals — a hash-aggregate over the small
      // per-workspace Issue table (≤4 errorClass buckets), workspaceId-indexed.
      this.db.issue.groupBy({
        by: ["errorClass"],
        where: { workspaceId },
        _sum: { occurrenceCount: true, userCount: true },
        _count: { _all: true },
      }),
      // (b) Per-category daily counts over the last 60 days for the sparkline +
      // delta. The (workspaceId, occurredAt) index makes this an index RANGE
      // scan over just the recent slice (never a full-table scan), then a
      // hash-aggregate by day-bucket + category — cost is O(rows in the 60-day
      // window), so it stays cheap as IssueOccurrence grows to millions. Loaded
      // once per page visit (not polled). Bucketed by "days ago" from now() so
      // there's no timezone dependence.
      this.db.$queryRaw<{ days_ago: number; errorClass: string; n: bigint }[]>(
        Prisma.sql`
          SELECT floor(extract(epoch FROM (now() - "occurredAt")) / 86400)::int AS days_ago,
                 "errorClass",
                 count(*)::bigint AS n
          FROM "IssueOccurrence"
          WHERE "workspaceId" = ${workspaceId}
            AND "occurredAt" >= now() - interval '60 days'
          GROUP BY 1, 2
        `,
      ),
    ]);

    // daily[bucket][d] = count d days ago (0 = last 24h … 59).
    const daily: Record<string, number[]> = {
      crashes: new Array(60).fill(0),
      exceptions: new Array(60).fill(0),
      freezes: new Array(60).fill(0),
      errors: new Array(60).fill(0),
    };
    for (const r of trend) {
      const d = Number(r.days_ago);
      if (d >= 0 && d < 60) daily[bucketKeyOf(r.errorClass)][d] += Number(r.n);
    }
    const buildBucket = (key: string): CrashStatBucket => {
      const days = daily[key];
      // Chronological trailing SPARK_DAYS: index 0 = oldest, last = today.
      const spark = Array.from(
        { length: SPARK_DAYS },
        (_, i) => days[SPARK_DAYS - 1 - i],
      );
      let cur = 0;
      let prev = 0;
      for (let d = 0; d < SPARK_DAYS; d++) cur += days[d];
      for (let d = SPARK_DAYS; d < 60; d++) prev += days[d];
      // No prior baseline → no honest percentage (never fabricate one).
      const deltaPct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
      return { events: 0, groups: 0, users: 0, spark, deltaPct };
    };

    const out: CrashStats = {
      crashes: buildBucket("crashes"),
      exceptions: buildBucket("exceptions"),
      freezes: buildBucket("freezes"),
      errors: buildBucket("errors"),
      affectedUsers: 0,
    };
    for (const g of grouped) {
      const bucket = out[bucketKeyOf(g.errorClass)] as CrashStatBucket;
      const users = g._sum.userCount ?? 0;
      bucket.events += g._sum.occurrenceCount ?? 0;
      bucket.groups += g._count._all;
      bucket.users += users;
      out.affectedUsers += users;
    }
    return out;
  }

  /**
   * One Issue + its most recent occurrences (each linking to a recording).
   * Occurrences are found by fingerprint via the (workspaceId, fingerprint)
   * index — bounded `take`, no scan.
   */
  async detail(workspaceId: number, id: number) {
    const issue = await this.db.issue.findFirst({
      where: { id, workspaceId },
    });
    if (!issue) {
      return null;
    }
    const occurrences = await this.db.issueOccurrence.findMany({
      where: { workspaceId, fingerprint: issue.fingerprint },
      orderBy: { occurredAt: "desc" },
      take: 25,
      select: {
        sessionId: true,
        screen: true,
        release: true,
        occurredAt: true,
        count: true,
        session: { select: { publicId: true } },
      },
    });
    // Representative stack for the investigation drawer — the latest session's
    // error event whose fingerprint matches this issue. ONE bounded ClickHouse
    // read (a single session's error events); best-effort so a missing/expired
    // trace never breaks the detail read. Skipped for behavioral issues (no stack).
    let stack: DisplayFrame[] = [];
    if (issue.lastSessionId && !issue.behavioral) {
      try {
        const evs = await errorEventsForSessions({
          workspaceId,
          sessionIds: [issue.lastSessionId],
        });
        const matchesFp = (ev: (typeof evs)[number]) =>
          fingerprintError({
            isCrash: ev.is_crash === 1,
            platform: issue.platform,
            name: ev.name,
            message: ev.message,
            stack: ev.stack,
            framesJson: ev.frames_json,
          }).fingerprint === issue.fingerprint;
        // Parse every candidate, keep those that actually yield frames, then
        // prefer the fingerprint match (the precise trace) — else the richest
        // trace in the session. A matching event whose stack doesn't parse is
        // useless, so it must NOT win over a sibling that carries a real trace.
        const parsed = evs
          .map((ev) => ({
            ev,
            frames: parseStackFrames({
              framesJson: ev.frames_json,
              stack: ev.stack,
            }),
          }))
          .filter((p) => p.frames.length > 0);
        const best =
          parsed.find((p) => matchesFp(p.ev)) ??
          parsed.sort((a, b) => b.frames.length - a.frames.length)[0];
        stack = best?.frames ?? [];
      } catch {
        // best-effort — the drawer just omits the trace
      }
    }
    // ── Investigation context — all bounded, best-effort, single read each ──
    // Failing / slow network around the representative session's crash.
    let network: Array<{
      method: string;
      url: string;
      status: number;
      durationMs: number;
      hits: number;
    }> = [];
    // The event trail (breadcrumbs) leading up to the latest occurrence.
    let breadcrumbs: Array<{ kind: string; label: string; offsetMs: number }> =
      [];
    if (issue.lastSessionId && !issue.behavioral) {
      try {
        const net = await failingNetworkForSessions({
          workspaceId,
          sessionIds: [issue.lastSessionId],
          limit: 8,
        });
        network = net.map((n) => ({
          method: n.method,
          url: n.url,
          status: n.status_code,
          durationMs: n.duration_ms,
          hits: n.hits,
        }));
      } catch {
        /* best-effort */
      }
      try {
        const evs = await listEventsForSessions({
          workspaceId,
          sessionIds: [issue.lastSessionId],
          kinds: ["screen", "tap", "console", "network", "error"],
          limit: 120,
        });
        // The last few events in time order = the run-up to the crash.
        breadcrumbs = evs.slice(-8).map((e) => ({
          kind: e.kind,
          label: this.breadcrumbLabel(e),
          offsetMs: e.offset_ms,
        }));
      } catch {
        /* best-effort */
      }
    }
    // Browser / OS / country breakdown across the issue's affected sessions —
    // ONE set-based read (DISTINCT sessions via the IssueOccurrence
    // (workspaceId, fingerprint) index, joined to Session), never per row.
    let device: { browser: DimStat[]; os: DimStat[]; country: DimStat[] } = {
      browser: [],
      os: [],
      country: [],
    };
    if (!issue.behavioral) {
      try {
        const rows = await this.db.$queryRaw<
          Array<{ dim: string; val: string; c: number }>
        >`
          WITH sess AS (
            SELECT DISTINCT s.id, s.browser, s.os, s.country
            FROM "IssueOccurrence" io JOIN "Session" s ON s.id = io."sessionId"
            WHERE io."workspaceId" = ${workspaceId}
              AND io.fingerprint = ${issue.fingerprint}
          )
          SELECT 'browser' AS dim, browser AS val, COUNT(*)::int AS c FROM sess WHERE browser IS NOT NULL AND browser <> '' GROUP BY browser
          UNION ALL SELECT 'os', os, COUNT(*)::int FROM sess WHERE os IS NOT NULL AND os <> '' GROUP BY os
          UNION ALL SELECT 'country', country, COUNT(*)::int FROM sess WHERE country IS NOT NULL AND country <> '' GROUP BY country`;
        device = this.bucketDevice(rows);
      } catch {
        /* best-effort */
      }
    }
    return {
      issue,
      occurrences: occurrences.map((o) => ({
        sessionId: o.sessionId,
        publicId: o.session?.publicId ?? null,
        screen: o.screen,
        release: o.release,
        occurredAt: o.occurredAt,
        count: o.count,
      })),
      stack,
      network,
      breadcrumbs,
      device,
    };
  }

  /** Human-readable one-liner for a breadcrumb event. */
  private breadcrumbLabel(e: {
    kind: string;
    ui_value: string;
    route: string;
    message: string;
  }): string {
    switch (e.kind) {
      case "screen":
        return e.route ? `Opened ${e.route}` : "Screen view";
      case "tap":
        return e.ui_value ? `Tapped ${e.ui_value}` : "Tap";
      case "console":
        return e.message || "Console log";
      case "network":
        return e.message || "Network request";
      case "error":
        return e.message ? `Error: ${e.message}` : "Error";
      default:
        return e.kind;
    }
  }

  /** Bucket the UNION'd dimension rows into top-3-with-percent per dimension. */
  private bucketDevice(
    rows: Array<{ dim: string; val: string; c: number }>,
  ): { browser: DimStat[]; os: DimStat[]; country: DimStat[] } {
    const out = {
      browser: [] as DimStat[],
      os: [] as DimStat[],
      country: [] as DimStat[],
    };
    for (const dim of ["browser", "os", "country"] as const) {
      const ds = rows.filter((r) => r.dim === dim);
      const total = ds.reduce((a, r) => a + Number(r.c), 0) || 1;
      out[dim] = ds
        .sort((a, b) => Number(b.c) - Number(a.c))
        .slice(0, 3)
        .map((r) => ({ val: r.val, pct: Math.round((Number(r.c) / total) * 100) }));
    }
    return out;
  }

  /**
   * Human status action from the dashboard (Resolve / Ignore / Reopen). We do
   * NOT let the AI call this — mutating an Issue's lifecycle is a person's job;
   * the AI is read + create only. Scoped by workspaceId so one tenant can't
   * touch another's issue.
   */
  async setStatus(
    workspaceId: number,
    id: number,
    status: "OPEN" | "RESOLVED" | "IGNORED",
  ) {
    const data: Prisma.IssueUpdateManyMutationInput = {
      status: status as IssueStatus,
    };
    if (status === "RESOLVED") {
      data.resolvedAt = new Date();
    } else if (status === "OPEN") {
      data.resolvedAt = null;
    }
    const res = await this.db.issue.updateMany({
      where: { id, workspaceId },
      data,
    });
    return { updated: res.count };
  }
}
