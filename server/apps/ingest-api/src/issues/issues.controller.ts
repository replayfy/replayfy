import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { CurrentWorkspaceId } from "../common/auth.context";
import { IssuesService } from "./issues.service";
import { SetIssueStatusDto } from "./issues.dto";

/**
 * Workspace-authed Issue reads + the human status actions (Resolve / Ignore /
 * Reopen). Every method is scoped by the JWT's workspaceId — a tenant can only
 * ever see or touch its own issues. The AI has NO path to these mutations; it
 * is read + create only.
 */
@Controller("v1/dashboard/issues")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
    @Query("behavioral") behavioral?: string,
    @Query("category") category?: string,
    @Query("search") search?: string,
    @Query("cursor") cursor?: string,
    @Query("platform") platform?: string,
    @Query("release") release?: string,
    @Query("since") since?: string,
    @Query("until") until?: string,
    @Query("sort") sort?: string,
  ) {
    return this.issues.list(workspaceId, {
      status,
      limit: limit ? Number(limit) : undefined,
      // Crashlytics segmented filter: crash | exception | error | anr | all.
      category,
      // Crashlytics free-text search + keyset cursor (infinite scroll).
      search,
      cursor,
      // Enterprise multi-filter facets (comma-separated) + "seen since" window.
      platform,
      release,
      since: since ? Number(since) : undefined,
      until: until ? Number(until) : undefined,
      // "recent" ⇒ lastSeenAt DESC (Crashlytics triage default); else rank DESC.
      sort,
      // Crashlytics passes behavioral=false (crashes & errors only); the
      // Signals surface passes behavioral=true. Omitted ⇒ both.
      behavioral:
        behavioral === "true"
          ? true
          : behavioral === "false"
            ? false
            : undefined,
    });
  }

  // MUST be declared before the ":id" route — Express matches in order, so a
  // "category-counts" / "facets" path would otherwise be captured as an id.
  @Get("category-counts")
  categoryCounts(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("status") status?: string,
    @Query("behavioral") behavioral?: string,
    @Query("search") search?: string,
    @Query("platform") platform?: string,
    @Query("release") release?: string,
    @Query("since") since?: string,
  ) {
    return this.issues.categoryCounts(workspaceId, {
      status,
      search,
      platform,
      release,
      since: since ? Number(since) : undefined,
      behavioral:
        behavioral === "true"
          ? true
          : behavioral === "false"
            ? false
            : undefined,
    });
  }

  // Distinct platform + release values for the filter dropdowns.
  @Get("facets")
  facets(@CurrentWorkspaceId() workspaceId: number) {
    return this.issues.facets(workspaceId);
  }

  // Crashes-by-version / by-platform summary for the Crashlytics header band.
  // Also declared before ":id" so "breakdown" isn't captured as an id.
  @Get("breakdown")
  breakdown(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    // Optional [from,to] epoch-ms window from the Crashlytics date-range picker.
    return this.issues.breakdown(
      workspaceId,
      from ? Number(from) : undefined,
      to ? Number(to) : undefined,
    );
  }

  // Per-category rollup (event volume + affected users) for the metric row.
  // Declared before ":id" so "stats" isn't captured as an id.
  @Get("stats")
  crashStats(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    // Optional [from,to] epoch-ms window from the Crashlytics date-range picker.
    return this.issues.crashStats(
      workspaceId,
      from ? Number(from) : undefined,
      to ? Number(to) : undefined,
    );
  }

  @Get(":id")
  detail(@CurrentWorkspaceId() workspaceId: number, @Param("id") id: string) {
    return this.issues.detail(workspaceId, Number(id));
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  setStatus(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
    @Body() body: SetIssueStatusDto,
  ) {
    return this.issues.setStatus(
      workspaceId,
      Number(id),
      body?.status ?? "RESOLVED",
    );
  }
}
