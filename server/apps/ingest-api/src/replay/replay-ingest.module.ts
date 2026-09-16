import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { QueueModule } from "../queue/queue.module";
import { PresenceModule } from "../presence/presence.module";
import { DevController } from "./dev.controller";
import { ReplayIngestController } from "./replay-ingest.controller";
import { ReplayIngestService } from "./replay-ingest.service";
import { ReplaySymbolicateController } from "./replay-symbolicate.controller";
import { SymbolicationService } from "./symbolication.service";

@Module({
  imports: [ApiKeysModule, QueueModule, PresenceModule],
  // ReplayIngestController is API-key authed (SDK traffic).
  // ReplaySymbolicateController is JwtAuthGuard authed (dashboard
  // UI traffic). Keeping them split keeps each controller's
  // auth model consistent.
  controllers: [
    ReplayIngestController,
    ReplaySymbolicateController,
    DevController,
  ],
  providers: [ReplayIngestService, SymbolicationService],
})
export class ReplayIngestModule {}
