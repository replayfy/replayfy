import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import type { Redis } from "ioredis";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";
import { readWorkspaceActivity } from "../common/workspace-activity";
import {
  AgentContext,
  ActionPreview,
  CapabilityRegistry,
  operationOf,
  requiresConfirmation,
} from "./capability";

/** The result of executing one planned capability call — becomes one piece of
 *  evidence. Errors are captured here, never thrown, so a single failed step
 *  can't abort the whole investigation. When `needsConfirmation` is set the
 *  capability did NOT run — `preview` describes what it WOULD do, pending the
 *  user's approval. */
export interface StepResult {
  capability: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  ms: number;
  needsConfirmation?: boolean;
  preview?: ActionPreview;
}

/**
 * The Execution Engine runs a single planned capability call under FULL
 * enforcement — this is where Replayfy's ownership of security lives, not the
 * LLM's. Every step passes through, in order:
 *
 *   registered?  →  permitted (RBAC)?  →  strip any caller-supplied
 *   workspaceId  →  required inputs present?  →  run executor  →  audit.
 *
 * The planner can only ask for a capability by name + input; it can never reach
 * SQL, pick a workspace, or bypass a permission. workspaceId always comes from
 * the injected context.
 */
@Injectable()
export class ExecutionEngine {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(ExecutionEngine.name);

  constructor(
    private readonly registry: CapabilityRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async executeStep(
    name: string,
    rawInput: Record<string, unknown>,
    ctx: AgentContext,
    opts: { confirmed?: boolean } = {},
  ): Promise<StepResult> {
    const started = Date.now();

    // NEVER trust a workspaceId from the plan; the executor reads ctx.workspaceId.
    // Stripped up front so the audited input never implies a chosen workspace.
    const input: Record<string, unknown> = { ...rawInput };
    delete input.workspaceId;

    // Every terminal path funnels through `finish`, which writes ONE durable
    // audit row (best-effort) — the "audit logging" step of the security
    // pipeline. `permitted` records whether RBAC passed; `writes` whether the
    // capability mutates state; `skill` its grouping.
    const finish = (
      result: StepResult,
      meta: { permitted: boolean; writes: boolean; skill: string },
    ): StepResult => {
      void this.audit(name, ctx, input, result, meta);
      return result;
    };

    const cap = this.registry.get(name);
    if (!cap) {
      return finish(this.fail(name, "unknown capability", started), {
        permitted: false,
        writes: false,
        skill: "(unknown)",
      });
    }
    const isWrite = operationOf(cap) !== "read";
    const meta = { skill: cap.skill, writes: isWrite };

    // RBAC — defense in depth (the planner's catalog is already filtered).
    if (!cap.permissions.every((p) => ctx.permissions.has(p))) {
      return finish(this.fail(name, "permission denied", started), {
        ...meta,
        permitted: false,
      });
    }
    const permitted = true;

    const missing = (cap.inputSchema.required ?? []).filter((r) => {
      const v = input[r];
      return v === undefined || v === null || v === "";
    });
    if (missing.length > 0) {
      return finish(
        this.fail(name, `missing input: ${missing.join(", ")}`, started),
        { ...meta, permitted },
      );
    }

    // Custom validator (schema-beyond-required checks).
    if (cap.validate) {
      const err = cap.validate(input);
      if (err) {
        return finish(this.fail(name, err, started), { ...meta, permitted });
      }
    }

    // Async precondition — checked BEFORE the confirmation gate, so an action
    // that CAN'T succeed (e.g. Linear not connected) fails fast with a helpful
    // reason instead of asking the user to confirm an action that would then
    // error. Best-effort: a precondition that throws doesn't block the action.
    if (cap.precondition) {
      let block: string | null = null;
      try {
        block = await cap.precondition(input, ctx);
      } catch (e) {
        this.logger.warn(
          `precondition check failed for ${name}: ${(e as Error).message}`,
        );
      }
      if (block) {
        return finish(this.fail(name, block, started), { ...meta, permitted });
      }
    }

    // Confirmation gate — update/delete/external NEVER execute on the first
    // pass. We resolve the target + build an ActionPreview and hand it back so
    // the agent can create a pending action and ask the user to confirm. The
    // executor runs only on the confirmed re-entry (opts.confirmed). No audit
    // row here — nothing executed; the PendingAction is the record of intent.
    if (requiresConfirmation(cap) && !opts.confirmed) {
      const preview = await this.buildPreview(cap, input, ctx);
      return {
        capability: name,
        ok: false,
        needsConfirmation: true,
        preview,
        ms: Date.now() - started,
      };
    }

    // Read cache — Redis-backed (shared across instances, survives restart),
    // freshness + version aware; reads only, never a write. The key folds in the
    // workspace VERSION for near-live capabilities (WorkspaceSnapshot
    // .lastActivityAt) so any new activity invalidates it; live/immutable key by
    // time only. Best-effort: a Redis error is just a miss.
    const freshness = cap.freshness ?? "live";
    const cacheable = !!cap.cache && !isWrite;
    let cacheKey = "";
    if (cacheable) {
      const version =
        freshness === "near-live"
          ? await this.workspaceVersion(ctx.workspaceId)
          : freshness;
      cacheKey = `agent:cache:${name}:${ctx.workspaceId}:${this.hashInput(input)}:${version}`;
      const cached = await this.cacheGet(cacheKey);
      if (cached !== undefined) {
        return finish(
          { capability: name, ok: true, output: cached, ms: Date.now() - started },
          { ...meta, permitted },
        );
      }
    }

    // Execute with the retry policy (reads only, by policy — writes set attempts:0).
    const attempts = Math.max(0, cap.retry?.attempts ?? 0);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        const output = await cap.executor(input, ctx);
        // Output sanity-check against the declared shape.
        if (cap.outputSchema) {
          const okShape =
            cap.outputSchema.type === "array"
              ? Array.isArray(output)
              : output !== null && typeof output === "object";
          if (!okShape) {
            return finish(this.fail(name, "output failed shape check", started), {
              ...meta,
              permitted,
            });
          }
        }
        if (cacheable && cacheKey) {
          await this.cacheSet(cacheKey, output, this.freshnessTtlSec(cap));
        }
        const ms = Date.now() - started;
        this.logger.log(
          `agent-exec ws=${ctx.workspaceId} user=${ctx.userId} ${name}` +
            `${isWrite ? " [WRITE]" : ""} ok ${ms}ms` +
            `${attempt > 0 ? ` (retry ${attempt})` : ""}`,
        );
        return finish({ capability: name, ok: true, output, ms }, {
          ...meta,
          permitted,
        });
      } catch (e) {
        lastError = e as Error;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, cap.retry?.delayMs ?? 200));
        }
      }
    }
    return finish(this.fail(name, lastError?.message ?? "executor failed", started), {
      ...meta,
      permitted,
    });
  }

  private fail(name: string, error: string, started: number): StepResult {
    const ms = Date.now() - started;
    this.logger.warn(`agent-exec ${name} failed: ${error} (${ms}ms)`);
    return { capability: name, ok: false, error, ms };
  }

  /** The workspace's coarse version — the activity watermark bumped by the
   *  signals chokepoint on any new activity. Served from Redis (ws:activity:<id>)
   *  so folding it into near-live cache keys costs no Postgres read; falls back
   *  to WorkspaceSnapshot.lastActivityAt on a Redis miss. The cache invalidates
   *  the instant data changes because the watermark moves. */
  private async workspaceVersion(workspaceId: number): Promise<string> {
    const fromRedis = await readWorkspaceActivity(this.redis, workspaceId);
    if (fromRedis !== null) return String(fromRedis);
    try {
      const snap = await this.db.workspaceSnapshot.findUnique({
        where: { workspaceId },
        select: { lastActivityAt: true },
      });
      return snap?.lastActivityAt ? String(snap.lastActivityAt.getTime()) : "0";
    } catch {
      return "0";
    }
  }

  /** TTL (seconds) by freshness — explicit cap.cache.ttlMs wins, else a sane
   *  default: immutable long, near-live medium, live short. */
  private freshnessTtlSec(cap: {
    cache?: { ttlMs: number };
    freshness?: string;
  }): number {
    const explicit = cap.cache?.ttlMs ? Math.ceil(cap.cache.ttlMs / 1000) : 0;
    switch (cap.freshness) {
      case "immutable":
        return explicit || 3600;
      case "near-live":
        return explicit || 120;
      default:
        return explicit || 15; // live
    }
  }

  private hashInput(input: Record<string, unknown>): string {
    return createHash("sha1")
      .update(JSON.stringify(input))
      .digest("hex")
      .slice(0, 16);
  }

  private async cacheGet(key: string): Promise<unknown> {
    try {
      const raw = await this.redis.get(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined; // best-effort: a Redis error is a miss
    }
  }

  private async cacheSet(
    key: string,
    value: unknown,
    ttlSec: number,
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), "EX", Math.max(1, ttlSec));
    } catch {
      // best-effort
    }
  }

  /**
   * Build the ActionPreview shown to the user before a confirmable action runs.
   * A capability's own `preview` (which can resolve the target's name and
   * estimate impact) is preferred; otherwise a generic preview is derived from
   * the operation. Preview builders are read-only — they resolve/describe, never
   * mutate — and a failure degrades to the generic preview (never blocks safely
   * surfacing the confirmation).
   */
  private async buildPreview(
    cap: NonNullable<ReturnType<CapabilityRegistry["get"]>>,
    input: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<ActionPreview> {
    const op = operationOf(cap);
    if (cap.preview) {
      try {
        return await cap.preview(input, ctx);
      } catch (e) {
        this.logger.warn(
          `preview builder failed for ${cap.name}: ${(e as Error).message}`,
        );
      }
    }
    return {
      operation: op,
      summary: `${op} via ${cap.name}`,
      permanent: op === "delete",
      reversible: cap.reversible ?? op !== "delete",
      details: { input },
    };
  }

  /**
   * Write one durable AgentExecution audit row. Best-effort — an audit failure
   * must never break the investigation, so it's caught and logged. The audited
   * `input` is the AI's own action params (workspaceId already stripped),
   * truncated so a large step (e.g. a funnel's steps) can't bloat the row; it is
   * NEVER raw analytics or session data.
   */
  private async audit(
    capability: string,
    ctx: AgentContext,
    input: Record<string, unknown>,
    result: StepResult,
    meta: { permitted: boolean; writes: boolean; skill: string },
  ): Promise<void> {
    try {
      await this.db.agentExecution.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          conversationId: ctx.conversationId ?? null,
          capability,
          skill: meta.skill,
          permitted: meta.permitted,
          ok: result.ok,
          writes: meta.writes,
          durationMs: result.ms,
          error: result.error ? result.error.slice(0, 500) : null,
          input: this.truncateInput(input),
        },
      });
    } catch (e) {
      this.logger.warn(
        `agent audit write failed for ${capability}: ${(e as Error).message}`,
      );
    }
  }

  /** Keep the audited input small: store it verbatim when compact, else a
   *  truncated JSON string marker. Prisma Json accepts either. */
  private truncateInput(input: Record<string, unknown>): Prisma.InputJsonValue {
    const s = JSON.stringify(input);
    if (s.length <= 1000) {
      return input as Prisma.InputJsonValue;
    }
    return { truncated: s.slice(0, 1000) };
  }
}
