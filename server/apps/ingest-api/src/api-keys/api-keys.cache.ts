import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable } from "@nestjs/common";
import type { Cache } from "cache-manager";
import { getPostgresClient, type ApiKeyScope } from "@replay/db-postgres";

export interface CachedApiKey {
  workspaceId: number;
  scope: ApiKeyScope;
  keyId: number;
}

const KEY_PREFIX = "apikey:";
const TTL_SECONDS = 60 * 60;

@Injectable()
export class ApiKeyCache {
  private readonly db = getPostgresClient();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  // NOTE: `del` — and ONLY `del` — returns undefined instead of a Promise, so
  // chaining `.catch()` on it throws "reading 'catch'". That is what crashed
  // rotate/revoke: both call invalidate() below. cache-manager v4 binds store
  // methods straight through (its caching.js does `self.del = store.del.bind`,
  // no promisify layer), and cache-manager-ioredis's `del` — unlike its `get`
  // and `set`, which do return real Promises — never returns its inner Promise.
  // So `.catch()` on a get/set is fine (sdk-config.service.ts relies on that);
  // only del must not be chained. `await` tolerates a Promise or a bare value,
  // and try/catch keeps every cache op best-effort so a hiccup never fails the
  // request — hence this shape throughout.
  //
  // Caveat that shape cannot fix: a FAILING del reports through a callback we
  // don't pass, so the error is swallowed and the try/catch never sees it. A
  // revoke whose DEL fails still answers `{revoked: true}` while the key stays
  // cached-valid until TTL. Verified against Redis on cache-manager@4.1.0 +
  // cache-manager-ioredis@2.1.0.
  async lookup(keyHash: string): Promise<CachedApiKey | null> {
    const cacheKey = `${KEY_PREFIX}${keyHash}`;
    let cached: CachedApiKey | undefined;
    try {
      cached = await this.cache.get<CachedApiKey>(cacheKey);
    } catch {
      /* cache read is best-effort */
    }
    if (cached) return cached;
    const row = await this.db.apiKey.findUnique({ where: { keyHash } });
    if (!row || row.revokedAt) return null;
    const entry: CachedApiKey = {
      workspaceId: row.workspaceId,
      scope: row.scope,
      keyId: row.id,
    };
    await this.set(keyHash, entry);
    return entry;
  }

  async set(keyHash: string, entry: CachedApiKey): Promise<void> {
    try {
      // `{ ttl }`, NOT a bare `set(key, value, seconds)`. The @types advertise a
      // raw-number overload so both typecheck, but cache-manager-ioredis reads
      // `options.ttl` off the third argument — a number has no `.ttl`, so that
      // form silently falls through to the store's default (AppCacheModule's 1
      // hour). It matches TTL_SECONDS today, which is exactly what makes it a
      // trap: lower TTL_SECONDS for faster revocation propagation and the bare
      // form would keep serving a revoked key for the full default hour.
      await this.cache.set(`${KEY_PREFIX}${keyHash}`, entry, {
        ttl: TTL_SECONDS,
      });
    } catch {
      /* best-effort */
    }
  }

  async invalidate(keyHash: string): Promise<void> {
    try {
      await this.cache.del(`${KEY_PREFIX}${keyHash}`);
    } catch {
      /* best-effort */
    }
  }
}
