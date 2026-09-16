import { Module } from "@nestjs/common";
import { HeatmapsController } from "./heatmaps.controller";
import { HeatmapsService } from "./heatmaps.service";

@Module({
  controllers: [HeatmapsController],
  providers: [HeatmapsService],
})
export class HeatmapsModule {}
