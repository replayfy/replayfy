import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import {
  failingNetworkForSessions,
  listEventsForSessions,
} from "@replay/db-clickhouse";
import { LlmService } from "../llm/llm.service";
import { resolveIncidentSessionIds } from "../common/incident-scope";
import { errorText } from "../common/session-evidence";
import { IncidentInvestigationService } from "./incident-investigation.service";
import {
  DIAGNOSIS_MAX_TOKENS,
  DIAGNOSIS_SCHEMA,
  DIAGNOSIS_SYSTEM,
  REMEDIATION_MAX_TOKENS,
  REMEDIATION_SCHEMA,
  REMEDIATION_SYSTEM,
  type DiagnosisOutput,
  type RemediationOutput,
  type ReportCitation,
  type ReportConfidence,
} from "./incident-report.constants";

/**
 * The AI INVESTIGATION REPORT behind one incident — the model-written half of
 * the investigation panel, sitting above the deterministic findings that
 * incident-investigation.service.ts already computes.
 *
 * Two focused structured calls run SEQUENTIALLY (see incident-report.constants.ts
 * for the full rationale): DIAGNOSIS, then REMEDIATION with the diagnosed cause
 * as settled input. Call B is SKIPPED entirely when A produces no root cause —
 * an undiagnosed incident earns no prescriptions, which preserves the existing
 * "a missing cause is better than a wrong one" invariant and saves the tokens.
 *
 * Everything the model may cite is a literal key of the evidence payload, and
 * every ref it returns is checked back against those keys here. That check —
 * not the prompt rule — is what makes an invented citation impossible.
 *
 * Access pattern (per repo rule: never an N+1, never an unbounded scan):
 *   - the deterministic investigation's own five bounded queries, reused rather
 *     than re-derived (IncidentInvestigationService.detail);
 *   - ONE index-only probe of Signal @@index([incidentId, workspaceId, sessionId])
 *     for the incident's session ids (common/incident-scope.ts);
 *   - ONE Prisma groupBy for the signal-type split;
 *   - TWO ClickHouse reads, each batched across the WHOLE sample in one query
 *     (listEventsForSessions / failingNetworkForSessions) — never one per
 *     session, which is exactly what the older cause assembler did.
 * Bounded round trips regardless of how many sessions the incident holds.
 */

/** The assembled report. EVERY optional key is ABSENT when the model omitted it
 *  — the client renders no heading rather than an empty one. */
export interface IncidentReport {
  executiveSummary: string;
  confidence: ReportConfidence;
  rootCause?: string;
  supportingEvidence?: ReportCitation[];
  confidenceRationale?: string;
  recommendedFix?: string;
  potentialRisks?: string[];
  relatedRegressions?: ReportCitation[];
  nextInvestigation?: string;
}

export interface IncidentReportResponse {
  available: boolean;
  reason?: string;
  report: IncidentReport | null;
  model?: string | null;
  cached?: boolean;
  /** Numeric Session.id -> publicId, for the sampled sessions the report cites.
   *  /recordings/:id resolves a PUBLIC id, so without this a citation names a
   *  session the reader cannot open. Absent ids simply render unlinked. */
  sessionPublicIds?: Record<string, string>;
}

/** One representative session's diagnostic content, as the model sees it. */
interface SessionBundle {
  errors: string[];
  requests: string[];
}

@Injectable()
export class IncidentReportService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IncidentReportService.name);

  /** Raw-sample caps. The breakdowns are aggregated in SQL and cost nothing
   *  extra; these bound the TOKEN payload, not the query. */
  private static readonly MAX_SAMPLE_SESSIONS = 5;
  private static readonly MAX_ERRORS_PER_SESSION = 4;
  private static readonly MAX_REQUESTS_PER_SESSION = 4;
  private static readonly MAX_TEXT = 200;

  constructor(
    private readonly llm: LlmService,
    private readonly investigation: IncidentInvestigationService,
  ) {}

  async reportFor(
    workspaceId: number,
    incidentId: number,
    opts: { refresh?: boolean } = {},
  ): Promise<IncidentReportResponse> {
    if (!Number.isFinite(incidentId)) {
      return { available: false, reason: "not_found", report: null };
    }
    // `{ id, workspaceId }` is the tenant guard: `id` is caller-supplied and
    // `workspaceId` is JWT-derived, so a foreign id resolves to nothing.
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      include: { storyline: true },
    });
    if (!incident) {
      return { available: false, reason: "not_found", report: null };
    }

    // Cache hit. The panel fires this on every card open and each report costs
    // one or two reasoning calls over several thousand input tokens — uncached,
    // re-opening a card would re-bill the customer for an answer that cannot
    // have changed (the incident's window is closed once the clusterer moves on).
    if (!opts.refresh && incident.storyline?.reportJson) {
      return {
        available: true,
        report: incident.storyline.reportJson as unknown as IncidentReport,
        model: incident.storyline.causeModel,
        cached: true,
      };
    }

    const { evidence, sessionPublicIds } = await this.assembleEvidence(
      workspaceId,
      incident,
    );
    const refs = new Set(Object.keys(evidence));

    const diagRes = await this.llm.structured<DiagnosisOutput>(workspaceId, {
      system: DIAGNOSIS_SYSTEM,
      user: JSON.stringify({ EVIDENCE: evidence }),
      schema: DIAGNOSIS_SCHEMA as unknown as Record<string, unknown>,
      surface: "cause",
      label: "cause-diagnosis",
      maxTokens: DIAGNOSIS_MAX_TOKENS,
      temperature: 0,
    });
    if (!diagRes.ok) {
      // disabled / no_key / budget / credits / no_output — the panel falls back
      // to the deterministic investigation, which is complete on its own.
      return { available: false, reason: diagRes.reason, report: null };
    }

    // THE VALIDITY GATE. "" is the documented way to omit a section, which means
    // a TRUNCATED call — whose arguments degrade to `{}` rather than to a
    // missing tool call (openrouter.provider.ts safeParse) — is indistinguishable
    // from a deliberately-empty report by shape alone. `executiveSummary` is the
    // one field that always has something to say, so its absence means the pass
    // produced nothing usable, not that the incident is clean.
    const executiveSummary = this.clean(diagRes.data?.executiveSummary);
    if (!executiveSummary) {
      this.logger.warn(
        `incident report ${incidentId} (ws ${workspaceId}): diagnosis returned no summary — discarding`,
      );
      return { available: false, reason: "no_output", report: null };
    }

    const confidence: ReportConfidence =
      diagRes.data?.confidence === "high" ||
      diagRes.data?.confidence === "medium"
        ? diagRes.data.confidence
        : "low";
    const rootCause = this.clean(diagRes.data?.rootCause);

    /* Call B is conditional, not automatic: with no diagnosed mechanism there is
       nothing for a fix to address, and prescribing one anyway is precisely the
       confident-but-wrong output this design exists to prevent.

       Running A and B concurrently was tried and REVERTED. Measured over four
       runs it was ~18.1s mean against ~17.1s sequential — no improvement, while
       the spread on identical input was 11.8-24.8s, so the variance dwarfs any
       effect a single sample appears to show. The fixed cost is evidence
       assembly, not the second call. Concurrency also cost B its grounding: it
       could no longer see A's rootCause, only the raw evidence. Paying a real
       quality cost for an unmeasurable gain is a bad trade. */
    const rem = rootCause
      ? await this.llm.structured<RemediationOutput>(workspaceId, {
          system: REMEDIATION_SYSTEM,
          user: JSON.stringify({
            DIAGNOSIS: { rootCause, confidence },
            EVIDENCE: evidence,
          }),
          schema: REMEDIATION_SCHEMA as unknown as Record<string, unknown>,
          surface: "cause",
          label: "cause-remediation",
          maxTokens: REMEDIATION_MAX_TOKENS,
          temperature: 0,
        })
      : null;

    const report = this.assembleReport(
      { executiveSummary, confidence, rootCause },
      diagRes.data,
      rem && rem.ok ? rem.data : null,
      refs,
    );

    const model = this.llm.modelFor(
      await this.llm.getConfig(workspaceId),
      "cause",
    );
    // Same persist gate the cause hypothesis uses: a low-confidence report is
    // worth SHOWING once, but not worth caching as this incident's answer.
    if (report.confidence !== "low") {
      await this.persist(
        workspaceId,
        incident.id,
        incident.lastSeenAt,
        report,
        model,
      );
    }
    return { available: true, report, model, cached: false, sessionPublicIds };
  }

  /* ── evidence ─────────────────────────────────────────────────────────── */

  /**
   * The bounded evidence bundle. Its KEYS are the ref vocabulary the prompts
   * publish (INC, SIG, BRK_*, ISSUE_*, CORR_*, HIST_*, SESS_*), so a citation is
   * verifiable by set membership rather than by trusting the model.
   *
   * Three details here are load-bearing:
   *  - each BRK_* carries `unknownPct`, the share of affected sessions whose
   *    value was never captured. A release breakdown that is 100% unknown is
   *    missing instrumentation, not a finding, and the prompt needs to be able
   *    to SEE that rather than read a confident 100% bucket.
   *  - ISSUE_* carries `behavioral`. A behavioural issue is re-clustered from
   *    the very same signals as the incident, so counting it as corroboration
   *    would let one measurement inflate confidence three times over.
   *  - SESS_*.requests carry METHOD and PATH only. Host and query string are
   *    stripped before the model ever sees them, because a query string is where
   *    tokens and email addresses live.
   */
  private async assembleEvidence(
    workspaceId: number,
    incident: {
      id: number;
      title: string;
      signalType: string;
      polarity: string;
      screen: string;
      element: string;
      status: string;
      sessionCount: number;
      userCount: number;
      deltaPctX100: number;
      impactCents: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
    },
  ): Promise<{
    evidence: Record<string, unknown>;
    sessionPublicIds: Record<string, string>;
  }> {
    const incidentId = incident.id;
    const [detail, typeSplit, scope] = await Promise.all([
      // Reuse the deterministic investigation rather than re-deriving its
      // breakdowns, crashes, correlations and history — one implementation, so
      // the report can never disagree with the panel rendered beside it.
      this.investigation.detail(workspaceId, incidentId),
      this.db.signal.groupBy({
        by: ["type"],
        where: { incidentId },
        _count: { _all: true },
      }),
      resolveIncidentSessionIds(this.db, workspaceId, incidentId),
    ]);

    // The samples ride the NEWEST few sessions — resolveIncidentSessionIds
    // orders by sessionId DESC, so this is a prefix of what the user would see
    // in Recordings, not a random draw.
    const sampleIds = scope.ids.slice(
      0,
      IncidentReportService.MAX_SAMPLE_SESSIONS,
    );
    const [errorEvents, networkRows] = await Promise.all([
      sampleIds.length > 0
        ? listEventsForSessions({
            workspaceId,
            sessionIds: sampleIds,
            kinds: ["error"],
            limit: 200,
          })
        : Promise.resolve([]),
      sampleIds.length > 0
        ? failingNetworkForSessions({ workspaceId, sessionIds: sampleIds })
        : Promise.resolve([]),
    ]);

    const sessionPublicIds: Record<string, string> = {};
    const evidence: Record<string, unknown> = {
      INC: {
        title: this.clean(incident.title),
        signalType: incident.signalType,
        polarity: incident.polarity,
        screen: incident.screen || "(app-wide)",
        element: incident.element || "",
        status: incident.status,
        sessions: incident.sessionCount,
        users: incident.userCount,
        // Signed whole percent, exactly as the prompt's changePct rule expects.
        changePct: Math.round(incident.deltaPctX100 / 100),
        impactCents: incident.impactCents,
        firstSeenAt: incident.firstSeenAt.toISOString(),
        lastSeenAt: incident.lastSeenAt.toISOString(),
        sampledSessions: sampleIds.length,
      },
      SIG: {
        note: "Signal-type mix across this incident's sessions.",
        types: typeSplit.map((t) => ({
          type: t.type,
          sessions: t._count._all,
        })),
      },
    };

    if (detail) {
      const dims: Array<[string, keyof typeof detail.breakdowns]> = [
        ["BRK_platform", "platforms"],
        ["BRK_browser", "browsers"],
        ["BRK_country", "countries"],
        ["BRK_release", "releases"],
      ];
      for (const [key, field] of dims) {
        const rows = detail.breakdowns[field];
        if (rows.length === 0) continue;
        const unknown = rows.find((r) => r.value === "unknown");
        evidence[key] = {
          note: "Shares of THIS incident's affected sessions. No workspace baseline exists.",
          // Surfaced explicitly so the prompt's "do not cite a breakdown whose
          // unknownPct is 50 or above" rule has a field to read, instead of the
          // model having to infer missing instrumentation from a suspicious 100%.
          unknownPct: unknown?.pct ?? 0,
          values: rows
            .filter((r) => r.value !== "unknown")
            .map((r) => ({ value: r.value, sessions: r.sessions, pct: r.pct })),
        };
      }

      for (const c of detail.relatedCrashes) {
        evidence[`ISSUE_${c.id}`] = {
          title: this.clean(c.title),
          errorType: c.errorType,
          isCrash: c.isCrash,
          // NOT independent evidence when true — see the class comment.
          behavioral: c.behavioral,
          occurrences: c.occurrences,
          sharedSessions: c.sharedSessions,
        };
      }

      for (const c of detail.correlated) {
        if (!c) continue;
        evidence[`CORR_${c.id}`] = {
          title: this.clean(c.title),
          signalType: c.signalType,
          polarity: c.polarity,
          sessions: c.sessionCount,
          changePct: Math.round(c.deltaPctX100 / 100),
          sharedSessions: c.sharedSessions,
        };
      }

      for (const h of detail.similarHistorical) {
        evidence[`HIST_${h.id}`] = {
          title: this.clean(h.title),
          status: h.status,
          sessions: h.sessionCount,
          firstSeenAt: h.firstSeenAt.toISOString(),
          lastSeenAt: h.lastSeenAt.toISOString(),
        };
      }
    }

    /* The evidence keys sessions by NUMERIC Session.id, but /recordings/:id
       resolves a session by its PUBLIC id ("e2e_s128"). A citation therefore
       names a session the reader cannot open unless we also carry the public id
       across. One bounded findMany over the sample (<= MAX_SAMPLE_SESSIONS), so
       the UI can turn "SESS_40188" into a working link instead of a dead one. */
    const publicRows =
      sampleIds.length > 0
        ? await this.db.session.findMany({
            where: { workspaceId, id: { in: sampleIds } },
            select: { id: true, publicId: true },
          })
        : [];
    for (const r of publicRows) {
      if (r.publicId) sessionPublicIds[String(r.id)] = r.publicId;
    }

    const bundles = this.sessionBundles(sampleIds, errorEvents, networkRows);
    for (const [sessionId, bundle] of bundles) {
      evidence[`SESS_${sessionId}`] = {
        note: "One representative sampled session, not the population.",
        ...bundle,
      };
    }

    return { evidence, sessionPublicIds };
  }

  /**
   * Fold the two batched ClickHouse reads into one bundle per sampled session.
   * Pure in-memory grouping over rows already fetched — the reason both reads
   * are batched is precisely so this does not become a query per session.
   */
  private sessionBundles(
    sampleIds: number[],
    errorEvents: Array<{ session_id: number; message: string; error: string }>,
    networkRows: Array<{
      session_id: number;
      method: string;
      url: string;
      status_code: number;
      duration_ms: number;
    }>,
  ): Map<number, SessionBundle> {
    const out = new Map<number, SessionBundle>();
    for (const id of sampleIds) out.set(id, { errors: [], requests: [] });

    for (const e of errorEvents) {
      const b = out.get(e.session_id);
      if (
        !b ||
        b.errors.length >= IncidentReportService.MAX_ERRORS_PER_SESSION
      ) {
        continue;
      }
      // `error` is the row's DISCRIMINATOR, not the error text — the ingest
      // writes the literal string "error" into it, so `e.error || e.message`
      // short-circuits and every error line becomes the word "error". Verified
      // on the reference workspace: all 32 error rows carry error = "error",
      // with the real text ("TypeError: Cannot read properties of undefined
      // …") in `message`. errorText() prefers message and ignores the
      // discriminator.
      const text = this.clean(errorText(e));
      if (text && !b.errors.includes(text)) b.errors.push(text);
    }

    for (const n of networkRows) {
      const b = out.get(n.session_id);
      if (
        !b ||
        b.requests.length >= IncidentReportService.MAX_REQUESTS_PER_SESSION
      ) {
        continue;
      }
      const line = `${n.method} ${this.path(n.url)} -> ${n.status_code} in ${n.duration_ms}ms`;
      if (!b.requests.includes(line)) b.requests.push(line);
    }
    return out;
  }

  /* ── assembly ─────────────────────────────────────────────────────────── */

  /**
   * Fold the calls into the client contract. Every optional field is OMITTED
   * unless it survives validation, so a section the model declined to write and
   * a section it wrote badly both render as absent — which is the intent: the
   * reader sees only what the evidence supported.
   */
  private assembleReport(
    base: {
      executiveSummary: string;
      confidence: ReportConfidence;
      rootCause: string;
    },
    d: DiagnosisOutput,
    r: RemediationOutput | null,
    refs: Set<string>,
  ): IncidentReport {
    const report: IncidentReport = {
      executiveSummary: base.executiveSummary,
      confidence: base.confidence,
    };
    if (base.rootCause) report.rootCause = base.rootCause;

    const supporting = this.citations(d?.supportingEvidence, refs, 5);
    if (supporting.length > 0) report.supportingEvidence = supporting;

    const rationale = this.clean(d?.confidenceRationale);
    if (rationale) report.confidenceRationale = rationale;

    if (r) {
      const fix = this.clean(r.recommendedFix);
      if (fix) report.recommendedFix = fix;

      const risks = this.cleanList(r.potentialRisks, 3);
      if (risks.length > 0) report.potentialRisks = risks;

      // Only CORR_* / HIST_* / ISSUE_* belong here — a diagnosis ref (INC, SIG,
      // BRK_*, SESS_*) is not a "related regression", and letting one through
      // would present the incident itself as its own correlate.
      const related = this.citations(r.relatedRegressions, refs, 4).filter(
        (c) => /^(CORR|HIST|ISSUE)_/.test(c.ref),
      );
      if (related.length > 0) report.relatedRegressions = related;

      const next = this.clean(r.nextInvestigation);
      if (next) report.nextInvestigation = next;
    }
    return report;
  }

  /**
   * Keep only citations whose ref is a LITERAL key of the evidence payload.
   *
   * This — not the prompt rule above it — is what makes a fabricated citation
   * impossible: a ref the server did not itself put in the payload matches
   * nothing and is dropped, so an invented incident id can never reach a reader
   * who would click it.
   */
  private citations(
    v: unknown,
    refs: Set<string>,
    max: number,
  ): ReportCitation[] {
    return (Array.isArray(v) ? v : [])
      .map((c) => ({
        ref: this.clean((c as ReportCitation)?.ref),
        statement: this.clean((c as ReportCitation)?.statement),
      }))
      .filter((c) => c.ref && c.statement && refs.has(c.ref))
      .slice(0, max);
  }

  private async persist(
    workspaceId: number,
    incidentId: number,
    day: Date,
    report: IncidentReport,
    model: string,
  ): Promise<void> {
    try {
      // Upsert (not update): the templated storyline generator was removed, so
      // the AI writers own row creation. `causeText` is left to the older cause
      // endpoint — this column is additive and the two never fight.
      await this.db.storyline.upsert({
        where: { incidentId },
        create: {
          incidentId,
          workspaceId,
          day,
          reportJson: report as unknown as Prisma.InputJsonValue,
          causeModel: model,
        },
        update: {
          reportJson: report as unknown as Prisma.InputJsonValue,
          causeModel: model,
        },
      });
    } catch (e) {
      // A cache write must never cost the user the report they just paid for.
      this.logger.warn(
        `incident report cache write failed (incident ${incidentId}): ${(e as Error).message}`,
      );
    }
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */

  /**
   * METHOD + PATH only. The host and the whole query string are dropped before
   * the URL reaches the model: a captured query string is where access tokens,
   * session ids and email addresses end up, and the prompt asks the model never
   * to reconstruct a full URL — which is a rule worth enforcing rather than
   * requesting.
   */
  private path(url: string): string {
    const raw = this.clean(url);
    if (!raw) return "";
    const noQuery = raw.split(/[?#]/)[0];
    const afterHost = noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
    return (afterHost || noQuery).slice(0, 120);
  }

  /** Trim + cap a captured or model-written string. Never null, never oversized. */
  private clean(s: unknown): string {
    return typeof s === "string"
      ? s.trim().slice(0, IncidentReportService.MAX_TEXT * 6)
      : "";
  }

  private cleanList(v: unknown, max: number): string[] {
    return (Array.isArray(v) ? v : [])
      .map((x) => this.clean(x))
      .filter((x) => x.length > 0)
      .slice(0, max);
  }
}
