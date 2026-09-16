/** Provider-agnostic LLM contract (doc 10 §3.2). The rest of the app talks to
 *  this, never a vendor SDK directly, so the model is swappable. */

export interface LlmMessage {
  role: "user" | "assistant";
  /** Plain text, or a provider content-block array (for tool results). */
  content: string | unknown[];
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  input_schema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** The provider's ACTUAL charged cost for this call, in micro-cents (1e-6
   *  cent), when the provider reports it (OpenRouter, via `usage.include`).
   *  Undefined for providers that don't (Anthropic direct) — the ledger then
   *  falls back to the env rate-table estimate. Authoritative when present:
   *  reflects prompt-cache discounts + real routing price, so it matches what
   *  OpenRouter actually deducted. */
  costMicroCents?: number;
}

export interface LlmCompletion {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  stopReason: string | null;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  /** Tool definitions the model may call (Ask Tempo). */
  tools?: LlmTool[];
  /** When set, forces a single structured response matching this JSON Schema
   *  (used for the scope guard + cause hypothesis). */
  schema?: Record<string, unknown>;
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmCompletion>;
  /** Optional streaming completion: forwards plain-text deltas via `onText` as
   *  the model emits them, and resolves with the full completion (accumulated
   *  text + usage). Providers that don't implement it fall back to complete()
   *  plus a single onText() call — correct, just not incremental. */
  completeStream?(
    req: LlmRequest,
    onText: (delta: string) => void,
    /** Cancels the upstream request on client disconnect so generation (and its
     *  billing) stops instead of running to completion unseen. */
    signal?: AbortSignal,
  ): Promise<LlmCompletion>;
}
