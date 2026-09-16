import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient, Prisma } from "@replay/db-postgres";

const MOBILE_PLATFORMS = ["ios", "android", "react_native", "flutter"];

interface MobileAggRow {
  workspaceId: number;
  day: Date;
  mobile_sessions: bigint;
  anr_sessions: bigint;
  frozen_sessions: bigint;
  anr_sum: bigint;
  frozen_sum: bigint;
}

/**
 * Per-workspace DAILY mobile-performance rollup (ANR + frozen frames). Mobile
 * sessions emit no LCP, so the web WorkspacePerfDaily can't score them; this proxy
 * lets experienceHealth() give a mobile-heavy workspace a real Performance score
 * instead of near-zero LCP samples.
 *
 * Sourced from the Postgres Session columns (anrCount/frozenFrameCount) via ONE
 * set-based GROUP BY over the reconcile window (never a per-row loop),
 * index-served by @@index([platform, startedAt desc]) so it scans only mobile
 * rows in-window — never the whole (web-heavy) Session table. Kept separate from
 * WorkspacePerfDaily: different source (Session cols, not web-vitals) and a
 * different population path (nightly reconcile, no live per-session bump).
 */
@Injectable()
export class WorkspaceMobilePerfDailyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceMobilePerfDailyService.name);

  /** Nightly: (re)materialize yesterday's mobile-perf rollup from Session. */
  @Cron("0 2 * * *")
  async reconcileYesterday(): Promise<void> {
    const end = WorkspaceMobilePerfDailyService.dayFloor(new Date());
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 1);
    try {
      await this.reconcileRange(start, end);
    } catch (e) {
      this.logger.warn(`mobile-perf reconcile failed: ${(e as Error).message}`);
    }
  }

  /** Backfill the trailing `days` — ONE set-based grouped query over the whole
   *  window emits every (workspace, day) row at once. Returns rows written. */
  async backfill(days: number): Promise<number> {
    const end = WorkspaceMobilePerfDailyService.dayFloor(new Date());
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - Math.max(1, Math.floor(days)));
    return this.reconcileRange(start, end);
  }

  /**
   * Window aggregate for 0b's mobile-Performance branch: ANR / frozen-frame rates
   * (sessions affected ÷ mobile sessions) + per-session ANR, from rollup rows only.
   */
  async windowSummary(workspaceId: number, since: Date) {
    const rows = await this.db.workspaceMobilePerfDaily.findMany({
      where: {
        workspaceId,
        day: { gte: WorkspaceMobilePerfDailyService.dayFloor(since) },
      },
      select: {
        mobileSessions: true,
        anrSessions: true,
        frozenSessions: true,
        anrSum: true,
        frozenSum: true,
      },
    });
    let mobile = 0;
    let anrSess = 0;
    let frozenSess = 0;
    let anr = 0;
    for (const r of rows) {
      mobile += r.mobileSessions;
      anrSess += r.anrSessions;
      frozenSess += r.frozenSessions;
      anr += r.anrSum;
    }
    if (mobile === 0) {
      return {
        mobileSessions: 0,
        anrRatePct: null,
        frozenRatePct: null,
        anrPerSession: null,
        days: rows.length,
      };
    }
    return {
      mobileSessions: mobile,
      anrRatePct: Math.round((anrSess / mobile) * 1000) / 10,
      frozenRatePct: Math.round((frozenSess / mobile) * 1000) / 10,
      anrPerSession: Math.round((anr / mobile) * 100) / 100,
      days: rows.length,
    };
  }

  /** ONE set-based grouped query over [start, end) → batched upserts. */
  private async reconcileRange(start: Date, end: Date): Promise<number> {
    const rows = await this.db.$queryRaw<MobileAggRow[]>(Prisma.sql`
      SELECT "workspaceId",
             date_trunc('day', "startedAt")::date AS day,
             COUNT(*)::bigint AS mobile_sessions,
             COUNT(*) FILTER (WHERE "anrCount" > 0)::bigint AS anr_sessions,
             COUNT(*) FILTER (WHERE "frozenFrameCount" > 0)::bigint AS frozen_sessions,
             COALESCE(SUM("anrCount"), 0)::bigint AS anr_sum,
             COALESCE(SUM("frozenFrameCount"), 0)::bigint AS frozen_sum
        FROM "Session"
       WHERE "platform" IN (${Prisma.join(MOBILE_PLATFORMS)})
         AND "startedAt" >= ${start} AND "startedAt" < ${end}
       GROUP BY "workspaceId", date_trunc('day', "startedAt")::date`);
    if (rows.length === 0) return 0;
    await Promise.all(
      rows.map((r) => {
        const day = WorkspaceMobilePerfDailyService.dayFloor(new Date(r.day));
        const data = {
          mobileSessions: Number(r.mobile_sessions),
          anrSessions: Number(r.anr_sessions),
          frozenSessions: Number(r.frozen_sessions),
          anrSum: Number(r.anr_sum),
          frozenSum: Number(r.frozen_sum),
        };
        return this.db.workspaceMobilePerfDaily.upsert({
          where: { workspaceId_day: { workspaceId: r.workspaceId, day } },
          create: { workspaceId: r.workspaceId, day, ...data },
          update: data,
        });
      }),
    );
    return rows.length;
  }

  private static dayFloor(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
