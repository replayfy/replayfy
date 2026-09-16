import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { listLogs } from "@replay/db-clickhouse";
import { LlmService } from "../llm/llm.service";
import { errorText, safePath } from "../common/session-evidence";

/** Structured-output schema for the cause hypothesis (doc 10 Slice 7). */
const CAUSE_SCHEMA = {
  type: "object",
  properties: {
    hypothesis: {
      type: "string",
      description:
        "One or two plain sentences naming the single most likely CAUSE, grounded strictly in the supplied evidence. Empty when the evidence is too thin.",
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    citedEvidence: {
      type: "array",
      items: { type: "string" },
      description: "Which evidence facts the hypothesis relied on.",
    },
  },
  required: ["hypothesis", "confidence", "citedEvidence"],
} as const;

const SYSTEM = [
  "You are an incident analyst for a product-analytics tool.",
  "You are given ONLY structured evidence already computed from real user sessions.",
  "Propose the single most likely CAUSE of the incident in one or two plain sentences,",
  "grounded strictly in that evidence — never invent specifics that are not present.",
  "Do not restate the incident's known facts; explain the likely mechanism behind them.",
  'If the evidence is too thin to support a confident cause, set confidence to "low"',
  "and keep the hypothesis empty. You are writing a hypothesis, not a fact.",
].join(" ");

interface CauseResult {
  hypothesis: string;
  confidence: "low" | "medium" | "high";
  citedEvidence: string[];
}

/**
 * Generates the optional LLM "likely cause" half of a Storyline (doc 09 §8 /
 * 10 Slice 7). On-demand (card-open) and cached: once a confident cause is
 * stored it's returned as-is. Never blends with the deterministic facts, and
 * only persists when the model is at least "medium" confident — a missing cause
 * is better than a wrong one.
 */
@Injectable()
export class IncidentCauseService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IncidentCauseService.name);

  /** Representative sessions + events to bound the evidence (and the tokens). */
  private static readonly MAX_EXAMPLES = 3;
  private static readonly MAX_EVENTS_PER_SESSION = 40;

  async causeFor(
    workspaceId: number,
    incidentId: number,
    opts: { refresh?: boolean } = {},
  ): Promise<{
    available: boolean;
    reason?: string;
    cause: string | null;
    confidence?: string;
    model?: string | null;
    cached?: boolean;
  }> {
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      include: { storyline: true },
    });
    if (!incident) {
      return { available: false, reason: "not_found", cause: null };
    }
    // Cache hit — return the stored hypothesis unless a refresh is requested.
    if (!opts.refresh && incident.storyline?.causeText) {
      return {
        available: true,
        cause: incident.storyline.causeText,
        model: incident.storyline.causeModel,
        cached: true,
      };
    }

    const evidence = await this.assembleEvidence(workspaceId, incidentId, {
      title: incident.title,
      signalType: incident.signalType,
      screen: incident.screen,
      sessionCount: incident.sessionCount,
      userCount: incident.userCount,
      deltaPctX100: incident.deltaPctX100,
      impactCents: incident.impactCents,
    });

    const r = await this.llm.structured<CauseResult>(workspaceId, {
      system: SYSTEM,
      user: JSON.stringify(evidence),
      schema: CAUSE_SCHEMA as unknown as Record<string, unknown>,
      surface: "cause",
      // Reasoning-model tax (llm.models.ts): a hypothesis is short, but the model
      // thinks first and that comes out of this budget.
      maxTokens: 1500,
      temperature: 0,
    });
    if (!r.ok) {
      // disabled / no_key / budget — the dashboard shows facts only.
      return { available: false, reason: r.reason, cause: null };
    }

    const { hypothesis, confidence } = r.data;
    // Only persist a hypothesis the model is at least medium-confident about,
    // and that actually says something.
    if (confidence === "low" || !hypothesis || hypothesis.trim().length === 0) {
      return { available: true, cause: null, confidence };
    }

    const model = this.llm.modelFor(await this.llm.getConfig(workspaceId), "cause");
    // Upsert (not update): the templated generator that used to INSERT this row
    // was removed, so the AI cause writer now owns row creation. factsText stays
    // null until the AI intelligence pass writes the storyline.
    await this.db.storyline.upsert({
      where: { incidentId },
      create: {
        incidentId,
        workspaceId,
        day: incident.lastSeenAt,
        causeText: hypothesis.trim(),
        causeModel: model,
      },
      update: { causeText: hypothesis.trim(), causeModel: model },
    });
    return {
      available: true,
      cause: hypothesis.trim(),
      confidence,
      model,
      cached: false,
    };
  }

  /**
   * Bounded evidence bundle: the incident summary, its signal-type breakdown,
   * and a few representative sessions' key error/slow-network events. Token
   * footprint is capped by MAX_EXAMPLES × MAX_EVENTS_PER_SESSION.
   */
  private async assembleEvidence(
    workspaceId: number,
    incidentId: number,
    incident: {
      title: string;
      signalType: string;
      screen: string;
      sessionCount: number;
      userCount: number;
      deltaPctX100: number;
      impactCents: number;
    },
  ) {
    const [breakdown, exampleRows] = await Promise.all([
      this.db.signal.groupBy({
        by: ["type"],
        where: { incidentId },
        _count: { _all: true },
      }),
      this.db.signal.findMany({
        where: { incidentId },
        distinct: ["sessionId"],
        select: { sessionId: true },
        take: IncidentCauseService.MAX_EXAMPLES,
      }),
    ]);

    const examples = [];
    for (const row of exampleRows) {
      const events = await listLogs({
        sessionId: row.sessionId,
        limit: IncidentCauseService.MAX_EVENTS_PER_SESSION,
      });
      // `error` is the row's DISCRIMINATOR, not the error text — the ingest
      // writes the literal string "error" into it, so `e.error || e.message`
      // always short-circuited and every error line in this payload used to be
      // the word "error". The human-readable text lives in `message`.
      const errors = events
        .filter((e) => e.kind === "error" && errorText(e))
        .slice(0, 3)
        .map((e) => errorText(e).slice(0, 160));
      const slowOrFailed = events
        .filter(
          (e) =>
            e.kind === "network" &&
            (e.status_code >= 500 || e.duration_ms >= 3000),
        )
        .slice(0, 3)
        // Method + PATH only: the captured URL carries the customer's host and
        // a query string that routinely holds tokens and personal data.
        .map(
          (e) =>
            `${e.method} ${safePath(e.url)} → ${e.status_code} in ${e.duration_ms}ms`,
        );
      examples.push({ sessionId: row.sessionId, errors, slowOrFailed });
    }

    return {
      incident: {
        title: incident.title,
        signalType: incident.signalType,
        screen: incident.screen || "(app-wide)",
        sessions: incident.sessionCount,
        users: incident.userCount,
        changePct: Math.round(incident.deltaPctX100 / 100),
        impactCents: incident.impactCents,
      },
      signalBreakdown: breakdown.map((b) => ({
        type: b.type,
        sessions: b._count._all,
      })),
      exampleSessions: examples,
    };
  }

  constructor(private readonly llm: LlmService) {}
}
