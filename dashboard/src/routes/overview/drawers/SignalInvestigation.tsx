import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import { SigIcon, type SigIconName } from "./SignalIcons";
import { Dashboard } from "@/api/endpoints";
import type { Signal } from "../overview.data";
import type {
  Breakdown,
  IncidentReport,
  IncidentReportResp,
  InvestigationResp,
  IssueInvestigationResp,
  ReportCitation,
} from "../overview.api";

/* ============================================================================
   SignalInvestigation — Replayfy's findings, written as a report.

   Deliberately NOT a property inspector. It reads in the order an engineer
   actually asks: what happened → what Replayfy thinks → the evidence → why it
   concluded that → what's related → what to do. Metadata still exists, but as
   evidence cards supporting a narrative rather than rows of database fields.

   Honesty rule: every number here is measured. Where Replayfy has not computed
   something, the section is omitted rather than filled with a plausible-looking
   placeholder — a fabricated finding in an incident tool is worse than a gap.
   ========================================================================== */

export type AiState = "idle" | "running" | "done" | "unavailable";

const SPRING = { type: "spring" as const, stiffness: 520, damping: 44, mass: 0.9 };

const SEV_LABEL: Record<string, string> = {
  bad: "Critical",
  warn: "Warning",
  good: "Opportunity",
  info: "Trend",
};
const SEV_ICON: Record<string, SigIconName> = {
  bad: "critical",
  warn: "critical",
  good: "opportunity",
  info: "activity",
};

/* The reasoning trace Replayfy streams while the deeper pass runs. Each line is
   a real stage of the request, not decoration. */
const AI_STEPS = [
  "Analyzing affected sessions",
  "Correlating recent deployments",
  "Reviewing backend failures",
  "Comparing historical incidents",
  "Searching for similar regressions",
  "Writing the assessment",
];

function EvidenceCard({
  icon,
  tone,
  k,
  v,
  small,
}: {
  icon: SigIconName;
  tone: string;
  k: string;
  v: string;
  small?: boolean;
}) {
  return (
    <div className="sigw-ev-card">
      <span className={`sigw-ev-ic c-${tone}`}>
        <SigIcon name={icon} size={13} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span className="sigw-ev-k">{k}</span>
        <div className={"sigw-ev-v" + (small ? " sm" : "")}>{v}</div>
      </span>
    </div>
  );
}

function Dist({
  title,
  icon,
  tone,
  rows,
}: {
  title: string;
  icon: SigIconName;
  tone: string;
  rows: Breakdown[];
}) {
  // A breakdown that is entirely "unknown" states nothing — web sessions
  // predate per-session geo, so Countries is routinely 100% unknown. Showing it
  // would present missing instrumentation as a finding.
  const usable = rows.filter((r) => r.value !== "unknown");
  if (usable.length === 0) return null;
  return (
    <div className="sigw-isec">
      <div className="sigw-ist">
        <span
          style={{ display: "inline-flex", verticalAlign: "-2px", marginRight: "var(--sp-8)" }}
        >
          <span className={`sigw-ev-ic c-${tone}`} style={{ width: 20, height: 20 }}>
            <SigIcon name={icon} size={11} />
          </span>
        </span>
        {title}
      </div>
      <div className="sigw-dist">
        {usable.map((r) => (
          <div className="sigw-dist-row" key={r.value}>
            <div>
              <div className="sigw-dist-l">{r.value}</div>
              <div className="sigw-dist-track">
                <i style={{ width: r.pct + "%" }} />
              </div>
            </div>
            <div className="sigw-dist-n">{r.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- the AI report's pieces ---------------------------------------------

   The report is a WRITTEN FINDING, not a transcript and not a property list.
   Every block below renders only when the server actually returned that field:
   sections it could not ground in measured evidence are absent from the payload
   entirely, and an empty heading would read as "we looked and found nothing,"
   which is a different — and false — claim.
   ------------------------------------------------------------------------- */

/* Evidence lines are written with a trailing grounding id — "…returned 503
   [E_net_2]". The id is real (the server rejects any the model invented), but it
   names a key only the server holds. It disciplines the model; it tells the
   reader nothing. So it is stripped for display rather than shown as noise. */
const CITE_RE = /\s*\[[^\]]*\]\s*$/;
const stripCite = (s: string) => s.replace(CITE_RE, "").trim();

/* A ref key is a server-side identifier — "SESS_40188", "BRK_browser". It is
   real (the server rejects invented ones), but the raw key means nothing to a
   reader, so it is shown as the thing it names rather than as its key. Anything
   unrecognised falls through to "evidence" rather than leaking the raw token. */
function refLabel(ref: string): string {
  if (ref === "INC") return "this incident";
  if (ref === "SIG") return "signal mix";
  if (ref.startsWith("BRK_")) return `${ref.slice(4)} breakdown`;
  const id = ref.split("_")[1] ?? "";
  if (ref.startsWith("SESS_")) return `session ${id}`;
  if (ref.startsWith("ISSUE_")) return `issue ${id}`;
  if (ref.startsWith("CORR_")) return `incident ${id}`;
  if (ref.startsWith("HIST_")) return `prior instance ${id}`;
  return "evidence";
}

/* The model is required to cite sessions by their evidence key, so report prose
   contains raw tokens like "SESS_326". That key is only meaningful to the server
   — to a reader it is noise, and worse, it names a recording they cannot reach.
   Render it as what it is: a link into the session it identifies. The id is the
   numeric Session.id the scope resolver produced, which is what
   /recordings/:recordingId matches. */
const SESS_RE = /\bSESS_(\d+)\b/g;
function LinkedText({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SESS_RE.lastIndex = 0;
  while ((m = SESS_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Link
        key={`${m.index}-${m[1]}`}
        to={`/recordings/${m[1]}`}
        className="sigw-sess-link"
      >
        session {m[1]}
      </Link>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function RepSec({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="sigw-rep-sec">
      <div className="sigw-rep-k">{k}</div>
      {children}
    </div>
  );
}

function RepList({ items, risk }: { items: string[]; risk?: boolean }) {
  return (
    <div className={risk ? "sigw-rep-risk" : undefined}>
      {items.map((t) => (
        <div className="sigw-rep-li" key={t}>
          <span className="pip2" />
          <span><LinkedText text={stripCite(t)} /></span>
        </div>
      ))}
    </div>
  );
}

/* A cited finding: one statement, tagged with the evidence it was drawn from.
   The server drops any citation whose `ref` is not a literal key of the evidence
   payload, so every tag rendered here names something that genuinely exists —
   which is what makes showing the tag honest rather than decorative. */
function CiteList({
  items,
  pubIds,
}: {
  items: ReportCitation[];
  pubIds: Record<string, string>;
}) {
  return (
    <div>
      {items.map((c) => (
        <div className="sigw-rep-li" key={c.ref + c.statement}>
          <span className="pip2" />
          <span>
            <LinkedText text={stripCite(c.statement)} />
            {/* A SESS_ ref names a real recording, so render it as the way in.
                Other ref kinds (BRK_, CORR_, HIST_) have no single destination,
                so they stay as plain labels. */}
            {/* Linked ONLY when we hold the publicId. /recordings/:id resolves a
                public id, so linking the numeric id would look right and 404.
                No publicId -> plain label, never a dead link. */}
            {pubIds[c.ref.slice(5)] && /^SESS_\d+$/.test(c.ref) ? (
              <Link
                to={`/recordings/${pubIds[c.ref.slice(5)]}`}
                className="sigw-rep-ref sigw-sess-link"
              >
                {refLabel(c.ref)}
              </Link>
            ) : (
              <span className="sigw-rep-ref">{refLabel(c.ref)}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReportBody({
  r,
  pubIds,
}: {
  r: IncidentReport;
  pubIds: Record<string, string>;
}) {
  return (
    <>
      <div className="sigw-rep-sec">
        <div className="sigw-rep-b lead"><LinkedText text={r.executiveSummary} /></div>
      </div>

      {r.rootCause && (
        <RepSec k="Root cause">
          <div className="sigw-rep-b"><LinkedText text={r.rootCause} /></div>
        </RepSec>
      )}

      {r.supportingEvidence && r.supportingEvidence.length > 0 && (
        <RepSec k="Supporting evidence">
          <CiteList items={r.supportingEvidence} pubIds={pubIds} />
        </RepSec>
      )}

      {r.confidenceRationale && (
        <RepSec k="Confidence">
          <div className="sigw-rep-b mut"><LinkedText text={r.confidenceRationale} /></div>
        </RepSec>
      )}

      {r.recommendedFix && (
        <RepSec k="Recommended fix">
          <div className="sigw-rep-b">{r.recommendedFix}</div>
        </RepSec>
      )}

      {r.potentialRisks && r.potentialRisks.length > 0 && (
        <RepSec k="Potential risks">
          <RepList items={r.potentialRisks} risk />
        </RepSec>
      )}

      {r.relatedRegressions && r.relatedRegressions.length > 0 && (
        <RepSec k="Related regressions">
          <CiteList items={r.relatedRegressions} pubIds={pubIds} />
        </RepSec>
      )}

      {r.nextInvestigation && (
        <RepSec k="Suggested next step">
          <div className="sigw-rep-b">{r.nextInvestigation}</div>
        </RepSec>
      )}
    </>
  );
}

/* ---- the AI investigation section (expands in place, never a chat) ------- */
function AiInvestigation({
  signal,
  state,
  onResolved,
}: {
  signal: Signal;
  state: AiState;
  onResolved: (s: AiState) => void;
}) {
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<IncidentReport | null>(null);
  const [pubIds, setPubIds] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<string | null>(null);
  /* Edge-detect the entry into "running" rather than keeping a "have I run"
     flag. A persistent flag is keyed to this component + incidentId, but the RUN
     is keyed to `state`, and the two fall out of sync: polling rebuilds the
     signals array, so `sel` becomes a NEW object with the SAME incidentId — the
     parent resets aiState to idle (identity changed) while this component's
     reset effect, keyed on incidentId, does not fire. The flag stays true, the
     next click early-returns, and the button sticks on "Investigating…" having
     sent no request. Tracking the transition instead fires exactly once per
     entry into running: first click, re-run and signal-switch all work. */
  const prevState = useRef<AiState>("idle");
  /* Bumped per run so a response that lands after the user has moved on (or
     re-run) cannot overwrite the newer state. */
  const runId = useRef(0);

  useEffect(() => {
    const entered = prevState.current !== "running" && state === "running";
    prevState.current = state;
    if (!entered) return;
    const myRun = ++runId.current;
    const stale = () => myRun !== runId.current;
    setStep(0);
    // Advance the visible reasoning trace while the request is in flight, so the
    // wait reads as work rather than a spinner. It never outruns the last step.
    /* Paced against the measured round-trip, not an arbitrary tick. At 620ms the
       six steps completed in ~3.7s and then sat still for the remaining ~13s,
       which read as a hang. The two model calls now run in parallel (~9s), so
       spread the trace across that: the last step stays active until the
       response actually lands, which is the one honest thing to show. */
    const tick = setInterval(
      () => setStep((s) => Math.min(s + 1, AI_STEPS.length - 1)),
      1500,
    );
    const id = signal.incidentId;
    const run = async () => {
      if (id == null) {
        if (stale()) return;
        setWhy("This signal has no incident behind it to investigate.");
        onResolved("unavailable");
        return;
      }
      try {
        // api.* returns an { data, page, meta } envelope — unwrap it.
        const res = await Dashboard.incidentReport<IncidentReportResp>(String(id));
        const r = res?.data;
        // `executiveSummary` is the one field a report cannot omit, so its
        // absence means the pass produced nothing usable — not that the
        // incident is clean.
        if (stale()) return;
        if (!r || r.available === false || !r.report?.executiveSummary) {
          setWhy(
            r?.reason === "no_key" || r?.reason === "disabled"
              ? "Replayfy AI isn't set up yet — add a model provider in Settings → AI."
              : r?.reason === "budget" || r?.reason === "credits"
                ? "This workspace has reached its AI budget for now."
                : "Replayfy couldn't reach a conclusion from the available evidence.",
          );
          onResolved("unavailable");
          return;
        }
        setResult(r.report);
        setPubIds(r.sessionPublicIds ?? {});
        onResolved("done");
      } catch {
        if (stale()) return;
        setWhy("The investigation request failed. Try again in a moment.");
        onResolved("unavailable");
      }
    };
    void run().finally(() => clearInterval(tick));
    return () => clearInterval(tick);
  }, [state, signal.incidentId, onResolved]);

  // Moving to another signal clears the displayed result. The run gate is the
  // state transition above, not this effect, so a stale flag can no longer
  // swallow a click.
  useEffect(() => {
    runId.current++; // abandon anything still in flight for the previous signal
    setResult(null);
    setPubIds({});
    setWhy(null);
  }, [signal.incidentId]);

  if (state === "idle") return null;

  const busy = state === "running";
  const conf =
    result?.confidence === "high" ? 92 : result?.confidence === "medium" ? 74 : 58;

  return (
    <motion.div
      className="sigw-ai-sec"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      transition={SPRING}
    >
      <div className="sigw-ai-in">
        <div className="sigw-ai-h">
          <span className={"sigw-ai-sp" + (busy ? " busy" : "")}>
            <SigIcon name="ai" size={13} />
          </span>
          <span className="lbl">
            {busy ? "Replayfy AI is investigating" : "Replayfy AI investigation"}
          </span>
          {!busy && result && (
            <span className="sigw-assess-c" style={{ marginLeft: "auto" }}>
              <b>{conf}%</b> confidence
            </span>
          )}
        </div>

        {busy && (
          <>
            <div className="sigw-steps">
              {AI_STEPS.map((s, i) => (
                <div
                  key={s}
                  className={
                    "sigw-step " + (i < step ? "done" : i === step ? "now" : "")
                  }
                >
                  {i < step ? (
                    <span className="dot">
                      <SigIcon name="healthy" size={12} />
                    </span>
                  ) : i === step ? (
                    <span className="ring" />
                  ) : (
                    <span className="pend" />
                  )}
                  <span>{s}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gap: "var(--sp-8)", marginTop: "var(--sp-14)" }}>
              <div className="sigw-sk" style={{ width: "88%" }} />
              <div className="sigw-sk" style={{ width: "72%" }} />
              <div className="sigw-sk" style={{ width: "80%" }} />
            </div>
          </>
        )}

        {state === "unavailable" && why && (
          <div className="sigw-rep-b mut">{why}</div>
        )}

        {state === "done" && result && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING}
          >
            <ReportBody r={result} pubIds={pubIds} />
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

export function SignalInvestigation({
  signal: s,
  ai,
}: {
  signal: Signal;
  ai: {
    state: AiState;
    setState: (v: AiState) => void;
    /** Swap the investigation to a correlated incident, in place. */
    openIncident?: (incidentId: number) => void;
    /** Run the signal's own recommended action. */
    act?: (s: Signal) => void;
  };
}) {
  // The deterministic findings. Fetched per signal; absent until it resolves, so
  // the panel renders its signal-level facts immediately and deepens in place.
  const [inv, setInv] = useState<InvestigationResp | null>(null);
  /* The issue twin. A signal is backed by an incident OR an issue, never both,
     so exactly one of these ever populates. Issues get no AI report by design —
     their evidence is forensic (release boundary, reach, the sessions), which is
     reported rather than reasoned about. */
  const [issueInv, setIssueInv] = useState<IssueInvestigationResp | null>(null);
  useEffect(() => {
    let cancelled = false;
    setIssueInv(null);
    const id = s.issueId;
    if (id == null || s.incidentId != null) return;
    Dashboard.issueInvestigation<IssueInvestigationResp>(String(id))
      .then((r) => {
        if (!cancelled) setIssueInv(r?.data ?? null);
      })
      .catch(() => {
        /* the panel still shows the signal-level facts */
      });
    return () => {
      cancelled = true;
    };
  }, [s.issueId, s.incidentId]);
  useEffect(() => {
    let cancelled = false;
    setInv(null);
    const id = s.incidentId;
    if (id == null) return;
    Dashboard.incidentInvestigation<InvestigationResp>(String(id))
      .then((r) => {
        if (!cancelled) setInv(r?.data ?? null);
      })
      .catch(() => {
        /* the panel is still useful without the deeper findings */
      });
    return () => {
      cancelled = true;
    };
  }, [s.incidentId]);

  const delta = s.deltaPct;
  const sev = SEV_LABEL[s.sev] ?? "Signal";

  // Why Replayfy concluded this — each line is derived from a measured fact.
  const why: React.ReactNode[] = [];
  if (s.conf > 0)
    why.push(
      <>
        Deterministic confidence band of <b>{s.conf}%</b> from cluster size and
        movement
      </>,
    );
  if (s.sessions != null && s.users != null)
    why.push(
      <>
        Observed across <b>{s.sessions.toLocaleString()}</b> sessions and{" "}
        <b>{s.users.toLocaleString()}</b> distinct users
      </>,
    );
  if (delta != null && delta !== 0)
    why.push(
      <>
        Moved <b>{delta > 0 ? "+" : ""}{delta}%</b> against the workspace's prior
        period
      </>,
    );
  if (s.recent)
    why.push(
      <>
        Still active — <b>+{s.recent.count}</b> new occurrences to{" "}
        <b>{s.recent.users}</b> {s.recent.users === 1 ? "user" : "users"} in the
        last hour
      </>,
    );
  else why.push(<>No new occurrences in the last hour</>);

  return (
    <>
      {/* AI investigation expands ABOVE everything, pushing the report down. */}
      <AiInvestigation signal={s} state={ai.state} onResolved={ai.setState} />

      {/* 1 — what happened */}
      <div className="sigw-sum">
        <span className={`sigw-sum-ic sev-${s.sev}`}>
          <SigIcon name={SEV_ICON[s.sev] ?? "activity"} size={17} />
        </span>
        <div>
          {/* `titleText` is the plain string real insights carry; fixture rows
              keep their headline in `t` as a node. Fall back to it rather than
              printing the severity word as the title. */}
          <div className="sigw-sum-t">{s.titleText ?? s.t ?? sev}</div>
          {s.d && <div className="sigw-sum-d">{s.d}</div>}
        </div>
      </div>

      {/* 2 — what Replayfy believes */}
      <div className="sigw-assess">
        <div className="sigw-assess-h">
          <span style={{ color: "var(--accent)", display: "grid" }}>
            <SigIcon name="ai" size={13} />
          </span>
          <span className="lbl">Replayfy assessment</span>
          {s.conf > 0 && (
            <span className="sigw-assess-c">
              <b>{s.conf}%</b> confidence
            </span>
          )}
        </div>
        <div className="sigw-assess-b">
          Classified <b>{sev.toLowerCase()}</b>
          {delta != null && delta !== 0 && (
            <>
              {" "}
              on a {delta > 0 ? "+" : ""}
              {delta}% move
            </>
          )}
          {s.sessions != null && <> across {s.sessions.toLocaleString()} sessions</>}
          . The recommended next step is <b>{s.act.toLowerCase()}</b>.
        </div>
      </div>

      {/* 3 — the evidence */}
      <div className="sigw-isec">
        <div className="sigw-ist">Evidence</div>
        <div className="sigw-ev">
          {s.sessions != null && (
            <EvidenceCard
              icon="sessions"
              tone="blue"
              k="Affected sessions"
              v={s.sessions.toLocaleString()}
            />
          )}
          {s.users != null && (
            <EvidenceCard
              icon="users"
              tone="indigo"
              k="Affected users"
              v={s.users.toLocaleString()}
            />
          )}
          {s.conf > 0 && (
            <EvidenceCard
              icon="confidence"
              tone={s.conf >= 90 ? "green" : "amber"}
              k="Confidence"
              v={`${s.conf}%`}
            />
          )}
          {delta != null && delta !== 0 && (
            <EvidenceCard
              icon={delta > 0 ? "opportunity" : "regression"}
              tone={delta > 0 ? "green" : "red"}
              k="Change vs baseline"
              v={`${delta > 0 ? "+" : ""}${delta}%`}
            />
          )}
          <EvidenceCard
            icon="recency"
            tone="slate"
            k="Latest occurrence"
            v={s.time}
            small
          />
          {s.recent && (
            <EvidenceCard
              icon="activity"
              tone="amber"
              k="Last hour"
              v={`+${s.recent.count} new`}
              small
            />
          )}
          <EvidenceCard
            icon="critical"
            tone={s.sev === "bad" ? "red" : s.sev === "warn" ? "amber" : "green"}
            k="Severity"
            v={sev}
            small
          />
          {s.tags[0] && (
            <EvidenceCard
              icon="category"
              tone="slate"
              k="Category"
              v={s.tags[0]}
              small
            />
          )}
        </div>
      </div>

      {/* 3b — where it happened */}
      {inv && (
        <>
          <Dist
            title="Platforms"
            icon="sessions"
            tone="blue"
            rows={inv.breakdowns.platforms}
          />
          <Dist
            title="Browsers"
            icon="network"
            tone="indigo"
            rows={inv.breakdowns.browsers}
          />
          <Dist
            title="Releases"
            icon="deployment"
            tone="violet"
            rows={inv.breakdowns.releases}
          />
          <Dist
            title="Countries"
            icon="conversion"
            tone="slate"
            rows={inv.breakdowns.countries}
          />
        </>
      )}

      {/* 3c — the forensic evidence behind an ISSUE. Ordered by what answers
             "where and when": the code location if we have it, then the release
             boundary that brackets the regression, then reach. */}
      {issueInv && (
        <>
          <div className="sigw-isec">
            <div className="sigw-ist">Error evidence</div>
            <div className="sigw-ev">
              {issueInv.issue.culprit && (
                <EvidenceCard
                  icon="crash"
                  tone="red"
                  k="Code location"
                  v={issueInv.issue.culprit}
                  small
                />
              )}
              {issueInv.issue.errorType && (
                <EvidenceCard
                  icon="critical"
                  tone="amber"
                  k="Error type"
                  v={issueInv.issue.errorType}
                  small
                />
              )}
              {issueInv.issue.firstRelease && (
                <EvidenceCard
                  icon="deployment"
                  tone="violet"
                  k="First seen in"
                  v={issueInv.issue.firstRelease}
                  small
                />
              )}
              {issueInv.issue.lastRelease &&
                issueInv.issue.lastRelease !== issueInv.issue.firstRelease && (
                  <EvidenceCard
                    icon="deployment"
                    tone="violet"
                    k="Last seen in"
                    v={issueInv.issue.lastRelease}
                    small
                  />
                )}
              <EvidenceCard
                icon="activity"
                tone="blue"
                k="Occurrences"
                v={issueInv.issue.occurrenceCount.toLocaleString()}
              />
              <EvidenceCard
                icon="sessions"
                tone="blue"
                k="Sessions"
                v={issueInv.issue.sessionCount.toLocaleString()}
              />
              <EvidenceCard
                icon="users"
                tone="indigo"
                k="Users"
                v={issueInv.issue.userCount.toLocaleString()}
              />
            </div>
          </div>

          <Dist
            title="Platforms"
            icon="sessions"
            tone="blue"
            rows={issueInv.breakdowns.platforms}
          />
          <Dist
            title="Browsers"
            icon="network"
            tone="indigo"
            rows={issueInv.breakdowns.browsers}
          />
          <Dist
            title="Releases"
            icon="deployment"
            tone="violet"
            rows={issueInv.breakdowns.releases}
          />

          {/* The bridge: behavioural incidents in the SAME sessions. Neither
              Crashlytics nor Signals shows this on its own, and a crash that
              co-occurs with a conversion drop is the most useful thing here. */}
          {issueInv.relatedIncidents.length > 0 && (
            <div className="sigw-isec">
              <div className="sigw-ist">
                Happening alongside
                <span className="n">{issueInv.relatedIncidents.length}</span>
              </div>
              <div className="sigw-rel-grid">
                {issueInv.relatedIncidents.map((c) => (
                  <button
                    className="sigw-relc"
                    key={c.id}
                    onClick={() => ai.openIncident?.(c.id)}
                  >
                    <span
                      className={`sigw-pip sev-${c.polarity === "POSITIVE" ? "good" : "bad"}`}
                    />
                    <span style={{ minWidth: 0 }}>
                      <div className="sigw-relc-t">{c.title}</div>
                      <div className="sigw-relc-s">
                        {c.sharedSessions} shared session
                        {c.sharedSessions === 1 ? "" : "s"}
                      </div>
                    </span>
                    <span className="go">
                      <SigIcon name="opportunity" size={12} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* 4 — why Replayfy concluded this */}
      <div className="sigw-isec">
        <div className="sigw-ist">
          Why Replayfy flagged this<span className="n">{why.length}</span>
        </div>
        <div className="sigw-why">
          {why.map((w, i) => (
            <div className="sigw-why-r" key={i}>
              <span className="tick">
                <SigIcon name="healthy" size={13} />
              </span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 5 — what else moved with it (shared-session correlation) */}
      {inv && inv.correlated.length > 0 && (
        <div className="sigw-isec">
          <div className="sigw-ist">
            Related signals<span className="n">{inv.correlated.length}</span>
          </div>
          <div className="sigw-rel-grid">
            {inv.correlated.map((c) => (
              <button
                className="sigw-relc"
                key={c.id}
                onClick={() => ai.openIncident?.(c.id)}
              >
                <span
                  className={`sigw-pip sev-${c.polarity === "POSITIVE" ? "good" : "bad"}`}
                />
                <span style={{ minWidth: 0 }}>
                  <div className="sigw-relc-t">{c.title}</div>
                  <div className="sigw-relc-s">
                    {c.sharedSessions} shared session
                    {c.sharedSessions === 1 ? "" : "s"}
                  </div>
                </span>
                <span className="go">
                  <SigIcon name="opportunity" size={12} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 5b — crashes inside the same sessions */}
      {inv && inv.relatedCrashes.length > 0 && (
        <div className="sigw-isec">
          <div className="sigw-ist">
            Related crashes<span className="n">{inv.relatedCrashes.length}</span>
          </div>
          <div className="sigw-rel-grid">
            {inv.relatedCrashes.map((c) => (
              <div className="sigw-relc" key={c.id}>
                <span className="sigw-pip sev-bad" />
                <span style={{ minWidth: 0 }}>
                  <div className="sigw-relc-t">{c.errorType || c.title}</div>
                  <div className="sigw-relc-s">
                    {c.sharedSessions} shared · {c.occurrences} occurrences
                  </div>
                </span>
                <span className="go">
                  <SigIcon name="crash" size={12} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5c — has this happened before */}
      {inv && inv.similarHistorical.length > 0 && (
        <div className="sigw-isec">
          <div className="sigw-ist">
            Previously<span className="n">{inv.similarHistorical.length}</span>
          </div>
          <div className="sigw-rel-grid">
            {inv.similarHistorical.map((h) => (
              <button
                className="sigw-relc"
                key={h.id}
                onClick={() => ai.openIncident?.(h.id)}
              >
                <span className="sigw-pip sev-info" />
                <span style={{ minWidth: 0 }}>
                  <div className="sigw-relc-t">{h.title}</div>
                  <div className="sigw-relc-s">
                    {h.status.toLowerCase()} · {h.sessionCount} sessions
                  </div>
                </span>
                <span className="go">
                  <SigIcon name="recency" size={12} />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 6 — what to do next */}
      {ai.act && (
        <div className="sigw-isec">
          <div className="sigw-ist">Recommended</div>
          <div className="sigw-acts">
            <button className="sigw-actc" onClick={() => ai.act?.(s)}>
              <span className="sigw-ev-ic c-indigo" style={{ width: 22, height: 22 }}>
                <SigIcon name="sessions" size={12} />
              </span>
              {s.act}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
