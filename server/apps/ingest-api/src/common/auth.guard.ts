import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { verifyJwt } from "../auth/jwt";
import { getPostgresClient } from "@replay/db-postgres";
import type { AuthContext, UserAuthContext } from "./auth.context";

/**
 * Authenticates the user and nothing else. Onboarding runs before the user
 * has any workspace, so JwtAuthGuard's membership lookup would 401 them off
 * the very routes that create one. Routes behind this guard must not read a
 * workspace id — there may not be one.
 */
@Injectable()
export class JwtUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { userAuth?: UserAuthContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const payload = verifyJwt(header.slice("Bearer ".length));
    if (!payload) throw new UnauthorizedException("Invalid token");
    req.userAuth = { userId: payload.userId, email: payload.email };
    return true;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly db = getPostgresClient();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }
    const payload = verifyJwt(header.slice("Bearer ".length));
    if (!payload) throw new UnauthorizedException("Invalid token");

    // A token minted before onboarding carries workspaceId: null. Coerce
    // through NaN rather than Number(null) — that yields 0, a workspace id
    // that looks real enough to leak past a truthiness check downstream.
    const workspaceHeader =
      (req.headers["x-workspace-id"] as string | undefined) ??
      payload.workspaceId;
    const workspaceId = Number(workspaceHeader ?? NaN);
    if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
      throw new UnauthorizedException("Missing or invalid workspace");
    }
    const membership = await this.db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: payload.userId } },
    });
    if (!membership) {
      throw new UnauthorizedException("Not a member of this workspace");
    }

    req.auth = {
      userId: payload.userId,
      email: payload.email,
      workspaceId,
      workspaceRole: membership.role,
    };

    // Fire-and-forget: bump the membership's lastActiveAt so the Team page
    // can show "active 2 minutes ago". Throttled to once per minute per
    // member via an in-memory cache — DB roundtrip on every API call would
    // double the workspace's query load for no benefit.
    bumpLastActive(this.db, membership.id);

    return true;
  }
}

// Last-active throttling — same member touched within 60s is a no-op.
const lastActiveCache = new Map<number, number>();
function bumpLastActive(
  db: ReturnType<typeof getPostgresClient>,
  memberId: number,
) {
  const now = Date.now();
  const prev = lastActiveCache.get(memberId) ?? 0;
  if (now - prev < 60_000) return;
  lastActiveCache.set(memberId, now);
  db.workspaceMember
    .update({ where: { id: memberId }, data: { lastActiveAt: new Date(now) } })
    .catch(() => {});
}
