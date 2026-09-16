import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { SettingsModule } from "../settings/settings.module";
import { SdkConfigController } from "./sdk-config.controller";
import { SdkConfigService } from "./sdk-config.service";

@Module({
  imports: [ApiKeysModule, SettingsModule],
  controllers: [SdkConfigController],
  providers: [SdkConfigService]
})
export class SdkModule {}
