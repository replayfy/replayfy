import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { getPostgresClient } from "@replay/db-postgres";
import { releaseLatency } from "@replay/db-clickhouse";
import { REDIS_CLIENT } from "../common/redis.module";

interface SessionAgg {
  release: string;
  sessions: number;
  users: number;
  avg_score: number;
  rage: number;
  errors: number;
  first_seen: Date;
  last_seen: Date;
}
interface SignalAgg {
  release: string;
  frustrated: number;
  crashes: number;
  backend_fail: number;
  slow_api: number;
  form_abandon: number;
  nav_loop: number;
  conv_success: number;
  conv_failure: number;
}
interface JourneyAgg {
  release: string;
  label: string;
  sessions: number;
  fails: number;
  fail_rate: number;
}

/**
 * Release Intelligence — treats every release (appVersion, falling back to the
 * web revId) as a first-class entity and answers "did this release help or hurt
 * the product?" without manual incident spelunking.
 *
 * Two set-based grouped reads (sessions-by-release + signals-by-release), merged
 * + scored in JS, then each release gets deltas vs the chronologically previous
 * one — so a regression is "the release where health dropped". Releases per
 * workspace are a small bounded set, so this is cheap; no per-release query loop.
 */
@Injectable()
export class ReleaseService {
  private readonly db = getPostgresClient();

  /** Ignore releases with fewer than this many sessions (noise). */
  private static readonly MIN_SESSIONS = 3;
  /** Health drop (points) vs the prior release that flags a regression. */
  private static readonly REGRESSION_DROP = 5;
  /** Redis TTL. Matched to the ~5min precompute sweep so the Releases panel
   *  never visibly disagrees in age with the /overview + /metrics panels sitting
   *  beside it on the same page. Against the Overview's 30s poll it collapses
   *  ~10 polls — and every concurrent viewer — into one compute. */
  private static readonly CACHE_TTL_SEC = 300;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Read-through cache over the release intelligence payload.
   *
   * Why: the Overview polls this every 30s per open tab, and each miss runs
   * three heavy reads — two 90-day GROUP BYs (Session, and Signal JOIN Session
   * with eight count(DISTINCT CASE…) branches) plus a ClickHouse latency query.
   * Nothing about it is per-user, and it takes NO parameters, so cardinality is
   * exactly one payload per workspace — the ideal cache shape.
   *
   * Key: `ws:releases:v1:{workspaceId}`. Tenant scoping is structural, not
   * conventional — workspaceId is the sole interpolation and arrives as a
   * `number` from @CurrentWorkspaceId (JWT-derived, never caller-supplied), so
   * no input can widen the key into another tenant's namespace. That matters
   * here: this payload carries release names, user counts and crash counts, so a
   * collision would show one company's ship history inside another's dashboard.
   *
   * `v1` versions the SHAPE **and the thresholds baked into it** — the 90-day
   * window, MIN_SESSIONS, the 24-release cap, REGRESSION_DROP and the health()
   * weights. Bump it in the same commit as any change to those, or the endpoint
   * serves pre-change numbers for up to a TTL.
   *
   * A plain TTL is deliberate: this payload is derived purely from ingest (no
   * mutation endpoint can change it), and a 90-day per-release health score does
   * not move meaningfully inside 5 minutes, so there is no read-your-writes
   * requirement to honour. Redis failures are swallowed — the cache is an
   * optimisation and must never turn a working dashboard into an error.
   */
  async intelligence(workspaceId: number) {
    const key = `ws:releases:v1:${workspaceId}`;
    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as Awaited<
        ReturnType<ReleaseService["computeIntelligence"]>
      >;
    } catch {
      /* fall through to the live compute */
    }
    const fresh = await this.computeIntelligence(workspaceId);
    try {
      await this.redis.set(
        key,
        JSON.stringify(fresh),
        "EX",
        ReleaseService.CACHE_TTL_SEC,
      );
    } catch {
      /* serving the fresh payload matters more than caching it */
    }
    return fresh;
  }

  private async computeIntelligence(workspaceId: number) {
    // Bounded to the last 90 days + the 24 most-recent releases: release
    // intelligence is about RECENT ships, and an ALL-TIME GROUP BY over the
    // whole Session table does not scale (500k+ rows → full scan every load).
    // The window rides @@index([workspaceId, startedAt desc]); each query is one
    // workspace-scoped range scan. The `LIMIT 24` on the release aggregate caps
    // a workspace that ships very often; deltas still work because we re-sort the
    // capped set chronologically (oldest→newest) below. The previous per-session
    // "top journeys" CTE (string_agg + a correlated EXISTS per session) was the
    // heaviest query here AND its output was never rendered by the panel — dropped.
    const [sessionRows, signalRows] = await Promise.all([
      this.db.$queryRaw<SessionAgg[]>`
        SELECT COALESCE(NULLIF(s."appVersion", ''), NULLIF(s."revId", ''), NULLIF(s."appBuild", ''), 'unknown') AS release,
               count(*)::int AS sessions,
               count(DISTINCT COALESCE(s."endUserId", -s.id))::int AS users,
               round(avg(s."sessionScore"), 1)::float8 AS avg_score,
               sum(s."rageCount")::int AS rage,
               sum(s."errorCount")::int AS errors,
               min(s."startedAt") AS first_seen,
               max(s."startedAt") AS last_seen
        FROM "Session" s
        WHERE s."workspaceId" = ${workspaceId} AND s.status = 'COMPLETED'
          AND s."startedAt" >= (now() - interval '90 days')
        GROUP BY 1
        HAVING count(*) >= ${ReleaseService.MIN_SESSIONS}
        ORDER BY max(s."startedAt") DESC
        LIMIT 24`,
      this.db.$queryRaw<SignalAgg[]>`
        SELECT COALESCE(NULLIF(s."appVersion", ''), NULLIF(s."revId", ''), NULLIF(s."appBuild", ''), 'unknown') AS release,
               count(DISTINCT CASE WHEN sig.type = 'user_frustrated'    THEN sig."sessionId" END)::int AS frustrated,
               count(DISTINCT CASE WHEN sig.type = 'crash_detected'     THEN sig."sessionId" END)::int AS crashes,
               count(DISTINCT CASE WHEN sig.type = 'backend_failure'    THEN sig."sessionId" END)::int AS backend_fail,
               count(DISTINCT CASE WHEN sig.type = 'slow_api'           THEN sig."sessionId" END)::int AS slow_api,
               count(DISTINCT CASE WHEN sig.type = 'form_abandonment'   THEN sig."sessionId" END)::int AS form_abandon,
               count(DISTINCT CASE WHEN sig.type = 'navigation_loop'    THEN sig."sessionId" END)::int AS nav_loop,
               count(DISTINCT CASE WHEN sig.type = 'conversion_success' THEN sig."sessionId" END)::int AS conv_success,
               count(DISTINCT CASE WHEN sig.type = 'conversion_failure' THEN sig."sessionId" END)::int AS conv_failure
        FROM "Signal" sig
        JOIN "Session" s ON s.id = sig."sessionId"
        WHERE s."workspaceId" = ${workspaceId}
          AND s."startedAt" >= (now() - interval '90 days')
        GROUP BY 1`,
    ]);

    // Per-release network latency from ClickHouse (denormalised release column).
    const latencyByRelease = new Map<string, number>();
    try {
      for (const l of await releaseLatency(workspaceId)) {
        latencyByRelease.set(l.release, l.avg_ms);
      }
    } catch {
      // ClickHouse unavailable — latency just stays null on the releases.
    }

    const sigByRelease = new Map(signalRows.map((r) => [r.release, r]));
    // Re-sort the 24 most-recent releases chronologically (oldest → newest) so
    // each release diffs against the prior one — the query returned them DESC so
    // the LIMIT kept the NEWEST releases, not the oldest.
    const chrono = [...sessionRows]
      .sort((a, b) => a.first_seen.getTime() - b.first_seen.getTime())
      .map((s) => {
      const sg = sigByRelease.get(s.release);
      const conv = {
        wins: sg?.conv_success ?? 0,
        losses: (sg?.conv_failure ?? 0) + (sg?.form_abandon ?? 0),
      };
      return {
        release: s.release,
        sessions: s.sessions,
        users: s.users,
        avgScore: s.avg_score ?? 0,
        health: this.health(s.sessions, sg),
        conversionRate:
          conv.wins + conv.losses === 0
            ? null
            : Math.round((conv.wins / (conv.wins + conv.losses)) * 100),
        frustrated: sg?.frustrated ?? 0,
        crashes: sg?.crashes ?? 0,
        errors: s.errors,
        avgLatencyMs: latencyByRelease.get(s.release) ?? null,
        firstSeen: s.first_seen.toISOString(),
        lastSeen: s.last_seen.toISOString(),
        // topJourneys retired — the per-session journey CTE was the heaviest
        // query in this endpoint and the panel never rendered its output.
        topJourneys: [],
      };
    });

    // Attach deltas vs the previous (older) release.
    const withDeltas = chrono.map((r, i) => {
      const prev = i > 0 ? chrono[i - 1] : null;
      const d = (cur: number, p: number | null | undefined) =>
        p == null ? null : cur - p;
      return {
        ...r,
        prevRelease: prev?.release ?? null,
        healthDelta: d(r.health, prev?.health),
        scoreDelta: prev ? Math.round((r.avgScore - prev.avgScore) * 10) / 10 : null,
        conversionDelta:
          prev && r.conversionRate != null && prev.conversionRate != null
            ? r.conversionRate - prev.conversionRate
            : null,
        crashesDelta: d(r.crashes, prev?.crashes),
        frustratedDelta: d(r.frustrated, prev?.frustrated),
        latencyDelta:
          r.avgLatencyMs != null && prev?.avgLatencyMs != null
            ? r.avgLatencyMs - prev.avgLatencyMs
            : null,
        isRegression:
          prev != null && r.health - prev.health <= -ReleaseService.REGRESSION_DROP,
      };
    });

    // Newest first for display.
    return { releases: withDeltas.reverse() };
  }

  /** Weighted health for a release (same shape as the daily health score). */
  private health(sessions: number, sg: SignalAgg | undefined): number {
    if (!sessions || !sg) return 100;
    const rate = (n: number) => Math.min(1, n / sessions);
    const weighted =
      (2.0 * rate(sg.crashes) +
        1.5 * rate(sg.backend_fail) +
        1.0 * rate(sg.frustrated) +
        1.0 * rate(sg.slow_api) +
        1.0 * rate(sg.form_abandon) +
        0.5 * rate(sg.nav_loop)) /
      7.0;
    return Math.max(0, Math.round(100 * (1 - Math.min(1, weighted))));
  }
}
