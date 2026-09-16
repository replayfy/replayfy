import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import {
  getPostgresClient,
  type WorkspaceLlmConfig,
  type LlmProviderMode,
} from "@replay/db-postgres";
import type { Redis } from "ioredis";
import type { LlmCompletion, LlmProvider, LlmRequest } from "./llm.types";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenRouterProvider } from "./openrouter.provider";
import { LLM_MODELS, priceMicroCents } from "./llm.models";
import { decryptSecret, encryptSecret, last4 } from "./llm-crypto";
import { microCentsToCredits, planAiCredits } from "../billing/plan-catalog";
import { AI_METERING_ENABLED } from "../billing/billing.port";
import { REDIS_CLIENT } from "../common/redis.module";

type Surface = "guard" | "cause" | "ask" | "askDeep" | "intel";

/** Why a workspace can't run a model right now (drives Ask Tempo outcomes).
 *  `credits` = platform AI bundle + purchased top-ups both spent this cycle. */
export type LlmUnavailable =
  | "disabled"
  | "no_key"
  | "budget"
  | "no_output"
  | "credits";

type Resolution =
  | { ok: true; provider: LlmProvider; config: WorkspaceLlmConfig }
  | { ok: false; reason: LlmUnavailable };

/**
 * Resolves + meters the LLM provider for a workspace (doc 10 §3). Owns the
 * WorkspaceLlmConfig CRUD (including BYOK key encryption) and the
 * mode/budget logic. The model is reached only through here.
 */
@Injectable()
export class LlmService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(LlmService.name);

  constructor(
    // The shared ioredis client doubles as a fail-CLOSED fallback ledger: when
    // the Postgres AiUsageLedger write fails, the spend is spilled here so the
    // credit gate still counts it (see record() / spillSpend()).
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    // Enterprise Edition presence flag (see billing.port.ts). Bound to `true`
    // only in the cloud build; `undefined` in the open-source / self-hosted
    // build, where `metered` is false → AI is unlimited and unmetered.
    @Optional()
    @Inject(AI_METERING_ENABLED)
    private readonly aiMeteringEnabled?: boolean,
  ) {}

  /** True only when the Enterprise billing module is present (cloud). When
   *  false (self-host / open source) AI has no plan credits, no daily token
   *  budget, and no fail-closed metering breaker — it just runs on the
   *  configured provider key. */
  private get metered(): boolean {
    return this.aiMeteringEnabled === true;
  }

  /** Consecutive platform spends we couldn't record in EITHER Postgres or Redis.
   *  Only a dual-store outage moves it; at/above HARD_FAIL_LIMIT, resolve() fails
   *  closed (reason "credits") so an unmeterable window can't hand out free AI.
   *  Reset by the first spend that lands in either store. Process-global —
   *  LlmService is a singleton provider, so this survives across requests. */
  private hardFailStreak = 0;
  /** Wall-clock of the most recent hard (dual-store) failure. The breaker is
   *  time-boxed off this: once HARD_FAIL_COOLDOWN_MS elapses with no new hard
   *  failure, resolve() lets calls through again to PROBE recovery — the reset
   *  that closes the breaker only happens inside record()/spillSpend(), which the
   *  gate would otherwise never reach, so without this decay a transient blip
   *  would latch platform AI off until a process restart. */
  private hardFailAt = 0;
  private static readonly HARD_FAIL_LIMIT = 3;
  private static readonly HARD_FAIL_COOLDOWN_MS = 30_000;

  // ── Config CRUD ────────────────────────────────────────────────────────

  /** Get-or-create the workspace's config row (default PLATFORM). New rows get
   *  the 1,000,000/day token budget (matches the schema @default) so every
   *  workspace has a sane platform budget out of the box. */
  async getConfig(workspaceId: number): Promise<WorkspaceLlmConfig> {
    return this.db.workspaceLlmConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, dailyTokenBudget: 1_000_000 },
      update: {},
    });
  }

  /** Client-safe view — never includes the key, only its last 4. */
  /**
   * BYOK ("bring your own key") is WITHDRAWN as a product option.
   *
   * The whole implementation is deliberately left in place — the enum member,
   * the AES-GCM key crypto (llm-crypto.ts), the resolution branch, and the
   * metering carve-out — so re-enabling it is this one constant rather than a
   * re-implementation. Flipping it back to true restores the previous behaviour
   * exactly; nothing else has been deleted.
   *
   * While false: the API refuses to SET the mode, and any workspace already
   * stored as BYOK resolves through the PLATFORM key instead (and is therefore
   * metered against its AI credits like everyone else). No stored key is read
   * and none is deleted.
   */
  static readonly BYOK_ENABLED = false;

  async getPublicConfig(workspaceId: number) {
    const c = await this.getConfig(workspaceId);
    // Report a withdrawn BYOK workspace as what it now effectively IS —
    // PLATFORM — so the dashboard never renders a mode the API would reject.
    const mode =
      !LlmService.BYOK_ENABLED && c.mode === "BYOK" ? "PLATFORM" : c.mode;
    return {
      mode,
      provider: c.provider,
      // The stored key is retained but no longer used; don't hint at it.
      apiKeyLast4: LlmService.BYOK_ENABLED ? c.apiKeyLast4 : null,
      guardModel: c.guardModel,
      causeModel: c.causeModel,
      askModel: c.askModel,
      dailyTokenBudget: c.dailyTokenBudget,
      tokensUsedToday: c.tokensUsedToday,
    };
  }

  /**
   * Update config. A provided `apiKey` is encrypted at rest (write-only — never
   * returned). Returns the client-safe view.
   */
  async setConfig(
    workspaceId: number,
    body: {
      mode?: LlmProviderMode;
      apiKey?: string | null;
      provider?: string;
      guardModel?: string | null;
      causeModel?: string | null;
      askModel?: string | null;
      dailyTokenBudget?: number;
    },
  ) {
    if (!LlmService.BYOK_ENABLED && body.mode === "BYOK") {
      throw new BadRequestException(
        "Bring-your-own-key is no longer available. Replayfy AI runs on the platform key and is billed as AI credits included with your plan.",
      );
    }
    const data: Record<string, unknown> = {};
    if (body.mode) data.mode = body.mode;
    if (body.provider) data.provider = body.provider;
    if (body.guardModel !== undefined) data.guardModel = body.guardModel;
    if (body.causeModel !== undefined) data.causeModel = body.causeModel;
    if (body.askModel !== undefined) data.askModel = body.askModel;
    if (body.dailyTokenBudget !== undefined) {
      data.dailyTokenBudget = Math.max(0, Math.round(body.dailyTokenBudget));
    }
    if (body.apiKey !== undefined) {
      if (body.apiKey === null || body.apiKey === "") {
        // Clear the stored key.
        data.apiKeyCipher = null;
        data.apiKeyIv = null;
        data.apiKeyTag = null;
        data.apiKeyLast4 = null;
      } else {
        const enc = encryptSecret(body.apiKey);
        data.apiKeyCipher = enc.cipher;
        data.apiKeyIv = enc.iv;
        data.apiKeyTag = enc.tag;
        data.apiKeyLast4 = last4(body.apiKey);
      }
    }
    await this.db.workspaceLlmConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
    return this.getPublicConfig(workspaceId);
  }

  // ── Resolution + metering ──────────────────────────────────────────────

  /** Resolve a usable provider, or the reason none is available. */
  async resolve(workspaceId: number): Promise<Resolution> {
    const config = await this.getConfig(workspaceId);
    if (config.mode === "DISABLED") {
      return { ok: false, reason: "disabled" };
    }
    // Withdrawn: a workspace still stored as BYOK resolves as PLATFORM, so AI
    // keeps working for them and is metered against their credits like anyone
    // else. The stored key is left untouched, just unused.
    if (LlmService.BYOK_ENABLED && config.mode === "BYOK") {
      if (!config.apiKeyCipher || !config.apiKeyIv || !config.apiKeyTag) {
        return { ok: false, reason: "no_key" };
      }
      const key = decryptSecret({
        cipher: config.apiKeyCipher,
        iv: config.apiKeyIv,
        tag: config.apiKeyTag,
      });
      return { ok: true, provider: this.makeProvider(key), config };
    }
    // PLATFORM
    const usingOpenRouter = process.env.LLM_PROVIDER === "openrouter";
    const platformKey = usingOpenRouter
      ? process.env.OPENROUTER_API_KEY || process.env.LLM_PLATFORM_KEY
      : process.env.LLM_PLATFORM_KEY || process.env.ANTHROPIC_API_KEY;
    if (!platformKey) {
      return { ok: false, reason: "no_key" };
    }
    // Self-host / open source (no Enterprise billing): AI is unmetered and
    // unlimited — skip the daily token budget, the fail-closed metering breaker,
    // and the AI-credit gate below. The self-hoster pays their own provider bill;
    // there is nothing to meter against. A provider key is still required above.
    if (!this.metered) {
      return { ok: true, provider: this.makeProvider(platformKey), config };
    }
    if (this.budgetExceeded(config)) {
      return { ok: false, reason: "budget" };
    }
    // Fail CLOSED: if recent platform spend couldn't be recorded in EITHER the
    // ledger or Redis (a dual-store outage), the credit balance is untrustworthy
    // — pause platform AI rather than serve calls we can't meter. This is the
    // ONLY safe direction: an unmeterable window that keeps serving is exactly
    // the "free unlimited AI" hole the ledger gate is meant to close.
    //
    // TIME-BOXED so it can't latch: the streak only resets inside record()/
    // spillSpend(), which this early return skips, so after the cooldown lapses
    // we let calls through again to probe recovery. A recovered store then resets
    // the streak; a still-broken one re-trips it (and re-stamps hardFailAt).
    if (
      this.hardFailStreak >= LlmService.HARD_FAIL_LIMIT &&
      Date.now() - this.hardFailAt < LlmService.HARD_FAIL_COOLDOWN_MS
    ) {
      this.logger.error(
        `platform AI paused (ws ${workspaceId}): ${this.hardFailStreak} consecutive spends unaccounted (ledger AND redis failing) — failing closed for up to ${LlmService.HARD_FAIL_COOLDOWN_MS}ms`,
      );
      return { ok: false, reason: "credits" };
    }
    // AI credits: the plan's monthly bundle + any purchased top-ups. When both
    // are spent, pause platform AI until the cycle resets or they top up. (BYOK
    // is never gated here — those users pay their own provider.)
    const credits = await this.aiCreditsState(workspaceId);
    // Reaching here means Postgres just answered, so it's healthy. If there is
    // un-ledgered spend sitting in Redis, flush it to the ledger now (fire-and-
    // forget) — that makes its purchased-credit drawdown permanent instead of
    // evaporating at the next cycle roll. Triggered even when exhausted, so an
    // out-of-credits workspace still reconciles.
    if (credits.spilled > 0) void this.reconcileSpill(workspaceId);
    if (credits.remaining != null && credits.remaining <= 0) {
      return { ok: false, reason: "credits" };
    }
    return { ok: true, provider: this.makeProvider(platformKey), config };
  }

  /** Start of the current calendar-month cycle (UTC). The AI bundle and session
   *  usage both reset here — matches BillingService.periodMonth. */
  private cycleStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /** Current AI-credit standing for a workspace: bundled (monthly allowance,
   *  resets) + purchased (persistent top-ups). `included: null` = Enterprise /
   *  unlimited. `remaining: null` when unlimited. Consumption draws the bundle
   *  first, so remaining = max(0, included − used) + purchased. */
  private async aiCreditsState(workspaceId: number): Promise<{
    included: number | null;
    used: number;
    purchased: number;
    spilled: number;
    remaining: number | null;
  }> {
    const [ws, agg, spilledUCents] = await Promise.all([
      this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true, aiPurchasedCredits: true },
      }),
      this.db.aiUsageLedger.aggregate({
        where: { workspaceId, createdAt: { gte: this.cycleStart() } },
        _sum: { costMicroCents: true },
      }),
      // Spend this cycle that FAILED to reach the ledger and was spilled to
      // Redis (record() → spillSpend). Still the workspace's spend; the gate
      // must see it or a broken ledger becomes free AI.
      this.spilledMicroCents(workspaceId),
    ]);
    const included = planAiCredits(ws?.plan);
    const used = microCentsToCredits(agg._sum.costMicroCents ?? 0n);
    const purchased = Number(ws?.aiPurchasedCredits ?? 0n);
    const spilled = microCentsToCredits(spilledUCents);
    // Spilled spend is subtracted from the WHOLE balance, NOT folded into `used`:
    // an overflow spill (bundle already gone) must draw down purchased credits,
    // but `Math.max(0, included − used)` would floor it away — so a ledger outage
    // during overflow would otherwise leak purchased credits. Subtracting last
    // makes the drawdown land on purchased, exactly as a committed row would. The
    // OUTER Math.max keeps an over-spill from showing a negative balance: the gate
    // only cares about `<= 0` (so flooring at 0 is still "exhausted"), and the
    // Billing page should read 0, not minus-something.
    const remaining =
      included == null
        ? null
        : Math.max(0, Math.max(0, included - used) + purchased - spilled);
    return { included, used, purchased, spilled, remaining };
  }

  /** Public credit summary for the Billing page. Returns the SAME balance
   *  resolve() gates on (spilled/un-ledgered spend included), so the page can
   *  never advertise a balance enforcement won't honour — the AI-credit twin of
   *  the entitlement invariant BillingService already keeps for sessions.
   *  `used` folds spilled spend back in so `used + remaining` stays coherent
   *  even mid-outage. */
  async aiCreditsSummary(workspaceId: number): Promise<{
    used: number;
    included: number | null;
    purchased: number;
    remaining: number | null;
  }> {
    const s = await this.aiCreditsState(workspaceId);
    return {
      used: s.used + s.spilled,
      included: s.included,
      purchased: s.purchased,
      remaining: s.remaining,
    };
  }

  // ── Fail-closed spill ledger (Redis) ───────────────────────────────────
  //
  // The Postgres AiUsageLedger is the source of truth for cycle spend, and the
  // credit gate reads its aggregate. If that write fails, the spend vanishes
  // from the aggregate and the gate never trips — a broken ledger silently
  // becomes free, unlimited platform AI. These three methods close that hole:
  // uncommitted spend is spilled to a cycle-scoped Redis counter that
  // aiCreditsState() adds back in, and a dual PG+Redis outage trips resolve().

  /** Cycle-scoped, self-expiring key holding this month's spilled spend (µ¢).
   *  Keyed by the same UTC cycle boundary as the bundle so it resets in lockstep
   *  with the monthly allowance the ledger aggregate resets against. */
  private spilledKey(workspaceId: number): string {
    const c = this.cycleStart();
    return `ai:spilled:${workspaceId}:${c.getUTCFullYear()}-${c.getUTCMonth() + 1}`;
  }

  /** This cycle's spilled spend (µ¢), or 0 if none / Redis unreachable. Read-path
   *  best-effort: a Redis read failure fails OPEN here, but the hard-fail breaker
   *  (set on the WRITE side) is what guarantees we still fail closed when spend
   *  can't be recorded at all. */
  private async spilledMicroCents(workspaceId: number): Promise<number> {
    try {
      const v = await this.withTimeout(
        this.redis.get(this.spilledKey(workspaceId)),
        1500,
      );
      return v ? Number(v) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /** Persist spend the ledger couldn't take so the credit gate still counts it.
   *  The ledger write is an atomic $transaction, so on catch we KNOW no row and
   *  no purchased-credit decrement committed — the full cost is unaccounted and
   *  safe to add here with no risk of double-counting. If Redis ALSO rejects it,
   *  bump the breaker so resolve() fails closed during the dual outage. */
  private async spillSpend(workspaceId: number, microCents: number): Promise<void> {
    if (microCents <= 0) {
      // Nothing to account for — a zero-cost completion doesn't threaten the
      // gate, so treat it as a healthy write and clear any prior streak.
      this.hardFailStreak = 0;
      return;
    }
    const key = this.spilledKey(workspaceId);
    try {
      // INCRBY + EXPIRE in ONE pipeline so that if the shared client queued them
      // under an outage, BOTH replay together on reconnect — the counter can
      // never come back TTL-less. (45-day TTL: past the cycle, gone before this
      // calendar month recurs next year.)
      await this.withTimeout(
        this.redis
          .multi()
          .incrby(key, microCents)
          .expire(key, 45 * 24 * 60 * 60)
          .exec(),
        2000,
      );
      // Spend is durably counted now — accounting is healthy again.
      this.hardFailStreak = 0;
      this.logger.warn(
        `ai spend spilled to redis (ws ${workspaceId}, ${microCents}µ¢) — ledger write failed; the credit gate still counts it`,
      );
    } catch (e) {
      this.hardFailStreak++;
      this.hardFailAt = Date.now();
      this.logger.error(
        `ai spend UNACCOUNTED (ws ${workspaceId}, ${microCents}µ¢): ledger AND redis both failed (${
          (e as Error).message
        }); hard-fail streak now ${this.hardFailStreak}`,
      );
    }
  }

  /** Drain any un-ledgered spill for this workspace into a REAL ledger row (and
   *  its purchased-credit drawdown), now that Postgres has answered — i.e. it is
   *  reachable again. Without this the spill lives only in a cycle-scoped Redis
   *  key: correct within the cycle, but at the next monthly roll the key resets
   *  while aiPurchasedCredits was never decremented, silently refunding paid
   *  credits an overflow spill consumed during the outage. Fire-and-forget from
   *  resolve(); never throws. */
  private async reconcileSpill(workspaceId: number): Promise<void> {
    let claimed = 0;
    try {
      // GETDEL claims the amount atomically, so if two calls race to reconcile
      // only one wins it — the other reads 0 and no-ops (no double-write).
      const v = await this.withTimeout(
        this.redis.getdel(this.spilledKey(workspaceId)),
        1500,
      );
      claimed = v ? Number(v) || 0 : 0;
    } catch {
      return; // Redis unreachable — leave the counter for a later attempt.
    }
    if (claimed <= 0) return;
    try {
      // Persist as a real ledger row (+ overflow → purchased drawdown) so the
      // spend is permanent. Tokens are unknown (the failed write's usage was
      // lost), so this row carries cost only; the credit math is unaffected.
      await this.persistSpend(
        workspaceId,
        claimed,
        { surface: "spill-reconcile", model: "-" },
        true,
      );
      this.hardFailStreak = 0;
      this.logger.warn(
        `ai spill reconciled to ledger (ws ${workspaceId}, ${claimed}µ¢)`,
      );
    } catch (e) {
      // Postgres still won't take it — put the amount back so the gate keeps
      // counting it and a later resolve() retries the reconcile.
      await this.spillSpend(workspaceId, claimed);
      this.logger.error(
        `ai spill reconcile failed (ws ${workspaceId}, ${claimed}µ¢): ${
          (e as Error).message
        } — returned to the spill counter`,
      );
    }
  }

  /** Bound a Redis op so a stalled connection can't hang an AI request. The
   *  shared client is configured with maxRetriesPerRequest:null (redis.module),
   *  so under an outage commands QUEUE indefinitely rather than throw — without
   *  this, a spill/read on the completion path would block the response until
   *  Redis reconnected. */
  private withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("redis timeout")), ms);
      timer.unref?.();
    });
    return Promise.race([
      op.finally(() => clearTimeout(timer)),
      bound,
    ]);
  }

  /**
   * Provider selected by env: `LLM_PROVIDER=openrouter` routes every call
   * through OpenRouter (env-default model, namespaced `anthropic/…`); otherwise
   * the Anthropic Messages API directly. One env var flips the whole app — the
   * rest of the code only ever touches the LlmProvider contract.
   */
  private makeProvider(key: string): LlmProvider {
    return process.env.LLM_PROVIDER === "openrouter"
      ? new OpenRouterProvider(key)
      : new AnthropicProvider(key);
  }

  /** Increment today's token usage atomically, resetting on a new UTC day. */
  async meter(
    workspaceId: number,
    config: WorkspaceLlmConfig,
    completion: LlmCompletion,
  ): Promise<void> {
    // Only the platform key is metered against our budget; BYOK is the
    // workspace's own spend.
    if (config.mode !== "PLATFORM") {
      return;
    }
    const tokens =
      (completion.usage.inputTokens ?? 0) +
      (completion.usage.outputTokens ?? 0);
    if (tokens <= 0) {
      return;
    }
    try {
      await this.db.$executeRaw`
        UPDATE "WorkspaceLlmConfig"
        SET "tokensUsedToday" = CASE WHEN "budgetDay" = CURRENT_DATE
                                     THEN "tokensUsedToday" + ${tokens}
                                     ELSE ${tokens} END,
            "budgetDay" = CURRENT_DATE
        WHERE "workspaceId" = ${workspaceId}`;
    } catch (e) {
      this.logger.warn(
        `llm meter failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
    }
  }

  // Always Opus 4.8 (owner decision 2026-06-25). Per-workspace *Model overrides
  // on WorkspaceLlmConfig are intentionally ignored — model choice isn't exposed.
  modelFor(_config: WorkspaceLlmConfig, surface: Surface): string {
    return LLM_MODELS[surface];
  }

  // ── High-level helpers ─────────────────────────────────────────────────

  /**
   * Single structured call (scope guard, cause hypothesis). Resolves, forces a
   * schema-shaped response, meters, and returns the parsed object — or the
   * unavailability reason.
   */
  async structured<T>(
    workspaceId: number,
    opts: {
      system: string;
      user: string;
      schema: Record<string, unknown>;
      surface: Surface;
      /** Ledger label (audit) when it differs from the model surface — e.g.
       *  a narration call uses surface "cause" but should log as "narrate". */
      label?: string;
      userId?: number;
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<{ ok: true; data: T } | { ok: false; reason: LlmUnavailable }> {
    const r = await this.resolve(workspaceId);
    if (!r.ok) return r;
    const completion = await r.provider.complete({
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      schema: opts.schema,
      model: this.modelFor(r.config, opts.surface),
      // Default sized for the reasoning-model tax (see llm.models.ts): thinking
      // tokens come out of this budget before any output is written, and a
      // truncated FORCED tool call yields no_output, not a short answer.
      maxTokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature ?? 0,
    });
    await this.record(workspaceId, r.config, completion, {
      surface: opts.label ?? opts.surface,
      model: this.modelFor(r.config, opts.surface),
      userId: opts.userId,
    });
    // Truncation surfaces here, and it does NOT always look like a missing tool
    // call. The reasoning-model tax (llm.models.ts) can cut the forced call's
    // arguments mid-JSON; OpenRouter still reports a tool_calls entry and its
    // parser degrades the unparseable arguments to `{}` (openrouter.provider.ts
    // safeParse), so `toolCalls[0]` is PRESENT and the result is an empty
    // object. Callers whose schema marks fields optional — with "" / [] as the
    // deliberate "I don't know" sentinel — cannot tell that apart from an honest
    // abstention, and would render a truncation as a confident empty report.
    // So an empty forced tool call is a failure, decided here, once, for every
    // surface. `stopReason` is the provider's own truncation flag; log it so the
    // ledger and the logs agree about which cap needs raising.
    const call = completion.toolCalls[0];
    const truncated =
      completion.stopReason === "length" ||
      completion.stopReason === "max_tokens";
    if (!call || Object.keys(call.input ?? {}).length === 0) {
      this.logger.warn(
        `llm structured produced no usable output (ws ${workspaceId}, surface ${
          opts.label ?? opts.surface
        }, stop ${completion.stopReason ?? "none"}, out ${
          completion.usage.outputTokens ?? 0
        }/${opts.maxTokens ?? 4000})${truncated ? " — TRUNCATED, raise maxTokens" : ""}`,
      );
      return { ok: false, reason: "no_output" };
    }
    if (truncated) {
      this.logger.warn(
        `llm structured hit the token ceiling (ws ${workspaceId}, surface ${
          opts.label ?? opts.surface
        }, ${completion.usage.outputTokens ?? 0}/${opts.maxTokens ?? 4000}) — ` +
          "output may be partial; raise maxTokens",
      );
    }
    return { ok: true, data: call.input as T };
  }

  /**
   * Streaming text call (the Narrator). Resolves the provider, forwards plain-
   * text deltas via `onText` as the model emits them, then meters + ledgers the
   * final usage and returns the full accumulated text — or the unavailability
   * reason. No schema: this is prose, so tokens arrive as content deltas.
   * Providers without native streaming degrade to one buffered `onText()`.
   */
  async stream(
    workspaceId: number,
    opts: {
      system: string;
      user: string;
      surface: Surface;
      label?: string;
      userId?: number;
      maxTokens?: number;
      temperature?: number;
    },
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; reason: LlmUnavailable }> {
    const r = await this.resolve(workspaceId);
    if (!r.ok) return r;
    const req: LlmRequest = {
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      model: this.modelFor(r.config, opts.surface),
      // Prose, so truncation degrades rather than fails outright — but a cut-off
      // answer is still a bad answer. Reasoning-model tax: see llm.models.ts.
      maxTokens: opts.maxTokens ?? 4000,
      temperature: opts.temperature ?? 0.2,
    };
    let completion: LlmCompletion;
    if (r.provider.completeStream) {
      completion = await r.provider.completeStream(req, onText, signal);
    } else {
      completion = await r.provider.complete(req);
      if (completion.text) onText(completion.text);
    }
    await this.record(workspaceId, r.config, completion, {
      surface: opts.label ?? opts.surface,
      model: this.modelFor(r.config, opts.surface),
      userId: opts.userId,
    });
    // Truncation on the STREAMING path is the dangerous kind. `structured()`
    // catches it for free — a cut-off forced tool call is malformed, so it
    // surfaces as no_output. Prose has no such tell: the provider stops
    // mid-sentence and we hand the caller a partial answer that reads like a
    // finished one, and nothing anywhere says otherwise. Nobody notices until
    // someone reads the ledger and spots outputTokens sitting exactly on the cap.
    //
    // So log it here, in the same shape structured() uses, and let the surface
    // name point at the cap that needs raising. Deliberately NOT an error: the
    // partial text is still the best answer we have and the caller should show
    // it — this makes the failure visible, it does not throw the answer away.
    if (
      completion.stopReason === "length" ||
      completion.stopReason === "max_tokens"
    ) {
      this.logger.warn(
        `llm stream hit the token ceiling (ws ${workspaceId}, surface ${
          opts.label ?? opts.surface
        }, ${completion.usage.outputTokens ?? 0}/${opts.maxTokens ?? 4000}) — ` +
          "the answer was cut off mid-sentence; raise maxTokens for this surface",
      );
    }
    if (!completion.text) return { ok: false, reason: "no_output" };
    return { ok: true, text: completion.text };
  }

  /** Raw completion for the Ask tool-loop. Meters + ledgers usage; caller drives
   *  tools. `meta` attributes the spend (surface + triggering user). */
  async complete(
    workspaceId: number,
    config: WorkspaceLlmConfig,
    provider: LlmProvider,
    req: LlmRequest,
    meta: { surface?: string; userId?: number } = {},
  ): Promise<LlmCompletion> {
    const completion = await provider.complete(req);
    await this.record(workspaceId, config, completion, {
      surface: meta.surface ?? "ask",
      model: req.model,
      userId: meta.userId,
    });
    return completion;
  }

  /**
   * Account for one completion: (1) meter it against the daily budget (platform
   * mode only), and (2) write a line-item AiUsageLedger row for owner audit
   * (ALL modes, ALL surfaces). The ledger write is best-effort — an audit-log
   * failure must never break a completion.
   */
  private async record(
    workspaceId: number,
    config: WorkspaceLlmConfig,
    completion: LlmCompletion,
    meta: { surface: string; model: string; userId?: number },
  ): Promise<void> {
    await this.meter(workspaceId, config, completion);
    const inTok = completion.usage.inputTokens ?? 0;
    const outTok = completion.usage.outputTokens ?? 0;
    // Prefer the provider's ACTUAL charged cost (OpenRouter reports it, cache-
    // and routing-aware, so it matches the real bill); fall back to the env
    // rate-table estimate when the provider doesn't report one (Anthropic direct).
    // Computed OUTSIDE the try so the catch can spill this exact cost to Redis.
    const costMicroCents = Math.round(
      completion.usage.costMicroCents ?? priceMicroCents(inTok, outTok),
    );
    // Only PLATFORM spend draws down credits — BYOK billed the user's own key.
    // With BYOK withdrawn every workspace is on the platform key, so every
    // workspace is metered; otherwise a legacy BYOK row would keep spending
    // OUR key for free.
    const isPlatform = !LlmService.BYOK_ENABLED || config.mode !== "BYOK";
    try {
      await this.persistSpend(
        workspaceId,
        costMicroCents,
        {
          surface: meta.surface,
          model: meta.model,
          userId: meta.userId,
          inputTokens: inTok,
          outputTokens: outTok,
        },
        isPlatform,
      );
      // A real ledger row landed — accounting is healthy, clear any prior streak.
      this.hardFailStreak = 0;
    } catch (e) {
      this.logger.warn(
        `ai usage ledger write failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
      // Fail CLOSED. The $transaction is atomic, so nothing committed: no ledger
      // row and no purchased-credit decrement. Spill the full cost to Redis so
      // the credit gate still counts it (spillSpend handles the dual-outage
      // breaker). Only PLATFORM spend is gated — a legacy BYOK row costs us
      // nothing, so a failure there is a lost audit line, not a credit leak.
      if (isPlatform) {
        await this.spillSpend(workspaceId, costMicroCents);
      }
    }
  }

  /** The atomic ledger write shared by record() (a fresh completion) and
   *  reconcileSpill() (draining the Redis spill once Postgres recovers): one
   *  $transaction that does bundle-first overflow → purchased drawdown, then
   *  writes the AiUsageLedger line. Throws on failure so each caller can react
   *  (record spills; reconcile returns the amount to the spill counter). */
  private async persistSpend(
    workspaceId: number,
    costMicroCents: number,
    meta: {
      surface: string;
      model: string;
      userId?: number | null;
      inputTokens?: number;
      outputTokens?: number;
    },
    isPlatform: boolean,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      // Bundle-first accounting: this call spends the monthly bundle first,
      // and only the OVERFLOW eats into purchased credits. Read usage BEFORE
      // this row is written so the split reflects the pre-call balance.
      if (isPlatform) {
        const [ws, agg] = await Promise.all([
          tx.workspace.findUnique({
            where: { id: workspaceId },
            select: { plan: true, aiPurchasedCredits: true },
          }),
          tx.aiUsageLedger.aggregate({
            where: { workspaceId, createdAt: { gte: this.cycleStart() } },
            _sum: { costMicroCents: true },
          }),
        ]);
        const included = planAiCredits(ws?.plan); // null = Enterprise/unlimited
        if (included != null) {
          const usedBefore = microCentsToCredits(agg._sum.costMicroCents ?? 0n);
          const bundledRemaining = Math.max(0, included - usedBefore);
          const overflow = Math.max(
            0,
            microCentsToCredits(costMicroCents) - bundledRemaining,
          );
          if (overflow > 0) {
            // ATOMIC, and deliberately not a read-then-write of an absolute
            // value: Postgres defaults to READ COMMITTED, so two concurrent
            // AI calls would both read the same balance and each write their
            // own total — silently losing one decrement and giving away
            // purchased credits. A raw UPDATE ... GREATEST(0, x - n) does the
            // arithmetic in the database under a row lock. GREATEST is what
            // keeps it from going negative (Prisma's `decrement` cannot floor).
            await tx.$executeRaw`
              UPDATE "Workspace"
                 SET "aiPurchasedCredits" =
                     GREATEST(0, "aiPurchasedCredits" - ${BigInt(overflow)}::bigint)
               WHERE id = ${workspaceId}`;
          }
        }
      }
      await tx.aiUsageLedger.create({
        data: {
          workspaceId,
          userId: meta.userId ?? null,
          surface: meta.surface,
          provider:
            process.env.LLM_PROVIDER === "openrouter"
              ? "openrouter"
              : "anthropic",
          model: meta.model,
          inputTokens: meta.inputTokens ?? 0,
          outputTokens: meta.outputTokens ?? 0,
          // BigInt column; round then widen, keeping compute in plain numbers.
          costMicroCents: BigInt(costMicroCents),
        },
      });
    });
  }

  /**
   * Owner audit of AI spend: total tokens + estimated cost, broken down by
   * surface, over a window. `WHERE workspaceId=? AND createdAt>=?` is served by
   * the (workspaceId, createdAt) index. Amounts are returned in cents.
   */
  async usage(
    workspaceId: number,
    opts: { sinceMs?: number; recent?: number } = {},
  ) {
    const since = new Date(
      opts.sinceMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000,
    );
    const bySurface = await this.db.aiUsageLedger.groupBy({
      by: ["surface"],
      where: { workspaceId, createdAt: { gte: since } },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        costMicroCents: true,
      },
      _count: { _all: true },
    });
    const recent = await this.db.aiUsageLedger.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(opts.recent ?? 50, 1), 200),
      select: {
        surface: true,
        model: true,
        inputTokens: true,
        outputTokens: true,
        costMicroCents: true,
        createdAt: true,
      },
    });
    // AI is shown to users as CREDITS, never USD — the ledger keeps the real µ¢.
    // 100,000 credits = $1, i.e. 1 credit = 1,000 µ¢ (see plan-catalog).
    const uCentsToCredits = (u: number) => Math.floor(u / 1_000);
    let totalTokens = 0;
    let totalUCents = 0;
    const surfaces = bySurface.map((r) => {
      const tokens = (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0);
      const uCents = Number(r._sum.costMicroCents ?? 0n);
      totalTokens += tokens;
      totalUCents += uCents;
      return {
        surface: r.surface,
        calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        tokens,
        credits: uCentsToCredits(uCents),
      };
    });
    return {
      since: since.toISOString(),
      totalTokens,
      totalCredits: uCentsToCredits(totalUCents),
      bySurface: surfaces.sort((a, b) => b.tokens - a.tokens),
      recent: recent.map((r) => ({
        surface: r.surface,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        credits: uCentsToCredits(Number(r.costMicroCents)),
        at: r.createdAt.toISOString(),
      })),
    };
  }

  private budgetExceeded(config: WorkspaceLlmConfig): boolean {
    if (config.dailyTokenBudget <= 0) {
      return false; // unlimited
    }
    // Only counts if the usage is for today; a new day resets implicitly.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const sameDay =
      config.budgetDay != null &&
      config.budgetDay.getTime() === today.getTime();
    return sameDay && config.tokensUsedToday >= config.dailyTokenBudget;
  }
}
