import { Module } from "@nestjs/common";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";
import { ApiKeyCache } from "./api-keys.cache";

@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeysService, ApiKeyCache],
  exports: [ApiKeysService, ApiKeyCache],
})
export class ApiKeysModule {}
