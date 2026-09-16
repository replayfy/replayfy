/**
 * Single source of truth for parsing the REDIS_URL env var into the ioredis
 * options shape that Bull / cache-manager / nest-bull all accept. Used by
 * queue.module, cache.module, and email.module so a single change (e.g.
 * adding `tls` support) propagates everywhere.
 */
export interface RedisConnOpts {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  // Present (as `{}`) ONLY for the `rediss://` scheme, which switches ioredis
  // into TLS mode. Managed prod Redis (ElastiCache in-transit encryption,
  // Upstash, Redis Cloud) requires this; omitting it makes the connection
  // either fail or fall back to plaintext. `{}` = TLS with system CAs; a
  // consumer that needs a custom CA / SNI can extend these opts.
  tls?: Record<string, never>;
}

const DEFAULT_REDIS_URL = "redis://127.0.0.1:6380";

export function parseRedisUrl(
  url: string = process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
): RedisConnOpts {
  try {
    const u = new URL(url);
    // `rediss://` (double-s) is the TLS scheme. ioredis only negotiates TLS
    // when a `tls` option is present, so map the scheme onto it here — one
    // place, so Bull, cache-manager, and the shared REDIS_CLIENT all inherit
    // it. Managed Redis also often requires an ACL username (Redis 6+), which
    // the old parser dropped; carry it through.
    const opts: RedisConnOpts = {
      host: u.hostname,
      port: Number(u.port || 6379),
      username: u.username || undefined,
      password: u.password || undefined,
      db:
        u.pathname && u.pathname !== "/"
          ? Number(u.pathname.slice(1))
          : undefined,
    };
    if (u.protocol === "rediss:") opts.tls = {};
    return opts;
  } catch {
    return { host: "127.0.0.1", port: 6380 };
  }
}
