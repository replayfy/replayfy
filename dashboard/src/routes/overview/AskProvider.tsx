import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/feedback";
import { Settings } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { useAskStream, type SuggestedAction } from "./ask.api";
import { AskPanel } from "./sections/AskPanel";
import { useAuth } from "@/lib/auth";

type AskCtx = { openAsk: (q?: string) => void; close: () => void };
const Ctx = createContext<AskCtx | null>(null);

/** Any page can trigger the global Ask AI panel (e.g. an "investigate" action).
 *  Falls back to no-ops outside the provider so it's always safe to call. */
export function useAsk(): AskCtx {
  return useContext(Ctx) ?? { openAsk: () => {}, close: () => {} };
}

/* ============================================================================
   AskProvider — owns the single Ask AI chat stream + open state and renders the
   floating AskPanel once, at the app-shell level, so the assistant is reachable
   from EVERY page (the FAB + panel are position:fixed, so they stay put as the
   page scrolls). Pages call useAsk().openAsk(question?) to open it.
   ========================================================================== */
export function AskProvider({ children }: { children: ReactNode }) {
  const ask = useAskStream();
  const toast = useToast();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  /* Is AI actually usable? getPublicConfig reports `aiReady` false when no model
     provider is resolved (self-host with LLM_* unset, or a disabled workspace) —
     the panel uses it to show a "set up AI" notice and disable the composer
     rather than let a question stream into a failure. MEMBER-gated endpoint, so
     only fetch it for contributors (viewers never see the panel). Shared cache
     key with PanelAI so this is one request, not two. Optimistic default (true)
     while it loads so the input doesn't flash disabled on a configured server. */
  const { data: llm } = useApi<{ aiReady?: boolean }>(
    () => Settings.llm.get<{ aiReady?: boolean }>(),
    [],
    { key: "settings-llm", enabled: can.contribute },
  );
  const aiReady = llm?.aiReady ?? true;

  const openAsk = useCallback(
    (q?: string) => {
      if (q) ask.ask(q);
      setOpen(true);
    },
    [ask.ask],
  );
  const close = useCallback(() => {
    setOpen(false);
    ask.cancel();
  }, [ask.cancel]);

  // Deep-link opener: the global command palette lives outside this provider, so
  // its "Ask AI" command navigates to /overview?ask=<question> instead of calling
  // openAsk(). Honor that param once, then strip it so a refresh/back doesn't
  // re-open the panel. Empty value opens the panel with no pre-filled turn.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!params.has("ask")) return;
    openAsk(params.get("ask") || undefined);
    const next = new URLSearchParams(params);
    next.delete("ask");
    setParams(next, { replace: true });
  }, [params, openAsk, setParams]);

  const value = useMemo(() => ({ openAsk, close }), [openAsk, close]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Asking bills the workspace against AiUsageLedger, and the panel carries
          the agentic write/confirm path — a viewer was invited to watch
          recordings, not to spend money or approve mutations. The API refuses
          them (agent routes are MEMBER); this stops the UI offering a box that
          will 403 mid-answer. */}
      {can.contribute && (
      <AskPanel
        open={open}
        onOpen={() => setOpen(true)}
        onClose={close}
        aiReady={aiReady}
        canConfigureAi={can.seeSettings}
        session={ask.session}
        onAsk={openAsk}
        onNew={() => ask.newConversation()}
        onConfirm={ask.confirm}
        onClarify={ask.clarify}
        onAction={(a: SuggestedAction) => {
          // connect_integration is a NAVIGATION, not an execution — it has no
          // capability to run; it points the user at the tool they don't have
          // yet.
          if (a.kind === "connect_integration") {
            setOpen(false);
            navigate(
              a.provider
                ? `/settings/integrations/${a.provider.toLowerCase()}`
                : "/settings/integrations",
            );
            return;
          }
          // Every other suggested action is a follow-up the assistant can carry
          // out. Send its label as a NEW user turn: it appends to the transcript
          // (so the chat reads as a conversation) and runs the agent, whose
          // confirmation gate handles external writes — filing an issue, posting
          // a message — before anything actually happens. Previously this only
          // toasted "<label> opened" and did nothing, which is what the user hit.
          setOpen(true);
          ask.ask(a.label);
        }}
        onCitation={(c) => {
          // A session/recording citation opens that recording. `ref` is the
          // session public id, which /recordings/:recordingId matches. Non-
          // recording citations (a funnel, a console line) have nowhere to go.
          const t = (c.type || "").toLowerCase();
          const isRec =
            t.includes("session") ||
            t.includes("record") ||
            t.includes("replay") ||
            /^(ses|lt)_/.test(c.ref);
          if (isRec && c.ref) {
            setOpen(false);
            navigate(`/recordings/${c.ref}`);
          }
        }}
      />
      )}
    </Ctx.Provider>
  );
}
