import { Module } from "@nestjs/common";
import { WorkspaceStatsModule } from "../workspace-stats/workspace-stats.module";
import { SessionReaperService } from "./session-reaper.service";

/**
 * Core billing — the shared "delete everywhere" session-reaper reused by the
 * end-users / sessions / retention paths, plus the plan catalogue + billing
 * types that live alongside it (imported directly as plain modules).
 *
 * The Stripe subscription + AI-credit metering side is Enterprise Edition and
 * lives in `ee/billing` (EeBillingModule). Core code that needs the metering
 * judge injects it via the BILLING_SERVICE token (see billing.port.ts) with
 * @Optional, so the open-source build — which ships without ee/ — runs with
 * billing simply unlimited.
 */
@Module({
  imports: [WorkspaceStatsModule],
  providers: [SessionReaperService],
  exports: [SessionReaperService],
})
export class BillingModule {}
