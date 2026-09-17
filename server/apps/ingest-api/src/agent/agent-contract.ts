/**
 * THE AGENT CONTRACT — the canonical shape of everything the Replayfy AI returns,
 * and the events it streams. This is the single source of truth the frontend
 * builds against (mirrored in the dashboard repo). Lock changes here first.
 *
 * Two transports, one shape:
 *   • POST /v1/agent            → returns a final `AgentMessage`.
 *   • GET  /v1/agent/stream (SSE) → emits `AgentStreamEvent`s, ending with a
 *                                   `{ type: "done", message: AgentMessage }`.
 * A non-streaming client can ignore the stream and use the `done` message; a
 * streaming client renders events live and reconciles with `done`.
 */

/**
 * How fresh an answer must be — set per capability/query, consumed by the
 * caching layer (see memory ai-caching-approach):
 *   live      — always execute latest (or a very short-lived cache); never cache
 *               the final answer.
 *   near-live — reuse cached evidence unless the workspace version changed;
 *               re-narrate.
 *   immutable — the result cannot change (yesterday's traffic, a finalized
 *               release comparison, "explain THIS replay"); cache the WHOLE
 *               answer, effectively forever.
 */
export type Freshness = "live" | "near-live" | "immutable";

/** Terminal outcome of a turn (matches the runtime strings the agent returns). */
export type AgentOutcome =
  | "ANSWERED"
  | "NEEDS_CONFIRMATION" // an update/delete/external action awaits confirm
  | "NEEDS_CLARIFICATION" // the agent is asking a question (ask-with-candidates)
  | "EXECUTED" // a confirmed action ran
  | "CANCELLED" // the user declined a confirmable action
  | "EXPIRED" // a pending action's window lapsed
  | "NOT_FOUND" // nothing to confirm
  | "REFUSED_OFFTOPIC"
  | "REFUSED_INJECTION"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "UNAVAILABLE"
  | "ERROR";

/**
 * A re-runnable reference to a session set behind an answer — powers
 * "Show recordings (N)" WITHOUT re-running the AI or minting a playlist. Prefer
 * `query` (a deterministic filter, re-executed paginated); fall back to
 * `snapshot` (concrete ids) only when the set isn't a clean query. See task #7.
 */
export type ResultRef =
  | {
      kind: "query";
      id: string;
      filter: Record<string, unknown>;
      count?: number;
    }
  | { kind: "snapshot"; id: string; sessionIds: string[]; count?: number };

/** A grounded pointer the narrative cites — a real session/issue/funnel/etc. */
export interface Citation {
  type: "session" | "issue" | "funnel" | "cohort" | "release" | "user";
  /** The public id / row id being cited (e.g. a session publicId). */
  ref: string;
  label?: string;
  /** Optional deep-link hint (e.g. a timestamp in ms for a replay). */
  atMs?: number;
}

/**
 * A typed evidence block the frontend renders as a rich card (not markdown).
 * Populated incrementally as capabilities declare their block type (tasks
 * #6–#11); `text` is the always-available fallback.
 */
export type EvidenceBlock =
  | {
      type: "metric-delta";
      title: string;
      metrics: Array<{
        key: string;
        label: string;
        value: number;
        prev?: number | null;
        deltaPct?: number;
        direction: "up" | "down" | "flat";
      }>;
    }
  | {
      type: "issue-card";
      issue: {
        id?: number;
        title: string;
        kind: "crash" | "error" | "behavioral";
        users: number;
        sessions: number;
        occurrences?: number;
        release?: string | null;
        recording?: string | null;
      };
    }
  | {
      type: "user-list";
      users: Array<{
        userId: string;
        email?: string | null;
        name?: string | null;
        country?: string | null;
        lastSeen?: string | null;
      }>;
      resultRef?: ResultRef;
    }
  | {
      type: "session-list";
      sessions: Array<{
        recording: string;
        outcome?: string;
        score?: number;
        platform?: string | null;
        durationMs?: number;
      }>;
      total?: number;
      resultRef?: ResultRef;
    }
  | {
      type: "funnel-viz";
      funnel: {
        id?: number;
        name: string;
        steps: Array<{ label: string; count: number; rate?: number }>;
      };
    }
  | { type: "text"; markdown: string };

/**
 * External tools a workspace can connect. Mirrors the `IntegrationProvider` enum
 * in the Prisma schema, but kept as a LOCAL union on purpose: this contract is
 * mirrored in the dashboard repo, which has no Prisma client, so it must stay
 * dependency-free. If the enum gains a member, add it here too.
 */
export type IntegrationProviderName =
  | "LINEAR"
  | "GITHUB"
  | "SLACK"
  | "PAGERDUTY"
  | "WEBHOOK"
  | "JIRA"
  | "LARK"
  | "SENTRY";

/**
 * What a suggested action DOES. Deliberately vendor-neutral: `file_issue` +
 * `provider` replaced the old `create_linear_issue`, which baked one vendor into
 * the type and made every other connected tool unreachable.
 */
export type SuggestedActionKind =
  | "create_funnel"
  | "create_cohort"
  | "create_alert"
  | "define_conversion"
  | "show_recordings"
  | "recompute"
  /** File this into the workspace's issue tracker — see `provider`. */
  | "file_issue"
  /** Post this to the workspace's chat tool — see `provider`. */
  | "post_message"
  /** Not an execution: deep-link the user to connect a provider they don't have. */
  | "connect_integration";

/**
 * A next step the assistant OFFERS; the user runs it. Never auto-executed.
 *
 * Selection is manifest + selector, NOT hardcoded branches: the server builds the
 * FEASIBLE set (what the evidence can actually prefill, what this role may run,
 * which providers are connected) and the model chooses which are RELEVANT to the
 * answer it just gave — or none at all. The server then validates every chosen id
 * back against its own candidates, so the model can only ever pick a real action,
 * never invent one.
 */
export interface SuggestedAction {
  /** Stable, server-minted id. The model selects BY this; the UI keys on it.
   *  An id the server did not mint is dropped. */
  id: string;
  kind: SuggestedActionKind;
  /** Server-authored, prefilled from evidence — never model prose. */
  label: string;
  /** Model-authored: why THIS action fits THIS answer, one short phrase. Shown as
   *  the chip's subtitle/tooltip. Absent if the model gave no reason. */
  reason?: string;
  /** The registry capability this maps to. Absent for `connect_integration`,
   *  which is a client-side navigation rather than an execution. */
  capability?: string;
  /** Prefilled input for the action. */
  input?: Record<string, unknown>;
  requiresConfirmation: boolean;
  /** Which external tool this targets. Set for file_issue / post_message /
   *  connect_integration; absent for native analytics actions. */
  provider?: IntegrationProviderName;
  /** False only on `connect_integration` — i.e. "you don't have this yet". */
  connected?: boolean;
}

/**
 * A question the agent asks when a required workspace fact is missing and not
 * high-confidence-inferable — offered WITH mined candidates so answering is one
 * tap. The answer is persisted to WorkspaceKnowledge so it's asked once, ever.
 * See tasks #3/#4.
 */
export interface Clarification {
  question: string;
  /** The WorkspaceKnowledge key the answer should be stored under. */
  rememberAs?: string;
  /** Observed candidates (e.g. tracked events) with frequencies, most-first. */
  candidates?: Array<{ value: string; label: string; count?: number }>;
  allowFreeText: boolean;
}

/**
 * The preview of a confirmable action (update/delete/external). Nothing has run;
 * the user confirms via POST /v1/agent/confirm with `pendingActionId`.
 */
export interface ExecutionPreviewDTO {
  operation: "update" | "delete" | "external";
  summary: string;
  permanent: boolean;
  reversible: boolean;
  details?: Record<string, unknown>;
  pendingActionId: string;
}

/** One inspectable round of the plan — which capabilities ran, and why. */
export interface PlanTraceRound {
  round: number;
  reasoning: string;
  steps: string[];
}

/**
 * THE canonical response. Every /v1/agent turn (and the SSE `done` event)
 * resolves to exactly this.
 */
export interface AgentMessage {
  outcome: AgentOutcome;
  conversationId: string | null;
  /** The natural-language answer (null on refusals/errors — see `narrative` use
   *  as the human message in those cases). */
  narrative: string | null;
  confidence?: "high" | "medium" | "low";
  /** Rich, typed evidence cards. Empty until capabilities populate it. */
  evidence: EvidenceBlock[];
  citations: Citation[];
  suggestedActions: SuggestedAction[];
  /** Present iff outcome === "NEEDS_CLARIFICATION". */
  clarification?: Clarification;
  /** Present iff outcome === "NEEDS_CONFIRMATION". */
  executionPreview?: ExecutionPreviewDTO;
  /** The inspectable plan (which capabilities ran each round, and why). */
  trace?: PlanTraceRound[];
  /** How fresh this answer is (drives client "as of" hints + caching). */
  freshness?: Freshness;
}

/**
 * The SSE event stream (task #2). Ordering per turn:
 *   plan* → (step:start → step:done)* / investigating* → evidence* →
 *   (narration token*)  → [needs_confirmation | needs_clarification] → done
 * `error` may arrive at any point and terminates the stream.
 */
export type AgentStreamEvent =
  | { type: "plan"; round: number; reasoning: string; steps: string[] }
  | { type: "step:start"; capability: string; label?: string }
  | { type: "step:done"; capability: string; ok: boolean; ms: number }
  | { type: "investigating"; source: string; detail?: string }
  | { type: "evidence"; block: EvidenceBlock }
  | { type: "narration"; token: string }
  | { type: "citation"; citation: Citation }
  | { type: "needs_confirmation"; preview: ExecutionPreviewDTO }
  | { type: "needs_clarification"; clarification: Clarification }
  | { type: "done"; message: AgentMessage }
  | { type: "error"; message: string };

/**
 * The sink the agent loop emits progress into during a streaming turn. Injected
 * by the streaming endpoint; the non-streaming endpoint passes nothing (emit is
 * a no-op). `isAborted` lets the loop stop early when the client disconnects
 * (Stop button / closed connection).
 */
export interface AgentStream {
  emit: (event: AgentStreamEvent) => void;
  isAborted?: () => boolean;
  /** Aborts on client disconnect — threaded into the model HTTP call so a
   *  dropped connection actually STOPS generation (and its billing), instead of
   *  the server finishing an answer nobody will see. */
  signal?: AbortSignal;
}
