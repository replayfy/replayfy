import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { createHash } from "crypto";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import type { Redis } from "ioredis";
import { DashboardService } from "../dashboard/dashboard.service";
import { LlmService } from "../llm/llm.service";
import { LLM_MODEL } from "../llm/llm.models";
import { REDIS_CLIENT } from "../common/redis.module";
import { planAiCadenceFloorHours, resolvePlan } from "../billing/plan-catalog";
import { readWorkspaceActivity } from "../common/workspace-activity";

/** The Redis-mirrored L1 payload (dates as ISO strings once round-tripped
 *  through JSON). Overview/metrics are opaque JSON blobs the dashboard renders. */
interface CachedSnapshot {
  overview: unknown;
  metrics: unknown;
  narrative: string | null;
  narrativeAt: string | null;
  snapshotAt: string;
}

/** System prompt for the storyline narration — deterministic numbers in,
 *  grounded prose out. */
const NARRATE_SYSTEM = [
  "You narrate ONE workspace's product-health storyline for its dashboard, in",
  "1-2 plain sentences. Use ONLY the numbers and labels in the provided facts",
  "JSON — never invent, infer, or round a number that isn't there. The facts",
  "include period-over-period deltas (prev + change%); lead with what CHANGED",
  "most and whether it got BETTER or WORSE, and note the trend. No preamble, no",
  "markdown, no lists — just the sentences.",
].join(" ");

/**
 * Workspace precompute — materialises each workspace's L1 payload (Overview +
 * business-health metrics) into WorkspaceSnapshot so the dashboard loads
 * instantly, and keeps it fresh cheaply via dirty-gating.
 *
 * Cost is proportional to CHANGE, not to total volume:
 *   • The signals finalize/backfill chokepoint bumps WorkspaceSnapshot
 *     .lastActivityAt for any workspace that finalized a session.
 *   • The sweep recomputes ONLY workspaces that are dirty (lastActivityAt >
 *     snapshotAt), never computed, or stale (>1h — so the relative-window
 *     metrics don't drift). Clean, fresh workspaces are skipped entirely.
 *   • The scan is over WorkspaceSnapshot, which holds one row per
 *     workspace-with-sessions — bounded by workspace count, NOT session/event
 *     volume.
 *
 * Numbers are 100% deterministic (they come straight from DashboardService's
 * SQL/ClickHouse rollups). Any AI narration of the storyline is layered on top
 * and only ever describes these precomputed figures.
 *
 * Postgres is the source of truth; every recompute WRITES THROUGH to Redis
 * (key `ws:snapshot:{id}`), and the dashboard read (`snapshot()`) is served
 * Redis-first (warming from Postgres on a miss). So a workspace's precomputed
 * L1 payload always lives in BOTH stores — the aggressive-cache invariant.
 */
@Injectable()
export class WorkspacePrecomputeService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspacePrecomputeService.name);

  /**
   * The range the dashboard requests by default — the one worth caching, and the
   * window the storyline is therefore grounded in (recomputeWorkspace feeds THIS
   * overview + metrics to narrate()).
   *
   * PUBLIC on purpose: DashboardController gates its /overview and /metrics
   * Redis fast paths on this exact constant instead of a hardcoded literal. They
   * previously disagreed — the dashboard header defaulted to 30d while this said
   * 7d — so the snapshot was recomputed every ~5min and NEVER served: every
   * homepage load paid the full live compute (~440ms at 500k sessions) plus 3
   * live ClickHouse FINAL scans. Keep this in step with the Overview header's
   * default range (the Overview header); referencing the constant means the
   * gate can no longer drift away from what is actually precomputed.
   */
  static readonly DEFAULT_RANGE = "30d";
  /** Default storyline-narration cadence (hours) when a workspace hasn't set one. */
  private static readonly DEFAULT_STORYLINE_HOURS = 12;
  /** Redis TTL for the mirrored snapshot — a safety net only; every sweep (≤5
   *  min) rewrites it, so it never actually expires under normal operation. */
  private static readonly CACHE_TTL_SEC = 3600;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly llm: LlmService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Recompute + cache one workspace's L1 payload NOW. Both the manual trigger
   * and the sweep call this. Stamping snapshotAt clears the dirty state
   * (snapshotAt catches up to lastActivityAt); activity arriving mid-recompute
   * bumps lastActivityAt past it, so it's simply recomputed next sweep.
   */
  async recomputeWorkspace(workspaceId: number): Promise<void> {
    const range = WorkspacePrecomputeService.DEFAULT_RANGE;
    const [overview, metrics] = await Promise.all([
      this.dashboard.overview(workspaceId, range),
      this.dashboard.metrics(workspaceId, range),
    ]);
    // Round-trip to a plain, Prisma-Json-safe value (the payloads are already
    // JSON-serialised for the HTTP response, so this never loses anything).
    const overviewJson = JSON.parse(
      JSON.stringify(overview),
    ) as Prisma.InputJsonValue;
    const metricsJson = JSON.parse(
      JSON.stringify(metrics),
    ) as Prisma.InputJsonValue;
    const now = new Date();

    // Storyline narration — grounded in the deterministic overview, regenerated
    // at most every storylineIntervalHours (default 12; 0 = off). The numbers
    // above still refresh ~5-min; only the LLM obeys the cadence (cost).
    // Best-effort: if the LLM is unavailable the snapshot still updates.
    //
    // Access pattern: ONE statement, replacing the previous findUnique — the
    // plan is fetched by widening the read that already ran, not by adding a
    // query. That matters because the 5-min sweep
    // (IntelligenceSchedulerService.tickPrecompute) enqueues one job per dirty
    // workspace up to its sweep cap and IntelligenceProcessor calls this once
    // per job; a second per-workspace plan lookup would be a 200-query N+1 every
    // tick. Both sides are PK-served (Workspace.id,
    // WorkspaceSnapshot.workspaceId), so it stays O(1) per workspace. It is
    // anchored on Workspace, not the snapshot, so `plan` is present even on the
    // FIRST-EVER narration, before a snapshot row exists — the sweep can't reach
    // that state (tickPrecompute selects FROM WorkspaceSnapshot, so every
    // enqueued workspace already has a row) but the manual controller path can,
    // and a snapshot-anchored read would hand the floor a null plan there. plan is
    // cast ::text to feed
    // resolvePlan (and because raw reads of a Postgres enum are not worth
    // relying on).
    const [prior] = await this.db.$queryRaw<
      Array<{
        plan: string;
        narrativeAt: Date | null;
        narrative: string | null;
        storylineIntervalHours: number | null;
      }>
    >`
      SELECT w."plan"::text AS plan,
             s."narrativeAt" AS "narrativeAt",
             s."narrative" AS narrative,
             s."storylineIntervalHours" AS "storylineIntervalHours"
      FROM "Workspace" w
      LEFT JOIN "WorkspaceSnapshot" s ON s."workspaceId" = w.id
      WHERE w.id = ${workspaceId}`;
    // The plan imposes a FLOOR on the cadence, never an override: a workspace
    // that chose a SLOWER interval (or 0 = off, preserved by the `> 0` test
    // below) keeps it. This narration is the more predictable background
    // spender of the two — unlike the intel pass it has NO material-change gate,
    // so it fires on the wall clock alone, ~136 credits a time, for every
    // workspace the sweep touches. At the 12h default that is ~8,300 credits a
    // month unconditionally; combined with a continuously-active intel pass at
    // its own 6h default a Free workspace runs ~153% of its 100,000-credit
    // allowance on background work before the user asks anything. Floored (see
    // AI_CADENCE_FLOOR_HOURS — one catalog record shared with the intel sweep,
    // so the two producers can't drift apart) the pair fits in ~40% and the rest
    // is the user's to spend.
    const storedHours =
      prior?.storylineIntervalHours ??
      WorkspacePrecomputeService.DEFAULT_STORYLINE_HOURS;
    const intervalHours = Math.max(
      storedHours,
      planAiCadenceFloorHours(prior?.plan),
    );
    const narrateDue =
      storedHours > 0 &&
      (!prior?.narrativeAt ||
        now.getTime() - prior.narrativeAt.getTime() >=
          intervalHours * 3_600_000);
    let narr:
      | { narrative: string; narrativeModel: string; narrativeAt: Date }
      | undefined;
    if (narrateDue) {
      // Feed BOTH the overview AND the metrics (which carry prev/deltaPct), so
      // the storyline is comparative — "what changed vs last period" + trend.
      const text = await this.narrate(workspaceId, { overview, metrics });
      if (text) {
        narr = { narrative: text, narrativeModel: LLM_MODEL, narrativeAt: now };
      }
    }

    // NUMBER, sweep-owned (R1): the material-facts fingerprint. Recomputed every
    // tick so the intel trigger (Phase 2) always has a LIVE producer — the pass
    // fires when this diverges from aiVersion. Magnitude-bucketed so noise doesn't
    // churn it, but a new/shifted incident, metric move, release, or health-band
    // change does (R12).
    const factsFingerprint = this.computeFactsFingerprint(overview, metrics);
    await this.db.workspaceSnapshot.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        lastActivityAt: now,
        snapshotAt: now,
        overview: overviewJson,
        metrics: metricsJson,
        factsFingerprint,
        ...(narr ?? {}),
      },
      update: {
        snapshotAt: now,
        overview: overviewJson,
        metrics: metricsJson,
        factsFingerprint,
        ...(narr ?? {}),
      },
    });

    // Write-through: mirror the freshly precomputed L1 payload into Redis so a
    // workspace's precomputed data lives in BOTH stores and the dashboard read
    // is served from Redis. The narrative is carried from the prior cycle when
    // this tick wasn't due to re-narrate (the DB upsert leaves it untouched).
    await this.cacheSnapshot(workspaceId, {
      overview: overviewJson,
      metrics: metricsJson,
      narrative: narr?.narrative ?? prior?.narrative ?? null,
      narrativeAt:
        (narr?.narrativeAt ?? prior?.narrativeAt ?? null)?.toISOString() ??
        null,
      snapshotAt: now.toISOString(),
    });

    // R2: the AI insight PROSE is material-gated (regenerated only every few
    // hours), but its NUMBERS must stay ~5-min fresh + consistent with the lanes
    // rendered next to them. Refresh the numeric columns from the just-computed
    // facts here (the numbers the sweep owns; the intel pass owns the prose).
    await this.refreshInsightNumbers(workspaceId, overview).catch(() => undefined);
  }

  /**
   * Refresh WorkspaceInsight numeric columns from the freshly-computed facts —
   * incident numbers come from the in-memory overview (no extra query); issue
   * numbers from ONE batched read (never an N+1 across two parent tables). Prose
   * is untouched (intel-owned). Insights whose source is gone are left for the
   * next intel pass to prune.
   */
  private async refreshInsightNumbers(
    workspaceId: number,
    overview: unknown,
  ): Promise<void> {
    const insights = await this.db.workspaceInsight.findMany({
      where: { workspaceId },
      select: { key: true, sourceIncidentId: true, sourceIssueId: true },
    });
    if (insights.length === 0) return;
    const lanes = ((overview ?? {}) as Record<string, unknown>).incidents ?? {};
    const inc = [
      ...(Array.isArray((lanes as Record<string, unknown>).problems) ? (lanes as Record<string, unknown[]>).problems : []),
      ...(Array.isArray((lanes as Record<string, unknown>).opportunities) ? (lanes as Record<string, unknown[]>).opportunities : []),
    ] as Array<Record<string, unknown>>;
    const incById = new Map(inc.map((i) => [Number(i.id), i]));
    const issueIds = insights
      .filter((i) => i.sourceIssueId != null)
      .map((i) => i.sourceIssueId as number);
    const issues = issueIds.length
      ? await this.db.issue.findMany({
          where: { id: { in: issueIds } },
          select: { id: true, sessionCount: true, userCount: true },
        })
      : [];
    const issById = new Map(issues.map((x) => [x.id, x]));
    await Promise.all(
      insights.map((ins) => {
        if (ins.sourceIncidentId != null) {
          const s = incById.get(ins.sourceIncidentId);
          if (!s) return Promise.resolve(undefined);
          return this.db.workspaceInsight.update({
            where: { workspaceId_key: { workspaceId, key: ins.key } },
            data: {
              sessionCount: Number(s.sessionCount ?? 0),
              userCount: Number(s.userCount ?? 0),
              deltaPctX100: Number(s.deltaPctX100 ?? 0),
              rank: Number(s.rank ?? 0),
              title: String(s.title ?? ""),
            },
          });
        }
        const s = ins.sourceIssueId != null ? issById.get(ins.sourceIssueId) : null;
        if (!s) return Promise.resolve(undefined);
        return this.db.workspaceInsight.update({
          where: { workspaceId_key: { workspaceId, key: ins.key } },
          data: { sessionCount: s.sessionCount, userCount: s.userCount },
        });
      }),
    );
  }

  /**
   * Turn the deterministic overview facts into 1-2 sentences of storyline via
   * the LLM. The model gets ONLY the precomputed facts and is told to invent no
   * numbers — so the prose is accurate by construction. Returns null (skip) when
   * the workspace has no LLM configured / is over budget.
   */
  private async narrate(
    workspaceId: number,
    data: unknown,
  ): Promise<string | null> {
    try {
      const facts = JSON.stringify(data).slice(0, 6000);
      const r = await this.llm.structured<{ storyline: string }>(workspaceId, {
        system: NARRATE_SYSTEM,
        user: facts,
        schema: {
          type: "object",
          properties: { storyline: { type: "string" } },
          required: ["storyline"],
        },
        surface: "cause",
        label: "narrate",
        // Ledger showed this pinned at 221/220 — truncating. Reasoning-model
        // tax, see llm.models.ts.
        maxTokens: 800,
        temperature: 0.3,
      });
      if (!r.ok) {
        return null;
      }
      const text = (r.data.storyline || "").trim();
      return text ? text.slice(0, 1000) : null;
    } catch (e) {
      this.logger.warn(
        `narrate ws ${workspaceId} failed: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Deterministic fingerprint of a workspace's MATERIAL facts (from the just-
   * computed overview + metrics). The intel trigger fires when this diverges from
   * the last pass's aiVersion. Numbers are magnitude-BUCKETED (sign + coarse band)
   * so a tiny wiggle leaves the fingerprint unchanged (no LLM churn), while a new
   * or shifted incident, a metric move across a band, a new release, or a health-
   * band change flips it — and a slow monotonic bleed still crosses a band (R12).
   */
  private computeFactsFingerprint(
    overview: unknown,
    metrics: unknown,
  ): string {
    const bucket = (n: unknown): string => {
      const v = Number(n) || 0;
      const a = Math.abs(v);
      const band = a === 0 ? 0 : a < 1000 ? 1 : a < 3000 ? 2 : a < 10000 ? 3 : 4;
      return `${Math.sign(v)}${band}`;
    };
    const o = (overview ?? {}) as Record<string, unknown>;
    const lanes = (o.incidents ?? {}) as Record<string, unknown>;
    const inc = [
      ...(Array.isArray(lanes.problems) ? lanes.problems : []),
      ...(Array.isArray(lanes.opportunities) ? lanes.opportunities : []),
    ] as Array<Record<string, unknown>>;
    // Incident set: id + delta band + type (order-independent → sorted).
    const incFp = inc
      .slice(0, 12)
      .map((i) => `${i.id}:${bucket(i.deltaPctX100)}:${i.signalType ?? ""}`)
      .sort()
      .join(",");
    const release =
      inc
        .map((i) => (typeof i.release === "string" ? i.release : ""))
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ?? "";
    const metArr = (
      Array.isArray(metrics)
        ? metrics
        : Object.values((metrics ?? {}) as Record<string, unknown>)
    ) as Array<Record<string, unknown>>;
    const metFp = metArr
      .filter((m) => m && typeof m === "object")
      .map(
        (m) =>
          `${m.key ?? ""}:${bucket(Math.round((Number(m.deltaPct) || 0) * 100))}`,
      )
      .sort()
      .join(",");
    const pulse = (o.pulse ?? {}) as Record<string, unknown>;
    const health = bucket(Math.round((Number(pulse.health) || 0) * 100));
    const raw = `i[${incFp}]m[${metFp}]r[${release}]h[${health}]`;
    return createHash("sha1").update(raw).digest("hex").slice(0, 20);
  }

  /**
   * Set how often the storyline re-narrates (hours; 0 = off, clamped to 0–168).
   * Upserts the workspace's snapshot row so the preference persists even before
   * the first compute. The deterministic numbers are unaffected — only the LLM
   * narration cadence changes.
   */
  async setStorylineInterval(workspaceId: number, hours: number) {
    const h = Math.min(168, Math.max(0, Math.floor(Number(hours)) || 0));
    // Access pattern: one row by PRIMARY KEY on a user-triggered save — not a
    // loop, not a scan.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    });
    const floor = planAiCadenceFloorHours(ws?.plan);
    // The narration cadence is a plan feature (AI_CADENCE_FLOOR_HOURS): the
    // narrate gate above runs at max(stored, floor), so accepting a faster value
    // would store and echo a cadence we never honour. Reject, matching
    // setIntelInterval and setRetention, so the UI can prompt an upgrade. 0 is
    // always allowed — a floor only slows narration, it never turns it back on.
    if (floor > 0 && h > 0 && h < floor)
      throw new BadRequestException(
        `Your ${resolvePlan(ws?.plan).label} plan re-narrates the storyline every ${floor} hours. Upgrade your plan for a faster refresh.`,
      );
    await this.db.workspaceSnapshot.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        lastActivityAt: new Date(),
        storylineIntervalHours: h,
      },
      update: { storylineIntervalHours: h },
    });
    return { storylineIntervalHours: h };
  }

  /**
   * The cached L1 snapshot for a workspace (null payload if never computed).
   * Served Redis-first (the write-through mirror); on a miss we read Postgres
   * and warm Redis, so the payload always ends up in both stores. The `stale`
   * hint is derived from the live activity watermark — a cheap single-column PK
   * read, the same coarse version the execution cache keys on — so activity that
   * arrived since the last recompute still surfaces as "refreshing…".
   */
  async snapshot(workspaceId: number) {
    const cached = await this.readCachedSnapshot(workspaceId);
    // On a cold miss we read the WorkspaceSnapshot row to warm the cache; that
    // read now also carries lastActivityAt, so the `stale` hint reuses it instead
    // of issuing a SECOND findUnique for the same row.
    const warm = cached ? null : await this.warmSnapshot(workspaceId);
    const payload = cached ?? warm?.payload ?? null;
    const snapshotAt = payload ? new Date(payload.snapshotAt) : null;
    const lastActivityAt = await this.lastActivityAt(
      workspaceId,
      warm ? warm.lastActivityAt : undefined,
    );
    return {
      overview: payload?.overview ?? null,
      metrics: payload?.metrics ?? null,
      snapshotAt,
      // The dashboard can show a "refreshing…" hint when the cache is behind.
      stale:
        snapshotAt && lastActivityAt
          ? lastActivityAt.getTime() > snapshotAt.getTime()
          : true,
    };
  }

  private snapshotKey(workspaceId: number): string {
    return `ws:snapshot:${workspaceId}`;
  }

  /** Write the precomputed payload THROUGH to Redis. Best-effort — Postgres is
   *  the source of truth, so a Redis error never fails a recompute. */
  private async cacheSnapshot(
    workspaceId: number,
    payload: CachedSnapshot,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.snapshotKey(workspaceId),
        JSON.stringify(payload),
        "EX",
        WorkspacePrecomputeService.CACHE_TTL_SEC,
      );
    } catch {
      // best-effort
    }
  }

  /** The Redis mirror of the snapshot payload, or null on miss/parse error. */
  private async readCachedSnapshot(
    workspaceId: number,
  ): Promise<CachedSnapshot | null> {
    try {
      const raw = await this.redis.get(this.snapshotKey(workspaceId));
      return raw ? (JSON.parse(raw) as CachedSnapshot) : null;
    } catch {
      return null; // best-effort: a Redis error is just a miss
    }
  }

  /** Read the snapshot row from Postgres and write it THROUGH to Redis. Used on
   *  a cache miss so the payload always ends up mirrored in both stores. */
  private async warmSnapshot(
    workspaceId: number,
  ): Promise<{ payload: CachedSnapshot; lastActivityAt: Date | null } | null> {
    const snap = await this.db.workspaceSnapshot.findUnique({
      where: { workspaceId },
      select: {
        overview: true,
        metrics: true,
        narrative: true,
        narrativeAt: true,
        snapshotAt: true,
        // Pulled in the SAME read so snapshot()'s stale hint needn't re-query
        // this row on a cold miss (see lastActivityAt's `fromWarm`).
        lastActivityAt: true,
      },
    });
    if (!snap || snap.snapshotAt == null) return null;
    const payload: CachedSnapshot = {
      overview: snap.overview ?? null,
      metrics: snap.metrics ?? null,
      narrative: snap.narrative ?? null,
      narrativeAt: snap.narrativeAt ? snap.narrativeAt.toISOString() : null,
      snapshotAt: snap.snapshotAt.toISOString(),
    };
    await this.cacheSnapshot(workspaceId, payload);
    return { payload, lastActivityAt: snap.lastActivityAt ?? null };
  }

  /** The workspace's live activity watermark, used only for the `stale` hint.
   *  Served from Redis (ws:activity:<id>, bumped by the signals chokepoint) so
   *  the hot read never touches Postgres; falls back to the column on a Redis
   *  miss (eviction/TTL/first activity before any bump). `fromWarm` (Date|null)
   *  is the column value already read during a cold-path warm — passed so the
   *  Redis-miss branch reuses it instead of re-querying the same row; `undefined`
   *  means "no warm read happened" (cache hit), so the DB fallback still runs. */
  private async lastActivityAt(
    workspaceId: number,
    fromWarm?: Date | null,
  ): Promise<Date | null> {
    const fromRedis = await readWorkspaceActivity(this.redis, workspaceId);
    if (fromRedis !== null) return new Date(fromRedis);
    if (fromWarm !== undefined) return fromWarm;
    try {
      const row = await this.db.workspaceSnapshot.findUnique({
        where: { workspaceId },
        select: { lastActivityAt: true },
      });
      return row?.lastActivityAt ?? null;
    } catch {
      return null;
    }
  }
}
