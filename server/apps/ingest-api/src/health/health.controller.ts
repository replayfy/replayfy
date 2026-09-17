import { Controller, Get, Inject, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";
import type { Redis } from "ioredis";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { getClickHouseClient } from "@replay/db-clickhouse";
import { REDIS_CLIENT } from "../common/redis.module";

/**
 * Liveness + readiness for a load balancer / orchestrator.
 *
 *   GET /healthz — LIVENESS. Process is up and the event loop is turning.
 *     Never touches a datastore, so a slow/blipping dependency can't cause a
 *     needless restart. Point the "restart if failing" probe here.
 *
 *   GET /readyz  — READINESS. Pings every backing store (Postgres, Redis,
 *     ClickHouse, Mongo) in parallel, each time-boxed, and returns 503 until
 *     all are reachable. Point the "route traffic to this node" probe here so
 *     a rolling deploy doesn't send requests to a node whose stores are still
 *     coming up.
 *
 * Both @SkipThrottle so probe traffic never counts against the global rate
 * limit. Neither requires auth — they leak no data (readyz returns only
 * up/down booleans per dependency, never connection strings or errors).
 */
const CHECK_TIMEOUT_MS = 2000;

@SkipThrottle()
@Controller()
export class HealthController {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  @Get("healthz")
  healthz(): { ok: true; at: string } {
    return { ok: true, at: new Date().toISOString() };
  }

  /**
   * Build identity — so a self-hoster (or a bug report) can say exactly which
   * version they're running. Baked into the image at build time (APP_VERSION from
   * package.json / the release tag, GIT_SHA + BUILD_TIME from CI); falls back to
   * dev placeholders for a from-source run. Public + unauthenticated — it leaks
   * only the version, never config.
   */
  @Get("version")
  version(): { version: string; commit: string; builtAt: string | null } {
    return {
      version: process.env.APP_VERSION || "0.0.0-dev",
      commit: process.env.GIT_SHA || "unknown",
      builtAt: process.env.BUILD_TIME || null,
    };
  }

  @Get("readyz")
  async readyz(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: boolean; checks: Record<string, boolean> }> {
    const [postgres, redis, clickhouse, mongo] = await Promise.all([
      this.check(() =>
        getPostgresClient().$queryRawUnsafe("SELECT 1"),
      ),
      this.check(() => this.redis.ping()),
      this.check(async () => {
        const r = await getClickHouseClient().ping();
        if (!r.success) throw new Error("clickhouse ping failed");
      }),
      this.check(() => getMongoClient().$runCommandRaw({ ping: 1 })),
    ]);
    const checks = { postgres, redis, clickhouse, mongo };
    const ok = Object.values(checks).every(Boolean);
    // 503 until every store is reachable — orchestrators treat non-2xx as
    // "not ready" and hold traffic. Bypass the exception filter (which would
    // mask the per-store breakdown behind a generic 500 body) by setting the
    // status on the passthrough response and returning the detail directly.
    res.status(ok ? 200 : 503);
    return { ok, checks };
  }

  /** Run one dependency ping, time-boxed; any throw/timeout → false (down). */
  private async check(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }
}
