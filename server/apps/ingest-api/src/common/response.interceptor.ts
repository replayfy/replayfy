import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, map } from "rxjs";
import { randomBytes } from "crypto";
import {
  isPaginatedPayload,
  type ApiMeta,
  type ApiSuccess,
  type ApiSuccessList,
} from "./api-response";

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const meta: ApiMeta = {
      request_id: `req_${randomBytes(8).toString("hex")}`,
      ts: Date.now(),
    };

    return next.handle().pipe(
      map((value) => {
        if (isPaginatedPayload(value)) {
          const payload = value as unknown as {
            items: unknown[];
            nextCursor: string | null;
            total?: { value: number; capped: boolean };
          };
          const out: ApiSuccessList<unknown> = {
            ok: true,
            data: payload.items,
            page: {
              next_cursor: payload.nextCursor,
              has_more: payload.nextCursor !== null,
              count: payload.items.length,
              // Spread-only when the service supplied one, so a list that does
              // not count emits byte-identical JSON to before this change — the
              // keys are absent, not null. `total: null` would be a new claim
              // ("no rows"?) on every other list in the API.
              ...(payload.total
                ? {
                    total: payload.total.value,
                    total_capped: payload.total.capped,
                  }
                : {}),
            },
            meta,
          };
          return out;
        }
        const out: ApiSuccess<unknown> = {
          ok: true,
          data: value ?? null,
          meta,
        };
        return out;
      }),
    );
  }
}
