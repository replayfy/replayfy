import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";
import { parseRedisUrl } from "./redis-url";

/**
 * Shared ioredis client for the frames ingest pipeline (Redis Streams +
 * the session-expiry sorted set). Distinct from the Bull / cache-manager
 * connections so a long-running stream consumer can never starve those
 * pools — but it reuses the SAME parseRedisUrl() source of truth, so one
 * REDIS_URL change still propagates everywhere.
 *
 * Two injectables:
 *   • REDIS_CLIENT          — the shared command connection (XADD, ZADD,
 *                             ZRANGEBYSCORE, SET NX, multipart-state hashes).
 *                             Safe to share: these are all non-blocking.
 *   • REDIS_CONNECTION_OPTS — the parsed opts, so a consumer that needs its
 *                             OWN dedicated connection (e.g. a blocking
 *                             XREAD) can `new Redis(opts)` without re-parsing.
 *
 * @Global so the ingest write path, the stream worker, and the finalizer
 * all inject the client without re-importing the module.
 */
export const REDIS_CLIENT = "REDIS_CLIENT";
export const REDIS_CONNECTION_OPTS = "REDIS_CONNECTION_OPTS";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION_OPTS,
      useFactory: () => parseRedisUrl(),
    },
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        // maxRetriesPerRequest:null + autoReconnect keeps the pipeline safe
        // under Redis restarts/failover — commands queue and replay on
        // reconnect instead of throwing, so an XADD on the ingest hot path
        // never surfaces a transient blip to the SDK.
        const client = new Redis({
          ...parseRedisUrl(),
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        client.on("error", (err) => {
          process.stderr.write(`[redis] client error: ${String(err)}\n`);
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT, REDIS_CONNECTION_OPTS],
})
export class RedisModule {}
