import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { getPostgresClient } from "@replay/db-postgres";
import { REDIS_CLIENT } from "./redis.module";
import type { AuthContext } from "./auth.context";
import { planManualPassesPerDay, resolvePlan } from "../billing/plan-catalog";

/**
 * Rate-limits the manual "regenerate insights" button to the plan's daily
 * allowance (AI_MANUAL_PASSES_PER_DAY) and REJECTS before the handler runs, so a
 * held-down button can't drive the ~1,206-credit intel pass on every click. It
 * lives in a guard, not in the service, because it is a per-request precondition
 * with no bearing on how the pass is computed — the same reason @RequiresRole is
 * a guard and not an `if` at the top of every method.
 *
 * SCOPE. This is NOT the money gate. AI credits are enforced one layer deeper by
 * LlmService.resolve(), which refuses BEFORE opening a socket, so an
 * out-of-credits workspace already spends nothing on any of the ~14 AI call
 * sites. This guard is the softer "don't burn your day's allowance in one
 * sitting" cap on the one endpoint a user can hammer.
 *
 * TRADE-OFF (deliberate). A guard runs before the handler, so it cannot know
 * whether the pass will actually reach the provider — it counts the click either
 * way. That means a click that opens no socket (e.g. already out of credits)
 * still costs a manual token. Acceptable: such a workspace gets no insights
 * regardless, and the credit gate is the real spend protection; the cost here is
 * only how fast the (already useless) daily allowance is consumed.
 */
@Injectable()
export class ManualAiThrottleGuard implements CanActivate {
  private readonly db = getPostgresClient();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Rolling 24h, not a calendar day: a fixed window lets a user spend the whole
   *  allowance either side of the boundary and can only say "retry within 24h"
   *  instead of naming the instant a token frees. */
  private static readonly WINDOW_MS = 86_400_000;
  /** The shared ioredis client runs maxRetriesPerRequest:null + an offline
   *  queue, so a Redis outage makes a command HANG rather than reject; bound it
   *  so the request answers instead of stalling. */
  private static readonly REDIS_TIMEOUT_MS = 300;
  /**
   * Take one token from the rolling window, atomically, as ONE Lua script. A
   * check-then-add pair from Node lets two concurrent clicks read the same count
   * and both proceed, overspending the window; and a plain INCR+EXPIRE pair can
   * die between its two commands and strand a TTL-less key, locking the workspace
   * out of manual refresh forever. Atomicity bounds the COUNT — two simultaneous
   * clicks each take a distinct token and the (N+1)th is still denied — but it
   * does not deduplicate two clicks on the same facts, which is fine: the user
   * asked to refresh twice and both are within budget.
   * A DENIED attempt deliberately does not ZADD, so an impatient user cannot push
   * their own window forward by retrying. The prune bound is INCLUSIVE of
   * `now - win` so a member is gone at exactly the retryAfterMs we advertised.
   * Returns [allowed, used, retryAfterMs].
   */
  private static readonly TAKE_LUA = `
    local now = tonumber(ARGV[1])
    local win = tonumber(ARGV[2])
    local lim = tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win)
    local used = redis.call('ZCARD', KEYS[1])
    if used >= lim then
      local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
      return {0, used, math.floor(tonumber(oldest[2]) + win - now)}
    end
    redis.call('ZADD', KEYS[1], now, ARGV[4])
    redis.call('PEXPIRE', KEYS[1], win)
    return {1, used + 1, 0}`;

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext }>();
    const workspaceId = req.auth?.workspaceId;
    // JwtAuthGuard (controller-level) owns rejecting the unauthenticated; if it
    // somehow let a request through without a workspace there is nothing to meter.
    if (!workspaceId) return true;

    // Access pattern: one row by PRIMARY KEY on a user-triggered click. `plan`
    // drives the limit; `aiEnabled` lets a disabled workspace through untolled,
    // matching the service's first gate (AI off spends nothing → no token).
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, aiEnabled: true },
    });
    if (ws?.aiEnabled === false) return true;
    const limit = planManualPassesPerDay(ws?.plan);
    if (limit <= 0) return true; // 0 = NO LIMIT (paid tiers) — never touch Redis

    const now = Date.now();
    const key = `ai:recompute:${workspaceId}`;
    // Our own member id, so the timeout path can compensate for a late-running
    // command. Per WORKSPACE, not per user: the route is MEMBER+, so a per-user
    // key would hand a 10-seat workspace 10x its budget.
    const member = `${now}:${randomUUID()}`;
    const op = this.redis.eval(
      ManualAiThrottleGuard.TAKE_LUA,
      1,
      key,
      String(now),
      String(ManualAiThrottleGuard.WINDOW_MS),
      String(limit),
      member,
    ) as Promise<[number, number, number]>;

    let res: [number, number, number];
    try {
      res = await this.raceRedis(op);
    } catch {
      // We abandoned the command at the 300ms bound, but ioredis' offline queue
      // still delivers it when Redis recovers. If that late EVAL ADDs our member,
      // compensate — otherwise a brief Redis stall that answered 503 (and ran no
      // pass) silently spends the token, and on Free (2/day) a 2s blip could lock
      // the button for the next 24h. The ZREM only fires if the command consumed.
      void op.then(
        (r) => {
          if (Array.isArray(r) && r[0] === 1) {
            void this.redis.zrem(key, member).catch(() => {});
          }
        },
        () => {},
      );
      // FAIL CLOSED, deliberately inverting the fail-open cache style next door
      // (release/presence): a cache's fallback is "compute it live", a throttle's
      // is "the control doesn't exist" — the exact unbounded-spend hole this
      // closes. Cheap here because the SCHEDULED pass touches no Redis, so an
      // outage costs nothing permanent — the button is an accelerator, not a data
      // path. A distinct code so we never claim a quota when our counter is down.
      throw new HttpException(
        {
          code: "AI_REFRESH_QUOTA_UNAVAILABLE",
          message:
            "Couldn't check your AI refresh quota just now. Your scheduled refresh is unaffected — try again in a moment.",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (res[0] === 1) return true;
    const label = resolvePlan(ws?.plan).label;
    // 429, not 403: temporary, self-clearing, and the body says when. The
    // explicit code matters because the global per-IP throttler also yields
    // RATE_LIMITED ("clicking too fast"), which is a different message from
    // "you've used your day's AI refreshes".
    throw new HttpException(
      {
        code: "AI_RECOMPUTE_THROTTLED",
        // No "insights still refresh automatically" claim — it would be false
        // when INTEL_PASS_ENABLED is off (rollout) or intelIntervalHours is 0
        // (scheduled pass turned off), leaving this button the only refresh.
        message: `You've used today's ${limit} manual AI insight refresh${limit === 1 ? "" : "es"} on the ${label} plan. Upgrade your plan to regenerate insights more often.`,
        details: { limit, used: res[1], retryAfterMs: res[2] },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Bound a Redis command so a hung client can't stall the request; rejects on
   *  timeout so canActivate fails the throttle CLOSED (see above). */
  private raceRedis<T>(op: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("redis timeout")),
        ManualAiThrottleGuard.REDIS_TIMEOUT_MS,
      );
    });
    return Promise.race([op, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
