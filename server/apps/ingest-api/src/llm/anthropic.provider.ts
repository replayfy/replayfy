import type {
  LlmCompletion,
  LlmProvider,
  LlmRequest,
  LlmToolCall,
} from "./llm.types";

/**
 * Anthropic Messages API implementation of LlmProvider. Uses global `fetch`
 * (Node 20) — no SDK dependency. When `schema` is set, forces a single
 * structured tool call named "respond" whose input matches the schema (the
 * scope guard + cause hypothesis rely on this).
 */
export class AnthropicProvider implements LlmProvider {
  private static readonly ENDPOINT = "https://api.anthropic.com/v1/messages";
  private static readonly VERSION = "2023-06-01";

  constructor(private readonly apiKey: string) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
    };
    if (req.temperature != null) {
      body.temperature = req.temperature;
    }
    let tools = req.tools ?? [];
    if (req.schema) {
      // Structured output: one forced tool whose input IS the result.
      tools = [
        {
          name: "respond",
          description: "Respond with the structured result.",
          input_schema: req.schema,
        },
      ];
      body.tool_choice = { type: "tool", name: "respond" };
    }
    if (tools.length > 0) {
      body.tools = tools;
    }

    const res = await fetch(AnthropicProvider.ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": AnthropicProvider.VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      content?: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string | null;
    };
    const content = json.content ?? [];
    const toolCalls: LlmToolCall[] = content
      .filter((c) => c.type === "tool_use")
      .map((c) => ({
        id: c.id ?? "",
        name: c.name ?? "",
        input: c.input ?? {},
      }));
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      stopReason: json.stop_reason ?? null,
    };
  }
}
