import { Link } from "react-router-dom";
import { Icon } from "@/components/primitives";
import { Settings } from "@/api/endpoints";
import { ee } from "@ee";
import { useApi } from "@/api/useApi";
import { fmtN } from "@/lib/format";
import { type ApiLlm } from "../settings.data";
import { SkAiCfg } from "./SetSkeletons";

/* Panel: AI — a read-only status view (GET /v1/settings/llm).
 *
 * Self-host (no billing): AI runs on the SERVER's provider key — LLM_PROVIDER +
 * a key + LLM_MODEL in the environment. There is intentionally NO per-workspace
 * key entry here: one server key serves every workspace, keeps key material out
 * of the app database, and LLM_PROVIDER=openrouter already reaches every provider
 * by model id. So this panel only REPORTS whether AI is configured and points at
 * the env vars to set — it never collects a key. (The API still technically
 * accepts a per-workspace BYOK key, but the self-host UI deliberately doesn't
 * offer it; the provider dropdown it used to show never actually routed.)
 *
 * Cloud (billing): AI is the managed, metered Replayfy AI; usage lives in Billing
 * and this panel links out to it. Keyed off ee.hasBilling. */
export function PanelAI() {
  const {
    data,
    loading: llmLoading,
    stale: llmStale,
  } = useApi<ApiLlm>(() => Settings.llm.get<ApiLlm>(), [], {
    // Shared cache entry with the Ask panel's aiReady probe (AskProvider).
    key: "settings-llm",
  });
  const busy = llmLoading || llmStale;

  // Cloud = managed Replayfy AI; self-host = the server's own key.
  const managed = ee.hasBilling;
  // Whether AI can actually run right now (a provider key + model are resolved).
  const aiReady = data?.aiReady ?? false;
  const tokensToday = data?.tokensUsedToday ?? 0;
  const budget = data?.dailyTokenBudget ?? 0;

  return (
    <>
      <div className="set-ai-sec">Configuration</div>
      {busy && <SkAiCfg />}
      {!busy && (
        <div className="ai-cfg">
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Status</span>
            {managed ? (
              <span className="ai-ok">
                <span className="dot" /> Active — managed by Replayfy
              </span>
            ) : aiReady ? (
              <span className="ai-ok">
                <span className="dot" /> Active — using the server's AI key
              </span>
            ) : (
              <span className="ai-cfg-note">
                Not configured — set <code>LLM_PROVIDER</code>, a provider key
                (<code>OPENROUTER_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>)
                and <code>LLM_MODEL</code> on the server, then restart.
              </span>
            )}
          </div>
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Models</span>
            <span className="ai-cfg-v">
              {managed
                ? "Auto — latest Replayfy-tuned models"
                : "From LLM_MODEL (server)"}
            </span>
          </div>
          {data?.metered && (
            <div className="ai-cfg-row">
              <span className="ai-cfg-k">Budget</span>
              <span className="ai-cfg-v">
                {fmtN(tokensToday)} / {fmtN(budget)} tokens today
              </span>
            </div>
          )}
          {!managed && (
            <div className="ai-cfg-row">
              <span className="ai-cfg-k">Providers</span>
              <span className="ai-cfg-note">
                Anthropic directly, or any OpenAI-compatible provider. Set{" "}
                <code>LLM_PROVIDER=openrouter</code> to reach OpenAI, Gemini,
                Groq, Mistral, DeepSeek, xAI and more — just choose the model in{" "}
                <code>LLM_MODEL</code>. You pay your provider directly; nothing is
                metered here.
              </span>
            </div>
          )}
        </div>
      )}

      {/* Usage lives in Billing (one source of truth) — this panel links out to
          the same AI-credits breakdown rather than duplicating it. Billing is
          Enterprise Edition, so the open-source build (no metering) omits both
          the section and the link entirely. */}
      {managed && (
        <>
          <div className="set-ai-sec">Usage</div>
          <Link to="/settings/billing#ai-credits" className="set-ai-bill-link">
            <span className="set-ai-bill-tx">
              <span className="set-ai-bill-t">View AI usage in billing</span>
              <span className="set-ai-bill-d">
                Credits, tokens and the per-product breakdown for this cycle
              </span>
            </span>
            <span className="set-ai-bill-arr" aria-hidden="true">
              <Icon name="chev" size={16} />
            </span>
          </Link>
        </>
      )}

      {/* Self-host: a quiet pointer to the managed option (Enterprise/Cloud is
          the only place billing + no-setup managed AI live). No paywall — the
          full AI works here with your own server key. */}
      {!managed && (
        <div
          style={{
            marginTop: "var(--sp-20)",
            padding: "var(--sp-12) var(--sp-16)",
            borderRadius: 8,
            background: "var(--surface-2, rgba(0,0,0,.03))",
            fontSize: "var(--text-sm)",
            lineHeight: 1.5,
          }}
        >
          Prefer zero setup? <b>Replayfy Cloud</b> runs and manages the AI for
          you — no keys, no server config, usage-based billing.{" "}
          <a
            href="https://replayfy.app"
            target="_blank"
            rel="noopener noreferrer"
            style={{ whiteSpace: "nowrap", fontWeight: 600 }}
          >
            Learn about Cloud →
          </a>
        </div>
      )}
    </>
  );
}
