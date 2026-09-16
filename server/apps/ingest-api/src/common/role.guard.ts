import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthContext } from "./auth.context";

export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

// Rank roles so we can check "≥ this role" with a single comparison.
const RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export const ROLES_KEY = "replay:minRole";

/** Mark a route/controller as requiring at least the given role. */
export const RequiresRole = (role: WorkspaceRole) =>
  SetMetadata(ROLES_KEY, role);

export const WORKSPACE_PATH_KEY = "replay:workspacePathId";

/**
 * Mark a controller/route whose `:id` path param IS the workspace id (the
 * workspaces controller). WorkspaceRoleGuard then confines `:id` to the
 * workspace the caller authenticated against — closing the confused-deputy
 * where a member of workspace A passes `:id=B` and the handler acts on B.
 * Resource controllers (cohorts/sessions/etc.) do NOT set this: their `:id` is
 * a resource id already scoped by `workspaceId` in the query.
 */
export const WorkspacePathId = () => SetMetadata(WORKSPACE_PATH_KEY, true);

/**
 * Companion guard for JwtAuthGuard. Reads the @RequiresRole(...) metadata and
 * 403s the caller if their workspace role doesn't meet the threshold. Without
 * metadata, any authenticated role is allowed through — controllers can stay
 * lean and only annotate the destructive endpoints.
 */
@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext; params?: Record<string, string> }>();

    // Path-workspace confinement (workspaces controller only, via
    // @WorkspacePathId()): the `:id` path param is a workspace id and MUST
    // equal the workspace the caller authenticated against — JwtAuthGuard ran
    // first and validated membership of THAT workspace (from x-workspace-id).
    // Runs independent of @RequiresRole, because read routes like GET
    // /v1/workspaces/:id/members don't set a role but must still be confined.
    const pathIsWorkspace = this.reflector.getAllAndOverride<boolean>(
      WORKSPACE_PATH_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (pathIsWorkspace) {
      if (!req.auth) throw new UnauthorizedException("Authentication required");
      const pathId = Number(req.params?.id);
      if (Number.isFinite(pathId) && pathId !== req.auth.workspaceId) {
        throw new ForbiddenException(
          "Workspace mismatch: the path workspace does not match the authenticated workspace.",
        );
      }
    }

    const required = this.reflector.getAllAndOverride<
      WorkspaceRole | undefined
    >(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required) return true;

    if (!req.auth) throw new UnauthorizedException("Authentication required");
    /* `?? -1` so an unrecognised role is the LOWEST, never the highest. RANK[x]
       on an unknown key is undefined, and `undefined < need` is false — i.e.
       this comparison would GRANT access. Unreachable today (the value comes
       from a verified membership row and the column is an enum), but the day
       someone adds a fifth role and forgets RANK, the failure must be a 403,
       not silent superuser. */
    const have = RANK[req.auth.workspaceRole] ?? -1;
    const need = RANK[required];
    if (have < need) {
      throw new ForbiddenException(
        `This action requires ${required.toLowerCase()} access.`,
      );
    }
    return true;
  }
}
