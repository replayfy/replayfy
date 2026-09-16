import { CacheModule } from "@nestjs/cache-manager";
import { Module, Global } from "@nestjs/common";
import { parseRedisUrl } from "./redis-url";
// `cache-manager-ioredis` ships as CJS with no types, so import via require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const redisStore = require("cache-manager-ioredis");

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: () => ({
        store: redisStore,
        ...parseRedisUrl(),
        ttl: 60 * 60, // seconds (cache-manager v4 uses seconds for ioredis store)
      }),
    }),
  ],
  exports: [CacheModule],
})
export class AppCacheModule {}
