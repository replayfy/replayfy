import { Injectable } from "@nestjs/common";
import type { Freshness } from "./agent-contract";

/**
 * The security + scoping context the Execution Engine injects into EVERY
 * capability. It is built server-side from the authenticated request — never
 * from anything the LLM produced. `workspaceId` in particular is authoritative:
 * capabilities read it from here, never from their input.
 */
export interface AgentContext {
  workspaceId: number;
  userId: number;
  role: string;
  /** Fine-grained permissions derived from the role (see permissionsForRole). */
  permissions: Set<string>;
  /** The conversation this request belongs to — threaded into the execution
   *  audit so a multi-turn investigation is traceable. Never used for scoping. */
  conversationId?: string;
}

/** Domain groupings — the vocabulary the planner reasons in. */
export type Skill =
  | "Session Intelligence"
  | "Replay Intelligence"
  | "User Intelligence"
  | "Funnel Intelligence"
  | "Cohort Intelligence"
  | "Metric Intelligence"
  | "Release Intelligence"
  | "Crash Intelligence"
  | "Performance Intelligence"
  | "Alert Intelligence"
  | "Playlist Intelligence"
  | "Comment Intelligence"
  | "Linear Intelligence"
  | "GitHub Intelligence"
  | "Slack Intelligence"
  | "Investigation Intelligence"
  | "Setup Intelligence";

/**
 * The operation class of a capability — drives risk level + whether an
 * execution preview + confirmation is required before it runs.
 *   read   (L1) — safe, immediate, cacheable.
 *   create (L2) — safe create, immediate.
 *   update (L3) — preview + confirm by default (workspace policy may relax).
 *   delete (L4) — destructive: ALWAYS preview + confirm.
 *   external    — leaves Replayfy (Linear/Slack/…): ALWAYS preview + confirm.
 */
export type OperationType = "read" | "create" | "update" | "delete" | "external";

/**
 * A human-facing description of exactly what an action WOULD do, produced before
 * an update/delete/external capability runs so the user can confirm. Never
 * executes anything — it only resolves the target + describes the change/impact.
 */
export interface ActionPreview {
  operation: OperationType;
  /** One line: "Delete funnel 'Signup Funnel'". */
  summary: string;
  /** true for deletes (and irreversible externals) — surfaced prominently. */
  permanent: boolean;
  reversible: boolean;
  /** Resolved target + the specific changes / estimated impact. */
  details?: Record<string, unknown>;
}

/**
 * A registered capability — the ONLY thing the planner can invoke. Replayfy
 * owns the executor; Claude only ever sees `name`, `skill`, `description`,
 * `inputSchema`, and `operation`. Capabilities span read/create/update/delete
 * and external integrations; update/delete/external run ONLY after an execution
 * preview + user confirmation (see ExecutionEngine).
 */
export interface Capability<I = Record<string, unknown>, O = unknown> {
  /** Dotted id the planner references, e.g. "session.search", "funnel.delete". */
  name: string;
  skill: Skill;
  /** One line the planner uses to decide when to invoke this. */
  description: string;
  /** Operation class → risk level + confirmation policy. Defaults (when omitted)
   *  to "create" if `writes` is set, else "read" — so existing read/create
   *  registrations keep working unchanged. */
  operation?: OperationType;
  /** How fresh this capability's result must be — drives the caching layer
   *  (task #16). Unset is treated as "live" (never over-cache). Reads that never
   *  change (e.g. a finalized release comparison) declare "immutable"; today's
   *  metrics declare "live". Writes ignore it. */
  freshness?: Freshness;
  /** Override the default confirmation policy. delete + external ALWAYS confirm
   *  regardless; update confirms by default; this can only relax `update`. */
  requiresConfirmation?: boolean;
  /** Whether the effect can be undone (informational, shown in the preview). */
  reversible?: boolean;
  /** Optional preview builder for confirmable ops — resolves the target and
   *  describes the change/impact. Falls back to a generic preview if omitted. */
  preview?: (input: I, ctx: AgentContext) => Promise<ActionPreview> | ActionPreview;
  /** Optional async precondition, checked BEFORE the confirmation gate. Return a
   *  human message if the action CAN'T proceed (e.g. "Linear isn't connected");
   *  the step then fails fast with that reason instead of asking the user to
   *  confirm an action that would fail. Return null when the precondition holds. */
  precondition?: (input: I, ctx: AgentContext) => Promise<string | null>;
  /** Permissions the caller must hold (RBAC). Reads: []. Writes: e.g.
   *  ["funnels.write"], ["funnels.delete"]. Enforced BEFORE the executor runs. */
  permissions: string[];
  /** true = the executor scopes itself to ctx.workspaceId (the norm). */
  workspaceScoped: boolean;
  /** true = mutates data. Surfaced so the planner/engine can treat writes
   *  distinctly (confirmation, audit emphasis). Prefer `operation`. */
  writes?: boolean;
  /** JSON-Schema-ish description of the input, shown to the planner and used
   *  by the engine to validate required fields before executing. `workspaceId`
   *  must NEVER appear here — it comes from context. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Optional custom validator, run after the required-field check. Returns an
   *  error string (rejects the step) or null (ok). */
  validate?: (input: I) => string | null;
  /** Optional output shape hint — the engine sanity-checks the result is
   *  present and of this shape; richer schema validation can grow here. */
  outputSchema?: { type: "object" | "array" };
  /** Retry policy for transient executor failures. Reads are safe to retry;
   *  omit (or attempts:0) for writes so a create is never duplicated. */
  retry?: { attempts: number; delayMs?: number };
  /** Cache policy — memoize the (capability, workspace, input) result for
   *  ttlMs. Applied ONLY to reads, so an investigation that hits the same
   *  capability twice pays for it once. */
  cache?: { ttlMs: number };
  /** The real work. Receives validated input + the injected context. Must read
   *  workspaceId from ctx, never from input. */
  executor: (input: I, ctx: AgentContext) => Promise<O>;
}

/** The resource domains that expose create/update/delete capabilities. */
const WRITE_DOMAINS = ["funnels", "cohorts", "playlists", "alerts"] as const;

/**
 * Map a workspace role to a permission set — a tiered RBAC:
 *   VIEWER          → read only.
 *   MEMBER (other)  → read + create + update (`<domain>.write` + `.update`).
 *   ADMIN / OWNER   → the above + delete (`<domain>.delete`) + external
 *                     integrations (`linear.issue.create`,
 *                     `github.issue.create`, `slack.message.post`).
 * Destructive + external actions are therefore admin/owner-gated, on top of the
 * per-action execution-preview + confirmation the engine enforces.
 */
export function permissionsForRole(role: string): Set<string> {
  const r = (role || "").toUpperCase();
  const perms = new Set<string>(["read"]);
  if (r === "VIEWER") {
    return perms;
  }
  for (const d of WRITE_DOMAINS) {
    perms.add(`${d}.write`); // create
    perms.add(`${d}.update`); // update
  }
  if (r === "ADMIN" || r === "OWNER") {
    for (const d of WRITE_DOMAINS) {
      perms.add(`${d}.delete`);
    }
    // External integrations — admin/owner only.
    perms.add("linear.issue.create");
    perms.add("github.issue.create");
    perms.add("slack.message.post");
  }
  return perms;
}

/** The operation class of a capability, defaulting for older registrations that
 *  only set `writes` (writes → create, else read). */
export function operationOf(cap: Pick<Capability, "operation" | "writes">): OperationType {
  return cap.operation ?? (cap.writes ? "create" : "read");
}

/** Whether an execution preview + confirmation must precede this capability.
 *  delete + external ALWAYS confirm; update confirms unless explicitly relaxed;
 *  create confirms only if it explicitly opts in; read never does.
 *
 *  `create` defaults to no-confirm because most creates are cheap and reversible
 *  (a cohort, a playlist). But a create that writes a DURABLE WORKSPACE FACT the
 *  AI then treats as truth in every later prompt is not in that class, and must
 *  set `requiresConfirmation: true` — see conversion.define. Before this, the
 *  override was consulted for `update` only, so setting it on a create was
 *  silently ignored: the flag looked like a control and was not one. */
export function requiresConfirmation(
  cap: Pick<Capability, "operation" | "writes" | "requiresConfirmation">,
): boolean {
  const op = operationOf(cap);
  if (op === "delete" || op === "external") return true;
  if (op === "update") return cap.requiresConfirmation ?? true;
  if (op === "create") return cap.requiresConfirmation ?? false;
  return false;
}

/** Risk level 1–4 (read → 1 … delete → 4; external → 4). Informational. */
export function riskLevel(cap: Pick<Capability, "operation" | "writes">): 1 | 2 | 3 | 4 {
  switch (operationOf(cap)) {
    case "read":
      return 1;
    case "create":
      return 2;
    case "update":
      return 3;
    default:
      return 4; // delete + external
  }
}

/**
 * The registry of all capabilities. Injectable (not a static singleton) so
 * executors can close over DI-provided domain services — AgentCapabilities
 * registers them at module init. The planner only ever sees `catalog()`, and
 * only the capabilities the caller is permitted to run.
 */
@Injectable()
export class CapabilityRegistry {
  private readonly caps = new Map<string, Capability>();

  register(cap: Capability): void {
    if (this.caps.has(cap.name)) {
      throw new Error(`duplicate capability: ${cap.name}`);
    }
    this.caps.set(cap.name, cap);
  }

  get(name: string): Capability | undefined {
    return this.caps.get(name);
  }

  /** The catalog the planner sees — filtered to what the caller may run, so the
   *  model can't even plan a capability the user lacks permission for. Each entry
   *  carries its `operation` + `requiresConfirmation` so the planner knows which
   *  steps are actions (and which will pause for the user's confirmation). */
  catalog(permissions: Set<string>): Array<
    Pick<Capability, "name" | "skill" | "description" | "inputSchema"> & {
      operation: OperationType;
      requiresConfirmation: boolean;
    }
  > {
    const out: Array<
      Pick<Capability, "name" | "skill" | "description" | "inputSchema"> & {
        operation: OperationType;
        requiresConfirmation: boolean;
      }
    > = [];
    for (const c of this.caps.values()) {
      if (c.permissions.every((p) => permissions.has(p))) {
        out.push({
          name: c.name,
          skill: c.skill,
          description: c.description,
          inputSchema: c.inputSchema,
          operation: operationOf(c),
          requiresConfirmation: requiresConfirmation(c),
        });
      }
    }
    return out;
  }

  size(): number {
    return this.caps.size;
  }
}
