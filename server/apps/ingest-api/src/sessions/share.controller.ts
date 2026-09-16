import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { SessionsService } from "./sessions.service";
import { MobileFramesService } from "./mobile-frames.service";

/**
 * Unauthenticated public route used by anyone holding a share token. We only
 * expose the panels the creator opted in to — the dashboard reads `panels`
 * from the resolve response and hides the rest. Subroutes return the same
 * shape as the authenticated session endpoints, but gated by the token.
 */
@Controller("v1/share")
export class ShareController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly mobileFrames: MobileFramesService,
  ) {}

  @Get(":token")
  async resolve(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException("Share link not found or expired");
    return bundle;
  }

  // Full rrweb replay stream for the shared player — NOT paginated (see
  // SessionsService.listEvents); the shared event tab uses :token/timeline.
  @Get(":token/events")
  async events(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.events) throw new NotFoundException();
    return this.sessions.listEvents(
      bundle.workspaceId,
      bundle.session.publicId,
    );
  }

  @Get(":token/console")
  async console(
    @Param("token") token: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.console) throw new NotFoundException();
    return this.sessions.listConsole(
      bundle.workspaceId,
      bundle.session.publicId,
      cursor,
      limit,
    );
  }

  @Get(":token/network")
  async network(
    @Param("token") token: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.network) throw new NotFoundException();
    return this.sessions.listNetwork(
      bundle.workspaceId,
      bundle.session.publicId,
      cursor,
      limit,
    );
  }

  @Get(":token/errors")
  async errors(
    @Param("token") token: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    // Errors back the web Performance tab (error rows) + the mobile Crashes tab,
    // so this data is only available when the sharer enabled one of them.
    if (!bundle.panels.perf && !bundle.panels.crashes) throw new NotFoundException();
    return this.sessions.listErrors(
      bundle.workspaceId,
      bundle.session.publicId,
      cursor,
      limit,
    );
  }

  @Get(":token/timeline")
  async timeline(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    // Timeline drives the Events panel — gate it on the sharer's `events` toggle,
    // exactly like /events, so a disabled panel is never fetchable by token.
    if (!bundle.panels.events) throw new NotFoundException();
    return this.sessions.timeline(bundle.workspaceId, bundle.session.publicId);
  }

  // ── Mobile share routes ───────────────────────────────────────────
  // The recording itself (frames archive) — same direct-R2 URL the authed
  // route returns. Not panel-gated: it's the session, not a side panel.
  @Get(":token/frames")
  async frames(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    const result = await this.mobileFrames.getFrames(
      bundle.workspaceId,
      bundle.session.publicId,
    );
    return result ?? { url: null, count: 0, startedAt: 0, fileFormat: "jpeg" };
  }

  @Get(":token/taps")
  async taps(
    @Param("token") token: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.events) throw new NotFoundException();
    return this.sessions.listTaps(
      bundle.workspaceId,
      bundle.session.publicId,
      cursor,
      limit,
    );
  }

  @Get(":token/customs")
  async customs(
    @Param("token") token: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.events) throw new NotFoundException();
    return this.sessions.listCustoms(
      bundle.workspaceId,
      bundle.session.publicId,
      cursor,
      limit,
    );
  }

  @Get(":token/screens")
  async screens(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.screens) throw new NotFoundException();
    return this.sessions.listScreens(bundle.workspaceId, bundle.session.publicId);
  }

  @Get(":token/performance")
  async performance(@Param("token") token: string) {
    const bundle = await this.sessions.resolveShare(token);
    if (!bundle) throw new NotFoundException();
    if (!bundle.panels.perf) throw new NotFoundException();
    return this.sessions.getPerformance(
      bundle.workspaceId,
      bundle.session.publicId,
    );
  }
}
