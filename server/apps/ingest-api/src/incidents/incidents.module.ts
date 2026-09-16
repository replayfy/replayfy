import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { IncidentsService } from "./incidents.service";
import { IncidentInvestigationService } from "./incident-investigation.service";
import { IncidentCauseService } from "./incident-cause.service";
import { IncidentReportService } from "./incident-report.service";
import { IncidentFunnelService } from "./incident-funnel.service";
import { FunnelsModule } from "../funnels/funnels.module";
import { IncidentsController } from "./incidents.controller";

/**
 * Owns the nightly signal→incident clusterer + auto-resolve sweep (Overview
 * spine, Slice 1). Imports ScheduleModule.forRoot() (idempotent across modules)
 * so the cron registers. Exports IncidentsService so a script / future admin
 * endpoint can trigger a recompute on demand. Lane reads go straight through
 * Prisma in DashboardService — no need to depend on this service for reads.
 */
@Module({
  imports: [ScheduleModule.forRoot(), FunnelsModule],
  controllers: [IncidentsController],
  providers: [
    IncidentsService,
    IncidentCauseService,
    IncidentInvestigationService,
    IncidentReportService,
    IncidentFunnelService,
  ],
  exports: [IncidentsService],
})
export class IncidentsModule {}
