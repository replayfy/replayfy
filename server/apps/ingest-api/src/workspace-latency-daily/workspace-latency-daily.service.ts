import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { latencyDaily, type LatencyDailyRow } from "@replay/db-clickhouse";

const SAMPLE_CAP = 1000;
/** Default API-latency SLO (ms) for the stored `slowCalls` counter at rollup
 *  time. The health SCORE's SLO threshold is a separate 0b concern; this is only
 *  the materialized counter. */
const SLOW_MS = 1000;

/**
 * Per-workspace daily API-latency rollup. Web-vitals (LCP/CLS/INP) live in
 * WorkspacePerfDailyService; this owns SERVER/API latency (network events),
 * materialized from ClickHouse so experienceHealth()'s Performance subsystem can
 * read a p95 daily series without a live session_events scan (API p95 previously
 * existed only as a live per-release scan, releaseLatency, which can't feed a
 * daily health series).
 *
 * ClickHouse is the source of truth for network timing, so — unlike
 * WorkspacePerfDaily's per-session live bump — this is CRON-ONLY: ONE grouped CH
 * query per day over ALL workspaces (never a per-workspace loop), upserted into
 * Postgres. reconcileYesterday runs nightly; backfill(days) seeds the spark window.
 */
@Injectable()
export class WorkspaceLatencyDailyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceLatencyDailyService.name);

  /** Nightly: (re)materialize yesterday's latency rollup from ClickHouse. */
  @Cron("0 2 * * *")
  async reconcileYesterday(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    try {
      await this.rollupDay(WorkspaceLatencyDailyService.toDay(yesterday));
    } catch (e) {
      this.logger.warn(`latency reconcile failed: ${(e as Error).message}`);
    }
  }

  /**
   * Backfill the trailing `days` UTC days (ending yesterday) from ClickHouse —
   * run once at rollout so the health spark has history. Sequential over DAYS
   * (bounded by `days`, ~35), ONE grouped CH query per day — bounded work, never
   * O(workspaces/sessions); sequential avoids firing 35 heavy CH scans at once.
   */
  async backfill(days: number): Promise<number> {
    let written = 0;
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 1);
    for (let i = 0; i < Math.max(1, Math.floor(days)); i++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() - i);
      try {
        written += await this.rollupDay(WorkspaceLatencyDailyService.toDay(day));
      } catch (e) {
        this.logger.warn(
          `latency backfill ${day.toISOString().slice(0, 10)} failed: ${(e as Error).message}`,
        );
      }
    }
    return written;
  }

  /**
   * Window aggregate for experienceHealth()'s Performance subsystem: union the
   * daily reservoir samples across [since, now] and compute the window p95 +
   * slow%, all from rollup rows (≤1000 samples/day × N days), never a session
   * scan. Served by @@index([workspaceId, day desc]).
   */
  async windowSummary(workspaceId: number, since: Date) {
    const rows = await this.db.workspaceLatencyDaily.findMany({
      where: {
        workspaceId,
        day: { gte: WorkspaceLatencyDailyService.toDay(since) },
      },
      select: { calls: true, slowCalls: true, maxMs: true, samples: true },
      orderBy: { day: "asc" },
    });
    let calls = 0;
    let slow = 0;
    let maxMs = 0;
    const all: number[] = [];
    for (const r of rows) {
      calls += r.calls;
      slow += r.slowCalls;
      if (r.maxMs > maxMs) maxMs = r.maxMs;
      all.push(...r.samples);
    }
    if (all.length === 0) {
      return { p95Ms: null, slowPct: null, calls: 0, maxMs: 0, days: rows.length };
    }
    all.sort((a, b) => a - b);
    const p95Ms = all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] ?? null;
    return {
      p95Ms,
      slowPct: calls > 0 ? Math.round((slow / calls) * 100) : null,
      calls,
      maxMs,
      days: rows.length,
    };
  }

  /** One grouped CH query for a UTC day → parallel per-workspace upserts (never a
   *  per-row await loop). Returns the number of workspaces written. */
  private async rollupDay(dayStart: Date): Promise<number> {
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const rows = await latencyDaily({
      sinceMs: dayStart.getTime(),
      untilMs: dayEnd.getTime(),
      slowMs: SLOW_MS,
    });
    if (rows.length === 0) return 0;
    await Promise.all(
      rows.map((r: LatencyDailyRow) => {
        const data = {
          calls: r.calls,
          p95Ms: r.p95_ms,
          avgMs: r.avg_ms,
          maxMs: r.max_ms,
          slowCalls: r.slow_calls,
          samples: (r.samples ?? []).slice(0, SAMPLE_CAP),
        };
        return this.db.workspaceLatencyDaily.upsert({
          where: {
            workspaceId_day: { workspaceId: r.workspace_id, day: dayStart },
          },
          create: { workspaceId: r.workspace_id, day: dayStart, ...data },
          update: data,
        });
      }),
    );
    return rows.length;
  }

  /** Truncate to the UTC day boundary (Postgres DATE keying, tz-stable). */
  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
