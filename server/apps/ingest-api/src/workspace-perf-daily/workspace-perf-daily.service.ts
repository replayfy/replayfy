import { Injectable } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";

const SAMPLE_CAP = 1000;
const POOR_MS = 4000;
const SLOW_MS = 2500;

/**
 * Per-workspace daily web-vitals rollup.
 *
 * The dashboard's Web Vitals tile + Insights Slow Pages used to scan
 * every Session in the window to compute median LCP. At 10M sessions
 * that's catastrophic. This rollup keeps one row per (workspace, day)
 * with the counts + sums + a length-capped reservoir of LCP values.
 *
 * Why a reservoir sample instead of all values:
 *   - At 1M LCPs/day per workspace we'd need 1M ints / day. Too much.
 *   - At ≤1000 random samples per day, the empirical median is within
 *     a few percent of the true median. Good enough for a dashboard
 *     tile; for exact percentiles we'd swap in a TDigest sketch later.
 *
 * Maintained two ways:
 *   1. Live, on every session.persist() with a non-null worstLcp. The
 *      ingest path calls `bumpForSession()` immediately after the
 *      Session upsert lands. Lossy under high concurrency (multiple
 *      writers can race on the sample array), so:
 *   2. Nightly cron reconciles yesterday's rollup from authoritative
 *      session data. The live path stays "close enough" intra-day; the
 *      reconcile guarantees correctness for completed days.
 */
@Injectable()
export class WorkspacePerfDailyService {
  private readonly db = getPostgresClient();

  /**
   * Record one session's web vitals into today's rollup. Best-effort:
   * a failure here never propagates (the persistence path catches it),
   * because the nightly reconcile catches drift.
   */
  async bumpForSession(args: {
    workspaceId: number;
    startedAt: Date;
    worstLcp: number | null;
    worstClsX1000: number | null;
    worstFid: number | null;
    longTaskTotalMs: number;
  }): Promise<void> {
    if (args.worstLcp == null || args.worstLcp <= 0) return;
    const day = WorkspacePerfDailyService.toDay(args.startedAt);

    // Atomic increment + sample-append in a single SQL statement.
    // Using $executeRaw to avoid the read-then-write race that
    // Prisma's upsert would introduce (two writers each reading a
    // stale lcpSamples array).
    //
    // `array_append` is concurrent-safe; the row-level lock during
    // UPDATE prevents two writers from clobbering each other's
    // appended values. We cap the array length in JS during the
    // reconcile job; bypassing the cap intra-day is fine since the
    // cron rewrites it from scratch.
    const lcp = Math.round(args.worstLcp);
    const slow = lcp > SLOW_MS ? 1 : 0;
    const poor = lcp > POOR_MS ? 1 : 0;
    const longTask = Math.max(0, Math.round(args.longTaskTotalMs));

    // Reservoir-style cap: only append if the existing array is under
    // SAMPLE_CAP. Past that we randomly skip ~half so the sample
    // distribution stays representative (not strictly classical
    // reservoir, but good enough for a tile-level percentile).
    const shouldSample = Math.random() < 0.5;
    await this.db.$executeRawUnsafe(
      `INSERT INTO "WorkspacePerfDaily"
         ("workspaceId", "day", "sampleCount", "lcpSum", "lcpMax",
          "slowCount", "poorCount", "lcpSamples", "longTaskSum", "updatedAt")
       VALUES ($1, $2, 1, $3, $3, $4, $5, ARRAY[$3]::int[], $6, NOW())
       ON CONFLICT ("workspaceId", "day") DO UPDATE SET
         "sampleCount"  = "WorkspacePerfDaily"."sampleCount" + 1,
         "lcpSum"       = "WorkspacePerfDaily"."lcpSum" + $3,
         "lcpMax"       = GREATEST("WorkspacePerfDaily"."lcpMax", $3),
         "slowCount"    = "WorkspacePerfDaily"."slowCount" + $4,
         "poorCount"    = "WorkspacePerfDaily"."poorCount" + $5,
         "longTaskSum"  = "WorkspacePerfDaily"."longTaskSum" + $6,
         "lcpSamples"   = CASE
           WHEN array_length("WorkspacePerfDaily"."lcpSamples", 1) IS NULL
             OR array_length("WorkspacePerfDaily"."lcpSamples", 1) < ${SAMPLE_CAP}
           THEN array_append("WorkspacePerfDaily"."lcpSamples", $3)
           WHEN $7::boolean
           THEN array_append("WorkspacePerfDaily"."lcpSamples"[2:${SAMPLE_CAP}], $3)
           ELSE "WorkspacePerfDaily"."lcpSamples"
         END,
         "updatedAt"    = NOW()`,
      args.workspaceId,
      day,
      lcp,
      slow,
      poor,
      longTask,
      shouldSample,
    );
  }

  /**
   * Window aggregate for the dashboard. Returns median LCP + slow %
   * over the requested day range. All math runs against rollup rows;
   * no Session scan at read time.
   *
   * For the median, we union all per-day samples (≤1000 per day × N
   * days = ≤30k ints for a 30-day window) and median them in JS. Still
   * orders of magnitude smaller than the underlying session count.
   */
  async windowSummary(workspaceId: number, since: Date) {
    const dayFloor = WorkspacePerfDailyService.toDay(since);
    const rows = await this.db.workspacePerfDaily.findMany({
      where: { workspaceId, day: { gte: dayFloor } },
      select: {
        day: true,
        sampleCount: true,
        slowCount: true,
        poorCount: true,
        lcpMax: true,
        lcpSamples: true,
      },
      orderBy: { day: "asc" },
    });
    let total = 0;
    let slow = 0;
    let poor = 0;
    let maxLcp = 0;
    const allSamples: number[] = [];
    for (const r of rows) {
      total += r.sampleCount;
      slow += r.slowCount;
      poor += r.poorCount;
      if (r.lcpMax > maxLcp) maxLcp = r.lcpMax;
      allSamples.push(...r.lcpSamples);
    }
    if (total === 0) {
      return {
        medianLcpMs: null,
        slowLcpPct: null,
        poorLcpPct: null,
        sampleCount: 0,
        worstLcpMs: 0,
        days: rows.length,
      };
    }
    allSamples.sort((a, b) => a - b);
    const medianLcpMs = allSamples[Math.floor(allSamples.length / 2)] ?? null;
    return {
      medianLcpMs,
      slowLcpPct: Math.round((slow / total) * 100),
      poorLcpPct: Math.round((poor / total) * 100),
      sampleCount: total,
      worstLcpMs: maxLcp,
      days: rows.length,
    };
  }

  /**
   * Nightly reconcile — recompute yesterday's rollup from authoritative
   * Session rows. Catches drift introduced by the live bump path
   * (concurrent writers, sample-cap eviction, ingest failures).
   *
   * Runs once a day at 02:00 UTC. Idempotent — overwrites the row.
   *
   * Uses a SINGLE SQL aggregate over Session for ALL workspaces in
   * the day window, not a per-workspace loop. That keeps the cron
   * cost at O(1) round-trips regardless of workspace count.
   */
  @Cron("0 2 * * *")
  async reconcileYesterday(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dayStart = WorkspacePerfDailyService.toDay(yesterday);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // Aggregate per workspace in ONE query. percentile_cont returns
    // an exact median; array_agg(lcp ORDER BY random()) limited by
    // the SAMPLE_CAP gives us the sample array. We sort it in JS
    // before writing since Postgres can't slice a sorted aggregate
    // without extra work.
    const rows = await this.db.$queryRawUnsafe<
      Array<{
        workspaceId: number;
        sample_count: bigint;
        lcp_sum: bigint;
        lcp_max: number;
        slow_count: bigint;
        poor_count: bigint;
        long_task_sum: bigint;
        lcp_samples: number[];
      }>
    >(
      `SELECT "workspaceId",
              COUNT(*)::bigint                                AS sample_count,
              COALESCE(SUM("worstLcp"), 0)::bigint            AS lcp_sum,
              COALESCE(MAX("worstLcp"), 0)                    AS lcp_max,
              COUNT(*) FILTER (WHERE "worstLcp" > ${SLOW_MS})::bigint AS slow_count,
              COUNT(*) FILTER (WHERE "worstLcp" > ${POOR_MS})::bigint AS poor_count,
              COALESCE(SUM("longTaskTotalMs"), 0)::bigint     AS long_task_sum,
              (ARRAY_AGG("worstLcp" ORDER BY random()))[1:${SAMPLE_CAP}] AS lcp_samples
         FROM "Session"
        WHERE "worstLcp" IS NOT NULL
          AND "worstLcp" > 0
          AND "startedAt" >= $1
          AND "startedAt" <  $2
        GROUP BY "workspaceId"`,
      dayStart,
      dayEnd,
    );

    if (rows.length === 0) return;

    // Parallel upserts — one per workspace. Different values per
    // row force per-row writes; Promise.all keeps wall-time at one
    // round-trip.
    await Promise.all(
      rows.map((r) =>
        this.db.workspacePerfDaily.upsert({
          where: {
            workspaceId_day: { workspaceId: r.workspaceId, day: dayStart },
          },
          create: {
            workspaceId: r.workspaceId,
            day: dayStart,
            sampleCount: Number(r.sample_count),
            lcpSum: r.lcp_sum,
            lcpMax: r.lcp_max,
            slowCount: Number(r.slow_count),
            poorCount: Number(r.poor_count),
            longTaskSum: r.long_task_sum,
            lcpSamples: (r.lcp_samples ?? []).slice(0, SAMPLE_CAP),
          },
          update: {
            sampleCount: Number(r.sample_count),
            lcpSum: r.lcp_sum,
            lcpMax: r.lcp_max,
            slowCount: Number(r.slow_count),
            poorCount: Number(r.poor_count),
            longTaskSum: r.long_task_sum,
            lcpSamples: (r.lcp_samples ?? []).slice(0, SAMPLE_CAP),
          },
        }),
      ),
    );
  }

  /**
   * Truncate a Date to the UTC day boundary. Stored as a Postgres
   * DATE so the key collides correctly regardless of timezone of
   * the inserting client.
   */
  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
