import { Module } from "@nestjs/common";
import { PresenceService } from "./presence.service";

/**
 * Redis-backed live presence. RedisModule is @Global, so PresenceService gets
 * REDIS_CLIENT injected without importing it here. Exported so the ingest
 * accept path (writer) and the dashboard + recordings readers can all share the
 * one stateless service.
 */
@Module({
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
