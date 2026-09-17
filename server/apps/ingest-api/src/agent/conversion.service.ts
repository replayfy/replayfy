import { Injectable, BadRequestException } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { topTrackEvents, topSuccessEndpoints } from "@replay/db-clickhouse";
import { WorkspaceKnowledgeService } from "./workspace-knowledge.service";

/** A conversion can be defined three ways — the reliability ladder. */
export type ConversionKind = "event" | "url" | "endpoint";

/** `tracked` = an explicit tracked event (highest trust); `defined` = a workspace
 *  rule (url/endpoint); `inferred` = a heuristic guess (confirm first); `none` =
 *  nothing defined yet. */
export type ConversionSource = "tracked" | "defined" | "inferred" | "none";

export interface ConversionDefinition {
  defined: boolean;
  kind: ConversionKind | null;
  value: string | null;
  /** For endpoint rules — the HTTP status that counts as success. */
  status?: number;
  source: ConversionSource;
}

/** The WorkspaceKnowledge key a confirmed conversion definition is stored under. */
const KEY = "conversion_definition";

/**
 * The shape a conversion `value` must match, per kind. This is a SECURITY control
 * as much as a validation one.
 *
 * `value` is authored by the LLM, and what it stores lands in WorkspaceKnowledge —
 * which `contextBlock` renders into EVERY later planner/narrator prompt, under the
 * "Known facts about THIS workspace" (trusted) header. Session data we ingest is
 * attacker-influenceable (a console.error on a customer's site becomes an Issue
 * title, which a read capability lifts verbatim into evidence), so a planner that
 * obeys injected text must not be able to turn a single define into durable prose
 * inside that fact block.
 *
 * A conversion value is an identifier or a path — never prose. Constraining the
 * shape removes the free-text channel entirely, well below the 500-char value cap
 * WorkspaceKnowledge would otherwise allow.
 */
const VALUE_SHAPE: Record<ConversionKind, RegExp> = {
  // Identifier-ish. Spaces are allowed because SDKs legitimately emit names like
  // "Order Placed", but no punctuation that would let prose or JSON through.
  event: /^[\w.:\- ]{1,64}$/,
  // A path or absolute URL. Excludes whitespace (prose needs it) and C0/DEL
  // control characters; every real URL character (- / ? = % #) stays legal.
  url: /^[^\s\u0000-\u001f\u007f]{1,200}$/,
  endpoint: /^[^\s\u0000-\u001f\u007f]{1,200}$/,
};

/**
 * Resolves, suggests, and stores a workspace's CONVERSION definition — what
 * "success" means for THAT product. Generalises the old funnel-goal-only rule to
 * event | url-reached | endpoint+status, and never guesses silently: it returns
 * a `source` badge so the AI/UI shows whether a conversion is tracked, defined,
 * or merely inferred. A user-confirmed definition is stored as a
 * WorkspaceKnowledge fact (so it rides #3's context injection and is asked once).
 */
@Injectable()
export class ConversionService {
  private readonly db = getPostgresClient();

  constructor(private readonly knowledge: WorkspaceKnowledgeService) {}

  /**
   * The effective definition, by priority: an explicit stored rule → the
   * workspace's funnel event-goal → none. Never returns `inferred` (that's a
   * property of a SUGGESTION, not a real definition).
   */
  async resolve(workspaceId: number): Promise<ConversionDefinition> {
    const fact = await this.knowledge.get(workspaceId, KEY);
    if (fact?.value) {
      const parsed = this.parse(fact.value);
      if (parsed) {
        return {
          defined: true,
          kind: parsed.kind,
          value: parsed.value,
          status: parsed.status,
          source: parsed.kind === "event" ? "tracked" : "defined",
        };
      }
    }
    const goal = await this.funnelGoalEvent(workspaceId);
    if (goal) {
      return { defined: true, kind: "event", value: goal, source: "tracked" };
    }
    return { defined: false, kind: null, value: null, source: "none" };
  }

  /**
   * Store/confirm a conversion definition (create-only config write, low risk +
   * reversible). Persisted as a WorkspaceKnowledge fact so the whole AI knows it.
   */
  async define(
    workspaceId: number,
    rule: { kind?: string; value?: string; status?: number },
    userId: number,
  ): Promise<ConversionDefinition> {
    const kind = this.parseKind(rule.kind);
    const value = String(rule.value ?? "").trim();
    if (!value) {
      throw new BadRequestException("A conversion value is required.");
    }
    // Shape-check BEFORE anything is persisted. See VALUE_SHAPE — this is the
    // control that stops an injected planner turning one define into durable
    // prose inside the trusted fact block of every later prompt.
    if (!VALUE_SHAPE[kind].test(value)) {
      throw new BadRequestException(
        kind === "event"
          ? "A conversion event must be a tracked-event name (letters, numbers, . : - _ or spaces; max 64 chars) — not free text."
          : `A conversion ${kind} must be a single path or URL with no spaces (max 200 chars) — not free text.`,
      );
    }
    const status =
      kind === "endpoint" && Number.isFinite(Number(rule.status))
        ? Number(rule.status)
        : undefined;
    await this.knowledge.set(
      workspaceId,
      KEY,
      JSON.stringify({ kind, value, ...(status ? { status } : {}) }),
      { source: "USER_PROVIDED", learnedById: userId },
    );
    return {
      defined: true,
      kind,
      value,
      status,
      source: kind === "event" ? "tracked" : "defined",
    };
  }

  /**
   * Auto-suggest conversion candidates mined across channels so the user (or the
   * AI's inference) picks one in a tap — tracked events, and 2xx endpoints
   * (payment-biased). Each carries how many distinct sessions back it (a rough
   * confidence signal). Best-effort per channel.
   */
  async suggest(workspaceId: number) {
    const [events, endpoints, payEndpoints] = await Promise.all([
      topTrackEvents({ workspaceId, limit: 6 }).catch(() => []),
      topSuccessEndpoints({ workspaceId, limit: 6 }).catch(() => []),
      topSuccessEndpoints({
        workspaceId,
        q: "pay|charge|checkout|order|purchase|subscribe|billing",
        limit: 4,
      }).catch(() => []),
    ]);
    // Prefer payment-like endpoints in the endpoint list, then general 2xx.
    const seen = new Set<string>();
    const endpointCandidates = [...payEndpoints, ...endpoints]
      .filter((e) => (seen.has(e.value) ? false : (seen.add(e.value), true)))
      .slice(0, 6);
    return {
      events: events.map((e) => ({
        kind: "event" as const,
        value: e.value,
        sessions: e.count,
      })),
      endpoints: endpointCandidates.map((e) => ({
        kind: "endpoint" as const,
        value: e.value,
        sessions: e.count,
      })),
    };
  }

  /** The workspace's funnel event-goal (its implicit conversion), or null. */
  private async funnelGoalEvent(workspaceId: number): Promise<string | null> {
    const funnels = await this.db.funnel.findMany({
      where: { workspaceId },
      select: { steps: true },
    });
    for (const f of funnels) {
      const steps = Array.isArray(f.steps)
        ? (f.steps as Array<{ kind?: string; value?: string }>)
        : [];
      const last = steps[steps.length - 1];
      if (
        last?.kind === "event" &&
        typeof last.value === "string" &&
        last.value.trim()
      ) {
        return last.value.trim();
      }
    }
    return null;
  }

  private parse(
    raw: string,
  ): { kind: ConversionKind; value: string; status?: number } | null {
    try {
      const d = JSON.parse(raw) as {
        kind?: string;
        value?: string;
        status?: number;
      };
      const kind = this.tryKind(d.kind);
      if (kind && typeof d.value === "string" && d.value.trim()) {
        return {
          kind,
          value: d.value.trim(),
          status: Number.isFinite(Number(d.status))
            ? Number(d.status)
            : undefined,
        };
      }
    } catch {
      // fall through — a malformed fact resolves as "no definition"
    }
    return null;
  }

  private parseKind(v: unknown): ConversionKind {
    const k = this.tryKind(v);
    if (!k) {
      throw new BadRequestException(
        "kind must be one of: event, url, endpoint",
      );
    }
    return k;
  }

  private tryKind(v: unknown): ConversionKind | null {
    return v === "event" || v === "url" || v === "endpoint" ? v : null;
  }
}
