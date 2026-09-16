import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertsService } from "./alerts.service";
import { AlertsController } from "./alerts.controller";
import { EmailModule } from "../email/email.module";
import { IntegrationsModule } from "../integrations/integrations.module";

/**
 * Alert Intelligence — user-defined threshold alerts on daily signal metrics.
 * ScheduleModule.forRoot() (idempotent across modules) registers the evaluator
 * cron. Breach notifications are written straight to the Notification table in
 * one batched insert (the evaluator fans out set-based, so it doesn't route
 * per-alert through NotificationsService). Exports AlertsService so the agent's
 * alert.create capability can drive it.
 */
@Module({
  imports: [ScheduleModule.forRoot(), EmailModule, IntegrationsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
