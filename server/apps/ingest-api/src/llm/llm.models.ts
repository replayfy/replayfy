/**
 * Model per LLM surface. Owner decision (2026-06-25): every surface uses the
 * one best model — no tiering, no per-workspace/user model choice. The surface
 * keys stay only so call sites read clearly; they all resolve to the same
 * model, and any WorkspaceLlmConfig.*Model overrides are ignored.
 *
 * Env-configurable (owner decision 2026-07-08) so moving models is a one-line
 * change — set LLM_MODEL to the FULLY-QUALIFIED id and it is passed to the
 * provider verbatim (no code-side prefixing). Switching vendors/models is then
 * an env change: OpenRouter wants a vendor prefix ("anthropic/claude-opus-4-8",
 * "openai/gpt-4o"); the Anthropic SDK wants the bare id ("claude-opus-4-8").
 *
 * REQUIRED when AI is enabled — there is deliberately NO built-in default (model
 * ids churn, so a stale hardcoded one is worse than none). If it is unset, a
 * provider call sends no model and 4xx-fails; bootstrap logs a clear warning at
 * startup when a provider key is present but LLM_MODEL is not.
 */
export const LLM_MODEL = process.env.LLM_MODEL as string;
/**
 * The intel-pass model (Phase 3). Grounded extraction with a strict schema, so a
 * cheaper (Sonnet-class) model fits — set LLM_MODEL_INTEL to a fully-qualified id
 * (e.g. "anthropic/claude-sonnet-5") to cut the at-scale bill. Defaults to
 * LLM_MODEL so it works out of the box and the funded live run succeeds; the env
 * override is the one-line switch to a cheaper tier (owner decision 2026-07-11).
 */
export const LLM_MODEL_INTEL = process.env.LLM_MODEL_INTEL || LLM_MODEL;
/**
 * The scope-guard model. The guard is a throwaway 3-way {intent,confidence}
 * classifier that sits ON the pre-TTFT critical path — every AI turn blocks on
 * it before a single token streams — yet needs no reasoning. A reasoning model
 * (glm-5.2) spends 300-700 thinking tokens on it, adding multiple seconds of
 * dead latency before the answer starts. Same opt-in shape as LLM_MODEL_INTEL:
 * defaults to LLM_MODEL (owner's "one best model" default is UNCHANGED), and
 * setting LLM_MODEL_FAST to a cheap non-reasoning id (e.g. a flash/mini tier)
 * is the one-line switch that cuts perceived AI latency with no code change.
 */
export const LLM_MODEL_FAST = process.env.LLM_MODEL_FAST || LLM_MODEL;
export const LLM_MODELS = {
  guard: LLM_MODEL_FAST,
  cause: LLM_MODEL,
  ask: LLM_MODEL,
  askDeep: LLM_MODEL,
  intel: LLM_MODEL_INTEL,
} as const;

/**
 * THE REASONING-MODEL TAX — read before setting a `maxTokens` anywhere.
 *
 * A reasoning model (the configured z-ai/glm-5.2, and every Claude/GPT thinking
 * tier) spends THINKING tokens before it writes a single character of output, and
 * those are billed and counted as completion tokens — i.e. they come out of
 * `maxTokens`. Measured here: 300-700 reasoning tokens on a routine call.
 *
 * Every structured call in this codebase uses a FORCED tool call, so hitting the
 * cap does NOT yield a short answer — it yields a MALFORMED one. The arguments
 * JSON is cut mid-string, `toolCalls[0]` is absent, `structured()` returns
 * `no_output`, and the caller sees "the LLM is unavailable". Nothing is logged.
 *
 * This bit us for real: `agent.narrate` was capped at 900 and every single call
 * in the ledger came back at exactly 900 output tokens — a 100% truncation rate —
 * which surfaced to users as "I couldn't find enough in your workspace data to
 * answer that". Our token cap, reported as a fact about the customer's data. The
 * ledger showed the same pin on `guard` (64/64), `agent.plan` (701/700) and
 * precompute `narrate` (221/220): every cap in the app had been sized against a
 * non-reasoning model, and switching LLM_MODEL to a reasoning one silently
 * invalidated all of them at once.
 *
 * Rules of thumb:
 *  - Budget reasoning (~700) + the real output, then add headroom.
 *  - A too-HIGH cap costs nothing: you are billed for tokens generated, not for
 *    the ceiling, and the prompt is what keeps answers short.
 *  - A too-LOW cap costs everything: a silent, total failure of that surface.
 *  - The ledger (`AiUsageLedger`) is the ground truth. If `max(outputTokens)` for
 *    a surface equals its cap, that surface IS truncating — go look.
 */

// Per-token price in MICRO-CENTS (1e-6 cent), env-overridable so the cost
// estimate can track the real model/provider without a code change. Defaults
// are ballpark Opus-tier rates (~$15/Mtok in, ~$75/Mtok out). Tokens in the
// ledger are exact and authoritative; cost is an estimate derived from these.
const PRICE_IN_UCENTS_PER_TOKEN = Number(
  process.env.LLM_PRICE_IN_UCENTS_PER_TOKEN || 1500,
);
const PRICE_OUT_UCENTS_PER_TOKEN = Number(
  process.env.LLM_PRICE_OUT_UCENTS_PER_TOKEN || 7500,
);

/** Best-effort cost of a call in micro-cents, from the env-configurable rates. */
export function priceMicroCents(
  inputTokens: number,
  outputTokens: number,
): number {
  return Math.round(
    (inputTokens || 0) * PRICE_IN_UCENTS_PER_TOKEN +
      (outputTokens || 0) * PRICE_OUT_UCENTS_PER_TOKEN,
  );
}
