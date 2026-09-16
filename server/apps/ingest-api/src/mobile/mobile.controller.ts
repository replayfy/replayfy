import {
  Body,
  Controller,
  Headers,
  Ip,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { MobileService } from "./mobile.service";
import { SkipThrottle } from "@nestjs/throttler";
import { verifyMobileToken } from "./mobile-token";

/**
 * Mobile SDK ingest endpoints. Project-key auth on /start (which mints
 * a session-scoped bearer); bearer auth on the data endpoints.
 *
 *   POST /v1/mobile/start   → create session, return token + fps/quality
 *   POST /v1/mobile/i       → gzipped binary message batch
 *   POST /v1/mobile/late    → final message batch (app terminate)
 *   POST /v1/mobile/images  → gzipped frames archive batch
 */
// High-volume mobile ingest: exempt from the global HTTP throttle.
@SkipThrottle()
@Controller("v1/mobile")
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Post("start")
  async start(
    @Headers("x-forwarded-for") forwardedFor: string | undefined,
    @Ip() ip: string,
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
  ) {
    // Same client-IP resolution the web ingest uses — geoip needs it to
    // derive country/city for the mobile session (the SDK can't see its
    // own egress IP, so geo is the server's job).
    const clientIp =
      forwardedFor?.split(",")[0]?.trim() ||
      ip ||
      (req.socket?.remoteAddress ?? undefined);
    const result = await this.mobile.createSession(body as never, clientIp);
    if (!result) throw new UnauthorizedException("invalid project key");
    return result;
  }

  @Post("i")
  async ingest(
    @Headers("authorization") auth: string | undefined,
    @Req() req: Request,
  ) {
    const token = verifyMobileToken(auth);
    if (!token) throw new UnauthorizedException("invalid session token");
    const buf = asBuffer(req.body);
    return this.mobile.ingestMessages(token, buf, /* gzipped */ true);
  }

  @Post("late")
  async late(
    @Headers("authorization") auth: string | undefined,
    @Req() req: Request,
  ) {
    const token = verifyMobileToken(auth);
    if (!token) throw new UnauthorizedException("invalid session token");
    const buf = asBuffer(req.body);
    // Late batches are not gzipped (sent best-effort on app terminate).
    const result = await this.mobile.ingestMessages(
      token,
      buf,
      /* gzipped */ false,
    );
    // Terminate beacon ⇒ session end ⇒ pack the frames archive now (the SDK
    // flushed the final frames before this call).
    await this.mobile.endSession(token);
    return result;
  }

  @Post("images")
  async images(
    @Headers("authorization") auth: string | undefined,
    @Req() req: Request,
  ) {
    const token = verifyMobileToken(auth);
    if (!token) throw new UnauthorizedException("invalid session token");
    const buf = asBuffer(req.body);
    return this.mobile.appendFrames(token, buf);
  }

  // Discard the current session's recording — the SDK's cancelSession() calls
  // this (bearer-authed by the session token) so a session the user cancels
  // never lands. JSON body carries `{ sessionId }` for logging/parity; the
  // authoritative session id is the one bound into the token.
  @Post("cancel")
  async cancel(@Headers("authorization") auth: string | undefined) {
    const token = verifyMobileToken(auth);
    if (!token) throw new UnauthorizedException("invalid session token");
    await this.mobile.cancelSession(token);
    return { ok: true };
  }
}

function asBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new UnauthorizedException("expected binary body");
}
