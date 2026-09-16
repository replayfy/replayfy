import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

/**
 * Liveness/readiness probes for a load balancer. No providers of its own — the
 * readiness check reaches the datastore singletons directly (getPostgresClient
 * etc.) and injects the @Global REDIS_CLIENT. Registered on every APP_ROLE node
 * (role gating stops crons/queues, not HTTP controllers), so every process
 * exposes /healthz + /readyz on its own port.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
