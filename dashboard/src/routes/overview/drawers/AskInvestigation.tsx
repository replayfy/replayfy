import { useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@/components/primitives";
import type {
  AskSession,
  AskAssistantMessage,
  Citation,
  SuggestedAction,
} from "../ask.api";

/* ---- Ask Replayfy: enterprise AI chat transcript ------------------------
   Renders the WHOLE in-session conversation (see useAskStream.session): every
   user turn and every assistant answer as distinct chat rows, oldest → newest,
   auto-scrolling to the bottom as new content streams in. The newest assistant
   answer streams token-by-token (narration deltas append into its body) while
   prior turns stay put. Per assistant turn we surface: a collapsible
   "thinking"/steps affordance (plan / step:start / investigating / step:done),
   evidence citation chips, suggestedAction buttons, and the confirm / clarify
   flows — all on the app's own tokens (no restyle of globals). */

const CHECK = (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

function citationIcon(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("session") || t.includes("record") || t.includes("replay"))
    return "rec";
  if (t.includes("funnel")) return "funnel";
  if (t.includes("network") || t.includes("console") || t.includes("trace"))
    return "console";
  if (t.includes("crash") || t.includes("error")) return "warn";
  return "spark";
}

/* Collapsible "thinking" affordance: live steps while streaming, auto-collapses
   into a one-line summary once the turn resolves (re-expandable on click). */
function AskThinking({ msg }: { msg: AskAssistantMessage }) {
  const streaming = msg.status === "streaming";
  const [open, setOpen] = useState(true);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false); // collapse once done
    wasStreaming.current = streaming;
  }, [streaming]);

  // A synthetic active row bridges the gap before the first step:start arrives.
  const rows = msg.steps.length
    ? msg.steps
    : streaming
      ? [{ label: msg.planReasoning || "Investigating…", done: false }]
      : [];
  if (!rows.length) return null;

  const activeIdx = msg.steps.findIndex((s) => !s.done);
  const count = msg.steps.length || rows.length;
  const header = streaming
    ? rows.find((r) => !r.done)?.label || "Investigating…"
    : `Investigated ${count} source${count === 1 ? "" : "s"}`;

  return (
    <div className={"ask-think" + (open ? " open" : "")}>
      <button className="ask-think-h" onClick={() => setOpen((o) => !o)}>
        <span className="atk-ic">
          {streaming ? <span className="rd-spinner sm" /> : CHECK}
        </span>
        <span className="atk-t">{header}</span>
        <span className="atk-chev">
          <Icon name="chev" size={13} />
        </span>
      </button>
      {open && (
        <div className="ask-think-body">
          {rows.map((s, i) => {
            const isActive =
              !s.done &&
              streaming &&
              (msg.steps.length ? i === activeIdx : true);
            return (
              <div
                className={
                  "ask-step " +
                  (s.done ? "done " : "") +
                  (isActive ? "active" : "")
                }
                key={i}
              >
                <span className="as-ic">
                  {s.done ? CHECK : <span className="rd-spinner sm" />}
                </span>
                <span className="as-t">{s.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* Minimal inline markdown for streamed answers: **bold** and `code` only.
   Anything else stays literal — the agent writes prose, not documents. */
/**
 * Renders the assistant's answer as real Markdown — GFM tables, lists, headings,
 * code — instead of the old inline-only pass that left `| a | b |` tables as raw
 * pipes. react-markdown escapes HTML (no raw-HTML plugin), so model output over
 * untrusted evidence can't inject markup. Styling lives in overview-v3.css scoped
 * to `.ask-body`, so it stays inside the approved design.
 */
const MD_COMPONENTS: Components = {
  // Wrap tables so a wide one scrolls horizontally inside the narrow chat panel
  // rather than blowing out the bubble width. `node` is dropped so it never lands
  // on the DOM element.
  table: ({ node: _n, ...props }) => (
    <div className="ask-table-wrap">
      <table {...props} />
    </div>
  ),
  // Links open safely in a new tab.
  a: ({ node: _n, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

function AskMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}

/**
 * The full outgoing content of a confirmable EXTERNAL action, assembled from the
 * preview's `details`, so the user approves exactly what will be sent — not just
 * a one-line summary. The server now includes the real payload here: `body` (the
 * rendered Markdown for a Linear/GitHub issue) or, for Slack, the individual
 * fields it posts. Returns "" when there's nothing extra to show (an update/
 * delete whose summary already says everything).
 */
function previewBody(details: Record<string, unknown> | undefined): string {
  if (!details) return "";
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const arr = (v: unknown) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string") as string[]) : [];
  // Linear / GitHub: the server already rendered the whole issue body.
  if (s(details.body)) return s(details.body);
  // Slack: no single body — reassemble the fields that will be posted, in order.
  const lines = [
    s(details.summary),
    s(details.impact),
    s(details.confidence) && `Confidence: ${s(details.confidence)}`,
    s(details.release) && `Release: ${s(details.release)}`,
    arr(details.platforms).length && `Platforms: ${arr(details.platforms).join(", ")}`,
    arr(details.sessions).length && `Sessions: ${arr(details.sessions).join(", ")}`,
    arr(details.nextSteps).length &&
      `Next steps:\n- ${arr(details.nextSteps).join("\n- ")}`,
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

/* One assistant answer row: thinking → streamed body → citations → actions. */
function AssistantRow({
  msg,
  question,
  onConfirm,
  onClarify,
  onAction,
  onCitation,
}: {
  msg: AskAssistantMessage;
  question: string;
  onConfirm: (pendingActionId: string, ok: boolean) => void;
  onClarify: (
    value: string,
    rememberAs: string | undefined,
    message: string,
  ) => void;
  onAction?: (action: SuggestedAction) => void;
  onCitation?: (c: Citation) => void;
}) {
  const {
    status,
    answer,
    citations,
    suggestedActions,
    pending,
    clarify,
    error,
  } = msg;
  const streaming = status === "streaming";
  const bodyText = error
    ? error
    : pending
      ? pending.summary
      : clarify
        ? clarify.question
        : answer;
  const showBody = !!bodyText || streaming;
  const hasActions =
    !!pending ||
    !!(clarify && clarify.candidates && clarify.candidates.length) ||
    suggestedActions.length > 0;

  return (
    <div className="ask-msg assistant">
      <span className="ask-av">
        <Icon name="spark" size={12} fill />
      </span>
      <div className="ask-bub">
        <AskThinking msg={msg} />
        {showBody && (
          <div className={"ask-ans" + (error ? " err" : "")}>
            {bodyText ? (
              // A div, not a p: markdown emits block elements (tables, lists,
              // paragraphs) that are invalid inside a <p>.
              <div className="ask-body">
                <AskMarkdown>{bodyText}</AskMarkdown>
                {streaming && answer && (
                  <span className="ask-caret" aria-hidden="true" />
                )}
              </div>
            ) : (
              <div className="ask-typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        )}
        {citations.length > 0 && (
          <div className="ask-ev">
            {citations.map((c: Citation, i) => (
              <button
                className="aa-chip"
                key={c.ref + i}
                onClick={() => onCitation && onCitation(c)}
                title={`Open ${c.label || c.ref}`}
              >
                <Icon name={citationIcon(c.type)} size={11} />{" "}
                {c.label || c.ref}
              </button>
            ))}
          </div>
        )}
        {/* What a confirmable external action will ACTUALLY send — the full
            issue body / Slack fields, not just the summary. The body is Markdown
            (headings, lists), so it renders through the same Markdown pass as the
            answer; the user must be able to read what they're approving. */}
        {pending &&
          (() => {
            const outgoing = previewBody(pending.details);
            if (!outgoing) return null;
            return (
              <div className="ask-ans">
                <div className="ask-body">
                  <AskMarkdown>{outgoing}</AskMarkdown>
                </div>
              </div>
            );
          })()}
        {hasActions && (
          <div className="ask-acts">
            {pending ? (
              <>
                <button
                  className="btn primary sm"
                  disabled={status === "confirming"}
                  onClick={() => onConfirm(pending.pendingActionId, true)}
                >
                  <Icon name="spark" size={11} fill /> Confirm
                </button>
                <button
                  className="btn sm"
                  disabled={status === "confirming"}
                  onClick={() => onConfirm(pending.pendingActionId, false)}
                >
                  Cancel
                </button>
              </>
            ) : clarify && clarify.candidates && clarify.candidates.length ? (
              clarify.candidates.map((cand) => (
                <button
                  className="btn sm"
                  key={cand.value}
                  onClick={() =>
                    onClarify(cand.value, clarify.rememberAs, question)
                  }
                >
                  {cand.label}
                  {cand.count != null ? ` · ${cand.count}` : ""}
                </button>
              ))
            ) : (
              suggestedActions.map((a, i) => (
                <button
                  className={i === 0 ? "btn primary sm" : "btn sm"}
                  key={a.id ?? a.kind + i}
                  title={a.reason}
                  onClick={() => onAction && onAction(a)}
                >
                  {i === 0 && <Icon name="play" size={11} fill />} {a.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function AskInvestigation({
  session,
  onConfirm,
  onClarify,
  onAction,
  onCitation,
}: {
  session: AskSession;
  onConfirm: (pendingActionId: string, ok: boolean) => void;
  onClarify: (
    value: string,
    rememberAs: string | undefined,
    message: string,
  ) => void;
  onAction?: (action: SuggestedAction) => void;
  onCitation?: (c: Citation) => void;
}) {
  const { messages } = session;
  // Scrolling is owned by the panel's useStickToBottom hook (stick-to-bottom with
  // user override), not a per-render scrollIntoView here — that snapped the view
  // back to the bottom on every token even when the reader had scrolled up.

  if (!messages.length) {
    return (
      <div className="ask-chat empty">
        <span className="ask-empty-badge">
          <Icon name="spark" size={13} fill />
        </span>
        <div className="ask-empty-t">Ask Replayfy AI</div>
        <div className="ask-empty-d">
          Ask anything about your product health, conversion, crashes or
          sessions. Answers are grounded in your live data — with the evidence
          to back them up.
        </div>
      </div>
    );
  }

  return (
    <div className="ask-chat">
      {messages.map((m, i) => {
        if (m.role === "user") {
          return (
            <div className="ask-msg user" key={m.id}>
              <div className="ask-bub">{m.text}</div>
            </div>
          );
        }
        // The clarify handler needs the question that prompted this answer — the
        // immediately-preceding user turn.
        const prev = messages[i - 1];
        const question = prev && prev.role === "user" ? prev.text : "";
        return (
          <AssistantRow
            key={m.id}
            msg={m}
            question={question}
            onConfirm={onConfirm}
            onClarify={onClarify}
            onAction={onAction}
            onCitation={onCitation}
          />
        );
      })}
    </div>
  );
}
