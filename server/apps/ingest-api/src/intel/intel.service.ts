import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient, Prisma, SignalPolarity } from "@replay/db-postgres";
import { LlmService } from "../llm/llm.service";
import { LLM_MODEL_INTEL } from "../llm/llm.models";
import {
  planAiCadenceFloorHours,
  planAiCadenceFloorPairs,
} from "../billing/plan-catalog";
import { IntelFactsService, type FactBundle, type Source } from "./intel-facts.service";
import {
  INTEL_SCHEMA,
  INTEL_SYSTEM,
  STORYLINE_SCHEMA,
  STORYLINE_SYSTEM,
} from "./intel.constants";

const AI_SWEEP_LIMIT = 100;
const MIN_CLUSTER = 3;
// The storyline is a tiny, focused call — a few sentences — so it needs little
// room and completes reliably. The signals/health call emits up to 12 slot-heavy
// insights + 5 explanations and, on GLM, spends variable reasoning tokens against
// the same ceiling, so it gets a much larger budget (see llm.models.ts on the
// reasoning-model tax; a truncated forced call yields no_output, not a short one).
const STORYLINE_MAX_TOKENS = 8000;
const INTEL_MAX_TOKENS = 16000;

interface DueRow {
  workspaceId: number;
  factsFingerprint: string;
}
/** The dedicated storyline call's output. */
interface StorylineOutput {
  text: string;
  citations: string[];
}
/** The signals + health call's output (the storyline is a separate call). */
interface IntelOutput {
  signals: Array<{
    sourceKind: string;
    sourceId: number;
    explanation: string;
    tags: string[];
    actionKind: string;
    citations: string[];
  }>;
  healthExplanations: Array<{ subsystem: string; text: string }>;
}

/**
 * The AI intelligence pass (Phases 2 + 3). The trigger (Phase 2) selects only
 * workspaces whose MATERIAL facts changed since their last pass; the pass (Phase
 * 3) makes ONE grounded llm.structured() call per workspace and persists the
 * storyline + ranked insights + health explanations.
 *
 * Grounding is structural: the model writes template-slot prose that the server
 * fills verbatim (R3, no fabricated numbers); every insight must anchor to a real
 * incident/issue in the bundle (unmatched dropped); numbers on the persisted
 * insight are COPIES of the source row (kept fresh by the 5-min sweep, R2);
 * confidence is a deterministic band. A degraded/empty SCHEDULED pass leaves prior
 * rows + aiVersion intact and only advances aiPassAt (R6); the MANUAL pass never
 * advances aiPassAt at all (see stampPass). Flag-gated by INTEL_PASS_ENABLED.
 */
@Injectable()
export class IntelService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IntelService.name);

  constructor(
    private readonly facts: IntelFactsService,
    private readonly llm: LlmService,
  ) {}

  @Cron("30 */15 * * * *")
  async generateIntelligenceDirty(): Promise<void> {
    if (process.env.INTEL_PASS_ENABLED !== "true") return; // flag-gated rollout
    try {
      const due = await this.selectDue();
      if (due.length === 0) return;
      this.logger.log(
        `intel trigger: ${due.length} workspace(s) due` +
          (due.length >= AI_SWEEP_LIMIT ? ` (capped ${AI_SWEEP_LIMIT})` : ""),
      );
      for (const d of due) {
        await this.processWorkspace(d.workspaceId, d.factsFingerprint).catch((e) =>
          this.logger.warn(`intel pass ws ${d.workspaceId} failed: ${(e as Error).message}`),
        );
      }
    } catch (e) {
      this.logger.warn(`intel trigger failed: ${(e as Error).message}`);
    }
  }

  /**
   * Workspaces due for an intel pass (see the schema comment on @@index([aiPassAt])).
   *
   * Access pattern: one scan of WorkspaceSnapshot — one row per
   * workspace-with-sessions, bounded by WORKSPACE count, not session/event
   * volume — joined to Workspace on its PRIMARY KEY, so no new index is needed
   * and none would help: the cadence comparison is row-dependent on both sides
   * (make_interval of a per-row column vs a per-row plan floor), which is
   * inherently non-sargable. It is deliberately evaluated IN SQL and not in
   * TypeScript after the fetch: filtering the LIMITed rows in JS would be a
   * cap-then-drop that silently discards due workspaces past the cap and shrinks
   * the effective sweep below AI_SWEEP_LIMIT.
   *
   * The plan imposes a FLOOR on the interval, not an override, so a workspace
   * that chose a SLOWER cadence keeps it — and the separate `intelIntervalHours
   * > 0` conjunct still runs first, so 0 (= explicitly off) stays off; without
   * it GREATEST(0, 24) would silently switch the pass back ON. The floors come
   * from the plan catalog (see AI_CADENCE_FLOOR_HOURS) rather than being spelled
   * out in this SQL string, and the CASE arms are generated from the Prisma
   * WorkspacePlan enum — which the catalog asserts at boot resolves entirely to
   * known tiers — so a plan added to the schema cannot silently miss an arm; the
   * CASE is assembled from bound PARAMETERS (never Prisma.raw), so no catalog
   * value can reach the parse tree. Two details are load-bearing: the ::int casts,
   * because Prisma binds a JS number as bigint and make_interval(hours => bigint)
   * does not resolve (42883, swallowed by the caller's catch, which would kill
   * every pass silently); and comparing w."plan"::text rather than the enum, so
   * an unknown label falls through to ELSE instead of raising. ELSE is the FREE
   * floor — the strictest — matching resolvePlan's unknown → FREE fallback, and
   * never NULL, which would make the comparison NULL and exclude the workspace
   * from the sweep forever. It is a belt-and-braces branch only: every enum
   * label already has an arm.
   */
  async selectDue(): Promise<DueRow[]> {
    const floorHours = Prisma.sql`CASE w."plan"::text ${Prisma.join(
      planAiCadenceFloorPairs().map((p) => Prisma.sql`WHEN ${p.plan} THEN ${p.hours}::int`),
      " ",
    )} ELSE ${planAiCadenceFloorHours(null)}::int END`;
    return this.db.$queryRaw<DueRow[]>(Prisma.sql`
      SELECT s."workspaceId", s."factsFingerprint"
      FROM "WorkspaceSnapshot" s
      JOIN "Workspace" w ON w.id = s."workspaceId"
      WHERE w."aiEnabled" = true
        AND s."intelIntervalHours" > 0
        AND s."factsFingerprint" IS NOT NULL
        AND (s."aiVersion" IS NULL OR s."factsFingerprint" <> s."aiVersion")
        AND (s."aiPassAt" IS NULL OR now() - s."aiPassAt" >= make_interval(hours => GREATEST(s."intelIntervalHours", ${floorHours})))
        AND (s."aiPassAt" IS NULL OR s."lastActivityAt" > s."aiPassAt")
      ORDER BY s."lastActivityAt" DESC
      LIMIT ${AI_SWEEP_LIMIT}`);
  }

  /** Force one pass now (the "regenerate insights" action + verification) —
   *  bypasses the cadence + the material-change gate (the user asked for a
   *  refresh; honouring it is the point, and ManualAiThrottleGuard bounds how
   *  often the route can be hit). `manual` is explicit: it decides whether
   *  aiPassAt is stamped, so a future ad-hoc/verification caller must state which
   *  clock it is spending. */
  async runPass(
    workspaceId: number,
    manual = true,
  ): Promise<{ insights: number; storyline: boolean }> {
    const snap = await this.db.workspaceSnapshot.findUnique({
      where: { workspaceId },
      select: { factsFingerprint: true },
    });
    return this.processWorkspace(workspaceId, snap?.factsFingerprint ?? "manual", manual);
  }

  /**
   * @param manual true for the user-forced pass. It writes aiVersion only when
   * the pass landed COMPLETE, and NEVER aiPassAt — see stampPass for why the two
   * watermarks split.
   */
  private async processWorkspace(
    workspaceId: number,
    fingerprint: string,
    manual = false,
  ): Promise<{ insights: number; storyline: boolean }> {
    const bundle = await this.facts.assemble(workspaceId);
    if (Object.keys(bundle.facts).length === 0) {
      if (!manual) await this.stampPass(workspaceId, null);
      return { insights: 0, storyline: false };
    }
    const user = JSON.stringify(bundle.facts);
    // Two focused structured calls in parallel: a tiny, reliable storyline call and
    // the larger signals/health call. Splitting them stops GLM from dropping the
    // storyline field (or truncating outright) under the weight of the combined
    // forced schema — a measured failure mode of the single-call design.
    const [storyRes, mainRes] = await Promise.all([
      this.llm.structured<StorylineOutput>(workspaceId, {
        system: STORYLINE_SYSTEM,
        user,
        schema: STORYLINE_SCHEMA as unknown as Record<string, unknown>,
        surface: "intel",
        label: "intel-storyline",
        maxTokens: STORYLINE_MAX_TOKENS,
        temperature: 0.3,
      }),
      this.llm.structured<IntelOutput>(workspaceId, {
        system: INTEL_SYSTEM,
        user,
        schema: INTEL_SCHEMA as unknown as Record<string, unknown>,
        surface: "intel",
        label: "intel",
        maxTokens: INTEL_MAX_TOKENS,
        temperature: 0.3,
      }),
    ]);
    // Both calls degraded → keep prior rows + aiVersion (R6), just advance the clock.
    if (!storyRes.ok && !mainRes.ok) {
      if (!manual) await this.stampPass(workspaceId, null);
      return { insights: 0, storyline: false };
    }
    return this.persist(
      workspaceId,
      fingerprint,
      bundle,
      {
        storyline: storyRes.ok ? storyRes.data : null,
        signals: mainRes.ok ? mainRes.data.signals : [],
        healthExplanations: mainRes.ok ? mainRes.data.healthExplanations : [],
      },
      manual,
    );
  }

  private async persist(
    workspaceId: number,
    fingerprint: string,
    bundle: FactBundle,
    out: IntelOutput & { storyline: StorylineOutput | null },
    manual: boolean,
  ): Promise<{ insights: number; storyline: boolean }> {
    const rows: Prisma.WorkspaceInsightUncheckedCreateInput[] = [];
    for (const sig of out.signals ?? []) {
      const kind = sig.sourceKind === "issue" ? "iss" : "inc";
      const source = bundle.sources[`F_${kind}_${sig.sourceId}`];
      if (!source) continue; // unmatched sourceId → drop (can't invent an insight)
      const filled = this.facts.fillSlots(sig.explanation, bundle.facts);
      if (!filled.ok || !filled.text) continue; // dangling/empty slot → drop
      const action = this.facts.resolveAction(sig.actionKind, source, bundle.funnels);
      rows.push({
        workspaceId,
        key: `${kind}:${sig.sourceId}`,
        sourceKind: source.kind,
        sourceIncidentId: source.kind === "incident" ? source.sourceId : null,
        sourceIssueId: source.kind === "issue" ? source.sourceId : null,
        explanation: filled.text,
        tags: (sig.tags ?? []).slice(0, 4),
        actionKind: action.actionKind,
        actionRef: action.actionRef,
        actionHref: action.actionHref,
        citations: (sig.citations ?? []).filter((c) => bundle.facts[c]) as Prisma.InputJsonValue,
        model: LLM_MODEL_INTEL,
        aiVersion: fingerprint,
        title: source.title,
        sessionCount: source.sessionCount,
        userCount: source.userCount,
        deltaPctX100: source.deltaPctX100,
        rank: source.rank,
        confidence: this.confidence(source),
        polarity: source.polarity as SignalPolarity,
        locusScreen: source.screen,
      });
    }

    const storyRaw = out.storyline?.text ?? "";
    const story = this.facts.fillSlots(storyRaw, bundle.facts);
    const storyOk = story.ok && !!story.text;
    // Observability: a rejected storyline is otherwise silent (aiPassAt advances,
    // storylineText goes stale). Log the raw prose — its unfilled {{...}} slots name
    // exactly which fact-id/field dangled — so a recurrence is diagnosable.
    if (storyRaw && !storyOk) {
      this.logger.warn(
        `intel ws ${workspaceId}: storyline rejected (dangling slot or empty) — raw="${storyRaw.slice(0, 200)}"`,
      );
    }
    const he: Record<string, string> = {};
    const heArr = Array.isArray(out.healthExplanations) ? out.healthExplanations : [];
    for (const item of heArr) {
      if (!item || typeof item.subsystem !== "string" || typeof item.text !== "string") continue;
      const f = this.facts.fillSlots(item.text, bundle.facts);
      if (f.ok && f.text) he[item.subsystem] = f.text;
    }

    // Non-empty success gate (R6): a fully-degraded pass leaves everything intact.
    if (rows.length === 0 && !storyOk) {
      if (!manual) await this.stampPass(workspaceId, null);
      return { insights: 0, storyline: false };
    }

    // A pass is COMPLETE only when BOTH halves landed. A partial manual pass
    // must NOT stamp aiVersion: doing so would close selectDue's G4 for the cron
    // on a half result — the scheduled pass would then never fill the missing
    // half until the fingerprint happens to move. Scheduled passes keep their
    // existing stamp-on-partial behaviour: they are on a clock, so a stuck
    // watermark is self-correcting there, and changing it would re-spend on every
    // tick.
    const complete = rows.length > 0 && storyOk;
    const now = new Date();
    await this.db.$transaction([
      ...rows.map((row) =>
        this.db.workspaceInsight.upsert({
          where: { workspaceId_key: { workspaceId, key: row.key } },
          create: row,
          update: row,
        }),
      ),
      // Prune insights whose source is no longer material — only when ≥1 valid
      // insight survived (never wipe a good prior list on a degraded pass).
      ...(rows.length > 0
        ? [
            this.db.workspaceInsight.deleteMany({
              where: { workspaceId, aiVersion: { not: fingerprint } },
            }),
          ]
        : []),
      this.db.workspaceSnapshot.update({
        where: { workspaceId },
        data: {
          ...(storyOk
            ? {
                storylineText: story.text,
                storylineConfidence: this.storyConfidence(bundle),
                storylineCitations: (out.storyline?.citations ?? []).filter(
                  (c) => bundle.facts[c],
                ) as Prisma.InputJsonValue,
                storylineModel: LLM_MODEL_INTEL,
                storylineAt: now,
              }
            : {}),
          healthExplanations: he as Prisma.InputJsonValue,
          // The two watermarks mean different things and the manual path splits
          // them (see stampPass). aiVersion = "which facts the persisted prose
          // reflects" — a COMPLETE manual pass DID consume these facts, so it
          // must stamp it; skipping it would leave selectDue's G4 open and the
          // cron would re-spend ~1,206 credits on the identical fingerprint
          // within 15 minutes, i.e. a double spend on exactly the users whose
          // click was most legitimate. An INCOMPLETE manual pass stamps neither,
          // which cannot cause that double spend: the click leaves G5/G6 exactly
          // as it found them, so the cron fires only if it was already due, and
          // it leaves the retry available (see `complete` above). aiPassAt =
          // "when the BACKGROUND budget was last spent" — the manual pass is not
          // background spend, so it leaves the scheduled clock (G5) and the
          // activity gate (G6) measuring from the last SCHEDULED pass. Net: the
          // click no longer steals the user's scheduled refresh, and it cannot
          // trigger a redundant one.
          ...(manual ? {} : { aiPassAt: now, aiVersion: fingerprint }),
          ...(manual && complete ? { aiVersion: fingerprint } : {}),
        },
      }),
    ]);
    return { insights: rows.length, storyline: storyOk };
  }

  /** Degraded/empty SCHEDULED pass: advance aiPassAt so the cadence debounce
   *  holds, but leave WorkspaceInsight rows AND aiVersion untouched (R6) — a real
   *  fingerprint change still re-triggers before the interval.
   *
   *  Never called on the manual path. aiPassAt is the BACKGROUND budget clock,
   *  and a manual pass that stamped it would push the next automatic pass a full
   *  cadence out (24h on Free) — the user would lose their scheduled refresh by
   *  asking for one, and worse, lose it even on the exits that make zero LLM
   *  calls (empty facts) or produce nothing (both calls degraded). A degraded
   *  MANUAL pass therefore stamps nothing at all: the workspace was already due
   *  before the click, so the cron re-running is the pass it was owed, not extra
   *  spend. (Not stamping also keeps this update off the one path where the
   *  WorkspaceSnapshot row may not exist yet, where it would raise P2025.) */
  private async stampPass(workspaceId: number, fingerprint: string | null): Promise<void> {
    await this.db.workspaceSnapshot.update({
      where: { workspaceId },
      data: { aiPassAt: new Date(), ...(fingerprint ? { aiVersion: fingerprint } : {}) },
    });
  }

  /** Deterministic insight confidence band (NOT AI): big cluster + big move → 95;
   *  a meaningful cluster → 70; else 40. Keeps every surfaced number deterministic. */
  private confidence(source: Source): number {
    const big = Math.abs(source.deltaPctX100) >= 3000;
    if (source.sessionCount >= 3 * MIN_CLUSTER && big) return 95;
    if (source.sessionCount >= MIN_CLUSTER) return 70;
    return 40;
  }

  /** Deterministic storyline confidence: how strong the top facts are. Returns
   *  null when the storyline is grounded in NO measured incident/issue — a
   *  brand-new / data-less workspace whose only facts are default health scores
   *  (assemble() always injects H_composite + subscores, so bundle.facts is
   *  never empty and this pass still runs). There is no signal to score there, so
   *  we emit NO confidence rather than the 55 floor, which used to surface as a
   *  fabricated "55% confidence" chip. storylineConfidence is Int? and the
   *  Overview hides the chip when confidence is absent. */
  private storyConfidence(bundle: FactBundle): number | null {
    if (Object.keys(bundle.sources).length === 0) return null;
    const strong = Object.values(bundle.sources).filter(
      (s) => s.sessionCount >= 3 * MIN_CLUSTER && Math.abs(s.deltaPctX100) >= 3000,
    ).length;
    return strong >= 3 ? 90 : strong >= 1 ? 75 : 55;
  }
}
