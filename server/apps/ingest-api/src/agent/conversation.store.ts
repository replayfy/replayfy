import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { Redis } from "ioredis";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { REDIS_CLIENT } from "../common/redis.module";

interface Turn {
  question: string;
  answer: string;
  citations: string[];
}

/**
 * Durable stateful-conversation memory so the agent carries an investigation
 * across turns ("...now create a cohort from those users"). Keyed by an opaque
 * conversationId the client passes back, and backed by the AgentConversation
 * table — so follow-up context survives an API restart and works across
 * instances (the in-memory version lost both).
 *
 * Isolation is enforced BY CONSTRUCTION: every read and write is scoped to the
 * composite key (conversationId, workspaceId). A turn stored under workspace A
 * is a different row from workspace B's, so a conversationId reused under a
 * different workspace can never surface another tenant's context.
 *
 * Postgres is the source of truth (durability); Redis is a WRITE-THROUGH mirror
 * (key `ws:conv:<ws>:<id>`) so `recent()` — read on the AI's hot path EVERY turn
 * — is served from Redis, not a Postgres round-trip. Redis TTL mirrors the
 * updatedAt-based session TTL, so a Redis hit is fresh by construction and a
 * READ never extends a session's life (only append() does).
 */
@Injectable()
export class ConversationStore {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(ConversationStore.name);
  // Session window = 10 minutes of inactivity (sliding — each append() resets
  // it). A user can also end it explicitly via end(); otherwise recent() ignores
  // anything past the TTL and the hourly sweep() prunes it.
  private static readonly TTL_MS = 10 * 60 * 1000;
  private static readonly TTL_SEC = 10 * 60;
  private static readonly MAX_TURNS = 8;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Prior turns for this conversation, or [] — scoped to the same workspace,
   *  and only if the conversation was active within the TTL. Redis-first. */
  async recent(
    conversationId: string | undefined,
    workspaceId: number,
  ): Promise<Array<{ question: string; answer: string }>> {
    if (!conversationId) return [];
    const turns = await this.load(conversationId, workspaceId);
    return turns
      .slice(-ConversationStore.MAX_TURNS)
      .map((t) => ({ question: t.question, answer: t.answer }));
  }

  /** Redis-first turn list (a Redis hit is within-TTL by construction). On a
   *  miss, read Postgres, apply the updatedAt TTL, and warm Redis with the
   *  REMAINING TTL — so a read never extends the session (only append() does). */
  private async load(
    conversationId: string,
    workspaceId: number,
  ): Promise<Turn[]> {
    const key = this.cacheKey(workspaceId, conversationId);
    try {
      const raw = await this.redis.get(key);
      if (raw) return this.asTurns(JSON.parse(raw));
    } catch {
      // best-effort — fall through to Postgres
    }
    const row = await this.db.agentConversation.findUnique({
      where: { conversationId_workspaceId: { conversationId, workspaceId } },
      select: { turns: true, updatedAt: true },
    });
    if (!row) return [];
    const ageMs = Date.now() - row.updatedAt.getTime();
    if (ageMs > ConversationStore.TTL_MS) return [];
    const turns = this.asTurns(row.turns);
    const remainingSec = Math.ceil(
      (ConversationStore.TTL_MS - ageMs) / 1000,
    );
    if (remainingSec > 0) {
      try {
        await this.redis.set(key, JSON.stringify(turns), "EX", remainingSec);
      } catch {
        // best-effort
      }
    }
    return turns;
  }

  /** Append a turn to (conversationId, workspaceId). Best-effort — a failure to
   *  persist context must never break the answer that was already produced. */
  async append(
    conversationId: string | undefined,
    workspaceId: number,
    turn: Turn,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      // Read-modify-write the capped turns array. Turns for one conversation
      // arrive sequentially (one user, one question at a time), so the tiny
      // race window is acceptable; the composite key keeps it workspace-scoped.
      const existing = await this.db.agentConversation.findUnique({
        where: { conversationId_workspaceId: { conversationId, workspaceId } },
        select: { turns: true },
      });
      const next = [...this.asTurns(existing?.turns), turn].slice(
        -ConversationStore.MAX_TURNS * 2,
      );
      const turnsJson = next as unknown as Prisma.InputJsonValue;
      await this.db.agentConversation.upsert({
        where: { conversationId_workspaceId: { conversationId, workspaceId } },
        create: { conversationId, workspaceId, turns: turnsJson },
        update: { turns: turnsJson },
      });
      // Write-through: this append IS fresh activity, so mirror the turns to
      // Redis with a full TTL (the next `recent()` reads it without touching PG).
      const key = this.cacheKey(workspaceId, conversationId);
      try {
        await this.redis.set(
          key,
          JSON.stringify(next),
          "EX",
          ConversationStore.TTL_SEC,
        );
      } catch {
        // Best-effort — Postgres remains authoritative. But a PRIOR key must not
        // linger with the pre-append turns: the next recent() would trust it and
        // silently drop the turn we just persisted (losing "those users"/"that
        // funnel" context). Evict it so the next load() re-warms from Postgres.
        // If this DEL also fails, Redis is unreachable and load()'s GET misses
        // anyway — either way the next read is fresh.
        try {
          await this.redis.del(key);
        } catch {
          // best-effort
        }
      }
    } catch (e) {
      this.logger.warn(
        `conversation append failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
    }
  }

  /** End a session window NOW (the user clicked "New conversation"/clear).
   *  Drops the durable row + the Redis mirror so the next turn starts cold.
   *  Best-effort + workspace-scoped by the composite key. */
  async end(
    conversationId: string | undefined,
    workspaceId: number,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.db.agentConversation.deleteMany({
        where: { conversationId, workspaceId },
      });
    } catch (e) {
      this.logger.warn(
        `conversation end failed (ws ${workspaceId}): ${(e as Error).message}`,
      );
    }
    try {
      await this.redis.del(this.cacheKey(workspaceId, conversationId));
    } catch {
      // best-effort — Postgres is authoritative and the row is already gone
    }
  }

  private cacheKey(workspaceId: number, conversationId: string): string {
    return `ws:conv:${workspaceId}:${conversationId}`;
  }

  /**
   * Hourly TTL cleanup — one set-based DELETE of conversations idle past the
   * TTL, served by @@index([updatedAt]). Bounded by expired-row count, never a
   * full scan; recent() already ignores anything this would delete.
   */
  @Cron("7 * * * *")
  async sweep(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - ConversationStore.TTL_MS);
      const r = await this.db.agentConversation.deleteMany({
        where: { updatedAt: { lt: cutoff } },
      });
      if (r.count > 0) {
        this.logger.log(`conversation sweep: pruned ${r.count} expired`);
      }
    } catch (e) {
      this.logger.warn(`conversation sweep failed: ${(e as Error).message}`);
    }
  }

  /** Coerce the stored Json column back into a typed turn array. */
  private asTurns(v: unknown): Turn[] {
    return Array.isArray(v) ? (v as unknown as Turn[]) : [];
  }
}
