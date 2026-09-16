import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { RetentionService } from "./retention.service";
import { QueueModule } from "../queue/queue.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SignalsModule } from "../signals/signals.module";

@Module({
  // SignalsModule so the LIVE→COMPLETED sweep can derive the sessions it flips
  // (event-only mobile sessions finalize ONLY here — see sweepLiveSessions).
  imports: [
    ScheduleModule.forRoot(),
    QueueModule,
    NotificationsModule,
    SignalsModule,
  ],
  providers: [RetentionService],
})
export class RetentionModule {}
