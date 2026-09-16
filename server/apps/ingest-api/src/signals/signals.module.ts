import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { SignalsService } from "./signals.service";
import { IssuesModule } from "../issues/issues.module";
import { SessionCardsModule } from "../session-cards/session-cards.module";

/**
 * Owns semantic-signal derivation (the Overview spine, Slice 0). Exports
 * SignalsService so the ingest persistence path can fire per-session derivation
 * at finalize. Imports ScheduleModule.forRoot() (idempotent across modules) so
 * the nightly backfill cron registers. Imports IssuesModule + SessionCardsModule
 * so the same finalize/backfill chokepoint also drives Issue grouping and the
 * per-session AI cards.
 */
@Module({
  imports: [ScheduleModule.forRoot(), IssuesModule, SessionCardsModule],
  providers: [SignalsService],
  exports: [SignalsService],
})
export class SignalsModule {}
