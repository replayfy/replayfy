import { Global, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { RedisModule } from "../common/redis.module";
import { SignalsModule } from "../signals/signals.module";
import { FramesStreamService } from "./frames-stream.service";
import { FramesArchiveService } from "./frames-archive.service";
import { FramesWorkerService } from "./frames-worker.service";
import { FramesFinalizerService } from "./frames-finalizer.service";

/**
 * Frames ingest pipeline (mobile screenshots): Redis Streams + async workers,
 * replacing the old on-disk accumulate → sweep → pack flow.
 *
 *   FramesStreamService    ingest write  — XADD + ZADD (the /v1/mobile/images
 *                                          hot path; injected by MobileService)
 *   FramesArchiveService   replay read   — resolve frames/{sid}.frames.gz URL
 *                                          (injected by MobileFramesService)
 *   FramesWorkerService    stream worker — drain → gzip → multipart to R2
 *   FramesFinalizerService lifecycle     — ZSET expiry poll + complete/cleanup
 *
 * @Global so the mobile ingest + replay modules inject the read/write services
 * without re-importing. StorageService + WorkspaceStatsService are themselves
 * @Global, so no explicit import needed for them; RedisModule provides the
 * shared client; ScheduleModule.forRoot() registers the @Interval timers
 * (idempotent — other modules already call it).
 */
@Global()
@Module({
  // SignalsModule so the native finalizer fires the same finalize-derive hook
  // the web replay path does (crash/error → sessionScore + Issue grouping).
  imports: [RedisModule, ScheduleModule.forRoot(), SignalsModule],
  providers: [
    FramesStreamService,
    FramesArchiveService,
    FramesWorkerService,
    FramesFinalizerService,
  ],
  exports: [FramesStreamService, FramesArchiveService],
})
export class FramesModule {}
