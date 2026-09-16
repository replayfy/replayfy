import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { BullModule } from "@nestjs/bull";
import { ApiExceptionFilter } from "./common/api-exception.filter";
import { ResponseEnvelopeInterceptor } from "./common/response.interceptor";
import { AppCacheModule } from "./common/cache.module";
import { parseRedisUrl } from "./common/redis-url";
import { EmailModule } from "./email/email.module";
import { AuthModule } from "./auth/auth.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { SessionsModule } from "./sessions/sessions.module";
import { EndUsersModule } from "./end-users/end-users.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { HeatmapsModule } from "./heatmaps/heatmaps.module";
import { FunnelsModule } from "./funnels/funnels.module";
import { PlaylistsModule } from "./playlists/playlists.module";
import { CohortsModule } from "./cohorts/cohorts.module";
import { CommentsModule } from "./comments/comments.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { SettingsModule } from "./settings/settings.module";
import { ApiKeysModule } from "./api-keys/api-keys.module";
import { QueueModule } from "./queue/queue.module";
import { ReplayPersistenceModule } from "./replay/replay-persistence.module";
import { ReplayIngestModule } from "./replay/replay-ingest.module";
import { MobileModule } from "./mobile/mobile.module";
import { SdkModule } from "./sdk/sdk.module";
import { RetentionModule } from "./retention/retention.module";
import { StorageModule } from "./storage/storage.module";
import { FramesModule } from "./frames/frames.module";
import { WorkspaceStatsModule } from "./workspace-stats/workspace-stats.module";
import { WorkspacePerfDailyModule } from "./workspace-perf-daily/workspace-perf-daily.module";
import { WorkspaceLatencyDailyModule } from "./workspace-latency-daily/workspace-latency-daily.module";
import { WorkspaceConversionDailyModule } from "./workspace-conversion-daily/workspace-conversion-daily.module";
import { WorkspaceEngagementDailyModule } from "./workspace-engagement-daily/workspace-engagement-daily.module";
import { WorkspaceMobilePerfDailyModule } from "./workspace-mobile-perf-daily/workspace-mobile-perf-daily.module";
import { WorkspaceHealthModule } from "./workspace-health/workspace-health.module";
import { IntelModule } from "./intel/intel.module";
import { WorkspaceSignalDailyModule } from "./workspace-signal-daily/workspace-signal-daily.module";
import { IncidentsModule } from "./incidents/incidents.module";
import { IssuesModule } from "./issues/issues.module";
import { JourneyModule } from "./journeys/journey.module";
import { LlmModule } from "./llm/llm.module";
import { ReleaseModule } from "./releases/release.module";
import { WorkspacePrecomputeModule } from "./workspace-precompute/workspace-precompute.module";
import { AlertsModule } from "./alerts/alerts.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { IntelligenceSchedulerModule } from "./intelligence-scheduler/intelligence-scheduler.module";
import { HealthModule } from "./health/health.module";

/**
 * Enterprise Edition modules (the agentic assistant + AI insights) load ONLY
 * when the proprietary `ee/` directory is present. Resolved via require() — not
 * a static import — so the open-source build, which ships without `ee/`,
 * compiles and runs with no reference to it (require throws → no ee modules).
 */
function eeModules(): any[] {
  try {
    return require("./ee").EE_MODULES ?? [];
  } catch {
    return [];
  }
}

@Module({
  imports: [
    // Global HTTP rate limit (per client IP). A coarse ceiling that stops
    // credential-stuffing / brute-force / scraping without impeding a normal
    // dashboard session. Auth routes set a much stricter @Throttle, and the
    // high-volume INGEST controllers (replay/mobile) @SkipThrottle since they
    // are protected by the queue/backpressure layer instead. Env-tunable.
    // NOTE: in-memory per-node; behind a proxy set `trust proxy` so req.ip is
    // the real client, and swap to the Redis storage for cross-node limits.
    ThrottlerModule.forRoot({
      ttl: Number(process.env.THROTTLE_TTL_SECONDS ?? 60),
      limit: Number(process.env.THROTTLE_LIMIT ?? 1000),
    }),
    // Single Bull root for the whole app — every consumer module just
    // registers its named queues against this shared connection.
    BullModule.forRootAsync({ useFactory: () => ({ redis: parseRedisUrl() }) }),
    AppCacheModule,
    // Object storage (Cloudflare R2). @Global so every module gets
    // StorageService injection without re-importing.
    StorageModule,
    // Frames ingest pipeline (Redis Streams + async workers). @Global so the
    // mobile ingest + replay read paths inject its services without importing.
    FramesModule,
    // Workspace-level counter cache. @Global so every create/delete
    // path can call `bump()` without each module importing.
    WorkspaceStatsModule,
    // Daily web-vitals rollup. @Global so ingest can bump on session
    // completion + the dashboard read path can resolve windows from
    // ≤30 rolled-up rows instead of scanning sessions.
    WorkspacePerfDailyModule,
    WorkspaceLatencyDailyModule,
    WorkspaceConversionDailyModule,
    WorkspaceEngagementDailyModule,
    WorkspaceMobilePerfDailyModule,
    WorkspaceHealthModule,
    IntelModule,
    // Daily semantic-signal rollup. @Global so the finalize-derive path bumps
    // it + the dashboard reads the Pulse without importing.
    WorkspaceSignalDailyModule,
    EmailModule,
    ReplayPersistenceModule,
    QueueModule,
    AuthModule,
    WorkspacesModule,
    DashboardModule,
    SessionsModule,
    EndUsersModule,
    AnalyticsModule,
    HeatmapsModule,
    FunnelsModule,
    PlaylistsModule,
    CohortsModule,
    CommentsModule,
    NotificationsModule,
    SettingsModule,
    ApiKeysModule,
    SdkModule,
    RetentionModule,
    ReplayIngestModule,
    MobileModule,
    IncidentsModule,
    IssuesModule,
    WorkspacePrecomputeModule,
    AlertsModule,
    IntegrationsModule,
    // Cron PRODUCERS for the intelligence pipeline — fan the bulk signal
    // backfill / mobile-quiet / precompute sweeps into the intelligence Bull
    // queue (consumed by IntelligenceProcessor in QueueModule).
    IntelligenceSchedulerModule,
    // Enterprise Edition (agentic assistant + AI insights) — present only when
    // the proprietary ee/ directory ships with the build; empty otherwise.
    ...eeModules(),
    JourneyModule,
    // LLM provider layer (@Global) — Overview cause + the agent.
    LlmModule,
    ReleaseModule,
    // Liveness (/healthz) + readiness (/readyz) probes for the load balancer.
    HealthModule,
  ],
  providers: [
    // Enforce the throttle globally (routes opt out with @SkipThrottle).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
