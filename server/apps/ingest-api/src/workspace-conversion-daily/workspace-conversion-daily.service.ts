import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient } from "@replay/db-postgres";
import { funnelTimeline, type FunnelStepCond } from "@replay/db-clickhouse";

const FUNNEL_PAGE = 100; // keyset page size over saved funnels
const DAY_MS = 86_400_000;

interface FunnelRow {
  id: number;
  workspaceId: number;
  steps: unknown;
  windowDays: number;
}

interface ConversionPoint {
  workspaceId: number;
  funnelId: number;
  day: Date;
  entered: number;
  converted: number;
}

/**
 * Per-workspace, per-saved-funnel DAILY conversion rollup — the REAL conversion
 * signal for experienceHealth()'s Conversion subsystem (replaces the old regex
 * signal proxy convSuccess/convFailure/formAbandon).
 *
 * Funnels have heterogeneous step defs, so — unlike perf/latency — they CANNOT
 * collapse into one grouped pass. Instead we KEYSET-PAGINATE saved funnels by id
 * (never load the Funnel table) and run ONE windowFunnel-timeline pass PER funnel;
 * cost is O(saved funnels), bounded, never O(sessions). funnelTimeline returns the
 * whole day-bucketed series in a single grouped query, so even a 35-day backfill
 * is one CH call per funnel. Upserts are batched (Promise.all per page), never a
 * per-row await loop.
 */
@Injectable()
export class WorkspaceConversionDailyService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceConversionDailyService.name);

  /** Nightly: (re)materialize yesterday's conversion point for every saved funnel. */
  @Cron("0 2 * * *")
  async reconcileYesterday(): Promise<void> {
    const end = WorkspaceConversionDailyService.dayFloor(Date.now());
    try {
      await this.rollupWindow(end - DAY_MS, end);
    } catch (e) {
      this.logger.warn(`conversion reconcile failed: ${(e as Error).message}`);
    }
  }

  /** Backfill the trailing `days` (ending yesterday) for the health spark — one
   *  CH timeline pass per funnel covers the whole window. Returns rows written. */
  async backfill(days: number): Promise<number> {
    const end = WorkspaceConversionDailyService.dayFloor(Date.now());
    const start = end - Math.max(1, Math.floor(days)) * DAY_MS;
    return this.rollupWindow(start, end);
  }

  /**
   * Window aggregate for 0b: the workspace's conversion over [since, now]. Sums
   * entered/converted across the workspace's funnel rows; 0b narrows to the
   * primary/pinned funnel when it wants a single funnel's rate. Rollup-only read,
   * served by @@index([workspaceId, day desc]).
   */
  async windowSummary(workspaceId: number, since: Date) {
    const rows = await this.db.workspaceConversionDaily.findMany({
      where: {
        workspaceId,
        day: { gte: WorkspaceConversionDailyService.toDay(since) },
      },
      select: { funnelId: true, entered: true, converted: true },
    });
    let entered = 0;
    let converted = 0;
    for (const r of rows) {
      entered += r.entered;
      converted += r.converted;
    }
    return {
      entered,
      converted,
      conversionPct:
        entered > 0 ? Math.round((converted / entered) * 1000) / 10 : null,
      funnels: new Set(rows.map((r) => r.funnelId)).size,
    };
  }

  /**
   * Materialize [startMs, endMs) for ALL saved funnels, keyset-paged by funnel id
   * (never a whole-table load). Per page: run funnelTimeline for each funnel in
   * parallel, then batch-upsert every (funnel, day) point.
   */
  private async rollupWindow(startMs: number, endMs: number): Promise<number> {
    let cursor = 0;
    let written = 0;
    for (;;) {
      const funnels = (await this.db.funnel.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: FUNNEL_PAGE,
        select: { id: true, workspaceId: true, steps: true, windowDays: true },
      })) as FunnelRow[];
      if (funnels.length === 0) break;

      const perFunnel = await Promise.all(
        funnels.map((f) =>
          this.timelineFor(f, startMs, endMs).catch((e) => {
            this.logger.warn(
              `conversion timeline funnel ${f.id} failed: ${(e as Error).message}`,
            );
            return [] as ConversionPoint[];
          }),
        ),
      );
      const points = perFunnel.flat();
      if (points.length > 0) {
        await Promise.all(
          points.map((p) =>
            this.db.workspaceConversionDaily.upsert({
              where: {
                workspaceId_funnelId_day: {
                  workspaceId: p.workspaceId,
                  funnelId: p.funnelId,
                  day: p.day,
                },
              },
              create: p,
              update: { entered: p.entered, converted: p.converted },
            }),
          ),
        );
        written += points.length;
      }
      cursor = funnels[funnels.length - 1].id;
      if (funnels.length < FUNNEL_PAGE) break;
    }
    return written;
  }

  /** funnelTimeline for one funnel over [startMs, endMs) → per-day points. The
   *  completion window is the funnel's OWN windowDays (not the range), so a
   *  backfill doesn't credit sessions an unrealistically long window to finish. */
  private async timelineFor(
    f: FunnelRow,
    startMs: number,
    endMs: number,
  ): Promise<ConversionPoint[]> {
    const raw = Array.isArray(f.steps)
      ? (f.steps as Array<Record<string, unknown>>)
      : [];
    if (raw.length < 2) return [];
    const steps: FunnelStepCond[] = raw.map((s) => ({
      kind: typeof s.kind === "string" ? s.kind : "page",
      matchType: typeof s.matchType === "string" ? s.matchType : "equals",
      value: String(s.value ?? ""),
    }));
    const pts = await funnelTimeline({
      workspaceId: f.workspaceId,
      steps,
      windowMs: Math.max(1, f.windowDays) * DAY_MS,
      sinceMs: startMs,
      untilMs: endMs,
    });
    return pts.map((p) => ({
      workspaceId: f.workspaceId,
      funnelId: f.id,
      day: WorkspaceConversionDailyService.toDay(new Date(p.day)),
      entered: p.total,
      converted: p.converted,
    }));
  }

  private static dayFloor(ms: number): number {
    return Math.floor(ms / DAY_MS) * DAY_MS;
  }
  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
