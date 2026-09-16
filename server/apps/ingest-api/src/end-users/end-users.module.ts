import { Module } from "@nestjs/common";
import { CohortsModule } from "../cohorts/cohorts.module";
import { BillingModule } from "../billing/billing.module";
import { EndUsersController } from "./end-users.controller";
import { EndUsersService } from "./end-users.service";

@Module({
  // BillingModule exports SessionReaperService — GDPR forget erases a user's
  // sessions across every store through it.
  imports: [CohortsModule, BillingModule],
  controllers: [EndUsersController],
  providers: [EndUsersService],
})
export class EndUsersModule {}
