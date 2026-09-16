import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { topTrackEvents } from "@replay/db-clickhouse";
import { LlmService } from "../llm/llm.service";
import {
  FunnelsService,
  type FunnelStep,
  type FunnelStepKind,
  type FunnelStepMatch,
} from "../funnels/funnels.service";

/**
 * Propose a conversion funnel from an incident and create it — the
 * investigation panel's "Create funnel" action.
 *
 * The model only CHOOSES steps; it never invents the vocabulary. Step `kind`
 * and `matchType` come from closed enums the server re-checks, and any `event`
 * step must name a real tracked event (the model is handed the actual list and
 * the server drops anything not in it). So a hallucinated event name can't
 * produce a funnel that silently matches nothing — the same discipline the
 * report uses for citation refs.
 *
 * Creation goes through FunnelsService.create — the SAME write path the
 * funnel.create agent capability and the Funnels page use — so validation,
 * ownership and the audit row are identical no matter who calls it.
 */

const STEP_KINDS: FunnelStepKind[] = ["page", "click", "event", "tap", "screen"];
const STEP_MATCHES: FunnelStepMatch[] = [
  "contains",
  "equals",
  "startsWith",
  "regex",
];

interface ProposedStep {
  name?: unknown;
  kind?: unknown;
  matchType?: unknown;
  value?: unknown;
}
interface ProposalOutput {
  name?: string;
  steps?: ProposedStep[];
}

const FUNNEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    steps: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: STEP_KINDS },
          matchType: { type: "string", enum: STEP_MATCHES },
          value: { type: "string" },
        },
        required: ["name", "kind", "matchType", "value"],
      },
    },
  },
  required: ["name", "steps"],
} as const;

const FUNNEL_SYSTEM = [
  "# Role",
  "",
  "Propose a conversion funnel that measures the user flow behind ONE product",
  "incident, so the team can watch that flow recover. You only CHOOSE steps; the",
  "server creates the funnel.",
  "",
  "# Your input",
  "",
  "- INCIDENT: the behavioural signal — its title, the screen it happened on, and",
  "  its signalType (e.g. conversion_failure).",
  "- EVENTS: the tracked custom-event names this workspace ACTUALLY records, each",
  "  with how many sessions fired it. These are the ONLY event names that exist.",
  "",
  "# The funnel",
  "",
  "2 to 5 ordered steps, earliest first, the GOAL last. The last step is the",
  "outcome the incident threatens (the purchase, signup, or conversion); earlier",
  "steps are the path to it. A funnel is a sequence — order matters.",
  "",
  "Each step is { name, kind, matchType, value }:",
  "- kind: one of page | click | event | tap | screen. Nothing else exists.",
  "    page  → value is a URL / path fragment (the incident's screen is a good one).",
  "    event → value MUST be one of the EVENTS names, copied VERBATIM. Never invent",
  "            an event name; a made-up one matches zero sessions.",
  "    click → value is visible button/link text.",
  "- matchType: one of contains | equals | startsWith | regex. Use `contains` for",
  "    URLs, `equals` for an exact event name.",
  "- name: a short human label for the step.",
  "",
  "# Rules",
  "",
  "- Ground every `event` value in EVENTS, verbatim. If the real events + screen",
  "  cannot form a sensible funnel, return an EMPTY steps array rather than",
  "  inventing one — a wrong funnel is worse than none.",
  "- No prose, no markdown. Just the JSON.",
].join("\n");

@Injectable()
export class IncidentFunnelService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(IncidentFunnelService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly funnels: FunnelsService,
  ) {}

  async proposeAndCreate(
    workspaceId: number,
    userId: number,
    incidentId: number,
  ): Promise<
    | { created: true; funnelId: number; name: string; steps: FunnelStep[] }
    | { created: false; reason: string }
  > {
    if (!Number.isFinite(incidentId)) {
      return { created: false, reason: "not_found" };
    }
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      select: { title: true, screen: true, element: true, signalType: true },
    });
    if (!incident) return { created: false, reason: "not_found" };

    // The real vocabulary the model must ground `event` steps in.
    const events = await topTrackEvents({ workspaceId, limit: 30 }).catch(
      () => [] as Array<{ value: string; count: number }>,
    );

    const r = await this.llm.structured<ProposalOutput>(workspaceId, {
      system: FUNNEL_SYSTEM,
      user: JSON.stringify({
        INCIDENT: {
          title: incident.title,
          screen: incident.screen || null,
          element: incident.element || null,
          signalType: incident.signalType,
        },
        EVENTS: events.map((e) => ({ name: e.value, sessions: e.count })),
      }),
      schema: FUNNEL_SCHEMA as unknown as Record<string, unknown>,
      surface: "cause",
      label: "funnel-propose",
      userId,
      maxTokens: 3000,
      temperature: 0.2,
    });
    if (!r.ok) return { created: false, reason: r.reason };

    // The known-good event set, for grounding `event` steps. Case-insensitive so
    // the model's copy need not match byte-for-byte on case.
    const eventSet = new Set(events.map((e) => e.value.toLowerCase()));
    const steps = this.validateSteps(r.data?.steps, eventSet);
    if (steps.length < 2) {
      this.logger.warn(
        `incident ${incidentId} (ws ${workspaceId}): funnel proposal yielded ${steps.length} valid step(s) — not creating`,
      );
      return { created: false, reason: "no_funnel" };
    }

    const name =
      (typeof r.data?.name === "string" && r.data.name.trim()) ||
      `${incident.title} funnel`;

    const funnel = await this.funnels.create(workspaceId, userId, {
      name: name.slice(0, 120),
      steps,
    });
    return {
      created: true,
      funnelId: (funnel as { id: number }).id,
      name: name.slice(0, 120),
      steps,
    };
  }

  /**
   * Keep only well-formed steps: kind + matchType from the closed enums, a
   * non-empty value, and — for `event`/`tap`/`screen` steps — a value that names
   * a REAL tracked event. `page`/`click` values are free text (a URL / button
   * label), so they pass on non-emptiness alone.
   */
  private validateSteps(
    raw: ProposedStep[] | undefined,
    eventSet: Set<string>,
  ): FunnelStep[] {
    if (!Array.isArray(raw)) return [];
    const out: FunnelStep[] = [];
    for (const s of raw) {
      const kind = s?.kind;
      const matchType = s?.matchType;
      const value = typeof s?.value === "string" ? s.value.trim() : "";
      const name = typeof s?.name === "string" ? s.name.trim() : "";
      if (
        !STEP_KINDS.includes(kind as FunnelStepKind) ||
        !STEP_MATCHES.includes(matchType as FunnelStepMatch) ||
        !value
      ) {
        continue;
      }
      // An event-shaped step whose value the workspace never recorded would
      // match nothing — drop it rather than ship a dead funnel step. Only
      // enforced when we actually know the event vocabulary.
      if (
        (kind === "event" || kind === "tap" || kind === "screen") &&
        eventSet.size > 0 &&
        !eventSet.has(value.toLowerCase())
      ) {
        continue;
      }
      out.push({
        name: (name || value).slice(0, 80),
        kind: kind as FunnelStepKind,
        matchType: matchType as FunnelStepMatch,
        value: value.slice(0, 200),
      });
      if (out.length >= 6) break;
    }
    return out;
  }
}
