import { Module } from "@nestjs/common";
import { IssuesService } from "./issues.service";
import { IssuesController } from "./issues.controller";

/**
 * Sentry-style Issue grouping. IssueOccurrence is derived per session off the
 * signals finalize chokepoint (SignalsModule imports this and calls
 * IssuesService.deriveForSessions); Issue aggregates are rebuilt set-based in
 * the same pass. Exports IssuesService so the signals pipeline + a future
 * hourly precompute / manual-recompute trigger can drive it.
 */
@Module({
  controllers: [IssuesController],
  providers: [IssuesService],
  exports: [IssuesService],
})
export class IssuesModule {}
