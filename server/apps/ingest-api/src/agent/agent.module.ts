import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { CapabilityRegistry } from "./capability";
import { AgentCapabilities } from "./agent-capabilities";
import { ExecutionEngine } from "./execution-engine";
import { Planner } from "./planner";
import { Narrator } from "./narrator";
import { ActionSelector } from "./action-selector";
import { MemoryExtractor } from "./memory-extractor";
import { ConversationStore } from "./conversation.store";
import { WorkspaceKnowledgeService } from "./workspace-knowledge.service";
import { ConversionService } from "./conversion.service";
import { ResultSetService } from "./result-set.service";
import { AgentService } from "./agent.service";
import { AgentController } from "./agent.controller";
import { InvestigationService } from "./investigation.service";
import { IssuesModule } from "../issues/issues.module";
import { FunnelsModule } from "../funnels/funnels.module";
import { DashboardModule } from "../dashboard/dashboard.module";
import { CohortsModule } from "../cohorts/cohorts.module";
import { ReleaseModule } from "../releases/release.module";
import { InsightsModule } from "../insights/insights.module";
import { CommentsModule } from "../comments/comments.module";
import { AlertsModule } from "../alerts/alerts.module";
import { PlaylistsModule } from "../playlists/playlists.module";
import { IntegrationsModule } from "../integrations/integrations.module";

/**
 * The Replayfy AI agentic platform.
 *
 *   AgentController → AgentService (firewall → iterative plan/execute/narrate)
 *     · Planner (Claude) — plans capability calls, never answers
 *     · ExecutionEngine — enforces permission→scope→validate→execute→audit
 *     · CapabilityRegistry + AgentCapabilities — the registered, RBAC-filtered
 *       capabilities wrapping Replayfy's deterministic services
 *     · Narrator — reasons over the collected evidence
 *     · ActionSelector — picks which next-step chips (if any) suit the answer,
 *       from a feasible set the server builds; never invents one
 *     · ConversationStore — stateful, workspace-scoped conversation memory
 *
 * Claude never touches data or picks a workspace. LlmService +
 * WorkspaceSignalDailyService are @Global; IssuesModule + FunnelsModule provide
 * the wrapped services.
 */
@Module({
  imports: [
    // ScheduleModule for the ConversationStore's hourly TTL cleanup cron.
    ScheduleModule.forRoot(),
    IssuesModule,
    FunnelsModule,
    DashboardModule,
    CohortsModule,
    ReleaseModule,
    InsightsModule,
    CommentsModule,
    AlertsModule,
    PlaylistsModule,
    IntegrationsModule,
  ],
  controllers: [AgentController],
  providers: [
    CapabilityRegistry,
    AgentCapabilities,
    ExecutionEngine,
    Planner,
    Narrator,
    ActionSelector,
    MemoryExtractor,
    ConversationStore,
    WorkspaceKnowledgeService,
    ConversionService,
    ResultSetService,
    InvestigationService,
    AgentService,
  ],
  exports: [
    CapabilityRegistry,
    ExecutionEngine,
    WorkspaceKnowledgeService,
    ConversionService,
    ResultSetService,
  ],
})
export class AgentModule {}
