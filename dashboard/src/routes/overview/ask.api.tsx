/* ============================================================================
   Enterprise Edition — the agentic Ask assistant client. PROPRIETARY (see
   ../LICENSE); NOT covered by the repository's AGPL-3.0 licence. Present only
   in the cloud build.

   Holds the AI agent SSE contract (AgentStreamEvent / AgentMessage + the
   suggested-action / citation / clarification types) and the `useAskStream`
   hook that drives the floating Ask panel off POST /v1/agent/stream, plus the
   `Agent` API namespace it calls. Extracted verbatim from the core Overview
   API module so the open-source build ships neither the assistant nor its
   backend routes.
   ========================================================================== */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, qs, getWorkspaceId } from "@/api/client";

/* -------------------------------------------------------------------- agent */
export const Agent = {
  run: <T = unknown>(body: { message: string; conversationId?: string }) => api.post<T>("/v1/agent", body),
  stream: <E = unknown>(
    body: { message: string; conversationId?: string },
    onEvent: (e: E) => void,
    signal?: AbortSignal,
  ) => api.stream<E>("/v1/agent/stream", body, onEvent, signal),
  /** End a session window on demand (the "New conversation" control). */
  endConversation: (id: string) => api.delete<{ ended: true }>(`/v1/agent/conversations/${id}`),
  confirm: <T = unknown>(body: { pendingActionId: string; confirm: boolean; conversationId?: string }) =>
    api.post<T>("/v1/agent/confirm", body),
  clarify: <T = unknown>(body: { rememberAs?: string; value: string; message: string; conversationId?: string }) =>
    api.post<T>("/v1/agent/clarify", body),
  recordings: <T = unknown>(q: { resultRef?: string; cursor?: string; limit?: number } = {}) =>
    api.get<T>(`/v1/agent/recordings${qs(q)}`),
  audit: <T = unknown>(q: { cursor?: string; limit?: number } = {}) => api.get<T>(`/v1/agent/audit${qs(q)}`),
  knowledge: {
    get: <T = unknown>() => api.get<T>("/v1/agent/knowledge"),
    put: <T = unknown>(body: unknown) => api.put<T>("/v1/agent/knowledge", body),
    remove: (id: string) => api.delete(`/v1/agent/knowledge/${id}`),
  },
};

/* ==========================================================================
   1 · AI AGENT — SSE stream + message contract (agent-contract.ts)
   ========================================================================== */
export type AgentOutcome =
  | "ANSWERED"
  | "NEEDS_CONFIRMATION"
  | "NEEDS_CLARIFICATION"
  | "EXECUTED"
  | "CANCELLED"
  | "EXPIRED"
  | "NOT_FOUND"
  | "REFUSED_OFFTOPIC"
  | "REFUSED_INJECTION"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "UNAVAILABLE"
  | "ERROR";

export type Citation = {
  type: string;
  ref: string;
  label?: string;
  atMs?: number;
};

/** Mirrors the server IntegrationProvider enum. Kept as a local union (the
 *  contract stays dependency-free), so add a member here when the server does. */
export type IntegrationProviderName =
  | "LINEAR"
  | "GITHUB"
  | "SLACK"
  | "PAGERDUTY"
  | "WEBHOOK"
  | "JIRA"
  | "LARK"
  | "SENTRY";

export type SuggestedActionKind =
  | "create_funnel"
  | "create_cohort"
  | "create_alert"
  | "define_conversion"
  | "show_recordings"
  | "recompute"
  // `file_issue` + `provider` replaced `create_linear_issue`: the server picks
  // the connected tracker rather than baking one vendor into the type.
  | "file_issue"
  | "post_message"
  // Not an execution — a nav to Settings → Integrations for a tool the
  // workspace does NOT have yet (connected === false).
  | "connect_integration";
export type SuggestedAction = {
  /** Stable server-minted id — use as the React key and to select the action. */
  id: string;
  kind: SuggestedActionKind;
  label: string;
  /** Model-authored one-phrase rationale; shown as the chip's hover title. */
  reason?: string;
  capability?: string;
  input?: Record<string, unknown>;
  requiresConfirmation: boolean;
  /** External tool this targets (drives routing for connect_integration). */
  provider?: IntegrationProviderName;
  /** false only on connect_integration — "you don't have this yet". */
  connected?: boolean;
};

export type Clarification = {
  question: string;
  rememberAs?: string;
  candidates?: { value: string; label: string; count?: number }[];
  allowFreeText: boolean;
};

export type ExecutionPreviewDTO = {
  operation: "update" | "delete" | "external";
  summary: string;
  permanent: boolean;
  reversible: boolean;
  details?: Record<string, unknown>;
  pendingActionId: string;
};

export type PlanRound = { round: number; reasoning: string; steps: string[] };

export type AgentMessage = {
  outcome: AgentOutcome;
  conversationId: string | null; // conv_<uuid>; echo back next turn
  narrative: string | null;
  confidence?: "high" | "medium" | "low";
  evidence: unknown[]; // always [] today — render from the below
  citations: Citation[];
  suggestedActions: SuggestedAction[];
  clarification?: Clarification;
  executionPreview?: ExecutionPreviewDTO;
  trace?: PlanRound[];
  freshness?: "live" | "near-live" | "immutable";
};

/** Discriminated by `type`; frames arrive raw as `data: <json>\n\n`. */
export type AgentStreamEvent =
  | { type: "plan"; round: number; reasoning: string; steps: string[] }
  | { type: "step:start"; capability: string; label?: string }
  | { type: "investigating"; source: string; detail?: string }
  | { type: "step:done"; capability: string; ok: boolean; ms: number }
  | { type: "needs_confirmation"; preview: ExecutionPreviewDTO }
  | { type: "needs_clarification"; clarification: Clarification }
  | { type: "citation"; citation: Citation }
  | { type: "narration"; token: string }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; message: string };

/* ==========================================================================
   1a · useAskStream — drives the Ask investigation drawer from the SSE stream
   ========================================================================== */
export type AskStepView = { label: string; done: boolean; ok?: boolean };
export type AskStatus = "idle" | "streaming" | "confirming" | "done" | "error";

/** One user turn in the transcript. */
export type AskUserMessage = { id: string; role: "user"; text: string };

/** One assistant turn — the full per-answer view-model (steps, streamed answer,
 *  evidence, actions, and any parked confirm/clarify). The server keeps the
 *  multi-turn context; this is the UI's record of a single answer. */
export type AskAssistantMessage = {
  id: string;
  role: "assistant";
  status: AskStatus; // streaming | confirming | done | error
  steps: AskStepView[];
  planReasoning: string | null;
  trace: PlanRound[];
  answer: string; // accumulated narration, then final narrative
  citations: Citation[];
  suggestedActions: SuggestedAction[];
  pending?: ExecutionPreviewDTO; // outcome NEEDS_CONFIRMATION
  clarify?: Clarification; // outcome NEEDS_CLARIFICATION
  outcome?: AgentOutcome;
  confidence?: "high" | "medium" | "low";
  error?: string;
};

export type AskMessage = AskUserMessage | AskAssistantMessage;

/** The whole in-session transcript. `messages` is every turn (oldest → newest);
 *  the last assistant message is the one currently streaming / awaiting confirm.
 *  `conversationId` is session-level (echoed back on every turn), `status`
 *  mirrors the latest assistant turn for convenience. */
export type AskSession = {
  messages: AskMessage[];
  conversationId: string | null;
  status: AskStatus;
};

let _askMsgSeq = 0;
function nextAskId(): string {
  _askMsgSeq += 1;
  return "am" + _askMsgSeq;
}

/** A blank streaming assistant turn (id filled in per turn). */
const INITIAL_ASSISTANT: Omit<AskAssistantMessage, "id"> = {
  role: "assistant",
  status: "streaming",
  steps: [],
  planReasoning: null,
  trace: [],
  answer: "",
  citations: [],
  suggestedActions: [],
};

const INITIAL_SESSION: AskSession = {
  messages: [],
  conversationId: null,
  status: "idle",
};

/** Find the newest assistant turn (the active one) in a transcript. */
function lastAssistant(
  messages: AskMessage[],
): AskAssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant")
      return messages[i] as AskAssistantMessage;
  }
  return undefined;
}

/** Immutably map `fn` over the newest assistant turn only — every streamed frame
 *  folds into the current answer, leaving prior turns untouched and rendered.
 *  Session `status` is kept in sync with that turn. */
function patchLastAssistant(
  session: AskSession,
  fn: (m: AskAssistantMessage) => AskAssistantMessage,
): AskSession {
  const messages = session.messages.slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      messages[i] = fn(messages[i] as AskAssistantMessage);
      break;
    }
  }
  const la = lastAssistant(messages);
  return { ...session, messages, status: la ? la.status : session.status };
}

/** Prettify a capability id ("investigation.diagnose" → "Investigation · diagnose"). */
function prettyCapability(cap: string): string {
  return cap
    .split(".")
    .map((p) => p.replace(/[-_]/g, " "))
    .join(" · ");
}

/** Fold one streamed frame into the active assistant turn. Pure. */
function reduceEvent(
  prev: AskAssistantMessage,
  e: AgentStreamEvent,
): AskAssistantMessage {
  switch (e.type) {
    case "plan":
      return {
        ...prev,
        planReasoning: e.reasoning || prev.planReasoning,
        trace: [
          ...prev.trace,
          { round: e.round, reasoning: e.reasoning, steps: e.steps },
        ],
      };
    case "step:start":
      return {
        ...prev,
        steps: [
          ...prev.steps,
          { label: e.label || prettyCapability(e.capability), done: false },
        ],
      };
    case "investigating": {
      // Keep the active step but sharpen its label with what's being inspected.
      if (!prev.steps.length)
        return { ...prev, planReasoning: e.detail || e.source };
      const steps = prev.steps.slice();
      const idx = steps.length - 1;
      if (!steps[idx].done) {
        steps[idx] = {
          ...steps[idx],
          label: `Investigating ${e.source}${e.detail ? " · " + e.detail : ""}`,
        };
      }
      return { ...prev, steps };
    }
    case "step:done": {
      const steps = prev.steps.slice();
      // mark the last not-done step done (steps complete in emission order).
      for (let i = steps.length - 1; i >= 0; i--) {
        if (!steps[i].done) {
          steps[i] = { ...steps[i], done: true, ok: e.ok };
          break;
        }
      }
      return { ...prev, steps };
    }
    case "citation":
      return { ...prev, citations: [...prev.citations, e.citation] };
    case "narration":
      return { ...prev, answer: prev.answer + e.token };
    case "needs_confirmation":
      return { ...prev, pending: e.preview };
    case "needs_clarification":
      return { ...prev, clarify: e.clarification };
    case "done":
      return applyMessage(prev, e.message);
    case "error":
      return {
        ...prev,
        status: "error",
        error: e.message || "Something went wrong answering that.",
      };
    default:
      return prev;
  }
}

/** Fold a terminal AgentMessage (done / confirm / clarify result) into the
 *  active assistant turn. `conversationId` is session-level, handled by callers. */
function applyMessage(
  prev: AskAssistantMessage,
  msg: AgentMessage,
): AskAssistantMessage {
  return {
    ...prev,
    status: "done",
    // final narrative is authoritative over the streamed word-chunks.
    answer: msg.narrative ?? prev.answer,
    citations: msg.citations?.length ? msg.citations : prev.citations,
    suggestedActions: msg.suggestedActions ?? prev.suggestedActions,
    pending:
      msg.executionPreview ??
      (msg.outcome === "NEEDS_CONFIRMATION" ? prev.pending : undefined),
    clarify:
      msg.clarification ??
      (msg.outcome === "NEEDS_CLARIFICATION" ? prev.clarify : undefined),
    outcome: msg.outcome,
    confidence: msg.confidence,
    trace: msg.trace ?? prev.trace,
    // once the turn resolves, every step is complete.
    steps: prev.steps.map((s) => (s.done ? s : { ...s, done: true })),
  };
}

export type UseAskStream = {
  /** The whole in-session transcript (every user + assistant turn). */
  session: AskSession;
  /** Ask a question. `fresh` starts a NEW conversation (clears the transcript);
   *  omit it for a follow-up so the transcript grows and server-side multi-turn
   *  context is preserved. */
  ask: (message: string, fresh?: boolean) => void;
  confirm: (pendingActionId: string, ok: boolean) => void;
  clarify: (
    value: string,
    rememberAs: string | undefined,
    message: string,
  ) => void;
  cancel: () => void;
  /** End the session window + clear the transcript (the "New conversation" control). */
  newConversation: () => void;
};

/** The server's ConversationStore sliding TTL — a conversation id is evicted this
 *  long after its last turn. */
const SERVER_CONVERSATION_TTL_MS = 10 * 60 * 1000;
/** Safety margin: the client stops treating a conversation as reusable a minute
 *  BEFORE the server would evict it, so we never send an id the server has already
 *  dropped (covers clock skew and boundary timing — the server is the authority). */
const CONVERSATION_SAFETY_MARGIN_MS = 60 * 1000;
/** How long the client considers a conversation still live/reusable — used BOTH for
 *  the in-session "start fresh after a gap of inactivity" check and the reload-
 *  restore window, so the two stay consistent. Deliberately UNDER the server TTL by
 *  the safety margin above (9 min), never over. */
const SESSION_INACTIVITY_MS =
  SERVER_CONVERSATION_TTL_MS - CONVERSATION_SAFETY_MARGIN_MS;

/* ---------------------------------------------------------------------------
   Transcript persistence — survive a page reload until the chat expires.

   The transcript lived only in React state, so a reload wiped it even though the
   server keeps the conversation alive (ConversationStore, same sliding TTL). We
   mirror it to localStorage, keyed PER WORKSPACE, and restore on mount when the
   window is still open (now − lastActivity ≤ TTL). Expiry stays in lock-step with
   the server so we never restore a transcript whose conversation id is already
   dead. Best-effort throughout: storage being unavailable never breaks the chat.
--------------------------------------------------------------------------- */
const ASK_STORE_PREFIX = "replay:ask:";
const ASK_STORE_V = 1;
type PersistedAsk = {
  v: number;
  workspaceId: number | null;
  conversationId: string | null;
  lastActivity: number;
  session: AskSession;
};
const askStoreKey = () => `${ASK_STORE_PREFIX}${getWorkspaceId() ?? "none"}`;

/** Keep the module id counter ahead of restored ids so a new turn's React key
 *  can't collide with a restored one (both are `am<n>`). */
function bumpAskSeq(messages: AskMessage[]): void {
  let max = _askMsgSeq;
  for (const m of messages) {
    const n = Number.parseInt(String(m.id).replace(/^am/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  _askMsgSeq = max;
}

/** A reloaded page has no live stream, so finalize any turn that was mid-flight:
 *  keep a partial answer as `done`, or drop a turn that produced nothing. Pending
 *  confirm/clarify turns are kept — their server-side action may still be valid
 *  within its own TTL. */
function sanitizeRestored(session: AskSession): AskSession {
  let messages = session.messages.slice();
  let li = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      li = i;
      break;
    }
  }
  if (li >= 0) {
    const a = messages[li] as AskAssistantMessage;
    if (a.status === "streaming") {
      if (a.answer.trim()) {
        messages[li] = { ...a, status: "done" };
      } else {
        // Nothing was produced before the reload — drop the dead turn + its prompt.
        messages = messages.slice(0, li);
        if (messages.length && messages[messages.length - 1].role === "user") {
          messages = messages.slice(0, -1);
        }
      }
    }
  }
  const la = lastAssistant(messages);
  return {
    messages,
    conversationId: session.conversationId,
    status: la ? la.status : "idle",
  };
}

function loadPersistedAsk(): {
  session: AskSession;
  conversationId: string | null;
  lastActivity: number;
} | null {
  try {
    const raw = localStorage.getItem(askStoreKey());
    if (!raw) return null;
    const p = JSON.parse(raw) as PersistedAsk;
    if (
      !p ||
      p.v !== ASK_STORE_V ||
      !p.session ||
      !Array.isArray(p.session.messages)
    ) {
      return null;
    }
    // Expire in lock-step with the server's sliding window.
    if (Date.now() - p.lastActivity > SESSION_INACTIVITY_MS) {
      localStorage.removeItem(askStoreKey());
      return null;
    }
    // Defensive: the key is already per-workspace, but never show one workspace's
    // chat under another.
    if (p.workspaceId !== getWorkspaceId()) return null;
    const session = sanitizeRestored(p.session);
    if (session.messages.length === 0) {
      localStorage.removeItem(askStoreKey());
      return null;
    }
    bumpAskSeq(session.messages);
    return {
      session,
      conversationId: p.conversationId,
      lastActivity: p.lastActivity,
    };
  } catch {
    return null;
  }
}

function savePersistedAsk(
  session: AskSession,
  conversationId: string | null,
  lastActivity: number,
): void {
  try {
    const payload: PersistedAsk = {
      v: ASK_STORE_V,
      workspaceId: getWorkspaceId(),
      conversationId,
      lastActivity,
      session,
    };
    localStorage.setItem(askStoreKey(), JSON.stringify(payload));
  } catch {
    /* quota exceeded / storage disabled — non-fatal, the chat still works live */
  }
}

function clearPersistedAsk(): void {
  try {
    localStorage.removeItem(askStoreKey());
  } catch {
    /* non-fatal */
  }
}

export function useAskStream(): UseAskStream {
  // Restore a still-live transcript once, synchronously, before the first paint,
  // so a reload shows the chat immediately (no flash of the empty state).
  const bootRef = useRef<ReturnType<typeof loadPersistedAsk> | undefined>();
  if (bootRef.current === undefined) bootRef.current = loadPersistedAsk();
  const boot = bootRef.current;

  const [session, setSession] = useState<AskSession>(
    boot?.session ?? INITIAL_SESSION,
  );
  const abortRef = useRef<AbortController | null>(null);
  const convRef = useRef<string | null>(boot?.conversationId ?? null);
  const lastActivityRef = useRef<number>(boot?.lastActivity ?? 0);

  // Mirror settled transcript states to storage so a reload restores them.
  // Skip while streaming (avoids a write per token — the terminal done / confirm
  // / clarify / error state is the one worth keeping); clear once emptied.
  useEffect(() => {
    if (session.status === "streaming") return;
    if (session.messages.length === 0) {
      clearPersistedAsk();
      return;
    }
    savePersistedAsk(
      session,
      convRef.current,
      lastActivityRef.current || Date.now(),
    );
  }, [session]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Abort any in-flight stream if the Overview route unmounts (navigate away).
  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback((message: string, fresh?: boolean) => {
    const q = message.trim();
    if (!q) return;
    // Re-asking cancels any in-flight stream (AbortController).
    abortRef.current?.abort();
    // Session window: an explicit `fresh` ask, or one sent >10 min after the last
    // message, drops the conversation id AND the transcript so the turn starts a
    // clean session; otherwise the turn is appended and context is preserved.
    const now = Date.now();
    const startFresh =
      !!fresh ||
      (lastActivityRef.current > 0 &&
        now - lastActivityRef.current > SESSION_INACTIVITY_MS);
    if (startFresh) convRef.current = null;
    lastActivityRef.current = now;
    const ac = new AbortController();
    abortRef.current = ac;
    const userMsg: AskUserMessage = { id: nextAskId(), role: "user", text: q };
    const asstMsg: AskAssistantMessage = {
      ...INITIAL_ASSISTANT,
      id: nextAskId(),
    };
    // Append this turn (the user bubble + a streaming assistant placeholder) so
    // every prior turn stays on screen; `startFresh` resets the transcript.
    setSession((prev) => ({
      conversationId: startFresh ? null : prev.conversationId,
      status: "streaming",
      messages: [...(startFresh ? [] : prev.messages), userMsg, asstMsg],
    }));

    Agent.stream<AgentStreamEvent>(
      { message: q, conversationId: convRef.current ?? undefined },
      (evt) => {
        if (ac.signal.aborted) return;
        if (evt.type === "done")
          convRef.current = evt.message.conversationId ?? convRef.current;
        setSession((prev) => {
          const next = patchLastAssistant(prev, (m) => reduceEvent(m, evt));
          return evt.type === "done"
            ? {
                ...next,
                conversationId:
                  evt.message.conversationId ?? prev.conversationId,
              }
            : next;
        });
      },
      ac.signal,
    ).catch((err: unknown) => {
      if (ac.signal.aborted) return;
      const msg =
        err instanceof Error
          ? err.message
          : "Something went wrong answering that.";
      setSession((prev) =>
        patchLastAssistant(prev, (m) => ({
          ...m,
          status: "error",
          error: msg,
        })),
      );
    });
  }, []);

  const confirm = useCallback((pendingActionId: string, ok: boolean) => {
    setSession((prev) =>
      patchLastAssistant(prev, (m) => ({ ...m, status: "confirming" })),
    );
    Agent.confirm<AgentMessage>({
      pendingActionId,
      confirm: ok,
      conversationId: convRef.current ?? undefined,
    })
      .then((res) => {
        convRef.current = res.data.conversationId ?? convRef.current;
        setSession((prev) => {
          const next = patchLastAssistant(prev, (m) =>
            applyMessage({ ...m, pending: undefined }, res.data),
          );
          return {
            ...next,
            conversationId: res.data.conversationId ?? prev.conversationId,
          };
        });
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Could not complete that action.";
        setSession((prev) =>
          patchLastAssistant(prev, (m) => ({
            ...m,
            status: "error",
            error: msg,
          })),
        );
      });
  }, []);

  const clarify = useCallback(
    (value: string, rememberAs: string | undefined, message: string) => {
      setSession((prev) =>
        patchLastAssistant(prev, (m) => ({
          ...m,
          status: "streaming",
          clarify: undefined,
        })),
      );
      Agent.clarify<AgentMessage>({
        value,
        rememberAs,
        message,
        conversationId: convRef.current ?? undefined,
      })
        .then((res) => {
          convRef.current = res.data.conversationId ?? convRef.current;
          setSession((prev) => {
            const next = patchLastAssistant(prev, (m) =>
              applyMessage(m, res.data),
            );
            return {
              ...next,
              conversationId: res.data.conversationId ?? prev.conversationId,
            };
          });
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof Error ? err.message : "Could not answer that.";
          setSession((prev) =>
            patchLastAssistant(prev, (m) => ({
              ...m,
              status: "error",
              error: msg,
            })),
          );
        });
    },
    [],
  );

  /** End the current session window and clear the transcript — the user clicked
   *  "New conversation". Best-effort tells the server to drop the stored turns. */
  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const id = convRef.current;
    convRef.current = null;
    lastActivityRef.current = 0;
    clearPersistedAsk();
    setSession(INITIAL_SESSION);
    if (id) Agent.endConversation(id).catch(() => undefined);
  }, []);

  return { session, ask, confirm, clarify, cancel, newConversation };
}
