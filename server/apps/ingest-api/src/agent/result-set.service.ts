import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { querySessions, type SessionQueryFilter } from "@replay/db-clickhouse";

export interface Recording {
  recording: string;
  platform?: string | null;
  country?: string | null;
  release?: string | null;
  durationMs?: number | null;
  errors?: number | null;
  rage?: number | null;
  startPath?: string | null;
}

/**
 * Persists + serves the re-runnable session set behind an AI answer — what makes
 * "Show recordings (N)" work WITHOUT re-running the AI or minting a playlist. A
 * QUERY set stores just the filter and re-executes it keyset-paginated (fresh
 * data, tiny row); a SNAPSHOT set stores concrete ids and pages them. Every read
 * is workspace-scoped; expired rows are swept hourly.
 */
@Injectable()
export class ResultSetService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(ResultSetService.name);
  private static readonly TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly PAGE = 50;

  /** Persist a result set (from session.query); returns its opaque id. */
  async create(
    workspaceId: number,
    ref: {
      kind: "query" | "snapshot";
      filter?: unknown;
      sessionIds?: number[];
      count?: number;
    },
  ): Promise<string> {
    const isQuery = ref.kind !== "snapshot";
    const row = await this.db.agentResultSet.create({
      data: {
        workspaceId,
        kind: isQuery ? "QUERY" : "SNAPSHOT",
        filter: isQuery
          ? ((ref.filter ?? {}) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        sessionIds: isQuery
          ? Prisma.JsonNull
          : ((ref.sessionIds ?? []) as Prisma.InputJsonValue),
        count: ref.count ?? 0,
        expiresAt: new Date(Date.now() + ResultSetService.TTL_MS),
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * One page of recordings for a saved result set. Workspace-scoped (a foreign id
   * never resolves). QUERY re-runs the stored filter keyset-paginated; SNAPSHOT
   * pages the stored ids by offset. `nextCursor` is opaque (pass it back for the
   * next page), null when exhausted.
   */
  async recordings(
    workspaceId: number,
    id: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ recordings: Recording[]; total: number; nextCursor: string | null }> {
    const rs = await this.db.agentResultSet.findFirst({
      where: { id, workspaceId },
    });
    if (!rs) return { recordings: [], total: 0, nextCursor: null };
    const lim = Math.max(
      1,
      Math.min(100, Math.floor(limit ?? ResultSetService.PAGE)),
    );

    if (rs.kind === "SNAPSHOT") {
      const ids = Array.isArray(rs.sessionIds)
        ? (rs.sessionIds as number[])
        : [];
      const start = Number(cursor) || 0;
      const pageIds = ids.slice(start, start + lim);
      const recordings = await this.hydrate(workspaceId, pageIds);
      const nextCursor = start + lim < ids.length ? String(start + lim) : null;
      return { recordings, total: rs.count, nextCursor };
    }

    // QUERY — re-execute the stored filter, keyset-paginated (fresh data).
    const filter = (rs.filter ?? {}) as SessionQueryFilter;
    const { sessions } = await querySessions({
      workspaceId,
      filter,
      limit: lim,
      cursor: this.parseCursor(cursor),
    });
    const recordings = await this.hydrate(
      workspaceId,
      sessions.map((s) => s.session_id),
      sessions,
    );
    const last = sessions[sessions.length - 1];
    const nextCursor =
      sessions.length === lim && last
        ? `${last.datetime}_${last.session_id}`
        : null;
    return { recordings, total: rs.count, nextCursor };
  }

  /** Resolve session_id → recording publicId (+ merge CH display attrs when the
   *  QUERY path passes them), preserving input order. A missing session (deleted)
   *  is dropped. */
  private async hydrate(
    workspaceId: number,
    ids: number[],
    attrRows?: Array<{
      session_id: number;
      country?: string;
      release?: string;
      platform?: string;
      duration_ms?: number;
      errors_count?: number;
      rage_count?: number;
      start_path?: string;
    }>,
  ): Promise<Recording[]> {
    if (ids.length === 0) return [];
    const pubs = await this.db.session.findMany({
      where: { workspaceId, id: { in: ids } },
      select: {
        id: true,
        publicId: true,
        platform: true,
        startUrl: true,
        durationMs: true,
      },
    });
    const byId = new Map(pubs.map((p) => [p.id, p]));
    const attrById = new Map((attrRows ?? []).map((a) => [a.session_id, a]));
    return ids
      .filter((id) => byId.has(id))
      .map((id) => {
        const p = byId.get(id)!;
        const a = attrById.get(id);
        return {
          recording: p.publicId,
          platform: a?.platform ?? p.platform,
          country: a?.country ?? null,
          release: a?.release ?? null,
          durationMs: a?.duration_ms ?? p.durationMs,
          errors: a?.errors_count ?? null,
          rage: a?.rage_count ?? null,
          startPath: a?.start_path ?? p.startUrl,
        };
      });
  }

  private parseCursor(
    cursor?: string,
  ): { datetime: number; sessionId: number } | undefined {
    if (!cursor) return undefined;
    const [dt, sid] = cursor.split("_");
    const datetime = Number(dt);
    const sessionId = Number(sid);
    return Number.isFinite(datetime) && Number.isFinite(sessionId)
      ? { datetime, sessionId }
      : undefined;
  }

  /** Hourly TTL sweep — one set-based DELETE (index [expiresAt]). */
  @Cron("23 * * * *")
  async sweep(): Promise<void> {
    try {
      const r = await this.db.agentResultSet.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (r.count > 0) {
        this.logger.log(`result-set sweep: pruned ${r.count} expired`);
      }
    } catch (e) {
      this.logger.warn(`result-set sweep failed: ${(e as Error).message}`);
    }
  }
}
