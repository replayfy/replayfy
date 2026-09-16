import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { SettingsModule } from "../settings/settings.module";
import { CohortsModule } from "../cohorts/cohorts.module";
import { PresenceModule } from "../presence/presence.module";
import { MobileController } from "./mobile.controller";
import { MobileService } from "./mobile.service";

/**
 * Mobile (iOS / Android) SDK ingest. Project-key → session token on
 * /start; binary message + frames ingest on the data endpoints.
 * StorageService is global (frames archive); ApiKeyCache resolves the
 * project key → workspace.
 */
@Module({
  imports: [
    ApiKeysModule,
    SettingsModule,
    CohortsModule,
    PresenceModule,
  ],
  controllers: [MobileController],
  providers: [MobileService],
})
export class MobileModule {}
