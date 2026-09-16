import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import {
  CurrentAuth,
  CurrentWorkspaceId,
  type AuthContext,
} from "../common/auth.context";
import { FunnelsService, type FunnelFilter } from "./funnels.service";
import {
  BreakdownFunnelDto,
  CreateFunnelDto,
  DropoffCohortDto,
  PreviewFunnelDto,
  TimelineFunnelDto,
  UpdateFunnelDto,
} from "./funnels.dto";

@Controller("v1/funnels")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class FunnelsController {
  constructor(private readonly service: FunnelsService) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    /** `?pinned=true` → only the pinned funnel(s). The Overview needs just that
     *  one and used to download the whole list to find it client-side. */
    @Query("pinned") pinned?: string,
    /** Name/description substring — server-side so the search sees ALL of the
     *  workspace's funnels, not only the pages the client has scrolled in. */
    @Query("search") search?: string,
  ) {
    return this.service.list(workspaceId, {
      cursor,
      limit,
      pinned: pinned === undefined ? undefined : pinned === "true",
      search,
    });
  }

  @Post()
  @RequiresRole("MEMBER")
  create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateFunnelDto,
  ) {
    return this.service.create(auth.workspaceId, auth.userId, body);
  }

  @Patch(":id")
  @RequiresRole("MEMBER")
  update(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateFunnelDto,
  ) {
    return this.service.update(workspaceId, id, body);
  }

  @Delete(":id")
  @RequiresRole("MEMBER")
  remove(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.remove(workspaceId, id);
  }

  /** Compute a saved funnel by id. Pulls steps + windowDays from the row. */
  @Get(":id/compute")
  computeSaved(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("range") range?: string,
    @Query("country") country?: string,
    @Query("device") device?: string,
    @Query("browser") browser?: string,
    @Query("plan") plan?: string,
    @Query("metric") metric?: string,
  ) {
    const filter: FunnelFilter = { country, device, browser, plan };
    return this.service.compute(workspaceId, {
      funnelId: id,
      range,
      filter,
      metric: metric === "user" ? "user" : "session",
    });
  }

  /** "What's influencing conversion" — event/property drivers & blockers for a
   *  saved funnel. `from`/`to` carry the Custom date range (else the funnel's
   *  own window). Two-segment path, so it never shadows the bare `:id` GET. */
  @Get(":id/influence")
  influence(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const f = from != null && from !== "" ? Number(from) : undefined;
    const t = to != null && to !== "" ? Number(to) : undefined;
    return this.service.computeInfluence(
      workspaceId,
      id,
      Number.isFinite(f) ? f : undefined,
      Number.isFinite(t) ? t : undefined,
    );
  }

  /** Preview count for the "create cohort from drop-off" modal — the number of
   *  DISTINCT identified users who dropped out at `stepIndex` (reached the prior
   *  step but not this one) in the funnel's window. One cheap CH aggregate;
   *  `fromTs`/`toTs` carry the Custom date range. */
  @Get(":id/dropoff-count")
  dropoffCount(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
    @Query("stepIndex") stepIndex?: string,
    @Query("fromTs") fromTs?: string,
    @Query("toTs") toTs?: string,
  ) {
    return this.service.previewDropoffCohort(
      workspaceId,
      id,
      stepIndex ? Number(stepIndex) : 0,
      fromTs ? Number(fromTs) : undefined,
      toTs ? Number(toTs) : undefined,
    );
  }

  /** Materialise a MANUAL cohort of the identified users who dropped out at
   *  `stepIndex`. A point-in-time snapshot (won't auto-update); reuses the
   *  cohort machinery. Keyset-drained from ClickHouse, never a whole-set fetch. */
  @Post(":id/dropoff-cohort")
  @RequiresRole("MEMBER")
  dropoffCohort(
    @CurrentAuth() auth: AuthContext,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: DropoffCohortDto,
  ) {
    return this.service.createDropoffCohort(auth.workspaceId, auth.userId, id, {
      stepIndex: body.stepIndex,
      name: body.name,
      description: body.description,
      fromTs: body.fromTs,
      toTs: body.toTs,
    });
  }

  /** Compute an ad-hoc funnel from a body of steps — used by the builder's
   * live preview pane so analysts see numbers before saving. Body's
   * `filter` scopes the compute to a segment (country/device/etc); the
   * dashboard calls this once per series when "Compare with..." is on. */
  @Post("preview")
  preview(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: PreviewFunnelDto,
  ) {
    return this.service.compute(workspaceId, {
      steps: body?.steps ?? [],
      range: body?.range,
      windowDays: body?.windowDays,
      filter: body?.filter,
      fromTs: body?.fromTs,
      toTs: body?.toTs,
      metric: body?.metric,
    });
  }

  /** List distinct custom-property keys that ANY EndUser in the workspace
   * has set (via `replay.identify(distinctId, { plan: 'pro', ... })`).
   * Powers the "User attributes" sub-picker in the Funnels filter menu —
   * the dashboard discovers the keys here, then renders them as options
   * instead of forcing the user to type a key name from memory. */
  @Get("attribute-keys")
  attributeKeys(@CurrentWorkspaceId() workspaceId: number) {
    return this.service.discoverAttributeKeys(workspaceId);
  }

  /** Distinct values seen for a given customProps key in this workspace.
   * Used by the value picker step in the User attributes sub-picker.
   * `q` is an optional case-insensitive substring filter so the picker
   * stays usable when a key has many distinct values. */
  @Get("attribute-values")
  attributeValues(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("key") key: string,
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ) {
    return this.service.discoverAttributeValues(workspaceId, key, { q, limit });
  }

  /** Filter-value autocomplete for a fixed session dimension (browser, os,
   * country, browserVersion, urlPath, plan, user, utm, …). Returns the distinct
   * values matching `q` seen in this workspace's sessions, most-common first. */
  @Get("suggest")
  suggest(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("field") field: string,
    @Query("q") q?: string,
  ) {
    return this.service.suggestValues(workspaceId, field ?? "", q);
  }

  /** Step-value autocomplete for the builder — distinct values seen for a step
   * KIND (custom event name, page URL, screen, click text) in this workspace,
   * most-common first. Reads the SAME `session_events` column the step matches
   * on, so the picker and the windowFunnel computation agree. `windowDays`
   * (default 90) bounds the lookback. */
  @Get("step-suggest")
  stepSuggest(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("kind") kind: string,
    @Query("q") q?: string,
    @Query("windowDays") windowDays?: string,
  ) {
    return this.service.suggestStepValues(
      workspaceId,
      kind ?? "page",
      q,
      windowDays ? Number(windowDays) : undefined,
    );
  }

  /** Daily-bucketed conversion timeline — drives the "Conversion over
   * time" view-mode. Same step + filter inputs as `preview`, with
   * optional `fromTs`/`toTs` for the Custom date range picker. */
  @Post("timeline")
  timeline(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: TimelineFunnelDto,
  ) {
    return this.service.computeTimeline(workspaceId, {
      funnelId: body?.funnelId,
      steps: body?.steps,
      range: body?.range,
      filter: body?.filter,
      fromTs: body?.fromTs,
      toTs: body?.toTs,
      metric: body?.metric,
    });
  }

  /** Funnel conversion split by a dimension (the reference's breakdown).
   * `dimension` defaults to "release" — the only denormalized dimension on
   * the events table today — so the dashboard can answer "did this release
   * change conversion through the flow?". Same step + filter inputs as
   * `timeline`/`preview`; `topN` caps the returned buckets. */
  @Post("breakdown")
  breakdown(
    @CurrentWorkspaceId() workspaceId: number,
    @Body() body: BreakdownFunnelDto,
  ) {
    return this.service.breakdown(workspaceId, {
      funnelId: body?.funnelId,
      steps: body?.steps,
      range: body?.range,
      windowDays: body?.windowDays,
      filter: body?.filter,
      fromTs: body?.fromTs,
      toTs: body?.toTs,
      dimension: body?.dimension,
      topN: body?.topN,
      metric: body?.metric,
    });
  }

  /** Fetch a saved funnel by numeric id. Declared LAST on purpose: this
   * single-segment `:id` GET (with ParseIntPipe) would otherwise shadow every
   * static GET above it — Express matches in declaration order, so a request to
   * `/funnels/suggest` (or attribute-keys / attribute-values / step-suggest)
   * matched here first and 400'd on the non-numeric id. Keep it below the static
   * routes. `:id/compute` (two segments) and PATCH/DELETE `:id` don't conflict. */
  @Get(":id")
  get(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.get(workspaceId, id);
  }
}
