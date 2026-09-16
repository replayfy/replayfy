import { Injectable } from "@nestjs/common";
import {
  getPostgresClient,
  type NotificationKind,
  type Prisma,
} from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";

@Injectable()
export class NotificationsService {
  private readonly db = getPostgresClient();

  /**
   * Insert a notification for a specific user. Fire-and-forget — callers
   * shouldn't await because the originating action (invite send, storage
   * threshold check) is the user-visible operation.
   */
  async emit(opts: {
    workspaceId: number;
    userId: number;
    kind: NotificationKind;
    payload: object;
  }): Promise<void> {
    await this.db.notification
      .create({
        data: {
          workspaceId: opts.workspaceId,
          userId: opts.userId,
          kind: opts.kind,
          payload: opts.payload as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
  }

  /**
   * Broadcast to every ADMIN/OWNER in a workspace. Used for workspace-wide
   * events (storage threshold, invite sent, rage cluster) where every
   * admin should see it.
   */
  async notifyAdmins(
    workspaceId: number,
    kind: NotificationKind,
    payload: object,
  ): Promise<void> {
    const admins = await this.db.workspaceMember.findMany({
      where: { workspaceId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    if (admins.length === 0) return;
    await this.db.notification
      .createMany({
        data: admins.map((m) => ({
          workspaceId,
          userId: m.userId,
          kind,
          payload: payload as Prisma.InputJsonValue,
        })),
      })
      .catch(() => undefined);
  }

  /**
   * Idempotent emit — only fires if no notification of the same kind exists
   * for this user+workspace within the dedupe window. Used for the storage
   * threshold check that runs every minute via cron; we don't want to spam
   * the admin every 60s.
   */
  async emitOnce(opts: {
    workspaceId: number;
    userId: number;
    kind: NotificationKind;
    payload: object;
    withinHours: number;
  }): Promise<boolean> {
    const since = new Date(Date.now() - opts.withinHours * 3_600_000);
    const existing = await this.db.notification.findFirst({
      where: {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        kind: opts.kind,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    if (existing) return false;
    await this.emit(opts);
    return true;
  }

  async list(
    userId: number,
    workspaceId: number,
    opts: { cursor?: string; limit?: string; unread?: string },
  ) {
    const take = parseLimit(opts.limit, 25, 100);
    const cursorId = decodeCursor(opts.cursor);
    const where: Prisma.NotificationWhereInput = { userId, workspaceId };
    if (opts.unread === "true") where.readAt = null;
    const rows = await this.db.notification.findMany({
      where:
        cursorId !== undefined ? { ...where, id: { lt: cursorId } } : where,
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor,
    );
  }

  async markRead(userId: number, id: number) {
    await this.db.notification.updateMany({
      where: { id, userId },
      data: { readAt: new Date() },
    });
    return { id, readAt: new Date().toISOString() };
  }

  async markAllRead(userId: number, workspaceId: number) {
    const result = await this.db.notification.updateMany({
      where: { userId, workspaceId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }
}
