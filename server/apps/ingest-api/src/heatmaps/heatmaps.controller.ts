import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { HeatmapsService } from "./heatmaps.service";

@Controller("v1/heatmaps")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class HeatmapsController {
  constructor(private readonly service: HeatmapsService) {}

  /** Top URLs ranked by friction — used to populate the URL picker. */
  @Get("pages")
  pages(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("range") range?: string,
    @Query("limit") limit?: string,
  ) {
    const lim = Number(limit) || 12;
    return this.service.topPages(workspaceId, range, lim);
  }

  /** Heatmap blob points for a specific URL. */
  @Get()
  forUrl(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("url") url?: string,
    @Query("range") range?: string,
  ) {
    if (!url) throw new BadRequestException("url query parameter is required");
    return this.service.forUrl(workspaceId, url, range);
  }
}
