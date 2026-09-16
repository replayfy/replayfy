import { Module } from "@nestjs/common";
import { FunnelsController } from "./funnels.controller";
import { FunnelsService } from "./funnels.service";
import { CohortsModule } from "../cohorts/cohorts.module";

@Module({
  // CohortsModule exports CohortsService — the drop-off cohort feature reuses
  // its create + addMembers (MANUAL cohort) rather than re-implementing them.
  imports: [CohortsModule],
  controllers: [FunnelsController],
  providers: [FunnelsService],
  exports: [FunnelsService],
})
export class FunnelsModule {}
