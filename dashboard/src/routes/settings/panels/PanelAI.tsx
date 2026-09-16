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
/** Mirrors LlmService.BYOK_ENABLED on the backend. BYOK is withdrawn as a
 *  product option; the picker, the provider form, and the key field below are
 *  all left intact behind this flag so re-enabling is one edit in each repo
 *  rather than a rebuild. While false the API also REJECTS mode: "BYOK", so
 *  showing the option would only produce an error. */
const BYOK_ENABLED = false;

export function PanelAI() {
  const {
    data,
    loading: llmLoading,
    stale: llmStale,
    refetch,
  } = useApi<ApiLlm>(() => Settings.llm.get<ApiLlm>());
  /* Cold load only, per read: `stale` = the PREVIOUS workspace's provider
     (keepPreviousData); `syncing` is excluded so saving a key or switching
     provider refetches under the block that is already correct. */
  const llmBusy = llmLoading || llmStale;
  const toast = useToast();
  const serverMode =
    BYOK_ENABLED && data?.mode === "BYOK" ? "BYOK" : "PLATFORM";
  const serverProvider = data?.provider ?? "anthropic";
  const tokensToday = data?.tokensUsedToday ?? 0;
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
          <span className="ai-mode-t">Replayfy AI</span>
          <span className="ai-mode-badge">Managed · Recommended</span>
          <span className="ai-mode-d">
            Fully managed by Replayfy. No setup — Storylines, Ask, and
            investigations work out of the box. Metered with your plan.
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
            <span className="ai-ok">
              <span className="dot" /> Active — managed by Replayfy
            </span>
          </div>
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Models</span>
            <span className="ai-cfg-v">
              Auto — latest Replayfy-tuned models
            </span>
          </div>
          <div className="ai-cfg-row">
            <span className="ai-cfg-k">Budget</span>
            <span className="ai-cfg-v">
              {fmtN(tokensToday)} / {fmtN(budget)} tokens today
            </span>
          </div>
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
    </>
  );
}
