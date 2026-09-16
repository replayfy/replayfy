import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { engagementDaily, type EngagementDailyRow } from "@replay/db-clickhouse";

const DAY_MS = 86_400_000;
const MAU_DAYS = 30;

/**
 * Per-workspace DAILY engagement rollup — persisted DAU + trailing-30d MAU (for
 * stickiness) + sessions + new users, so experienceHealth()'s Engagement
 * subsystem reads a real daily series instead of the live OverviewUserMetrics
 * prior-window approximation.
 *
 * ClickHouse (replay.sessions) is the source of truth, so this is CRON-ONLY: ONE
 * grouped engagementDaily query per day over ALL workspaces (never a per-workspace
 * loop). v1 = DAU/MAU stickiness; true D1/D7/D30 cohort retention is a deferred
 * follow-up (only 15% weight).
 */
@Injectable()
export class WorkspaceEngagementDailyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceEngagementDailyService.name);

  /** Nightly: (re)materialize yesterday's engagement rollup from ClickHouse. */
  @Cron("0 2 * * *")
  async reconcileYesterday(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    try {
      await this.rollupDay(WorkspaceEngagementDailyService.toDay(yesterday));
    } catch (e) {
      this.logger.warn(`engagement reconcile failed: ${(e as Error).message}`);
    }
  }

  /** Backfill the trailing `days` (ending yesterday) for the health spark. One
   *  grouped CH query per day (each scans the trailing 30d for MAU); sequential
   *  over DAYS (bounded), never O(workspaces/sessions). Returns rows written. */
  async backfill(days: number): Promise<number> {
    let written = 0;
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 1);
    for (let i = 0; i < Math.max(1, Math.floor(days)); i++) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() - i);
      try {
        written += await this.rollupDay(WorkspaceEngagementDailyService.toDay(day));
      } catch (e) {
        this.logger.warn(
          `engagement backfill ${day.toISOString().slice(0, 10)} failed: ${(e as Error).message}`,
        );
      }
    }
    return written;
  }

  /**
   * Window aggregate for 0b: avg DAU over [since, now], the current MAU (latest
   * day's trailing-30d distinct), stickiness (avgDau/mau), and session/new-user
   * sums — all from rollup rows, never a session scan.
   */
  async windowSummary(workspaceId: number, since: Date) {
    const rows = await this.db.workspaceEngagementDaily.findMany({
      where: {
        workspaceId,
        day: { gte: WorkspaceEngagementDailyService.toDay(since) },
      },
      select: { day: true, dau: true, mau: true, sessions: true, newUsers: true },
      orderBy: { day: "asc" },
    });
    if (rows.length === 0) {
      return { avgDau: null, mau: null, stickinessPct: null, sessions: 0, newUsers: 0, days: 0 };
    }
    let dauSum = 0;
    let sessions = 0;
    let newUsers = 0;
    for (const r of rows) {
      dauSum += r.dau;
      sessions += r.sessions;
      newUsers += r.newUsers;
    }
    const avgDau = Math.round(dauSum / rows.length);
    const mau = rows[rows.length - 1].mau; // latest day's trailing-30d MAU
    return {
      avgDau,
      mau,
      stickinessPct: mau > 0 ? Math.round((avgDau / mau) * 1000) / 10 : null,
      sessions,
      newUsers,
      days: rows.length,
    };
  }

  /** One grouped CH query for a UTC day → parallel per-workspace upserts. */
  private async rollupDay(dayStart: Date): Promise<number> {
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const rows = await engagementDaily({
      dayStartMs: dayStart.getTime(),
      dayEndMs: dayEnd.getTime(),
      mauDays: MAU_DAYS,
    });
    if (rows.length === 0) return 0;
    await Promise.all(
      rows.map((r: EngagementDailyRow) => {
        const data = {
          dau: r.dau,
          mau: r.mau,
          sessions: r.sessions,
          newUsers: r.new_users,
        };
        return this.db.workspaceEngagementDaily.upsert({
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

  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
