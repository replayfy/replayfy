import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { countryFilterToIso2 } from "../common/geo";
import {
  funnelStages,
  funnelTimeline,
  funnelBreakdown,
  FUNNEL_BREAKDOWN_COLUMNS,
  FUNNEL_BREAKDOWN_SESSION_COLUMNS,
  suggestSessionValues,
  suggestFunnelStepValues,
  funnelStepDropoffUserIds,
  funnelStepDropoffUserCount,
  funnelInfluence,
  type FunnelSegment,
  type SegmentCond,
} from "@replay/db-clickhouse";
import { CohortsService } from "../cohorts/cohorts.service";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";

/**
 * Funnels — an ordered list of steps. The compute endpoint counts how many
 * sessions in a date window hit each step *in order*, via ClickHouse
 * `windowFunnel` over `session_events` (the reference's set-based approach —
 * one grouped pass, scales to millions, no in-Node session walk). Drop-off
 * percentage is the gap between adjacent steps; per-issue phi-correlation
 * (`significanceFromContingency`) surfaces what drives the drop.
 *
 * Steps span web (page/click/event) and native (tap/screen) — see
 * FunnelStepKind. Each kind maps to a `session_events` column (route /
 * ui_value / message) inside db-clickhouse's `funnelStages` / `funnelTimeline`.
 * A segment filter is resolved to session ids in Postgres first, then the CH
 * funnel is scoped to them; with no filter the funnel is pure ClickHouse.
 */

export type FunnelStepMatch = "contains" | "equals" | "startsWith" | "regex";

/**
 * Step kinds — match the three step categories.
 *
 *   page  → URL of any visited page (matchType acts on the URL string)
 *   click → text content of a clicked element (rage/dead clicks carry a
 *           `selector` that includes button/link text fragments)
 *   event → name of a custom event the SDK forwarded (e.g. "form-submitted").
 *           Wired end-to-end: the SDK's `replay.track(name)` emits a custom
 *           event; ingest writes it to `session_events` (kind='custom',
 *           message=name); a funnel event step matches the `message` column
 *           inside `windowFunnel`, so it can sit between two page steps in the
 *           ordered sequence.
 */
// page/click/event are web; tap/screen are mobile (the reference's
// CLICK_MOBILE → taps, VIEW_MOBILE → views). `event` (custom) is cross-platform.
export type FunnelStepKind = "page" | "click" | "event" | "tap" | "screen";

export interface FunnelStep {
  name: string;
  kind?: FunnelStepKind; // defaults to "page" for back-compat
  matchType: FunnelStepMatch;
  value: string;
}

/**
 * Optional segment filter applied to the SESSION before walking steps.
 * Mirrors the filter set on the Recordings page so analysts can reuse
 * the same mental model across both surfaces.
 *
 *   EndUser-side: country, device, browser, os, plan, city
 *   Session-side: hasErrors, hasRage, hasDead, minDurationMs, startUrl
 */
export interface FunnelFilter {
  country?: string;
  device?: string;
  browser?: string;
  /// Browser version (web UA). Exact/starts-with match on EndUser.browserVersion.
  browserVersion?: string;
  os?: string;
  /// OS version (web UA / mobile SDK). Match on EndUser.osVersion.
  osVersion?: string;
  /// Landing path (pathname of the session's start URL).
  urlPath?: string;
  plan?: string;
  city?: string;
  /// Geo region / state (EndUser.state, derived from IP).
  state?: string;
  /// Identified user id — exact match on EndUser.distinctId.
  userId?: string;
  /// Anonymous/device id (Session.anonymousId) — links a user's pre-identify
  /// sessions. Exact match by default.
  anonymousId?: string;
  /// Capture platform: "web" (Session.platform null) | "ios" | "android".
  /// Case-insensitive — the dashboard sends "Web" / "iOS" / "Android".
  platform?: string;
  /// Entry-URL UTM campaign params (Session.utm* columns).
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  /// Web build/revision id (Session.revId).
  revId?: string;
  hasErrors?: boolean;
  hasRage?: boolean;
  hasDead?: boolean;
  minDurationMs?: number;
  startUrlContains?: string;
  // Path-class filters from the filter menu. All operate on the
  // existing `Session.startUrl` / `Session.entryReferrer` columns —
  // no new ingest required.
  landingPage?: string; // alias of startUrlContains, kept for clarity
  exitPage?: string; // reserved — needs a denormalised exitUrl; not wired
  referrerUrl?: string; // contains-match on entryReferrer
  // Session attributes. `newReturning` is derived from EndUser.firstSeenAt
  // compared against Session.startedAt (returning = firstSeen ≥ 5min
  // before the session started). Numeric comparators on pageCount /
  // errorCount come straight off the Session row.
  newReturning?: "New" | "Returning";
  pageCount?: number; // sessions with `pageCount >=` this value
  errorCount?: number; // sessions with `errorCount >=` this value
  /**
   * Custom user-attribute filters discovered from the EndUser.customProps
   * JSON column (set via the SDK's `replay.identify(distinctId, props)`).
   * Each entry is ANDed; values are matched against the JSON value at
   * the given top-level key. `op` defaults to "equals" for stable
   * categorical attributes (plan, role) and "contains" for free-text
   * ones (email fragments etc.).
   *
   * Example: `[{ key: "plan", op: "equals", value: "pro" }]` →
   *   `EndUser.customProps -> 'plan' = 'pro'`
   */
  userAttributes?: Array<{
    key: string;
    op?: "equals" | "contains";
    value: string;
  }>;
  /**
   * Per-field operator override, keyed by the filter field name (country,
   * browser, startUrlContains, minDurationMs, …). Values: is | isNot | contains
   * | notContains | startsWith | endsWith | regex | gt | gte | lt | lte | isAny
   * | isUndefined. Absent → each field's sensible default (text=is, url=contains,
   * numeric=gte). Lets the dashboard express "Country is not US", "URL starts
   * with /app", etc.
   */
  operators?: Record<string, string>;
}

const MAX_STEPS = 10;
const RANGE_DAYS: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

@Injectable()
export class FunnelsService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly stats: WorkspaceStatsService,
    private readonly cohorts: CohortsService,
  ) {}

  /**
   * A workspace's funnels, pinned first. `pinned: true` narrows to just the
   * pinned one(s) — the Overview needs ONLY that, and used to read the whole
   * list and `.find(f => f.pinned)` in the browser, i.e. download every funnel
   * in the workspace to render one card.
   *
   * Access pattern: the filter rides the existing @@index([workspaceId, pinned])
   * — a range scan bounded to one workspace's pinned rows, no scan, no sort on
   * the pinned leg. Unfiltered reads keep the previous keyset behaviour.
   */
  async list(
    workspaceId: number,
    opts: {
      cursor?: string;
      limit?: string;
      pinned?: boolean;
      search?: string;
    },
  ) {
    const take = parseLimit(opts.limit, 25, 100);
    const cursorId = decodeCursor(opts.cursor);
    const rows = await this.db.funnel.findMany({
      where: {
        workspaceId,
        ...(opts.pinned !== undefined ? { pinned: opts.pinned } : {}),
        // Name/description search. Funnels are user-authored dashboards — a
        // workspace has dozens, not millions — so the ILIKE rides the existing
        // @@index([workspaceId, ...]) workspace scope and filters the bounded
        // set in memory; no trigram index needed (unlike EndUser/Session).
        ...(opts.search
          ? {
              OR: [
                { name: { contains: opts.search, mode: "insensitive" } },
                {
                  description: {
                    contains: opts.search,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : {}),
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      include: { owner: { select: { id: true, name: true, email: true } } },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((f) => this.toSummary(f)),
      nextCursor,
    );
  }

  async create(
    workspaceId: number,
    userId: number,
    body: {
      name: string;
      description?: string;
      steps: FunnelStep[];
      windowDays?: number;
      /** "Pin to dashboard" at create time. The dashboard has always sent this;
       *  create silently dropped it (only update honoured it), so pinning a NEW
       *  funnel toasted success and saved pinned=false — and the Overview, which
       *  renders the pinned funnel, never saw it until you re-toggled. */
      pinned?: boolean;
      /** The segment scope — same story as pinned was: the builder posted it to
       *  /preview so the numbers were right, then create dropped it and toasted
       *  success, so the saved funnel silently computed a DIFFERENT population. */
      filter?: FunnelFilter;
      /** Set by the assistant's `funnel.create` capability — provenance only, so
       *  the UI can badge it "Created with Replayfy AI". User-made funnels omit it. */
      createdByAi?: boolean;
    },
  ) {
    this.assertValidSteps(body.steps);
    const row = await this.db.funnel.create({
      data: {
        workspaceId,
        ownerId: userId,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        steps: body.steps as unknown as Prisma.InputJsonValue,
        windowDays:
          body.windowDays && Number.isFinite(body.windowDays)
            ? Math.max(1, Math.min(90, body.windowDays))
            : 7,
        pinned: body.pinned === true,
        createdByAi: body.createdByAi === true,
        // Empty filter object stores as SQL null — an unfiltered funnel, not a
        // funnel filtered by nothing (JSON columns need DbNull, not JS null).
        filter: this.normalizeFilter(body.filter) ?? Prisma.DbNull,
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    this.stats.bump(workspaceId, { funnelsTotal: 1 }).catch(() => {});
    return this.toSummary(row);
  }

  async get(workspaceId: number, id: number) {
    const row = await this.db.funnel.findFirst({
      where: { id, workspaceId },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    if (!row) throw new NotFoundException("Funnel not found");
    return this.toSummary(row);
  }

  async update(
    workspaceId: number,
    id: number,
    body: {
      name?: string;
      description?: string;
      steps?: FunnelStep[];
      pinned?: boolean;
      windowDays?: number;
      /** null clears the segment; undefined leaves the stored one untouched. */
      filter?: FunnelFilter | null;
    },
  ) {
    await this.assertExists(workspaceId, id);
    if (body.steps) this.assertValidSteps(body.steps);
    const row = await this.db.funnel.update({
      where: { id },
      data: {
        name: body.name?.trim(),
        description: body.description?.trim(),
        steps: body.steps
          ? (body.steps as unknown as Prisma.InputJsonValue)
          : undefined,
        pinned: body.pinned,
        windowDays:
          body.windowDays != null
            ? Math.max(1, Math.min(90, body.windowDays))
            : undefined,
        // undefined => Prisma leaves the column as-is; null or {} => clear it.
        filter:
          body.filter === undefined
            ? undefined
            : (this.normalizeFilter(body.filter) ?? Prisma.DbNull),
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });
    return this.toSummary(row);
  }

  async remove(workspaceId: number, id: number) {
    await this.assertExists(workspaceId, id);
    await this.db.funnel.delete({ where: { id } });
    this.stats.bump(workspaceId, { funnelsTotal: -1 }).catch(() => {});
    return { id };
  }

  /**
   * Compute conversion + drop-off for a saved funnel. The math:
   *
   *   for each session in [now - windowDays, now]
   *     walk its ordered paths
   *     find the first path matching step 0; if found, the session
   *     "entered" step 0
   *     scan forward for step 1, …, step N
   *     bump counters[k] for the highest k reached
   *
   * Returns: { step, name, count, conversionPct (vs step 0),
   *            stepConversionPct (vs prior step), dropOffPct (vs prior) }
   *
   * Sessions param lets the caller compute against an ad-hoc step list
   * (used by the live preview in the funnel builder).
   */
  async compute(
    workspaceId: number,
    opts: {
      funnelId?: number;
      steps?: FunnelStep[];
      range?: string;
      windowDays?: number;
      filter?: FunnelFilter;
      // Optional explicit window in epoch-ms. When set, `range` and
      // `windowDays` are ignored — the funnel walks sessions started
      // strictly within [fromTs, toTs]. Used by the dashboard's
      // "Custom" date range picker.
      fromTs?: number;
      toTs?: number;
      // Count unit: "session" (default) or "user" — distinct identified users
      // through the flow (the reference's MetricFormatUserCount; anonymous
      // sessions excluded).
      metric?: "session" | "user";
    },
  ) {
    let steps: FunnelStep[];
    let windowDays: number;
    let name: string | null = null;
    // A saved funnel's own segment. It is the BASE for the compute — the funnel
    // is defined by its filter as much as its steps (see the reference: filter
    // and steps live in the same object). An explicit request filter overrides
    // it per-key, which is what lets the builder segment a saved funnel ad-hoc
    // without mutating it; the Overview sends no filter, so it gets exactly the
    // saved segment. Was the bug: the Overview computed pinned funnels UNfiltered.
    let storedFilter: FunnelFilter | undefined;
    if (opts.funnelId) {
      const f = await this.db.funnel.findFirst({
        where: { id: opts.funnelId, workspaceId },
      });
      if (!f) throw new NotFoundException("Funnel not found");
      steps = f.steps as unknown as FunnelStep[];
      windowDays = f.windowDays;
      name = f.name;
      storedFilter = (f.filter as FunnelFilter | null) ?? undefined;
    } else {
      if (!opts.steps?.length)
        throw new ForbiddenException("steps or funnelId required");
      steps = opts.steps;
      windowDays = opts.windowDays ?? RANGE_DAYS[opts.range ?? "7d"] ?? 7;
    }
    if (opts.range) windowDays = RANGE_DAYS[opts.range] ?? windowDays;

    this.assertValidSteps(steps);

    // Custom from/to takes priority over rolling windows. Untils the
    // user picks one, fall back to a rolling N-day window.
    const useCustom = opts.fromTs && opts.toTs && opts.toTs > opts.fromTs;
    const since = useCustom
      ? new Date(opts.fromTs!)
      : new Date(Date.now() - windowDays * 86_400_000);
    const until = useCustom ? new Date(opts.toTs!) : null;

    // Every filter dimension is denormalised onto `replay.sessions`, so the whole
    // funnel — including the segment filter — is pure ClickHouse: one grouped
    // windowFunnel over `session_events`, INNER JOINed to the per-session
    // `replay.sessions` for filtering (the reference's approach). No Postgres,
    // no id cap — scales to millions.
    const effectiveFilter = FunnelsService.mergeFilter(storedFilter, opts.filter);
    const segment = FunnelsService.toSegment(
      effectiveFilter,
      steps,
      since.getTime(),
    );

    const windowMs = until
      ? until.getTime() - since.getTime()
      : windowDays * 86_400_000;
    const fn = await funnelStages({
      workspaceId,
      steps: steps.map((s) => ({
        kind: s.kind ?? "page",
        matchType: s.matchType,
        value: s.value,
      })),
      windowMs,
      sinceMs: since.getTime(),
      untilMs: until ? until.getTime() : undefined,
      segment,
      metric: opts.metric === "user" ? "user" : "session",
    });

    const counts = fn.stages;
    const startedFunnel = fn.entered; // reached step 0 — the reference baseline
    const reachedZero = counts[0] || 1;
    const result = steps.map((step, k) => {
      const prev = k === 0 ? reachedZero : counts[k - 1] || 1;
      const count = counts[k] ?? 0;
      return {
        index: k,
        name: step.name,
        kind: step.kind ?? "page",
        matchType: step.matchType,
        value: step.value,
        count,
        // Bar as a % of step 0 and of the previous step — the dashboard picks.
        conversionPct: Number(((count / reachedZero) * 100).toFixed(1)),
        stepConversionPct: Number(((count / prev) * 100).toFixed(1)),
        dropOffPct:
          k === 0 ? 0 : Number((((prev - count) / prev) * 100).toFixed(1)),
        // Time to reach this step from the PREVIOUS one (ms) — real now, derived
        // in the funnelStages pass (transitions[k-1]). `avgTimeToReachMs` kept for
        // back-compat; median/p95 + sample size are the honest new fields. null on
        // step 0 (no prior) or empty sample → the UI renders "—", never a fake 0.
        avgTimeToReachMs: (k === 0 ? null : fn.transitions[k - 1]?.avgMs) ?? 0,
        medianTimeToReachMs:
          k === 0 ? null : fn.transitions[k - 1]?.p50Ms ?? null,
        p95TimeToReachMs: k === 0 ? null : fn.transitions[k - 1]?.p95Ms ?? null,
        timeSampleSize: k === 0 ? 0 : fn.transitions[k - 1]?.n ?? 0,
      };
    });

    // Overall conversion = sessions that reached the LAST step / entered.
    const lastCount = counts[counts.length - 1] ?? 0;
    const overallConversionPct =
      startedFunnel > 0
        ? Number(((lastCount / startedFunnel) * 100).toFixed(2))
        : 0;
    const insights = FunnelsService.significanceFromContingency(
      fn.entered,
      fn.dropped,
      fn.issues,
    );

    return {
      funnelId: opts.funnelId ?? null,
      name,
      windowDays,
      // "session" or "user" — what startedFunnel / counts are measured in.
      metric: opts.metric === "user" ? "user" : "session",
      startedFunnel,
      overallConversionPct,
      // Real entry→last-step time for converters (ms). median/p95 + sample size
      // are the honest fields; null when no one converted → UI shows "—".
      avgTimeToConvertMs: fn.convertTime.avgMs ?? 0,
      medianTimeToConvertMs: fn.convertTime.p50Ms ?? null,
      p95TimeToConvertMs: fn.convertTime.p95Ms ?? null,
      convertTimeSampleSize: fn.convertTime.n,
      totalSessions: fn.totalSessions,
      steps: result,
      // In user mode these are the session ids of the users who reached the
      // stage, so the recordings drill-down scopes to those users.
      dropOffSessionIds: fn.exampleIds,
      // Which issues correlate with drop-off (the reference's significance).
      insights,
    };
  }

  /**
   * "What's influencing conversion" — the events and person-properties most
   * correlated with COMPLETING this funnel (drivers) vs dropping out (blockers).
   * Reuses the funnel's saved steps + segment (resolveDropoffScope) and the CH
   * `funnelInfluence` two-pass query, then scores each candidate with a SIGNED
   * 2×2 phi (unlike the issue insights' [0,1]-clamped phi, so positive lifts —
   * drivers — surface too). Issue-kind factors are NOT returned here; the FE
   * keeps folding those from `insights.significant` on the compute endpoint.
   */
  async computeInfluence(
    workspaceId: number,
    funnelId: number,
    from?: number,
    to?: number,
  ) {
    const scope = await this.resolveDropoffScope(workspaceId, funnelId, from, to);
    const infl = await funnelInfluence({
      workspaceId,
      steps: scope.chSteps,
      windowMs: scope.windowMs,
      sinceMs: scope.sinceMs,
      untilMs: scope.untilMs,
      segment: scope.segment,
    });
    const baselinePct = infl.entered > 0 ? infl.converted / infl.entered : 0;
    const factors = infl.features
      .map((feat) => {
        const stat = FunnelsService.influenceStat(
          infl.entered,
          infl.converted,
          feat.withTotal,
          feat.withConv,
        );
        // require a meaningful lift AND statistical significance (t > 1.96) — a
        // guard against the many-candidate false positives a raw scan invites.
        if (!stat || Math.abs(stat.lift) < 0.03 || stat.t <= 1.96) return null;
        const dir: "driver" | "blocker" = stat.lift > 0 ? "driver" : "blocker";
        const label =
          feat.kind === "property"
            ? `${FunnelsService.influencePropLabel(feat.prop ?? "")} is ${feat.value}`
            : feat.label;
        return {
          id: `${feat.kind}:${feat.prop ?? ""}:${feat.label}`,
          label,
          kind: feat.kind,
          icon: feat.kind === "event" ? "cursor" : "user",
          dir,
          withPct: stat.convWith,
          withoutPct: stat.convWithout,
          // significance (t) gates inclusion; the bar tracks the lift MAGNITUDE
          // (what the panel visually compares), not the raw phi coefficient.
          strength: Math.round(Math.max(6, Math.min(96, Math.abs(stat.lift) * 190))),
          confidence: stat.t > 3.29 ? "High" : "Medium",
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const byStrength = (a: { strength: number }, b: { strength: number }) =>
      b.strength - a.strength;
    return {
      drivers: factors.filter((f) => f.dir === "driver").sort(byStrength).slice(0, 8),
      blockers: factors.filter((f) => f.dir === "blocker").sort(byStrength).slice(0, 8),
      baselinePct,
      sessions: infl.entered,
    };
  }

  /**
   * Resolve a SAVED funnel to everything the drop-off queries need: its steps,
   * the CH windowFunnel window, the analysed since/until window (a custom
   * from/to overrides the rolling windowDays), and its stored segment. Shared by
   * the drop-off cohort preview + materialiser so the two always agree with the
   * funnel the user is looking at.
   */
  private async resolveDropoffScope(
    workspaceId: number,
    funnelId: number,
    from?: number,
    to?: number,
  ) {
    const f = await this.db.funnel.findFirst({
      where: { id: funnelId, workspaceId },
    });
    if (!f) throw new NotFoundException("Funnel not found");
    const steps = f.steps as unknown as FunnelStep[];
    this.assertValidSteps(steps);
    const storedFilter = (f.filter as FunnelFilter | null) ?? undefined;
    const windowDays = f.windowDays;
    const useCustom = !!(from && to && to > from);
    const since = useCustom
      ? new Date(from!)
      : new Date(Date.now() - windowDays * 86_400_000);
    const until = useCustom ? new Date(to!) : null;
    const windowMs = until
      ? until.getTime() - since.getTime()
      : windowDays * 86_400_000;
    const segment = FunnelsService.toSegment(storedFilter, steps, since.getTime());
    const chSteps = steps.map((s) => ({
      kind: s.kind ?? "page",
      matchType: s.matchType,
      value: s.value,
    }));
    const rangeLabel = useCustom
      ? `${since.toISOString().slice(0, 10)} → ${until!.toISOString().slice(0, 10)}`
      : `last ${windowDays}d`;
    return {
      name: f.name,
      steps,
      chSteps,
      segment,
      windowMs,
      sinceMs: since.getTime(),
      untilMs: until ? until.getTime() : undefined,
      rangeLabel,
    };
  }

  /**
   * Cheap preview count for the "create cohort from drop-off" modal — the number
   * of DISTINCT identified users who dropped out at step `stepIndex` (reached the
   * previous step but not this one), in the funnel's window/segment. One CH
   * aggregate, never materialises ids. `stepIndex` is 1-based-meaningful (a
   * drop-off is a transition OUT of the prior step); 0 or out-of-range → 0.
   */
  async previewDropoffCohort(
    workspaceId: number,
    funnelId: number,
    stepIndex: number,
    from?: number,
    to?: number,
  ) {
    const scope = await this.resolveDropoffScope(workspaceId, funnelId, from, to);
    const k = Math.floor(stepIndex);
    if (!(k >= 1 && k < scope.steps.length)) {
      return { count: 0, step: null, funnel: scope.name };
    }
    const count = await funnelStepDropoffUserCount({
      workspaceId,
      steps: scope.chSteps,
      windowMs: scope.windowMs,
      sinceMs: scope.sinceMs,
      untilMs: scope.untilMs,
      dropAtStep: k,
      segment: scope.segment,
    });
    return {
      count,
      step: scope.steps[k]?.name ?? `step ${k + 1}`,
      funnel: scope.name,
    };
  }

  /**
   * Materialise a MANUAL cohort of the identified users who dropped out at step
   * `stepIndex`. A snapshot (MANUAL) on purpose: it is point-in-time by nature
   * ("who dropped in this window"), and — being MANUAL — is invisible to the
   * cohort precompute crons, so nothing ever recomputes/clobbers it. Droppers are
   * drained from ClickHouse by keyset cursor (never one giant fetch), mapped to
   * EndUser ids with ONE set-based query per page, and inserted in bulk. Anonymous
   * droppers are excluded (no EndUser row → not cohort-able). A hard cap bounds a
   * pathological funnel; when hit we return `capped:true` rather than silently
   * dropping rows.
   */
  async createDropoffCohort(
    workspaceId: number,
    userId: number,
    funnelId: number,
    opts: {
      stepIndex: number;
      name?: string;
      description?: string;
      fromTs?: number;
      toTs?: number;
    },
  ) {
    const scope = await this.resolveDropoffScope(
      workspaceId,
      funnelId,
      opts.fromTs,
      opts.toTs,
    );
    const k = Math.floor(opts.stepIndex);
    if (!(k >= 1 && k < scope.steps.length)) {
      throw new ForbiddenException("stepIndex out of range for this funnel");
    }
    const stepName = scope.steps[k]?.name?.trim() || `step ${k + 1}`;
    const name =
      opts.name?.trim() || `Dropped at "${stepName}" · ${scope.name}`;
    const description =
      opts.description?.trim() ||
      `Identified users who reached step ${k} but not step ${k + 1} of "${scope.name}" (${scope.rangeLabel}).`;
    const cohort = await this.cohorts.create(workspaceId, userId, {
      name,
      description,
      kind: "MANUAL",
    });

    // Keyset-drain the droppers (cursor on user_id), page-map distinctId→EndUser
    // id with one set-based query, bulk-insert. No await-in-a-loop of per-row
    // work; no whole-set fetch. Cap bounds a pathological funnel — surfaced, not
    // silent (standing rule: never silently drop past a cap).
    const PAGE = 5_000;
    const CAP = 100_000;
    let afterId: string | undefined;
    let membersAdded = 0;
    let capped = false;
    for (;;) {
      const distinctIds = await funnelStepDropoffUserIds({
        workspaceId,
        steps: scope.chSteps,
        windowMs: scope.windowMs,
        sinceMs: scope.sinceMs,
        untilMs: scope.untilMs,
        dropAtStep: k,
        limit: PAGE + 1,
        afterId,
        segment: scope.segment,
      });
      const pageIds = distinctIds.slice(0, PAGE);
      if (pageIds.length === 0) break;
      const users = await this.db.endUser.findMany({
        where: { workspaceId, distinctId: { in: pageIds } },
        select: { id: true },
      });
      if (users.length) {
        // recount:false — the growing membersCount is refreshed ONCE after the
        // drain (recountMembers below), not re-counted on every page.
        const res = await this.cohorts.addMembers(
          workspaceId,
          cohort.id,
          users.map((u) => u.id),
          { recount: false },
        );
        membersAdded += res.added ?? 0;
      }
      // Fewer than a full page came back → nothing left to drain.
      const hasMore = distinctIds.length > PAGE;
      // Only "capped" when there's genuinely more to drain — a set that lands
      // exactly at CAP with nothing left wasn't truncated.
      if (membersAdded >= CAP && hasMore) {
        capped = true;
        break;
      }
      if (!hasMore) break;
      afterId = pageIds[pageIds.length - 1];
    }

    if (membersAdded === 0) {
      // Every dropper was anonymous / forgotten / not-yet-mirrored, so none map
      // to an EndUser — don't leave a stranded empty cohort behind.
      await this.db.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
      throw new ForbiddenException(
        "No identified users dropped at this step to add to a cohort.",
      );
    }
    // One membersCount refresh for the whole drain (not per page).
    await this.cohorts.recountMembers(workspaceId, cohort.id);
    return {
      cohortId: cohort.id,
      name,
      step: stepName,
      membersAdded,
      capped,
    };
  }

  // FunnelFilter field → (sessions column, default operator). The dashboard can
  // override the operator per field via `filter.operators[field]` (is/isNot/
  // contains/startsWith/regex/gt/lt/…). `startUrlContains`/`landingPage` collapse
  // to `start_url`; numeric fields default to `gte` (a numeric floor).
  private static readonly FIELD_COL: Record<
    string,
    { column: string; defaultOp: SegmentCond["op"] }
  > = {
    country: { column: "country", defaultOp: "is" },
    browser: { column: "browser", defaultOp: "is" },
    browserVersion: { column: "browser_version", defaultOp: "is" },
    os: { column: "os", defaultOp: "is" },
    osVersion: { column: "os_version", defaultOp: "is" },
    urlPath: { column: "start_path", defaultOp: "is" },
    device: { column: "device", defaultOp: "is" },
    state: { column: "state", defaultOp: "is" },
    city: { column: "city", defaultOp: "is" },
    plan: { column: "plan", defaultOp: "is" },
    userId: { column: "user_id", defaultOp: "is" },
    anonymousId: { column: "anonymous_id", defaultOp: "is" },
    revId: { column: "release", defaultOp: "is" },
    utmSource: { column: "utm_source", defaultOp: "is" },
    utmMedium: { column: "utm_medium", defaultOp: "is" },
    utmCampaign: { column: "utm_campaign", defaultOp: "is" },
    referrerUrl: { column: "referrer", defaultOp: "contains" },
    minDurationMs: { column: "duration_ms", defaultOp: "gte" },
    pageCount: { column: "pages_count", defaultOp: "gte" },
    errorCount: { column: "errors_count", defaultOp: "gte" },
  };

  /**
   * Translate a FunnelFilter into a CH `FunnelSegment` (applied via the
   * `replay.sessions` JOIN) — every dimension is denormalised onto that table,
   * so the funnel is always pure ClickHouse (no Postgres, no id cap). Each filter
   * becomes a `SegmentCond` with an operator (from `filter.operators[field]`, or
   * the field default). `sinceMs` resolves new-vs-returning; mobile funnels
   * restrict to native platforms so even an unfiltered mobile funnel stays
   * pure-CH. (`exitPage` isn't wired anywhere.)
   */
  /** An empty or all-blank filter stores as null — "unfiltered", not "filtered
   *  by nothing". Drops keys whose value is undefined/null/"" so a chip the user
   *  cleared doesn't persist as a dead constraint. Returns null when nothing
   *  survives, which the column stores and toSummary reads back as null. */
  private normalizeFilter(
    filter: FunnelFilter | null | undefined,
  ): Prisma.InputJsonValue | null {
    if (!filter) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined || v === null || v === "") continue;
      // Nested maps the compute understands (operators, userAttributes) pass
      // through when non-empty.
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
        continue;
      out[k] = v;
    }
    return Object.keys(out).length ? (out as Prisma.InputJsonValue) : null;
  }

  /** The saved segment is the base; request keys override it one at a time. So
   *  the Overview (no request filter) computes the saved segment exactly, while
   *  the builder can narrow a saved funnel ad-hoc without persisting the change.
   *  A per-key merge, not object-replace: passing `country` shouldn't wipe a
   *  saved `device`. */
  private static mergeFilter(
    base: FunnelFilter | undefined,
    override: FunnelFilter | undefined,
  ): FunnelFilter | undefined {
    if (!base) return override;
    if (!override) return base;
    const merged: FunnelFilter = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined || v === null || v === "") continue;
      (merged as Record<string, unknown>)[k] = v;
    }
    return merged;
  }

  // Public so the funnel-step drill-down (incident-scope.resolveFunnelStepSessionIds,
  // used by "View sessions" on a funnel step) can apply the SAME saved segment the
  // compute uses — otherwise the drill-down returned every step-hitter, ignoring the
  // funnel's saved filter. Pure/static: no instance state, no DI.
  static toSegment(
    filter: FunnelFilter | undefined,
    steps: FunnelStep[],
    sinceMs: number,
  ): FunnelSegment {
    const segment: FunnelSegment = {};
    const isMobile = steps.some((s) => s.kind === "tap" || s.kind === "screen");
    if (filter?.platform) segment.platformIn = [filter.platform];
    else if (isMobile) segment.platformIn = ["ios", "android"];

    if (!filter) return segment;

    const conditions: SegmentCond[] = [];
    const opFor = (field: string, def: SegmentCond["op"]): SegmentCond["op"] =>
      (filter.operators?.[field] as SegmentCond["op"]) ?? def;
    const f = filter as unknown as Record<string, unknown>;
    for (const [field, meta] of Object.entries(FunnelsService.FIELD_COL)) {
      const raw = f[field];
      if (raw == null || raw === "") continue;
      // Country pickers send the display name ("Nigeria"); the denormalised
      // ClickHouse column stores the ISO-2 code ("NG"). Normalise so the
      // segment match hits — everything else passes through untouched.
      const v = field === "country" ? countryFilterToIso2(String(raw)) : raw;
      conditions.push({
        column: meta.column,
        op: opFor(field, meta.defaultOp),
        values: [String(v)],
      });
    }
    // Landing-page chip is an alias of startUrlContains; both → start_url.
    const url = filter.landingPage ?? filter.startUrlContains;
    if (url)
      conditions.push({
        column: "start_url",
        op: opFor("startUrlContains", "contains"),
        values: [url],
      });
    // Boolean issue chips → presence on the denormalised counts. Tri-state:
    // true → HAS the signal (count > 0), false → WITHOUT it (count = 0), and
    // undefined leaves the dimension unfiltered. Accepts the real boolean the
    // builder now sends AND the legacy string "true"/"false" saved funnels stored,
    // so existing "Has errors" segments keep matching. (`is` on a numeric column
    // compiles to `= 0` in segmentCondSql.)
    const boolCond = (val: unknown, column: string) => {
      if (val === true || val === "true")
        conditions.push({ column, op: "gt", values: ["0"] });
      else if (val === false || val === "false")
        conditions.push({ column, op: "is", values: ["0"] });
    };
    boolCond(f.hasErrors, "errors_count");
    boolCond(f.hasRage, "rage_count");
    boolCond(f.hasDead, "dead_count");
    // Custom identify() traits → the attrs Map (each carries its own op).
    for (const ua of filter.userAttributes ?? []) {
      if (!ua.key || !ua.value) continue;
      conditions.push({
        mapKey: ua.key,
        op: ua.op === "contains" ? "contains" : "is",
        values: [ua.value],
      });
    }
    if (conditions.length > 0) segment.conditions = conditions;
    // New = first seen within the window; Returning = first seen before it.
    if (filter.newReturning === "New") segment.firstSeenGteMs = sinceMs;
    else if (filter.newReturning === "Returning")
      segment.firstSeenLtMs = sinceMs;
    return segment;
  }

  /**
   * Funnel conversion split by a dimension (the reference's funnel breakdown),
   * in one pure-ClickHouse pass (`funnelBreakdown`). `metric: user` counts
   * distinct identified users per bucket (anonymous excluded). Steps/window/
   * segment resolve identically to `compute`.
   */
  async breakdown(
    workspaceId: number,
    opts: {
      funnelId?: number;
      steps?: FunnelStep[];
      range?: string;
      windowDays?: number;
      filter?: FunnelFilter;
      fromTs?: number;
      toTs?: number;
      dimension?: string;
      topN?: number;
      metric?: "session" | "user";
    },
  ) {
    const dimension = opts.dimension ?? "release";
    if (
      !FUNNEL_BREAKDOWN_COLUMNS[dimension] &&
      !FUNNEL_BREAKDOWN_SESSION_COLUMNS[dimension]
    ) {
      throw new ForbiddenException(
        `Unsupported breakdown dimension: ${dimension}`,
      );
    }

    let steps: FunnelStep[];
    let windowDays: number;
    let name: string | null = null;
    if (opts.funnelId) {
      const f = await this.db.funnel.findFirst({
        where: { id: opts.funnelId, workspaceId },
      });
      if (!f) throw new NotFoundException("Funnel not found");
      steps = f.steps as unknown as FunnelStep[];
      windowDays = f.windowDays;
      name = f.name;
    } else {
      if (!opts.steps?.length)
        throw new ForbiddenException("steps or funnelId required");
      steps = opts.steps;
      windowDays = opts.windowDays ?? RANGE_DAYS[opts.range ?? "7d"] ?? 7;
    }
    if (opts.range) windowDays = RANGE_DAYS[opts.range] ?? windowDays;
    this.assertValidSteps(steps);

    const useCustom = opts.fromTs && opts.toTs && opts.toTs > opts.fromTs;
    const since = useCustom
      ? new Date(opts.fromTs!)
      : new Date(Date.now() - windowDays * 86_400_000);
    const until = useCustom ? new Date(opts.toTs!) : null;

    const segment = FunnelsService.toSegment(
      opts.filter,
      steps,
      since.getTime(),
    );

    const windowMs = until
      ? until.getTime() - since.getTime()
      : windowDays * 86_400_000;
    const raw = await funnelBreakdown({
      workspaceId,
      steps: steps.map((s) => ({
        kind: s.kind ?? "page",
        matchType: s.matchType,
        value: s.value,
      })),
      windowMs,
      sinceMs: since.getTime(),
      untilMs: until ? until.getTime() : undefined,
      segment,
      dimension,
      topN: opts.topN,
      metric: opts.metric === "user" ? "user" : "session",
    });

    const buckets = raw.map((b) => ({
      value: b.value || "unknown",
      totalSessions: b.total,
      startedFunnel: b.entered,
      converted: b.converted,
      overallConversionPct:
        b.entered > 0
          ? Number(((b.converted / b.entered) * 100).toFixed(2))
          : 0,
      steps: steps.map((s, k) => ({
        index: k,
        name: s.name,
        count: b.stages[k] ?? 0,
        conversionPct:
          b.entered > 0
            ? Number((((b.stages[k] ?? 0) / b.entered) * 100).toFixed(1))
            : 0,
      })),
    }));
    return {
      funnelId: opts.funnelId ?? null,
      name,
      windowDays,
      dimension,
      metric: opts.metric === "user" ? "user" : "session",
      buckets,
    };
  }

  /**
   * Daily-bucketed conversion timeline — one ClickHouse `windowFunnel` pass
   * grouped by the day of each session's first event (`funnelTimeline`), filled
   * to a dense per-day series. Fuels the "Conversion over time" view-mode.
   */
  async computeTimeline(
    workspaceId: number,
    opts: {
      funnelId?: number;
      steps?: FunnelStep[];
      range?: string;
      filter?: FunnelFilter;
      // Same custom-window support as `compute`. When set, the bucket
      // loop runs across [fromTs, toTs] day-by-day rather than the
      // last N days.
      fromTs?: number;
      toTs?: number;
      // session (default) counts sessions that completed the funnel; user counts
      // distinct identified users — same semantics the steps/breakdown queries use.
      metric?: "session" | "user";
    },
  ) {
    let steps: FunnelStep[];
    let windowDays: number;
    if (opts.funnelId) {
      const f = await this.db.funnel.findFirst({
        where: { id: opts.funnelId, workspaceId },
      });
      if (!f) throw new NotFoundException("Funnel not found");
      steps = f.steps as unknown as FunnelStep[];
      windowDays = f.windowDays;
    } else {
      if (!opts.steps?.length)
        throw new ForbiddenException("steps or funnelId required");
      steps = opts.steps;
      windowDays = RANGE_DAYS[opts.range ?? "7d"] ?? 7;
    }
    if (opts.range) windowDays = RANGE_DAYS[opts.range] ?? windowDays;
    this.assertValidSteps(steps);

    const dayMs = 86_400_000;
    // Custom range buckets every day inside [fromTs, toTs]; otherwise the last
    // `windowDays` ending today. `endDay`/`windowStart` are UTC day-floors so
    // they line up with the CH `intDiv(timestamp, dayMs)*dayMs` day key.
    const useCustom = !!(opts.fromTs && opts.toTs && opts.toTs > opts.fromTs);
    const endDay = useCustom
      ? Math.floor(opts.toTs! / dayMs) * dayMs
      : Math.floor(Date.now() / dayMs) * dayMs;
    const days = useCustom
      ? Math.max(1, Math.ceil((opts.toTs! - opts.fromTs!) / dayMs))
      : windowDays;
    windowDays = days;
    const windowStart = endDay - (days - 1) * dayMs;
    const windowEnd = endDay + dayMs;

    type Point = {
      ts: string;
      conversionPct: number;
      started: number;
      converted: number;
    };
    const emit = (byDay: Map<number, { total: number; converted: number }>) => {
      const buckets: Point[] = [];
      for (let d = days - 1; d >= 0; d--) {
        const dayKey = endDay - d * dayMs;
        const p = byDay.get(dayKey);
        const total = p?.total ?? 0;
        const converted = p?.converted ?? 0;
        buckets.push({
          ts: new Date(dayKey).toISOString(),
          conversionPct:
            total > 0 ? Number(((converted / total) * 100).toFixed(2)) : 0,
          started: total,
          converted,
        });
      }
      return { funnelId: opts.funnelId ?? null, windowDays, points: buckets };
    };

    // Pure ClickHouse: one grouped windowFunnel pass bucketed by day, with the
    // segment applied via the sessions JOIN — no per-day round-trips, no Postgres.
    const segment = FunnelsService.toSegment(opts.filter, steps, windowStart);

    const points = await funnelTimeline({
      workspaceId,
      steps: steps.map((s) => ({
        kind: s.kind ?? "page",
        matchType: s.matchType,
        value: s.value,
      })),
      windowMs: days * dayMs,
      sinceMs: windowStart,
      untilMs: windowEnd,
      segment,
      metric: opts.metric === "user" ? "user" : "session",
    });
    return emit(
      new Map(
        points.map((p) => [p.day, { total: p.total, converted: p.converted }]),
      ),
    );
  }

  /**
   * Filter-value autocomplete: the distinct values of a filter `field` seen in
   * this workspace's sessions, matching `q`, most-common first (the reference's
   * frequency-ranked autocomplete). Reads live off `replay.sessions`. `field` is
   * a FunnelFilter field name (browser, browserVersion, os, country, urlPath,
   * plan, userId, utm*, …); numeric/unknown fields yield [] (not text columns).
   */
  async suggestValues(workspaceId: number, field: string, q?: string) {
    const column =
      FunnelsService.FIELD_COL[field]?.column ??
      (field === "startUrlContains" || field === "landingPage"
        ? "start_url"
        : undefined);
    if (!column) return { items: [] as Array<{ value: string; count: number }> };
    const items = await suggestSessionValues({
      workspaceId,
      column,
      q,
      // Default 20 (was 10): the picker keeps re-querying with `q` as the user
      // types, so a wider default surfaces more matches for a partial term while
      // still being a single bounded, workspace-pinned, frequency-ranked pass.
      limit: 20,
    });
    return { items };
  }

  /**
   * Step-value autocomplete for the builder's Custom-event / URL / screen /
   * click steps. Delegates to the ClickHouse pass that reads the SAME
   * `session_events` column the step matches on (funnelColumn), so the picker
   * and the windowFunnel computation always agree. Bounded, frequency-ranked,
   * workspace-scoped; `windowDays` (default 30, matching topTrackEvents) sets the
   * lookback. Scales: one set-based, workspace-pinned, partition-pruned pass +
   * LIMIT — no table scan.
   */
  async suggestStepValues(
    workspaceId: number,
    kind: string,
    q?: string,
    windowDays?: number,
  ) {
    const days = Math.max(1, Math.min(365, Math.floor(windowDays || 30)));
    const items = await suggestFunnelStepValues({
      workspaceId,
      kind: kind || "page",
      q,
      sinceMs: Date.now() - days * 86_400_000,
      // Default 20 (was 10): the builder re-queries with `q` on every settled
      // keystroke, so a wider default lets more matches surface as the analyst
      // narrows the term — still one set-based, partition-pruned pass + LIMIT.
      limit: 20,
    });
    return { items };
  }

  /**
   * Discover the distinct customProps keys set on ANY EndUser in the
   * workspace. Uses Postgres' `jsonb_object_keys` to crack the JSON
   * column open and aggregate keys. Capped at 200 keys so a pathological
   * workspace doesn't return a megabyte of names — anything past that
   * the analyst can type by hand via the "contains" fallback.
   *
   * Output is sorted alphabetically so the picker is stable across
   * calls. Empty-string and known-bad keys ("forgottenAt") are filtered
   * out so the picker only surfaces real attributes.
   */
  async discoverAttributeKeys(workspaceId: number) {
    // Note: Prisma's default Postgres table/column naming preserves the
    // model's PascalCase / camelCase, so raw SQL must quote every
    // identifier. `"EndUser"`, `"customProps"`, `"workspaceId"` are not
    // optional — Postgres would lowercase them otherwise and the table
    // wouldn't be found.
    const rows = await this.db.$queryRaw<Array<{ key: string }>>(
      Prisma.sql`
        SELECT DISTINCT jsonb_object_keys("customProps") AS key
        FROM "EndUser"
        WHERE "workspaceId" = ${workspaceId}
          AND "customProps" IS NOT NULL
        ORDER BY key ASC
        LIMIT 200
      `,
    );
    const HIDDEN = new Set(["", "forgottenAt"]);
    const keys = rows.map((r) => r.key).filter((k) => !HIDDEN.has(k));
    return { items: keys };
  }

  /**
   * Distinct values seen for a given customProps key. We coerce to text
   * via `->>` so numbers and booleans show up as their string form (the
   * picker is a single text-equality control). `q` is a case-insensitive
   * substring filter; results are capped at 100 to keep the picker
   * snappy — analysts typically narrow with the search input before
   * scrolling.
   */
  async discoverAttributeValues(
    workspaceId: number,
    key: string,
    opts: { q?: string; limit?: string },
  ) {
    if (!key || typeof key !== "string") {
      return { items: [] };
    }
    const cap = Math.min(
      Math.max(parseInt(opts.limit ?? "100", 10) || 100, 1),
      500,
    );
    const q = (opts.q ?? "").trim();
    const like = q ? `%${q}%` : null;
    const rows = await this.db.$queryRaw<Array<{ value: string }>>(
      Prisma.sql`
        SELECT DISTINCT ("customProps" ->> ${key})::text AS value
        FROM "EndUser"
        WHERE "workspaceId" = ${workspaceId}
          AND "customProps" IS NOT NULL
          AND "customProps" ? ${key}
          AND ("customProps" ->> ${key}) IS NOT NULL
          ${like ? Prisma.sql`AND ("customProps" ->> ${key}) ILIKE ${like}` : Prisma.empty}
        ORDER BY value ASC
        LIMIT ${cap}
      `,
    );
    return {
      items: rows.map((r) => r.value).filter((v) => v !== "" && v !== null),
    };
  }

  private async assertExists(workspaceId: number, id: number) {
    const row = await this.db.funnel.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Funnel not found");
    return row;
  }

  private assertValidSteps(steps: FunnelStep[]) {
    if (!Array.isArray(steps) || steps.length < 2) {
      throw new ForbiddenException("A funnel needs at least 2 steps.");
    }
    if (steps.length > MAX_STEPS) {
      throw new ForbiddenException(`Maximum ${MAX_STEPS} steps per funnel.`);
    }
    for (const s of steps) {
      if (!s?.name?.trim())
        throw new ForbiddenException("Every step needs a name.");
      if (!s?.value?.trim())
        throw new ForbiddenException(
          `Step "${s.name}" is missing a URL value.`,
        );
      if (
        !["contains", "equals", "startsWith", "regex"].includes(s.matchType)
      ) {
        throw new ForbiddenException(`Unknown matchType "${s.matchType}".`);
      }
      if (s.matchType === "regex") {
        try {
          new RegExp(s.value);
        } catch {
          throw new ForbiddenException(
            `Step "${s.name}" has an invalid regex.`,
          );
        }
      }
    }
  }

  private toSummary = (
    f: Prisma.FunnelGetPayload<{
      include: { owner: { select: { id: true; name: true; email: true } } };
    }> & { filter?: Prisma.JsonValue },
  ) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    steps: f.steps as unknown as FunnelStep[],
    windowDays: f.windowDays,
    // null when the funnel has no segment — the builder reads it back to
    // rebuild its filter chips.
    filter: (f.filter as FunnelFilter | null) ?? null,
    pinned: f.pinned,
    createdByAi: f.createdByAi,
    owner: f.owner,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  });

  // -------------------------------------------------------------------------
  //  Step / filter compilers — pure transformations, no `this` deps so they
  //  live as static methods inside the class rather than module functions.
  // -------------------------------------------------------------------------

  /**
   * Significance from the CH funnel's contingency counts (set-based; the
   * reference's get_issues / pearson_corr without an in-Node session loop). For
   * each issue, phi-correlate "dropped before the last stage" with "had the
   * issue" over the entered sessions, from the 2×2 cells.
   */
  private static significanceFromContingency(
    entered: number,
    dropped: number,
    issues: Record<string, [number, number]>,
  ) {
    const titles: Record<string, string> = {
      error: "Errors",
      crash: "Crashes",
      rage: "Rage taps",
      dead: "Dead taps",
    };
    if (entered < 2) {
      return {
        entered,
        dropped,
        totalDropDueToIssues: 0,
        significant: [] as unknown[],
      };
    }
    const insights: Array<{
      type: string;
      title: string;
      affectedSessions: number;
      conversionImpactPct: number;
      lostConversions: number;
      significant: boolean;
    }> = [];
    for (const [type, cell] of Object.entries(issues)) {
      if (type === "any") continue;
      const [total, dropWith] = cell;
      if (total === 0) continue;
      const phi = FunnelsService.phi(entered, dropped, total, dropWith);
      if (!phi || phi.r <= 0) continue;
      insights.push({
        type,
        title: titles[type] ?? type,
        affectedSessions: total,
        conversionImpactPct: Math.round(phi.r * 100),
        lostConversions: Math.round(phi.r * total),
        significant: phi.significant,
      });
    }
    insights.sort(
      (a, b) =>
        Number(b.significant) - Number(a.significant) ||
        b.conversionImpactPct - a.conversionImpactPct,
    );
    const [anyTotal, anyDrop] = issues.any ?? [0, 0];
    const anyPhi = FunnelsService.phi(entered, dropped, anyTotal, anyDrop);
    const totalDropDueToIssues = anyPhi ? Math.round(anyPhi.r * anyTotal) : 0;
    return { entered, dropped, totalDropDueToIssues, significant: insights };
  }

  /**
   * Phi (binary Pearson) from a 2×2: of `n` entered sessions, `dropped` dropped,
   * `issueTotal` had the issue, `issueDropped` had it AND dropped. Clamped to
   * [0,1] (only issue↔drop associations); significant via the t-statistic.
   */
  private static phi(
    n: number,
    dropped: number,
    issueTotal: number,
    issueDropped: number,
  ): { r: number; significant: boolean } | null {
    const a = issueDropped; // issue & dropped
    const b = issueTotal - issueDropped; // issue & not-dropped
    const c = dropped - issueDropped; // no-issue & dropped
    const d = n - dropped - b; // no-issue & not-dropped
    const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
    if (denom <= 0) return null;
    let r = (a * d - b * c) / denom;
    r = Math.max(0, Math.min(1, r));
    if (r === 0) return { r, significant: false };
    const t = r * Math.sqrt((n - 2) / Math.max(1e-9, 1 - r * r));
    return { r, significant: t > 1.96 };
  }

  /**
   * SIGNED 2×2 statistic for conversion influence: of `entered` sessions,
   * `converted` converted, `withTotal` had a feature and `withConv` had it AND
   * converted. Unlike `phi`, r is NOT clamped, so a positive r (feature raises
   * conversion → driver) and a negative r (blocker) are both expressed. Returns
   * the with/without conversion rates, the signed lift, r and the |t|-stat.
   */
  private static influenceStat(
    entered: number,
    converted: number,
    withTotal: number,
    withConv: number,
  ): {
    convWith: number;
    convWithout: number;
    lift: number;
    r: number;
    t: number;
  } | null {
    const withoutTotal = entered - withTotal;
    const withoutConv = converted - withConv;
    if (withTotal <= 0 || withoutTotal <= 0) return null;
    const convWith = withConv / withTotal;
    const convWithout = withoutConv / withoutTotal;
    const a = withConv; // feature & converted
    const b = withTotal - withConv; // feature & not-converted
    const c = withoutConv; // no-feature & converted
    const d = withoutTotal - withoutConv; // no-feature & not-converted
    const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
    if (denom <= 0) return null;
    const r = (a * d - b * c) / denom;
    const t = Math.abs(r) * Math.sqrt((entered - 2) / Math.max(1e-9, 1 - r * r));
    return { convWith, convWithout, lift: convWith - convWithout, r, t };
  }

  private static influencePropLabel(prop: string): string {
    const map: Record<string, string> = {
      browser: "Browser",
      country: "Country",
      device: "Device",
      os: "OS",
      plan: "Plan",
      referrer: "Referrer",
      deviceModel: "Device model",
    };
    return map[prop] ?? prop;
  }
}
