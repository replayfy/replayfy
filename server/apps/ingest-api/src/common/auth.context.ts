import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

export interface AuthContext {
  userId: number;
  email: string;
  workspaceId: number;
  workspaceRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
}

/** What JwtUserGuard attaches — no workspace, because there may not be one. */
export interface UserAuthContext {
  userId: number;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data, ctx: ExecutionContext): UserAuthContext => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { userAuth?: UserAuthContext }>();
    if (!req.userAuth) {
      throw new UnauthorizedException("Authentication required");
    }
    return req.userAuth;
  },
);

export const CurrentAuth = createParamDecorator(
  (_data, ctx: ExecutionContext): AuthContext => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    if (!req.auth) {
      throw new UnauthorizedException("Authentication required");
    }
    return req.auth;
  },
);

export const CurrentWorkspaceId = createParamDecorator(
  (_data, ctx: ExecutionContext): number => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    if (!req.auth) throw new UnauthorizedException("Authentication required");
    return req.auth.workspaceId;
  },
);

export const CurrentUserId = createParamDecorator(
  (_data, ctx: ExecutionContext): number => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    if (!req.auth) throw new UnauthorizedException("Authentication required");
    return req.auth.userId;
  },
);

export const CurrentRole = createParamDecorator(
  (_data, ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    if (!req.auth) throw new UnauthorizedException("Authentication required");
    return req.auth.workspaceRole;
  },
);
