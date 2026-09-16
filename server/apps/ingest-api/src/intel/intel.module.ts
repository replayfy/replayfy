import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { IntelService } from "./intel.service";
import { IntelFactsService } from "./intel-facts.service";
import { LlmModule } from "../llm/llm.module";
import { WorkspaceHealthModule } from "../workspace-health/workspace-health.module";
import { IssuesModule } from "../issues/issues.module";

/**
 * Owns the AI intelligence-pass trigger (Phase 2) + the LLM pass (Phase 3).
 * IntelFactsService assembles the bounded FactBundle + owns the grounding helpers;
 * IntelService runs the trigger + the single llm.structured() call + persist.
 * Exported so a "regenerate" endpoint / verification can force a pass.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    LlmModule,
    WorkspaceHealthModule,
    IssuesModule,
  ],
  providers: [IntelService, IntelFactsService],
  exports: [IntelService],
})
export class IntelModule {}
