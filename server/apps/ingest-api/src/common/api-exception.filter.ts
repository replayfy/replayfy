import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import type { Response } from "express";
import type { ApiError } from "./api-response";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("ApiException");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong";
    let details: unknown;
    // The real message, for the log only. Never sent to the client unless it
    // came from an HttpException the code deliberately threw.
    let internal: string | undefined;
    const requestId = `req_${randomBytes(8).toString("hex")}`;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (body && typeof body === "object") {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string) ?? message;
        code = (obj.code as string) ?? this.codeForStatus(status);
        details = obj.details;
      }
      code = code === "INTERNAL_ERROR" ? this.codeForStatus(status) : code;
    } else if (this.isExposable4xx(exception)) {
      // Express middleware (body-parser especially) throws PLAIN Errors — not
      // HttpExceptions — that still carry a numeric `status`/`statusCode` and
      // `expose:true` for CLIENT faults: 413 'entity.too.large' when a body
      // (including a gzip-INFLATED one) exceeds its limit, 400
      // 'entity.parse.failed' for malformed JSON, 415 for a bad encoding. These
      // are the caller's fault, so surface the real 4xx instead of masking every
      // one as a generic 500 (which is what made a rejected gzip bomb look like
      // a server error). Gated on expose+4xx so a 5xx internal never leaks here.
      const e = exception as { status?: number; statusCode?: number };
      status = Number(e.status ?? e.statusCode);
      code = this.codeForStatus(status);
      message = this.messageForStatus(status);
    } else if (exception instanceof Error) {
      // NOT sent to the client. An unhandled error's message is written for
      // whoever is reading the logs, and routinely carries things a caller must
      // never see: absolute filesystem paths, ORM internals and the shape of the
      // query that failed, driver text quoting column and table names, and
      // occasionally the offending values themselves. A Prisma failure here was
      // returning the API's install path and the failing `user.findUnique()`
      // call to the browser. The client gets the generic message above plus the
      // request id, which is the only thing it needs to report the problem.
      internal = exception.message;
    }

    if (status >= 500) {
      // Logged WITH the request id, so a user quoting the id from a failed
      // response can be matched to this line. Without it the id is decoration.
      this.logger.error(
        `${requestId} ${code}: ${internal ?? message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const payload: ApiError = {
      ok: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
      meta: { request_id: requestId, ts: Date.now() },
    };

    res.status(status).json(payload);
  }

  /** True for a non-HttpException that still describes a CLIENT (4xx) fault it
   *  intends to expose — i.e. body-parser / express middleware errors. */
  private isExposable4xx(e: unknown): boolean {
    if (!e || typeof e !== "object") return false;
    const o = e as { status?: unknown; statusCode?: unknown; expose?: unknown };
    const s = Number(o.status ?? o.statusCode);
    return o.expose === true && Number.isInteger(s) && s >= 400 && s < 500;
  }

  /** Safe, generic client message for a middleware 4xx — never the raw error
   *  text (which can carry limits, paths, or the offending bytes). */
  private messageForStatus(status: number): string {
    switch (status) {
      case 413:
        return "Payload too large";
      case 415:
        return "Unsupported content encoding";
      case 400:
        return "Malformed request body";
      default:
        return "Request rejected";
    }
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case 400:
        return "BAD_REQUEST";
      case 401:
        return "UNAUTHORIZED";
      case 403:
        return "FORBIDDEN";
      case 404:
        return "NOT_FOUND";
      case 409:
        return "CONFLICT";
      case 413:
        return "PAYLOAD_TOO_LARGE";
      case 415:
        return "UNSUPPORTED_MEDIA_TYPE";
      case 422:
        return "VALIDATION_FAILED";
      case 429:
        return "RATE_LIMITED";
      default:
        return status >= 500 ? "INTERNAL_ERROR" : "ERROR";
    }
  }
}
