/**
 * Redis key conventions + tunables for the frames ingest pipeline. Single
 * source of truth so the ingest write path, the stream worker, and the
 * finalizer can never drift on a key name.
 *
 *   frames:{sid}            Stream — the durable, ordered append log of a
 *                           session's raw `[ts][size][jpeg]` batches. Replaces
 *                           the old on-disk `{sid}.frames` file. Retained until
 *                           finalize, so finalization can always rebuild the
 *                           archive from scratch after a worker crash.
 *   session:expiry          Sorted set — score = epoch-ms the session is
 *                           considered idle/ended. score > now ⇒ ACTIVE (the
 *                           stream worker drains it); score ≤ now ⇒ ENDED (it
 *                           gets finalized). This one ZSET is the active-session
 *                           registry AND the expiry queue.
 *   frames:mp:{sid}         Hash — multipart-upload state mirrored from the
 *                           owning worker (uploadId, parts JSON, lastId,
 *                           running count/bytes/lastTs) so the finalizer and a
 *                           takeover worker can see/clean it.
 *   frames:owner:{sid}      String w/ TTL — the lease pinning a session to one
 *                           worker (NX + renew), giving per-session ordering +
 *                           single-writer multipart + horizontal scaling.
 *   finalize:{sid}          String w/ TTL — NX idempotency lock so a session is
 *                           finalized exactly once (owner OR orphan finalizer).
 */
export const framesStreamKey = (sid: string): string => `frames:${sid}`;

/**
 * Next stream id strictly after `id`, formatted as an INCLUSIVE XRANGE start —
 * the portable equivalent of the `(id` EXCLUSIVE-range operator. That operator
 * was only added in Redis 6.2; the prod box installs Ubuntu 22.04's Redis 6.0
 * (see deploy/setup-vm.sh: `apt-get install redis-server`), where `XRANGE key
 * (id +` throws "ERR Invalid stream ID specified as stream command argument" —
 * so every mobile-frame drain failed on prod. A stream id is `<ms>-<seq>`; the
 * next id is `<ms>-<seq+1>` (BigInt, so the 64-bit sequence can't overflow),
 * rolling to `<ms+1>-0` only if the sequence is already at its 2^64-1 ceiling.
 * Passing THIS (no paren) as the XRANGE start reads exactly the entries after
 * `id` on every Redis version.
 */
export const nextStreamId = (id: string): string => {
  const dash = id.lastIndexOf("-");
  const ms = id.slice(0, dash);
  const seq = BigInt(id.slice(dash + 1));
  const MAX_SEQ = 18_446_744_073_709_551_615n; // 2^64 - 1
  return seq < MAX_SEQ ? `${ms}-${seq + 1n}` : `${BigInt(ms) + 1n}-0`;
};
export const framesMpKey = (sid: string): string => `frames:mp:${sid}`;
export const framesOwnerKey = (sid: string): string => `frames:owner:${sid}`;
export const finalizeLockKey = (sid: string): string => `finalize:${sid}`;
export const SESSION_EXPIRY_ZSET = "session:expiry";

/** The served archive object key — UNCHANGED from the legacy disk pipeline,
 *  so the player/SDK contract (and the `?v=` cache-bust) is identical. */
export const framesGzKey = (sid: string): string => `frames/${sid}.frames.gz`;

/** Consumer-group name (reserved for future fan-out; the lease model already
 *  gives single-writer ordering, so the worker reads with XRANGE today). */
export const FRAMES_CONSUMER_GROUP = "frames-workers";

/**
 * No new batch for this long ⇒ session ended ⇒ finalize. Mirrors the legacy
 * FRAMES_IDLE_MS (the reference "ender" 2.5-min inactivity timeout).
 */
export const idleMs = (): number => Number(process.env.FRAMES_IDLE_MS) || 150_000;

/** R2/S3 minimum non-final part size (5 MiB). Gzip output is buffered to this
 *  before a part is flushed mid-session; the last part has no minimum. */
export const PART_MIN_BYTES =
  Number(process.env.FRAMES_PART_MIN_BYTES) || 5 * 1024 * 1024;

/**
 * After finalize, the stream is KEPT (not deleted) for this long, so a session
 * that RESUMES the same id (SDK backgrounds → foregrounds after the idle
 * timeout) accumulates onto its earlier frames instead of overwriting them: the
 * resumed batches XADD onto the retained stream, the worker rebuilds from the
 * FULL stream, and the absolute count/size SET makes the archive cumulative.
 *
 * Trade-off (no disk ⇒ this retention costs Redis RAM): bounds memory to
 * recently-ended sessions, not all of them. A resume AFTER this window expires
 * starts a fresh archive. Set ≥ the SDK's session-resume timeout.
 */
export const streamRetainMs = (): number =>
  Number(process.env.FRAMES_STREAM_TTL_MS) || 30 * 60_000;
