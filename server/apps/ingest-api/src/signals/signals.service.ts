import { Inject, Injectable, Logger } from "@nestjs/common";
import { getPostgresClient, Prisma, SignalPolarity } from "@replay/db-postgres";
import type { Redis } from "ioredis";
import {
  aggregateSignalsForSessions,
  insertSessionRows,
  type SessionSignalAgg,
} from "@replay/db-clickhouse";
import { SignalType } from "./signal.constants";
import { WorkspaceSignalDailyService } from "../workspace-signal-daily/workspace-signal-daily.service";
import { SESSION_ROW_SELECT, toSessionRow } from "../common/ch-session-row";
import { REDIS_CLIENT } from "../common/redis.module";
import { bumpWorkspaceActivity } from "../common/workspace-activity";
import { IssuesService } from "../issues/issues.service";
import { SessionCardsService } from "../session-cards/session-cards.service";

/**
 * Derives semantic signals for finalized sessions — the bottom of the Overview
 * spine (signals → incidents → storyline; the internal design notes). One typed observation per session, from the session's
 * own Postgres counters (frustration) plus a single bounded ClickHouse pass
 * (backend failures, slow APIs, crashes).
 *
 * Two entry points share one private batch routine:
 *   - `deriveForSession` — fired (fire-and-forget) from the ingest finalize
 *     path when a session flips to COMPLETED.
 *   - the nightly `backfillRecent` cron — a safety net that re-derives the
 *     recent window, catching sessions the retention sweep flipped
 *     LIVE→COMPLETED out-of-band (those never hit the finalize hook) and any
 *     transient finalize-time failures.
 *
 * Derivation is idempotent per session: the batch routine deletes a session's
 * existing signals before re-inserting, so the finalize hook and the nightly
 * backfill can both run for the same session without ever duplicating.
 */
@Injectable()
export class SignalsService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(SignalsService.name);

  constructor(
    private readonly signalDaily: WorkspaceSignalDailyService,
    private readonly issues: IssuesService,
    private readonly cards: SessionCardsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** A network call slower than this emits a slow_api signal. First-guess
   *  constant; doc 09 §6 moves this to a per-endpoint p95 in a later slice. */
  private static readonly SLOW_API_MS = 3000;
  /** Dead-click count at/above which a session counts as frustrated even with
   *  zero rage clicks. */
  private static readonly DEAD_CLICK_FRUSTRATION = 3;
  /** Revisits of the same screen/URL within a session at/above which it counts
   *  as a navigation loop. */
  private static readonly NAV_LOOP_REVISITS = 3;
  // The mobile-quiet window, the backfill look-back and the keyset page size
  // that used to live here moved with their sweeps to
  // IntelligenceSchedulerService, which now owns the cron side of both and
  // enqueues onto the intelligence queue; this service keeps only the derive
  // work those jobs call. Duplicating them here would be two sources of truth
  // for one cadence.
  /** Never-match sentinel for a workspace with no event-goal funnel — the
   *  countIf then matches nothing, so it emits NO conversion signals. */
  private static readonly NO_MATCH_RE = "zzzz_no_conversion_defined_zzzz";

  /**
   * Derive (idempotently) the signals for a single finalized session. Resilient
   * by contract — the caller fire-and-forgets, so this must never reject into
   * the ingest finalize path. Any failure is logged; the nightly backfill is
   * the catch-up.
   */
  async deriveForSession(sessionId: number): Promise<void> {
    try {
      // Finalize path bumps the daily rollup for intraday Pulse freshness.
      await this.deriveForSessionIds([sessionId], { bumpDaily: true });
    } catch (e) {
      this.logger.warn(
        `signal derive failed for session ${sessionId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Batch sibling of deriveForSession — derive a SET of just-finalized sessions
   * in one pass. Used by the retention LIVE→COMPLETED sweep for sessions that
   * never hit an inline finalize hook (event-only mobile sessions have no
   * frames, so they reach COMPLETED only via that sweep; without this their
   * crashes/errors would wait for the nightly backfill). Not an N+1:
   * deriveForSessionIds groups the ClickHouse reads by workspace (one seek per
   * distinct workspace), same as the finalize chokepoint. Fire-and-forget +
   * idempotent by contract — must never reject into the sweep.
   */
  async deriveForSessions(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    try {
      await this.deriveForSessionIds(ids, { bumpDaily: true });
    } catch (e) {
      this.logger.warn(
        `signal batch derive failed (${ids.length} sessions): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Queue entry point — derive one page/batch of sessions. Called by
   * IntelligenceProcessor for the scheduler's bulk paths (nightly backfill +
   * mobile end-of-session sweep), which replaced the @Cron sweeps that used to
   * live in this file. UNLIKE `deriveForSession`/`deriveForSessions`, this does
   * NOT swallow errors: it rethrows so the Bull job applies its attempts/backoff
   * and a genuinely-failed batch is retried (and, failing that, re-covered by
   * the nightly backfill). Idempotent per session, so retries never duplicate.
   *
   * `markProcessedAt` is stamped only AFTER a successful derive, so a failed
   * mobile batch stays unstamped and is re-enqueued by the next sweep — the same
   * self-healing the in-process version had, now backed by Bull's retries too.
   */
  async deriveBatch(
    sessionIds: number[],
    opts: { bumpDaily?: boolean; markProcessedAt?: boolean } = {},
  ): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }
    await this.deriveForSessionIds(sessionIds, { bumpDaily: opts.bumpDaily });
    if (opts.markProcessedAt) {
      await this.db
        .$executeRaw`UPDATE "Session" SET "processedAt" = now() WHERE id IN (${Prisma.join(sessionIds)})`;
    }
  }


  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Derive signals for a batch of session ids in a fixed number of queries
   * regardless of batch size — never a per-session loop:
   *   1. one Postgres read of the batch's (workspaceId, endedAt) anchors,
   *   2. one grouped ClickHouse pass for backend/slow/crash facts,
   *   3. one short transaction: delete the batch's old signals, set-based
   *      INSERT…SELECT the counter-derived frustration signals, bulk-insert the
   *      ClickHouse-derived rows.
   * The ClickHouse round-trip happens BEFORE the transaction opens, so no
   * Postgres locks are held across an external call.
   */
  private async deriveForSessionIds(
    ids: number[],
    opts: { bumpDaily?: boolean } = {},
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    // (1) anchors — workspace + occurredAt for the CH-derived rows, plus the
    // rage/dead counters the session score needs.
    const anchors = await this.db.session.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        workspaceId: true,
        endedAt: true,
        rageCount: true,
        deadCount: true,
      },
    });
    const anchorById = new Map(anchors.map((a) => [a.id, a]));

    // (2) ClickHouse signal facts. Conversions/intents are matched against each
    // workspace's OWN funnel goals (not a hardcoded store pattern), so we group
    // the batch by workspace and pass per-workspace patterns — one CH call per
    // DISTINCT workspace in the batch (finalize = 1), never per session.
    const wsGroups = new Map<number, number[]>();
    for (const a of anchors) {
      const g = wsGroups.get(a.workspaceId);
      if (g) g.push(a.id);
      else wsGroups.set(a.workspaceId, [a.id]);
    }
    const convPatterns = await this.conversionPatternsForWorkspaces([
      ...wsGroups.keys(),
    ]);
    // Workspaces that actually DEFINE a conversion (they have a funnel with an
    // event goal). Gates the conversion-DEPENDENT signals so a workspace with no
    // funnel never mislabels every input session as an abandonment.
    const convDefWs = new Set(
      [...convPatterns.entries()].filter(([, p]) => p.hasDef).map(([ws]) => ws),
    );
    const aggs: SessionSignalAgg[] = [];
    for (const [ws, wsIds] of wsGroups) {
      const p = convPatterns.get(ws);
      const part = await aggregateSignalsForSessions({
        workspaceId: ws,
        sessionIds: wsIds,
        slowApiMs: SignalsService.SLOW_API_MS,
        conversionRe: p?.conversionRe,
        intentRe: p?.intentRe,
      });
      aggs.push(...part);
    }
    const aggById = new Map(aggs.map((a) => [a.session_id, a]));
    // Sessions that converted — excluded from unmet-demand (they got there).
    const convertedIds = aggs
      .filter((a) => a.conversions > 0)
      .map((a) => a.session_id);
    const chRows: Prisma.SignalCreateManyInput[] = [];
    for (const a of aggs) {
      const anchor = anchorById.get(a.session_id);
      if (!anchor) {
        continue;
      }
      const base = {
        workspaceId: anchor.workspaceId,
        sessionId: a.session_id,
        polarity: SignalPolarity.NEGATIVE,
        occurredAt: anchor.endedAt,
      };
      if (a.backend_failures > 0) {
        chRows.push({
          ...base,
          type: SignalType.BACKEND_FAILURE,
          screen: this.endpointPath(a.worst_fail_url),
          weight: a.backend_failures,
        });
      }
      if (a.slow_apis > 0) {
        chRows.push({
          ...base,
          type: SignalType.SLOW_API,
          screen: this.endpointPath(a.worst_slow_url),
          weight: a.slow_apis,
        });
      }
      if (a.crashes > 0) {
        chRows.push({
          ...base,
          type: SignalType.CRASH_DETECTED,
          screen: null,
          weight: a.crashes,
        });
      }
      // Form abandonment: the session entered input but never reached the
      // workspace's conversion. Only meaningful when the workspace HAS a
      // conversion defined (a funnel goal) — otherwise "no conversion" is the
      // norm and every input session would falsely count as abandonment.
      if (
        a.inputs > 0 &&
        a.conversions === 0 &&
        convDefWs.has(anchor.workspaceId)
      ) {
        chRows.push({
          ...base,
          type: SignalType.FORM_ABANDONMENT,
          screen: null,
          weight: a.inputs,
        });
      }
      // Conversion success — the one POSITIVE signal (feeds the Opportunities
      // lane). Derived from tracked conversion-named events.
      if (a.conversions > 0) {
        chRows.push({
          workspaceId: anchor.workspaceId,
          sessionId: a.session_id,
          occurredAt: anchor.endedAt,
          polarity: SignalPolarity.POSITIVE,
          type: SignalType.CONVERSION_SUCCESS,
          screen: null,
          weight: a.conversions,
        });
      }
      // Conversion failure (NEGATIVE → Problems): the flow started (intent
      // event) but never completed. Mirrors conversion_success; a per-workspace
      // funnel definition could replace the intent pattern later.
      if (a.intents > 0 && a.conversions === 0) {
        chRows.push({
          ...base,
          type: SignalType.CONVERSION_FAILURE,
          screen: null,
          weight: a.intents,
        });
      }
      // Element-level unmet demand: the session dead-clicked an element (a click
      // that did nothing). Across many users → demand for a missing/broken
      // feature ("237 users clicked Export"). Clusters as "Unmet demand: <el>".
      if (a.dead_clicks > 0 && this.cleanLabel(a.dead_element)) {
        chRows.push({
          workspaceId: anchor.workspaceId,
          sessionId: a.session_id,
          occurredAt: anchor.endedAt,
          polarity: SignalPolarity.POSITIVE,
          type: SignalType.UNMET_DEMAND,
          screen: (a.dead_route ?? "").trim() || null,
          element: this.cleanLabel(a.dead_element),
          weight: a.dead_clicks,
        });
      }
    }

    // Frustration — attributed to the screen + element the user actually raged
    // on (from the CH rage events) so the incident reads "rage clicks on the
    // password field on /register", not "frustration across the app". Iterates
    // anchors (not aggs) so dead-click-only sessions still count; those stay
    // session-level (no element).
    for (const anchor of anchors) {
      if (
        anchor.rageCount > 0 ||
        anchor.deadCount >= SignalsService.DEAD_CLICK_FRUSTRATION
      ) {
        const a = aggById.get(anchor.id);
        chRows.push({
          workspaceId: anchor.workspaceId,
          sessionId: anchor.id,
          occurredAt: anchor.endedAt,
          polarity: SignalPolarity.NEGATIVE,
          type: SignalType.USER_FRUSTRATED,
          screen: (a?.rage_route ?? "").trim() || null,
          element: this.cleanLabel(a?.rage_element),
          weight: anchor.rageCount + anchor.deadCount,
        });
      }
    }

    // Per-session experience score (doc 09 §6.3) for every session in the
    // batch — computed from the data already in hand (counters + CH aggs), so
    // no extra reads. Written set-based via a single UPDATE…FROM (VALUES …).
    const scoreTuples = anchors.map(
      (anchor) =>
        Prisma.sql`(${anchor.id}::int, ${this.sessionScore(anchor.rageCount, anchor.deadCount, aggById.get(anchor.id))}::int)`,
    );

    // (3) atomic delete-then-insert + score write, scoped to this batch.
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.db
        .$executeRaw`DELETE FROM "Signal" WHERE "sessionId" IN (${Prisma.join(ids)})`,
      // Navigation loop: a session that revisited the same screen/URL ≥3×. One
      // set-based INSERT…SELECT off SessionPath — inner groups (session, url)
      // past the loop threshold, outer emits one signal per session.
      this.db.$executeRaw`
        INSERT INTO "Signal" ("workspaceId", "sessionId", "type", "polarity", "screen", "weight", "occurredAt")
        SELECT s."workspaceId", lp."sessionId", ${SignalType.NAVIGATION_LOOP}, 'NEGATIVE'::"SignalPolarity", NULL,
               max(lp.cnt), s."endedAt"
        FROM (
          SELECT "sessionId", url, count(*) AS cnt
          FROM "SessionPath"
          WHERE "sessionId" IN (${Prisma.join(ids)})
          GROUP BY "sessionId", url
          HAVING count(*) >= ${SignalsService.NAV_LOOP_REVISITS}
        ) lp
        JOIN "Session" s ON s.id = lp."sessionId"
        GROUP BY s."workspaceId", lp."sessionId", s."endedAt"`,
      // Unmet demand (POSITIVE → opportunities): a session that revisited a
      // high-intent route (pricing/upgrade/export…) ≥2× but did NOT convert.
      // One set-based INSERT…SELECT off SessionPath, excluding converted
      // sessions. screen = the route. (True "dead-click on a missing feature"
      // demand needs the dead-click element captured — a follow-on.)
      this.db.$executeRaw`
        INSERT INTO "Signal" ("workspaceId", "sessionId", "type", "polarity", "screen", "weight", "occurredAt")
        SELECT s."workspaceId", lp."sessionId", ${SignalType.UNMET_DEMAND}, 'POSITIVE'::"SignalPolarity",
               lp.route, lp.cnt, s."endedAt"
        FROM (
          SELECT sp."sessionId",
                 split_part(split_part(regexp_replace(sp.url, '^https?://[^/]+', ''), '?', 1), '#', 1) AS route,
                 count(*) AS cnt
          FROM "SessionPath" sp
          WHERE sp."sessionId" IN (${Prisma.join(ids)})
            AND sp.url ~* '(pricing|plans|upgrade|premium|checkout|billing|export|subscribe|cart)'
          GROUP BY sp."sessionId", split_part(split_part(regexp_replace(sp.url, '^https?://[^/]+', ''), '?', 1), '#', 1)
          HAVING count(*) >= 2
        ) lp
        JOIN "Session" s ON s.id = lp."sessionId"
        ${
          convertedIds.length > 0
            ? Prisma.sql`WHERE lp."sessionId" NOT IN (${Prisma.join(convertedIds)})`
            : Prisma.empty
        }`,
      // Set-based session-score write for the whole batch.
      this.db.$executeRaw`
        UPDATE "Session" s SET "sessionScore" = v.score
        FROM (VALUES ${Prisma.join(scoreTuples)}) AS v(id, score)
        WHERE s.id = v.id`,
    ];
    if (chRows.length > 0) {
      ops.push(this.db.signal.createMany({ data: chRows }));
    }
    await this.db.$transaction(ops);

    // Sync the ClickHouse `replay.sessions` row(s) for this batch — what lets
    // the funnel engine count by user / break down / filter purely in CH.
    // Best-effort + idempotent (ReplacingMergeTree); a failure is logged and
    // the nightly backfill re-syncs.
    try {
      await this.syncClickhouseSessions(ids);
    } catch (e) {
      this.logger.warn(
        `clickhouse sessions sync failed (${ids.length} sessions): ${(e as Error).message}`,
      );
    }

    // Mark the batch's workspaces DIRTY so the hourly precompute recomputes
    // their cached L1 snapshot. One set-based upsert over the DISTINCT
    // workspaces (primary-key served); best-effort so it never breaks finalize.
    // The same bump is mirrored to Redis (ws:activity:<id>, one pipelined write)
    // so the freshness reads — the precompute stale-hint + the near-live exec
    // cache key — are served from Redis and never touch Postgres.
    try {
      const wsIds = [...new Set(anchors.map((a) => a.workspaceId))];
      if (wsIds.length > 0) {
        await this.db.$executeRaw`
          INSERT INTO "WorkspaceSnapshot" ("workspaceId", "lastActivityAt", "updatedAt")
          SELECT w, now(), now()
          FROM unnest(ARRAY[${Prisma.join(wsIds)}]::int[]) AS w
          ON CONFLICT ("workspaceId") DO UPDATE SET "lastActivityAt" = now()`;
        await bumpWorkspaceActivity(this.redis, wsIds, Date.now());
      }
    } catch (e) {
      this.logger.warn(`workspace dirty-bump failed: ${(e as Error).message}`);
    }

    // Issue grouping + the per-session AI cards ride the SAME chokepoint
    // (finalize + nightly backfill), so every path that derives signals also
    // groups errors/crashes and refreshes the cards. Cards are
    // CHAINED after Issues because a card references the issue fingerprints,
    // which must be committed first. Both are fire-and-forget + self-error-
    // handling so they never delay or break the finalize path.
    void this.issues
      .deriveForSessions(ids)
      .then(() => this.issues.deriveBehavioralIssues(ids))
      .then(() => this.cards.deriveForSessions(ids));

    // Daily rollup update (finalize path only; backfill leaves it to nightly).
    // ONE set-based ABSOLUTE recompute of the touched workspace-days from the
    // Session + Signal source tables — idempotent, so re-deriving a session
    // (finalize + retention sweep) can't double-count the way the old per-session
    // incremental bump did (it inflated sessions/crashes). Not an N+1: one query
    // for the whole batch, scoped to its distinct workspaces since the oldest
    // touched day, and navLoop/formAbandon now come from the Signal table too
    // (no longer skipped). Best-effort; a failure just costs intraday freshness.
    if (opts.bumpDaily && anchors.length > 0) {
      const wsIds = [...new Set(anchors.map((a) => a.workspaceId))];
      const sinceDay = new Date(
        Math.min(...anchors.map((a) => a.endedAt.getTime())),
      );
      sinceDay.setUTCHours(0, 0, 0, 0);
      await this.signalDaily.reconcileFinalize(wsIds, sinceDay);
    }
  }

  /**
   * Sync the `replay.sessions` analytics rows for this batch — one row per
   * session, read set-based from Postgres (Session + its EndUser) and bulk-
   * upserted into ClickHouse (ReplacingMergeTree, highest `_version` wins). This
   * is the table the funnel engine JOINs to count by user, break down by any
   * session attribute, and filter segments, all in pure ClickHouse.
   *
   * Access pattern: one `findMany(id IN …)` (with the EndUser relation) over the
   * ≤500-id batch the caller already scoped — set-based, never per-row — then one
   * bulk insert. No N+1.
   */
  private async syncClickhouseSessions(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const rows = await this.db.session.findMany({
      where: { id: { in: ids } },
      select: SESSION_ROW_SELECT,
    });
    const version = Date.now();
    await insertSessionRows(rows.map((s) => toSessionRow(s, version)));
  }

  /**
   * Per-workspace conversion + intent regexes, derived from each workspace's OWN
   * funnels — so "conversion" means what it means for THAT product, not a
   * hardcoded store pattern. Conversion = the event-kind GOAL step (a funnel's
   * last step); intent = the event-kind ENTRY step (first step). A workspace
   * with no event-goal funnel gets a never-match sentinel (→ no conversion
   * signals) — that's the store-bias fix. One Postgres read for the whole batch.
   */
  private async conversionPatternsForWorkspaces(
    workspaceIds: number[],
  ): Promise<
    Map<number, { conversionRe: string; intentRe: string; hasDef: boolean }>
  > {
    const out = new Map<
      number,
      { conversionRe: string; intentRe: string; hasDef: boolean }
    >();
    if (workspaceIds.length === 0) {
      return out;
    }
    const funnels = await this.db.funnel.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { workspaceId: true, steps: true },
    });
    const goalsByWs = new Map<number, Set<string>>();
    const entriesByWs = new Map<number, Set<string>>();
    for (const f of funnels) {
      const steps = Array.isArray(f.steps)
        ? (f.steps as Array<{ kind?: string; value?: string }>)
        : [];
      if (steps.length === 0) {
        continue;
      }
      const last = steps[steps.length - 1];
      const first = steps[0];
      const goal =
        last?.kind === "event" && typeof last.value === "string"
          ? last.value.trim()
          : "";
      const entry =
        first?.kind === "event" && typeof first.value === "string"
          ? first.value.trim()
          : "";
      if (goal) {
        const s = goalsByWs.get(f.workspaceId) ?? new Set<string>();
        s.add(goal);
        goalsByWs.set(f.workspaceId, s);
      }
      if (entry) {
        const s = entriesByWs.get(f.workspaceId) ?? new Set<string>();
        s.add(entry);
        entriesByWs.set(f.workspaceId, s);
      }
    }
    for (const ws of workspaceIds) {
      const goals = [...(goalsByWs.get(ws) ?? [])];
      out.set(ws, {
        conversionRe: this.eventsToRe(goals),
        intentRe: this.eventsToRe([...(entriesByWs.get(ws) ?? [])]),
        hasDef: goals.length > 0,
      });
    }
    return out;
  }

  /** RE2-safe lowercased alternation of event names (sanitised to
   *  [a-z0-9_-] so no regex metachar / quote / backslash can reach the query),
   *  or the never-match sentinel when empty. */
  private eventsToRe(events: string[]): string {
    const parts = events
      .map((e) => e.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
      .filter((e) => e.length > 0);
    return parts.length > 0 ? parts.join("|") : SignalsService.NO_MATCH_RE;
  }

  /**
   * Per-session experience score 0–100 (doc 09 §6.3). Starts at 100 and
   * subtracts capped penalties for the signal-bearing facts we have at derive
   * time. Penalty weights are first-guess constants tuned in-build.
   */
  private sessionScore(
    rage: number,
    dead: number,
    agg: SessionSignalAgg | undefined,
  ): number {
    let score = 100;
    if (agg && agg.crashes > 0) score -= 25;
    score -= Math.min(15, 5 * rage);
    if (agg && agg.backend_failures > 0) score -= 10;
    if (agg) score -= Math.min(10, 5 * agg.slow_apis);
    if (dead >= SignalsService.DEAD_CLICK_FRUSTRATION) score -= 5;
    // Form abandonment: entered input but never converted.
    if (agg && agg.inputs > 0 && agg.conversions === 0) score -= 10;
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Tidy a captured UI element label for an incident title. Drops empty +
   * opaque/system labels (so a title never reads "rage clicks on RCTView"),
   * caps length.
   */
  private cleanLabel(raw: string | undefined): string | null {
    const v = (raw ?? "").trim();
    if (!v) return null;
    if (/^(view$|_?ui[a-z]|rct|rns|flutterview)/i.test(v)) return null;
    return v.slice(0, 60);
  }

  /**
   * Reduce a captured request URL to a stable endpoint path for screen
   * attribution / correlation. Absolute URLs → pathname; relative → strip
   * query + hash. Returns null for empty input.
   */
  private endpointPath(raw: string): string | null {
    if (!raw) {
      return null;
    }
    try {
      if (raw.startsWith("http://") || raw.startsWith("https://")) {
        return new URL(raw).pathname || null;
      }
    } catch {
      // fall through to the string strip
    }
    const path = raw.split("?")[0].split("#")[0];
    return path || null;
  }
}
