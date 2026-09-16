import { Injectable, NotFoundException } from "@nestjs/common";
import { getPostgresClient, type Prisma } from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";

/**
 * The 4 author fields a comment row shows. `author: true` pulled the whole User
 * — passwordHash included — for every comment on a list that pages up to 200.
 * The mapper never serialises it, so this is blast radius rather than bytes:
 * a credential shouldn't cross into the API process to render a name.
 */
const COMMENT_AUTHOR_SELECT = {
  select: { id: true, name: true, email: true, initials: true },
} as const;

@Injectable()
export class CommentsService {
  private readonly db = getPostgresClient();

  constructor(private readonly stats: WorkspaceStatsService) {}

  async listForWorkspace(workspaceId: number, cursor?: string, limit?: string) {
    const take = parseLimit(limit, 25, 100);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.comment.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      include: {
        author: COMMENT_AUTHOR_SELECT,
        session: { select: { publicId: true, startUrl: true } },
      },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((c) => this.toSummary(c)),
      nextCursor,
    );
  }

  async listForSession(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
  ) {
    // Existence check + FK: the only field read is `id`, so don't hydrate ~90
    // Session columns (customProps jsonb, eventNames, the BigInt
    // counters) just to resolve a publicId.
    const session = await this.db.session.findFirst({
      where: { workspaceId, publicId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    const take = parseLimit(limit, 50, 200);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.comment.findMany({
      where: {
        sessionId: session.id,
        deletedAt: null,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      include: {
        author: COMMENT_AUTHOR_SELECT,
        session: { select: { publicId: true, startUrl: true } },
      },
      orderBy: [{ atMs: "asc" }, { id: "asc" }],
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((c) => this.toSummary(c)),
      nextCursor,
    );
  }

  async create(
    workspaceId: number,
    userId: number,
    publicId: string,
    body: { body: string; atMs: number; parentId?: number },
  ) {
    // Existence check + FK: the only field read is `id`, so don't hydrate ~90
    // Session columns (customProps jsonb, eventNames, the BigInt
    // counters) just to resolve a publicId.
    const session = await this.db.session.findFirst({
      where: { workspaceId, publicId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    const row = await this.db.comment.create({
      data: {
        workspaceId,
        sessionId: session.id,
        authorId: userId,
        body: body.body,
        atMs: body.atMs,
        parentId: body.parentId,
      },
      include: {
        author: COMMENT_AUTHOR_SELECT,
        session: { select: { publicId: true, startUrl: true } },
      },
    });
    // Cached counter — never blocks the response. If the bump fails the
    // 5-min reconcile will pick it up.
    this.stats.bump(workspaceId, { commentsTotal: 1 }).catch(() => {});
    await this.db.session.update({
      where: { id: session.id },
      data: { commentCount: { increment: 1 } },
    });
    return this.toSummary(row);
  }

  async update(workspaceId: number, id: number, body: { body?: string }) {
    const existing = await this.db.comment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Comment not found");
    const row = await this.db.comment.update({
      where: { id },
      data: { body: body.body },
      include: {
        author: COMMENT_AUTHOR_SELECT,
        session: { select: { publicId: true, startUrl: true } },
      },
    });
    return this.toSummary(row);
  }

  async remove(workspaceId: number, id: number) {
    const existing = await this.db.comment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundException("Comment not found");
    await this.db.comment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    // Decrement only if it wasn't already soft-deleted, so re-running
    // delete on the same comment doesn't double-decrement.
    if (!existing.deletedAt) {
      this.stats.bump(workspaceId, { commentsTotal: -1 }).catch(() => {});
    }
    return { id, deleted: true };
  }

  private toSummary = (
    c: Prisma.CommentGetPayload<{
      include: {
        author: typeof COMMENT_AUTHOR_SELECT;
        session: { select: { publicId: true; startUrl: true } };
      };
    }>,
  ) => ({
    id: c.id,
    body: c.body,
    atMs: c.atMs,
    parentId: c.parentId,
    sessionPublicId: c.session?.publicId,
    sessionUrl: c.session?.startUrl,
    author: c.author
      ? {
          id: c.author.id,
          name: c.author.name,
          email: c.author.email,
          initials: c.author.initials,
        }
      : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  });
}
