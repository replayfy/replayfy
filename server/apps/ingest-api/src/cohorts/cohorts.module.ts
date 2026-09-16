import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { CohortsController } from "./cohorts.controller";
import { CohortsService } from "./cohorts.service";

@Module({
  // ScheduleModule.forRoot() (idempotent across modules) registers the 15s
  // drainDirtyCohorts @Cron. RedisModule is @Global, so CohortsService injects
  // REDIS_CLIENT without importing it.
  imports: [ScheduleModule.forRoot()],
  controllers: [CohortsController],
  providers: [CohortsService],
  exports: [CohortsService],
})
export class CohortsModule {}
