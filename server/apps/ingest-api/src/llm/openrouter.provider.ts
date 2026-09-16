import type {
  LlmCompletion,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmToolCall,
} from "./llm.types";

/**
 * OpenRouter implementation of LlmProvider. OpenRouter speaks the OpenAI
 * chat-completions format, so this translates our Anthropic-shaped LlmRequest
 * (system + messages whose content may be tool_use / tool_result blocks) into
 * OpenAI messages + function tools, and maps the response back. Uses global
 * `fetch` — no SDK. Selected via LLM_PROVIDER=openrouter + OPENROUTER_API_KEY.
 *
 * `buildBody` and `parseResponse` are split out (pure) so the translation is
 * unit-testable without a live call.
 */
interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type OpenAiMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string | null;
      tool_calls?: OpenAiToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string | null;
  }>;
  /** With `usage: { include: true }` in the request, OpenRouter returns `cost`
   *  — the ACTUAL USD credits deducted for the call (after prompt-cache
   *  discounts + routing price), the amount that shows on the OpenRouter bill. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

export class OpenRouterProvider implements LlmProvider {
  private static readonly ENDPOINT =
    "https://openrouter.ai/api/v1/chat/completions";

  constructor(private readonly apiKey: string) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const res = await fetch(OpenRouterProvider.ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(this.buildBody(req)),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openrouter ${res.status}: ${detail.slice(0, 300)}`);
    }
    return this.parseResponse((await res.json()) as OpenAiResponse);
  }

  /**
   * Streaming completion. Sends `stream: true` (+ `stream_options.include_usage`
   * so the real charged cost still arrives in the final chunk), then reads the
   * SSE response, forwarding each `choices[0].delta.content` to `onText` as it
   * lands and accumulating the full text + usage. Intended for plain-prose
   * generation (the narrator) — NOT for schema/tool-forced calls, whose deltas
   * are partial-JSON tool arguments rather than clean content.
   */
  async completeStream(
    req: LlmRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmCompletion> {
    const body = {
      ...this.buildBody(req),
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await fetch(OpenRouterProvider.ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      // Client disconnect aborts this fetch → the reader loop below rejects and
      // OpenRouter stops generating, so we don't pay for tokens nobody reads.
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`openrouter ${res.status}: ${detail.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let cost: number | undefined;
    let finish: string | null = null;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE lines are newline-delimited; a frame is a `data:` line (OpenRouter
      // also emits `: comment` keep-alive lines, which we skip).
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: {
          choices?: Array<{
            delta?: { content?: string | null };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            cost?: number;
          };
        };
        try {
          json = JSON.parse(data);
        } catch {
          continue; // partial/garbled frame — skip
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          text += delta;
          onText(delta);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens ?? promptTokens;
          completionTokens = json.usage.completion_tokens ?? completionTokens;
          cost = json.usage.cost ?? cost;
        }
      }
    }

    const costMicroCents =
      typeof cost === "number" && Number.isFinite(cost)
        ? Math.round(cost * 1e8)
        : undefined;
    return {
      text,
      toolCalls: [],
      usage: {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        ...(costMicroCents !== undefined ? { costMicroCents } : {}),
      },
      stopReason: finish,
    };
  }

  /** Translate an LlmRequest into an OpenAI chat-completions request body. */
  buildBody(req: LlmRequest): Record<string, unknown> {
    const messages: OpenAiMessage[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      this.translateMessage(m, messages);
    }

    const body: Record<string, unknown> = {
      // Model id is sent VERBATIM — set the fully-qualified id via LLM_MODEL
      // (e.g. "anthropic/claude-opus-4-8", "openai/gpt-4o") so models/vendors can
      // be switched from env with no code change and no hidden prefixing.
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      // Ask OpenRouter to return the real charged cost (+ cache-aware token
      // accounting) inline in the response `usage`, so the ledger records what
      // OpenRouter actually deducted rather than a list-price estimate.
      usage: { include: true },
    };
    if (req.temperature != null) {
      body.temperature = req.temperature;
    }

    let tools = (req.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
    if (req.schema) {
      // Structured output: one forced function whose arguments ARE the result.
      tools = [
        {
          type: "function",
          function: {
            name: "respond",
            description: "Respond with the structured result.",
            parameters: req.schema,
          },
        },
      ];
      body.tool_choice = { type: "function", function: { name: "respond" } };
    }
    if (tools.length > 0) {
      body.tools = tools;
    }
    return body;
  }

  /** Map an OpenAI response back into our provider-agnostic completion. */
  parseResponse(json: OpenAiResponse): LlmCompletion {
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      input: this.safeParse(tc.function?.arguments),
    }));
    // OpenRouter's `cost` is USD credits. Convert to ledger micro-cents
    // (1 USD = 1e8 micro-cents) so it's the authoritative cost when present.
    const costUsd = json.usage?.cost;
    const costMicroCents =
      typeof costUsd === "number" && Number.isFinite(costUsd)
        ? Math.round(costUsd * 1e8)
        : undefined;
    return {
      text: msg?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        ...(costMicroCents !== undefined ? { costMicroCents } : {}),
      },
      stopReason: choice?.finish_reason ?? null,
    };
  }

  /** Convert one Anthropic-shaped message into one or more OpenAI messages. */
  private translateMessage(m: LlmMessage, out: OpenAiMessage[]): void {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      return;
    }
    const blocks = m.content as Array<Record<string, unknown>>;
    if (m.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const toolCalls: OpenAiToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id ?? ""),
          type: "function",
          function: {
            name: String(b.name ?? ""),
            arguments: JSON.stringify(b.input ?? {}),
          },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      return;
    }
    // user role: tool_result blocks → one OpenAI `tool` message each.
    let hadToolResult = false;
    for (const b of blocks) {
      if (b.type === "tool_result") {
        hadToolResult = true;
        out.push({
          role: "tool",
          tool_call_id: String(b.tool_use_id ?? ""),
          content: this.blockToText(b.content),
        });
      }
    }
    if (!hadToolResult) {
      out.push({ role: "user", content: this.blockToText(blocks) });
    }
  }

  private blockToText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (typeof c === "string") return c;
          const t = (c as { text?: unknown })?.text;
          return typeof t === "string" ? t : JSON.stringify(c);
        })
        .join("\n");
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private safeParse(s: string | undefined): Record<string, unknown> {
    if (!s) return {};
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
