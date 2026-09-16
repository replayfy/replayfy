import {
  Controller,
  Get,
  Inject,
  Post,
  Query,
  UseGuards,
  forwardRef,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { ManualAiThrottleGuard } from "../common/manual-ai-throttle.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { DashboardService } from "./dashboard.service";
import { WorkspacePrecomputeService } from "../workspace-precompute/workspace-precompute.service";

@Controller("v1/dashboard")
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    @Inject(forwardRef(() => WorkspacePrecomputeService))
    private readonly precompute: WorkspacePrecomputeService,
  ) {}

  @Get("overview")
  async overview(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const fromTs = from ? Number(from) : undefined;
    const toTs = to ? Number(to) : undefined;
    // Fast path: WorkspacePrecomputeService.DEFAULT_RANGE is precomputed every
    // ~5min and mirrored to Redis (snapshot → schema.prisma
    // WorkspaceSnapshot.overview). Serve it verbatim (one Redis GET, ~1ms)
    // instead of recomputing the whole Overview live (~440ms at 500k sessions).
    // Custom/absolute ranges and cache misses fall through to the live compute.
    // Gated on the CONSTANT, never a literal: this gate and the precomputed
    // range silently disagreed before (30d header vs a 7d precompute), so the
    // snapshot was rebuilt every 5 minutes and never once served.
    if (
      (range ?? "7d") === WorkspacePrecomputeService.DEFAULT_RANGE &&
      fromTs === undefined &&
      toTs === undefined
    ) {
      const snap = await this.precompute.snapshot(workspaceId);
      if (snap.overview) {
        // Overlay a FRESH all-time session total on the (up to ~1h stale) snapshot
        // so the Overview's "total sessions" always matches the real-time sidebar
        // + Recordings header. One PK counter lookup on top of the ~1ms Redis GET.
        const sessionsTotal = await this.service.sessionsTotalOf(workspaceId);
        return { ...(snap.overview as object), sessionsTotal, stale: snap.stale };
      }
    }
    return this.service.overview(workspaceId, range ?? "7d", fromTs, toTs);
  }

  /** Segments — real platform / browser / country distribution of the window's
   *  sessions (replaces the Overview's demo fixture). */
  @Get("segments")
  segments(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    // `full=1` → the breakdown drawer's complete ranked list (every label, no
    // top-N cap / "Other"). Omitted on the compact 30s Overview poll.
    @Query("full") full?: string,
  ) {
    const fromTs = from ? Number(from) : undefined;
    const toTs = to ? Number(to) : undefined;
    return this.service.segments(
      workspaceId,
      range ?? "7d",
      fromTs,
      toTs,
      full === "1" || full === "true",
    );
  }

  /** Level-1 business-health metrics (DAU/WAU/MAU, sessions, duration,
   *  conversion, returning, crashes) — each with prev-period delta + sparkline. */
  @Get("metrics")
  async metrics(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const fromTs = from ? Number(from) : undefined;
    const toTs = to ? Number(to) : undefined;
    // Same fast path as /overview above. WorkspacePrecomputeService ALREADY
    // computes metrics for the default relative window every sweep and mirrors
    // it to Redis (recomputeWorkspace → dashboard.metrics), but nothing ever
    // read it back — so that work was recomputed every ~5min and thrown away
    // while every dashboard load still paid 3 live ClickHouse FINAL scans (up
    // to 60d). Serve the snapshot verbatim (one Redis GET); custom/absolute
    // ranges and cache misses still fall through to the live compute.
    if (
      (range ?? "7d") === WorkspacePrecomputeService.DEFAULT_RANGE &&
      fromTs === undefined &&
      toTs === undefined
    ) {
      const snap = await this.precompute.snapshot(workspaceId);
      if (snap.metrics) {
        return { ...(snap.metrics as object), stale: snap.stale };
      }
    }
    return this.service.metrics(workspaceId, range ?? "7d", fromTs, toTs);
  }

  /** Activity chart — REAL per-dimension, per-bucket series with optional
   *  breakdown, granularity, segment, rule-filters and a compare window. Drives
   *  the Overview → Activity chart's Filter (the fabricated breakdown is gone). */
  @Get("activity-series")
  activitySeries(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("metric") metric?: string,
    @Query("dimension") dimension?: string,
    @Query("range") range?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("gran") gran?: string,
    @Query("segment") segment?: string,
    @Query("compare") compare?: string,
    @Query("topN") topN?: string,
    // Repeated `rule=dim:value` params (?rule=browser:Chrome&rule=country:NG).
    @Query("rule") rule?: string | string[],
  ) {
    return this.service.activitySeries(workspaceId, {
      metric,
      dimension,
      range: range ?? "30d",
      fromTs: from ? Number(from) : undefined,
      toTs: to ? Number(to) : undefined,
      gran,
      segment,
      compare: compare === "1" || compare === "true",
      topN: topN ? Number(topN) : undefined,
      rules: Array.isArray(rule) ? rule : rule ? [rule] : [],
    });
  }

  /** The AI intelligence layer (health score + storyline + insights), gated by
   *  the per-workspace aiEnabled toggle. Returns { aiEnabled:false } when AI is
   *  off — the dashboard then shows only classic analytics. */
  @Get("intelligence")
  intelligence(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
  ) {
    return this.service.intelligence(workspaceId, range ?? "30d");
  }

  /** Force an AI intelligence pass now (the "regenerate insights" button). Makes
   *  TWO LLM calls → MEMBER+ only, and rate-limited per plan by
   *  ManualAiThrottleGuard, which rejects with 429 AI_RECOMPUTE_THROTTLED past
   *  the daily allowance BEFORE the handler runs. No-op when AI is off. */
  @Post("intel/recompute")
  @UseGuards(WorkspaceRoleGuard, ManualAiThrottleGuard)
  @RequiresRole("MEMBER")
  recomputeIntel(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.recomputeIntel(workspaceId);
  }

  @Get("live")
  live(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.liveCount(workspaceId);
  }

  /** Real-time "who's using your app now": distinct online people + live
   *  sessions, read from Redis presence. Poll this (the dashboard already
   *  polls HTTP; no WebSocket needed). */
  @Get("online")
  online(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.onlinePresence(workspaceId);
  }

  @Get("counts")
  counts(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.counts(workspaceId);
  }
}
