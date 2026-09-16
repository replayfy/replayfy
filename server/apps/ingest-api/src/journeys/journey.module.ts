import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { JourneyService } from "./journey.service";

/**
 * Owns the nightly journey clusterer (Overview health zone, Slice 4). Imports
 * ScheduleModule.forRoot() (idempotent) for the cron; exports JourneyService so
 * a script / future admin endpoint can recompute on demand. "Top failed
 * journeys" reads go straight through Prisma in DashboardService.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [JourneyService],
  exports: [JourneyService],
})
export class JourneyModule {}
