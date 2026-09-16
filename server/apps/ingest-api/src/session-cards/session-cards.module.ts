import { Module } from "@nestjs/common";
import { SessionCardsService } from "./session-cards.service";

/**
 * The Session Processor's card stage. Exports SessionCardsService so the
 * signals chokepoint (SignalsModule imports this) can chain card derivation
 * after Issues, and so a future hourly precompute / manual-recompute trigger
 * can drive it directly.
 */
@Module({
  providers: [SessionCardsService],
  exports: [SessionCardsService],
})
export class SessionCardsModule {}
