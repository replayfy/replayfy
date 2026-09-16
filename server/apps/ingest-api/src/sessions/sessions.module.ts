import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";
import { MobileFramesService } from "./mobile-frames.service";
import { ShareController } from "./share.controller";
import { PresenceModule } from "../presence/presence.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [PresenceModule, NotificationsModule, BillingModule],
  controllers: [SessionsController, ShareController],
  providers: [SessionsService, MobileFramesService],
  exports: [SessionsService],
})
export class SessionsModule {}
