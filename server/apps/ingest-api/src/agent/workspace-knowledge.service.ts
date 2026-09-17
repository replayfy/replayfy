import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { getPostgresClient, KnowledgeSource } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";

/** One learned fact as stored/mirrored. Exported because it is the shape the
 *  `GET /knowledge` handler returns to the "what we know" UI. */
export interface KnowledgeFact {
  key: string;
  value: string;
  source: KnowledgeSource;
  confidence: number;
  learnedById: number | null;
  learnedAt: string | Date;
}

/**
 * The AI's durable per-workspace learned memory — the assistant's own
 * per-workspace knowledge file. Semantic mappings + preferences the AI accumulates so it never
 * re-asks — injected into the planner/narrator context every turn via
 * `contextBlock`. Workspace-scoped by construction: every read/write takes a
 * workspaceId (injected server-side, NEVER from the LLM). Stores mappings and
 * preferences, never secrets/PII. Distinct from the short-term ConversationStore.
 *
 * Postgres is the source of truth; Redis is a WRITE-THROUGH mirror — every set/
 * remove rewrites the workspace's fact list into Redis, and every read (hit
 * every agent turn) is served from Redis, falling back to Postgres + warming on
 * a miss. So a workspace's learned facts always exist in BOTH stores.
 */
@Injectable()
export class WorkspaceKnowledgeService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(WorkspaceKnowledgeService.name);
  private static readonly MAX_LIST = 200;
  private static readonly MAX_CONTEXT = 60;
  private static readonly MAX_VALUE = 500;
  private static readonly TTL_SEC = 3600; // safety net; refreshed on every write

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** All facts for a workspace, newest first (for the "what we know" UI). */
  async list(workspaceId: number) {
    return this.getFacts(workspaceId);
  }

  /** One fact by key, or null. Serves from the (Redis-cached) fact list first,
   *  but the list is capped at MAX_LIST newest-first — so if it is FULL the key
   *  may live just past the cached window. In that case confirm with an indexed
   *  point lookup (backed by the `@@unique([workspaceId,key])` index) before
   *  concluding the fact is unknown; otherwise a workspace with >200 facts would
   *  make the AI re-ask/re-learn something it already knows. */
  async get(workspaceId: number, key: string) {
    const k = this.normKey(key);
    const facts = await this.getFacts(workspaceId);
    const f = facts.find((x) => x.key === k);
    if (f) {
      return {
        key: f.key,
        value: f.value,
        source: f.source,
        confidence: f.confidence,
      };
    }
    if (facts.length >= WorkspaceKnowledgeService.MAX_LIST) {
      const row = await this.db.workspaceKnowledge.findUnique({
        where: { workspaceId_key: { workspaceId, key: k } },
        select: { key: true, value: true, source: true, confidence: true },
      });
      return row ?? null;
    }
    return null;
  }

  /**
   * Upsert a fact (one canonical value per key per workspace), then write the
   * workspace's fact list THROUGH to Redis. Default source USER_PROVIDED (truth);
   * the clarify path writes user answers here, the conversion layer writes
   * CONFIRMED/INFERRED.
   */
  async set(
    workspaceId: number,
    key: string,
    value: string,
    opts: {
      source?: KnowledgeSource;
      learnedById?: number;
      confidence?: number;
    } = {},
  ) {
    const k = this.normKey(key);
    const v = String(value).trim().slice(0, WorkspaceKnowledgeService.MAX_VALUE);
    const source = opts.source ?? "USER_PROVIDED";
    const confidence = Math.min(
      100,
      Math.max(0, opts.confidence ?? (source === "INFERRED" ? 60 : 100)),
    );
    const data = {
      value: v,
      source,
      confidence,
      learnedById: opts.learnedById ?? null,
    };
    const row = await this.db.workspaceKnowledge.upsert({
      where: { workspaceId_key: { workspaceId, key: k } },
      create: { workspaceId, key: k, ...data },
      update: data,
      select: { key: true, value: true, source: true, confidence: true },
    });
    await this.warm(workspaceId); // write-through
    return row;
  }

  /** Forget a fact (user correction / cleanup), then refresh Redis. */
  async remove(workspaceId: number, key: string) {
    const r = await this.db.workspaceKnowledge.deleteMany({
      where: { workspaceId, key: this.normKey(key) },
    });
    await this.warm(workspaceId); // write-through
    return { removed: r.count > 0 };
  }

  /**
   * A compact block of learned facts for the planner/narrator prompt — the
   * workspace's own knowledge file. User-provided + confirmed facts are stated as
   * truth; inferred ones flagged unconfirmed. Served from Redis (warmed from
   * Postgres on a miss). Empty string when nothing has been taught yet.
   *
   * BUDGETING IS BY ROLE, NOT BY RECENCY — this ordering is the whole point.
   *
   * This used to `.slice(0, MAX_CONTEXT)` the recency-ordered list and THEN split
   * truth from guesses, which quietly inverted the module's purpose. `getFacts`
   * returns newest-first, so once a workspace passed 60 facts the newest INFERRED
   * guesses displaced the oldest USER_PROVIDED truth. The planner then saw its
   * conversion event as MISSING and hit the clarify path — re-asking a question
   * the user had already answered, which is exactly what this block exists to
   * prevent ("use them, do NOT re-ask"). It also thrashed: the re-answer bumped
   * `updatedAt`, pulling that fact back into the window and evicting another.
   *
   * The two tiers are not interchangeable, so they must not share one recency
   * queue. Truth is ONTOLOGY — the semantic mappings the planner cannot function
   * without, small and naturally bounded (a workspace has a handful of these,
   * ever). Guesses are ADVISORY, unbounded, and safe to drop. So truth is served
   * first and guesses take only what is left over.
   *
   * The sibling `get()` already guards this exact failure at the MAX_LIST=200
   * boundary, and its comment names it: "otherwise a workspace with >200 facts
   * would make the AI re-ask/re-learn something it already knows." That reasoning
   * was applied to the cold path and missed on the hot one, at a 3.3x tighter
   * threshold. This closes it.
   */
  async contextBlock(workspaceId: number): Promise<string> {
    const all = await this.getFacts(workspaceId);
    if (all.length === 0) return "";

    // Partition BEFORE budgeting. Never the other way round.
    const allTruth = all.filter((f) => f.source !== "INFERRED");
    const allGuesses = all.filter((f) => f.source === "INFERRED");

    // Truth is mandatory and gets the budget first; guesses take the remainder.
    // A guess can therefore never displace a confirmed fact, however fresh it is
    // — which also denies an injected fact the "I am newest, so I am always in
    // the window" position it would otherwise hold for free.
    const truth = allTruth.slice(0, WorkspaceKnowledgeService.MAX_CONTEXT);
    const room = Math.max(
      0,
      WorkspaceKnowledgeService.MAX_CONTEXT - truth.length,
    );
    const guesses = allGuesses.slice(0, room);

    // Truth itself overflowing is a different, louder problem: the AI is about to
    // re-ask something the user confirmed, and no ordering can save us. Surface
    // it rather than dropping facts silently. (Note the outer bound too: getFacts
    // caps at MAX_LIST newest-first, so a workspace past that could have truth
    // outside the fetched window — the same class of bug, an order of magnitude
    // further away. Revisit by fetching truth by role if a real workspace ever
    // approaches it.)
    if (allTruth.length > truth.length) {
      this.logger.warn(
        `workspace ${workspaceId} has ${allTruth.length} confirmed facts but only ${truth.length} fit the prompt — the AI may re-ask what it already knows. Prune WorkspaceKnowledge or raise MAX_CONTEXT.`,
      );
    }

    const lines: string[] = [];
    if (truth.length > 0) {
      lines.push(
        "Known facts about THIS workspace (learned — use them, do NOT re-ask):",
      );
      for (const f of truth) lines.push(`- ${f.key} = ${f.value}`);
    }
    if (guesses.length > 0) {
      lines.push(
        "Unconfirmed guesses (confirm with the user before relying on these):",
      );
      for (const f of guesses) lines.push(`- ${f.key} = ${f.value}`);
    }
    return lines.join("\n");
  }

  /** Redis-first fact list (source of truth = Postgres). On a miss, read the DB
   *  and warm Redis, so the workspace's facts always end up in BOTH stores. */
  private async getFacts(workspaceId: number): Promise<KnowledgeFact[]> {
    try {
      const raw = await this.redis.get(this.cacheKey(workspaceId));
      if (raw) return JSON.parse(raw) as KnowledgeFact[];
    } catch {
      // best-effort — fall through to Postgres
    }
    return this.warm(workspaceId);
  }

  /** Read the workspace's facts from Postgres and write them THROUGH to Redis. */
  private async warm(workspaceId: number): Promise<KnowledgeFact[]> {
    const facts = (await this.db.workspaceKnowledge.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      take: WorkspaceKnowledgeService.MAX_LIST,
      select: {
        key: true,
        value: true,
        source: true,
        confidence: true,
        learnedById: true,
        learnedAt: true,
      },
    })) as KnowledgeFact[];
    try {
      await this.redis.set(
        this.cacheKey(workspaceId),
        JSON.stringify(facts),
        "EX",
        WorkspaceKnowledgeService.TTL_SEC,
      );
    } catch {
      // best-effort
    }
    return facts;
  }

  private cacheKey(workspaceId: number): string {
    return `ws:knowledge:${workspaceId}`;
  }

  /** Normalise a key to a stable lowercased slug — runs of non-key chars
   *  collapse to one `_`, and leading/trailing separators are trimmed, so
   *  "Payment Success Event!" and "payment_success_event" resolve identically. */
  private normKey(key: string): string {
    return String(key)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.]+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "")
      .slice(0, 80);
  }
}
