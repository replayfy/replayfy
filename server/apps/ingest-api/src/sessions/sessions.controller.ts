import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { CurrentUserId, CurrentWorkspaceId } from "../common/auth.context";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import { SessionsService } from "./sessions.service";
import { MobileFramesService } from "./mobile-frames.service";
import { CreateShareDto, UpdateSessionDto } from "./sessions.dto";

@Controller("v1/sessions")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class SessionsController {
  constructor(
    private readonly service: SessionsService,
    private readonly mobileFrames: MobileFramesService,
  ) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("status") status?: "LIVE" | "COMPLETED",
    @Query("device") device?: string,
    @Query("deviceModel") deviceModel?: string,
    @Query("platform") platform?: string,
    @Query("plan") plan?: string,
    @Query("browser") browser?: string,
    @Query("country") country?: string,
    @Query("hasErrors") hasErrors?: string,
    @Query("hasRage") hasRage?: string,
    @Query("hasDead") hasDead?: string,
    @Query("hasSlowLcp") hasSlowLcp?: string,
    @Query("hasLongTasks") hasLongTasks?: string,
    @Query("minDurationMs") minDurationMs?: string,
    @Query("playlistId") playlistId?: string,
    @Query("sinceMs") sinceMs?: string,
    @Query("untilMs") untilMs?: string,
    @Query("quick") quick?: "issues" | "live" | "bookmarked",
    @Query("sort") sort?: "recent" | "duration" | "errors",
    @Query("endUserId") endUserId?: string,
    // CSV of internal session ids — scopes the list to a specific set (e.g. the
    // sessions that reached a funnel step, drilled in from the funnel view).
    @Query("sessionIds") sessionIds?: string,
    // Incident id — scopes the list to the sessions currently attributed to that
    // incident ("View sessions" on an Overview signal). Named rather than a CSV
    // because an incident's session set is unbounded; the service resolves it.
    @Query("incident") incident?: string,
    // issue ("View sessions" on an issue-backed signal). Same contract as
    // `incident` above: named, server-resolved, never a CSV.
    @Query("issue") issue?: string,
    // Funnel-step drill-down ("View sessions" on a funnel step). `funnel` = the
    // saved funnel id, `fstep` = the 0-based step index; `ffrom`/`fto` carry the
    // analysed date range. Server-resolved (windowFunnel) + keyset-paged like
    // `incident`/`issue` — never a URL CSV, so it scrolls past the per-page cap.
    @Query("funnel") funnel?: string,
    @Query("fstep") fstep?: string,
    @Query("ffrom") ffrom?: string,
    @Query("fto") fto?: string,
  ) {
    return this.service.list({
      workspaceId,
      funnel,
      fstep,
      ffrom,
      fto,
      cursor,
      limit,
      search,
      status,
      playlistId,
      sinceMs,
      untilMs,
      device,
      deviceModel,
      platform,
      plan,
      browser,
      country,
      hasErrors,
      hasRage,
      hasDead,
      hasSlowLcp,
      hasLongTasks,
      minDurationMs,
      quick,
      sort,
      endUserId,
      sessionIds,
      incident,
      issue,
    });
  }

  /**
   * Recordings search autocomplete — the values that exist in this workspace,
   * grouped by kind, for the search dropdown's dynamic sections.
   *
   * MUST stay declared ABOVE `@Get(":publicId")`: Nest matches routes in
   * declaration order, so a `:publicId` above this one captures "suggest" as a
   * session id and the endpoint 404s with "Session not found".
   *
   * `groups` is a REPEATED param (?groups=user&groups=page…), not a CSV — Nest
   * yields a bare string when exactly one is present (the "browser:" value-mode
   * the dashboard uses), so all three cases are normalised to an array here.
   */
  @Get("suggest")
  suggest(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("q") q?: string,
    @Query("groups") groups?: string | string[],
  ) {
    return this.service.suggest(workspaceId, {
      q,
      groups:
        groups === undefined ? [] : Array.isArray(groups) ? groups : [groups],
    });
  }

  /**
   * The BOUNDED half of the search autocomplete — the workspace's complete
   * browser / device / country value sets, in ONE cached response per workspace
   * rather than one per keystroke. Recordings preloads it on mount and filters
   * the values client-side; the unbounded groups (user, page) stay on `suggest`.
   *
   * Takes NO `q` on purpose — a per-keystroke param is exactly what would make
   * this uncacheable again. `types` tells the caller which types this response
   * is authoritative for; anything absent from it falls back to the typeahead.
   *
   * MUST stay declared ABOVE `@Get(":publicId")`, for the same reason `suggest`
   * must: Nest matches in declaration order, so a `:publicId` above this one
   * captures "facets" as a session id and 404s with "Session not found".
   */
  @Get("facets")
  facets(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.facets(workspaceId);
  }

  @Get(":publicId")
  get(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.getByPublicId(workspaceId, publicId);
  }

  @Patch(":publicId")
  @RequiresRole("MEMBER")
  update(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Body() body: UpdateSessionDto,
  ) {
    return this.service.patchByPublicId(workspaceId, publicId, body);
  }

  @Delete(":publicId")
  @RequiresRole("ADMIN")
  remove(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.deleteByPublicId(workspaceId, publicId);
  }

  @Get(":publicId/segments")
  segments(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.listSegments(workspaceId, publicId);
  }

  // The full rrweb replay stream for the player — NOT paginated (see
  // SessionsService.listEvents). The event tab uses :publicId/timeline instead.
  @Get(":publicId/events")
  events(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.listEvents(workspaceId, publicId);
  }

  @Get(":publicId/console")
  console(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("level") level?: string,
  ) {
    return this.service.listConsole(
      workspaceId,
      publicId,
      cursor,
      limit,
      level,
    );
  }

  @Get(":publicId/network")
  network(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("status") status?: string,
    @Query("method") method?: string,
  ) {
    return this.service.listNetwork(
      workspaceId,
      publicId,
      cursor,
      limit,
      status,
      method,
    );
  }

  @Get(":publicId/errors")
  errors(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.listErrors(workspaceId, publicId, cursor, limit);
  }

  @Get(":publicId/timeline")
  timeline(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.timeline(workspaceId, publicId);
  }

  /**
   * Native-platform tap + gesture stream. Returns one row per
   * captured tap / long-press / swipe / pinch event, with the
   * widget metadata (uiClass / uiValue / uiId / uiType), bounds
   * in screen-relative pixels, sensitivity flag, gesture variant,
   * pinch scale, and the route the event fired on.
   *
   * Used by:
   *   - EventsPanel timeline (mobile sessions).
   *   - NativePlayerStage tap-marker overlay.
   *   - Tap heatmap rendering.
   *   - Per-route interaction analytics (group by route + uiId).
   */
  @Get(":publicId/taps")
  taps(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("route") route?: string,
    @Query("gesture") gesture?: string,
  ) {
    return this.service.listTaps(
      workspaceId,
      publicId,
      cursor,
      limit,
      route,
      gesture,
    );
  }

  /**
   * Custom event stream — `Replay.track()` events plus the
   * dashboard-promoted variants (bug_report / session_property /
   * session_tag / push_token / session_favorite). The `kind`
   * query param filters by variant.
   *
   * Used by:
   *   - "Recent feedback" panel (kind=bug_report)
   *   - Session header chips (kind=push_token / session_property)
   *   - Tag filter facet on session list (kind=session_tag)
   *   - EventsPanel generic timeline row for unmatched kinds
   */
  @Get(":publicId/customs")
  customs(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @Query("kind") kind?: string,
  ) {
    return this.service.listCustoms(workspaceId, publicId, cursor, limit, kind);
  }

  /**
   * Screen-navigation event stream. Each row carries the route
   * name + timestamp; the dashboard's "Screens" tab uses these to
   * render the session's navigation flow with per-screen
   * time-on-screen derived from consecutive event deltas.
   */
  @Get(":publicId/screens")
  screens(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.listScreens(workspaceId, publicId);
  }

  /**
   * Mobile (iOS / Android) replay frames archive. Returns a single
   * URL the dashboard player fetches + decompresses + walks by
   * timestamp, plus the session start (frame ts are absolute
   * epoch-ms; the player subtracts start to get playhead offsets)
   * and the image format.
   *
   * Built lazily on first request from the session's native_snapshot
   * images + cached in object storage. Returns `{ url: null }` when
   * the session has no captured frames so the player shows its
   * empty-state.
   */
  @Get(":publicId/frames")
  async frames(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    const result = await this.mobileFrames.getFrames(workspaceId, publicId);
    return result ?? { url: null, count: 0, startedAt: 0, fileFormat: "png" };
  }

  /**
   * Web vitals + long tasks + memory snapshots captured by the SDK's
   * PerformanceObserver pipeline. Returns:
   *   { lcp, cls, fid }        — last value seen for each web vital
   *   { longTasks }            — count + total blocking time + slowest task
   *   { memory }               — peak heap + a downsampled series for charting
   * All driven from the session's MongoDB batches; no extra schema cost.
   */
  @Get(":publicId/performance")
  performance(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.getPerformance(workspaceId, publicId);
  }

  /**
   * Create a public share-link for this session. Caller picks which panels
   * (events/console/network/perf/comments) the viewer can see.
   */
  @Post(":publicId/share")
  @RequiresRole("MEMBER")
  createShare(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Param("publicId") publicId: string,
    @Body() body: CreateShareDto,
  ) {
    return this.service.createShare(workspaceId, userId, publicId, body);
  }

  @Get(":publicId/shares")
  listShares(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
  ) {
    return this.service.listShares(workspaceId, publicId);
  }

  @Delete(":publicId/shares/:shareId")
  @RequiresRole("MEMBER")
  revokeShare(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("publicId") publicId: string,
    @Param("shareId") shareId: string,
  ) {
    return this.service.revokeShare(workspaceId, publicId, Number(shareId));
  }
}
