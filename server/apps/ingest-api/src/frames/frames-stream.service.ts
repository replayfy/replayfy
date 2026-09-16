import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../common/redis.module";
import {
  framesStreamKey,
  SESSION_EXPIRY_ZSET,
  idleMs,
} from "./frames.constants";

/**
 * Ingest WRITE path for mobile frames — the hot path behind
 * POST /v1/mobile/images. Replaces the old disk append (fs.appendFile).
 *
 * Does exactly two Redis writes, pipelined into ONE round-trip, and NOTHING
 * else — no parsing, no gzip, no R2, no Postgres, no disk:
 *
 *   XADD frames:{sid} * ts <recvMs> data <raw>     (durable ordered append)
 *   ZADD session:expiry <recvMs + idleMs> sid       (arm/extend the idle timer)
 *
 * The stream is the durable buffer the worker drains; the ZSET score is the
 * epoch-ms the session is considered ended. Re-arming it on every batch is the
 * "session is still alive" heartbeat — once batches stop for idleMs, the score
 * falls into the past and the session gets finalized.
 *
 * Stateless + Redis-only ⇒ any ingest node can serve any batch (horizontal
 * scale), and an XADD survives Redis reconnects (client queues + replays), so
 * the SDK never sees a transient blip. Target: <10ms.
 */
@Injectable()
export class FramesStreamService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Append one batch's raw `[ts][size][jpeg]` bytes for a session.
   * `recvMs` is the server receive time (the SDK's own frame timestamps are
   * inside `raw` and are re-derived by the worker — ingest never parses).
   */
  async append(sid: string, raw: Buffer, recvMs: number): Promise<void> {
    // Access pattern: O(1) append keyed by session id + O(log N) ZADD on the
    // expiry set. No table scans, no per-row loops; scales horizontally because
    // it's pure Redis with no shared in-process state. Pipelined → 1 RTT.
    //
    // PERSIST clears any retention TTL a prior finalize left on the stream: if
    // this session RESUMES the same id, its frames must not expire mid-record.
    // No-op (cheap) on a stream with no TTL — the common, never-finalized case.
    await this.redis
      .multi()
      .xadd(framesStreamKey(sid), "*", "ts", String(recvMs), "data", raw)
      .persist(framesStreamKey(sid))
      .zadd(SESSION_EXPIRY_ZSET, String(recvMs + idleMs()), sid)
      .exec();
  }

  /**
   * Mark a session ended NOW (the /late terminate beacon). Just drops its
   * expiry score into the past so the next worker/finalizer tick picks it up —
   * no synchronous packing on the request path. Idempotent.
   */
  async markEnded(sid: string, recvMs: number): Promise<void> {
    // Score = recvMs - 1 ⇒ strictly in the past ⇒ enters the "ended" range.
    await this.redis.zadd(SESSION_EXPIRY_ZSET, String(recvMs - 1), sid);
  }

  /**
   * Discard a cancelled session's frames (POST /v1/mobile/cancel). DELETE the
   * durable stream so NOTHING gets packed to R2, then drop the expiry score into
   * the past so the finalizer picks it up on its next tick and finalizes it to
   * an EMPTY session (its drain sees a missing stream ⇒ 0 frames ⇒ COMPLETED)
   * rather than leaving it stuck LIVE. Access pattern: O(1) DEL + O(log N) ZADD,
   * pipelined into one round-trip — same shape as the append hot path, no scans.
   * Idempotent.
   */
  async drop(sid: string, recvMs: number): Promise<void> {
    await this.redis
      .multi()
      .del(framesStreamKey(sid))
      .zadd(SESSION_EXPIRY_ZSET, String(recvMs - 1), sid)
      .exec();
  }
}
