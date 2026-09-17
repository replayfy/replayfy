import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon, Select } from "@/components/primitives";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { ee } from "@ee";
import { useApi } from "@/api/useApi";
import { fmtN } from "@/lib/format";
import { type ApiLlm } from "../settings.data";
import { SkAiCfg } from "./SetSkeletons";

type AiStatus = null | "checking" | "valid" | "invalid";

/* Panel: AI — wired to GET/PATCH /v1/settings/llm. The mode cards drive
   llm.mode (PLATFORM persists immediately; BYOK reveals the form and is
   persisted when the key is saved). The Validate button PATCHes
   { mode:'BYOK', provider, apiKey } — the backend stores the key write-only and
   returns only its last 4. AI spend/token/call usage is NOT shown here — it
   lives in Billing (one source of truth); this panel links out to it rather
   than re-fetching /v1/settings/ai/usage and duplicating the breakdown.
   TODO(api): Settings.aiMode (aiEnabled) and Settings.intelInterval have no
   control in this layout. */
/** Mirrors LlmService.BYOK_ENABLED on the backend. In the open-source /
 *  self-hosted build (no billing) BYOK is ON — self-hosters bring their own
 *  provider key. In the cloud build AI is the managed, metered "Replayfy AI" on
 *  the platform key, so the per-workspace-key path is withheld (the API also
 *  rejects mode:"BYOK" there). Keyed off ee.hasBilling to stay in lock-step. */
const BYOK_ENABLED = !ee.hasBilling;

export function PanelAI() {
  const {
    data,
    loading: llmLoading,
    stale: llmStale,
    refetch,
  } = useApi<ApiLlm>(() => Settings.llm.get<ApiLlm>(), [], {
    // Shared cache entry with the Ask panel's aiReady probe (AskProvider): one
    // request, and saving a key here refreshes the panel's composer state.
    key: "settings-llm",
  });
  /* Cold load only, per read: `stale` = the PREVIOUS workspace's provider
     (keepPreviousData); `syncing` is excluded so saving a key or switching
     provider refetches under the block that is already correct. */
  const llmBusy = llmLoading || llmStale;
  const toast = useToast();
  const serverMode =
    BYOK_ENABLED && data?.mode === "BYOK" ? "BYOK" : "PLATFORM";
  const serverProvider = data?.provider ?? "anthropic";
  const tokensToday = data?.tokensUsedToday ?? 0;
  // Whether AI can actually run right now (a provider key + model are resolved).
  const aiReady = data?.aiReady ?? false;
  const budget = data?.dailyTokenBudget ?? 0;

  const [modeOverride, setModeOverride] = useState<string | null>(null);
  const [providerOverride, setProviderOverride] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<AiStatus>(null);
  /* `null` until the read reports, so neither provider card wears the `on` ring:
     serverMode falls back to PLATFORM, which lit "Replayfy AI" as the selected
     provider on every cold load — including for the BYOK workspaces it was wrong
     about. A local pick (modeOverride) is the user's own intent and still wins
     immediately. */
  const mode = modeOverride ?? (llmBusy ? null : serverMode);
  const provider = providerOverride ?? serverProvider;
  /* The Configuration block is mode-dependent, so an unknown mode can't pick a
     block to render — unless the user has already chosen one themselves. */
  const cfgBusy = llmBusy && modeOverride == null;

  const selectPlatform = async () => {
    setModeOverride("PLATFORM");
    try {
      await Settings.llm.set({ mode: "PLATFORM" });
      toast && toast("Switched to Replayfy AI", { kind: "ok" });
      refetch();
    } catch (e) {
      toast &&
        toast(e instanceof Error ? e.message : "Could not save", {
          kind: "err",
        });
    }
  };
  const changeProvider = async (v: string) => {
    setProviderOverride(v);
    setStatus(null);
    try {
      await Settings.llm.set({ provider: v });
      refetch();
    } catch {
      /* surfaced on save */
    }
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    setStatus("checking");
    try {
      await Settings.llm.set({ mode: "BYOK", provider, apiKey: key.trim() });
      setStatus("valid");
      setKey("");
      refetch();
    } catch (e) {
      setStatus("invalid");
      toast &&
        toast(e instanceof Error ? e.message : "Could not save key", {
          kind: "err",
        });
    }
  };

  return (
    <>
      {BYOK_ENABLED && (
        <>
      <div className="set-ai-sec">Intelligence provider</div>
      <div className="ai-modes">
        <button
          className={`ai-mode ${mode === "PLATFORM" ? "on" : ""}`}
          onClick={selectPlatform}
        >
          <span className="ai-mode-top">
            <span className="ai-mode-ic">
              <Icon name="spark" size={14} fill />
            </span>
            <span className="ai-mode-radio" />
          </span>
          <span className="ai-mode-t">
            {ee.hasBilling ? "Replayfy AI" : "Server key"}
          </span>
          <span className="ai-mode-badge">
            {ee.hasBilling ? "Managed · Recommended" : "Unmetered"}
          </span>
          <span className="ai-mode-d">
            {ee.hasBilling
              ? "Fully managed by Replayfy. No setup — Storylines, Ask, and investigations work out of the box. Metered with your plan."
              : "Uses the AI provider key configured on the server (LLM_PROVIDER + a key + LLM_MODEL). Unmetered — you pay your provider directly."}
          </span>
        </button>
        <button
          className={`ai-mode ${mode === "BYOK" ? "on" : ""}`}
          onClick={() => {
            setModeOverride("BYOK");
            setStatus(null);
          }}
        >
          <span className="ai-mode-top">
            <span className="ai-mode-ic">
              <Icon name="settings" size={14} />
            </span>
            <span className="ai-mode-radio" />
          </span>
          <span className="ai-mode-t">Bring your own key</span>
          <span className="ai-mode-badge alt">
            Your provider · Billed to you
          </span>
          <span className="ai-mode-d">
            Use your own model provider and API key. Calls are billed directly
            by your provider; nothing is metered by Replayfy.
          </span>
        </button>
      </div>
        </>
      )}

      <div className="set-ai-sec">Configuration</div>
      {cfgBusy && <SkAiCfg />}
      {mode === "PLATFORM" && (
        <div className="ai-cfg">
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Status</span>
            {ee.hasBilling ? (
              <span className="ai-ok">
                <span className="dot" /> Active — managed by Replayfy
              </span>
            ) : aiReady ? (
              <span className="ai-ok">
                <span className="dot" /> Active — using the server's AI key
              </span>
            ) : (
              <span className="ai-key-msg">
                Not configured — set <code>LLM_PROVIDER</code>, a provider key
                (<code>OPENROUTER_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>)
                and <code>LLM_MODEL</code> on the server, then restart. Or bring
                your own key below.
              </span>
            )}
          </div>
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Models</span>
            <span className="ai-cfg-v">
              {ee.hasBilling
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
        </div>
      )}
      {BYOK_ENABLED && mode === "BYOK" && (
        <div className="ai-cfg">
          <div className="ai-cfg-field">
            <label>Provider</label>
            <Select
              value={provider}
              width={220}
              options={[
                { value: "anthropic", label: "Anthropic (Claude)" },
                { value: "openai", label: "OpenAI" },
                { value: "google", label: "Google (Gemini)" },
                { value: "azure", label: "Azure OpenAI" },
              ]}
              onChange={changeProvider}
            />
          </div>
          <div className="ai-cfg-field">
            <label>API key</label>
            <div className="ai-key">
              <input
                type="password"
                className={`ai-key-in ${status === "invalid" ? "err" : status === "valid" ? "ok" : ""}`}
                placeholder={
                  data?.apiKeyLast4 ? `••••${data.apiKeyLast4}` : "sk-ant-…"
                }
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setStatus(null);
                }}
              />
              <button
                className="btn sm"
                disabled={!key.trim() || status === "checking"}
                onClick={saveKey}
              >
                {status === "checking" ? "Saving…" : "Validate"}
              </button>
            </div>
            {status === "valid" && (
              <div className="ai-key-msg ok">
                <Icon name="check" size={12} /> Key verified — Replayfy AI is
                now using your {provider} key.
              </div>
            )}
            {status === "invalid" && (
              <div className="ai-key-msg err">
                <Icon name="warn" size={12} /> Couldn't validate this key. Check
                the provider and try again.
              </div>
            )}
            {!status && (
              <div className="ai-key-msg">
                Encrypted at rest and never shown again after saving.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Usage lives in Billing (one source of truth) — this panel links out to
          the same AI-credits breakdown rather than duplicating it. Billing is
          Enterprise Edition, so the open-source build (no metering) omits both
          the section and the link entirely. */}
      {ee.hasBilling && (
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
          full AI works here with your own key. */}
      {!ee.hasBilling && (
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
