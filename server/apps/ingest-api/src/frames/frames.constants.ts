/**
 * Redis key conventions + tunables for the frames ingest pipeline. Single
 * source of truth so the ingest write path, the stream worker, and the
 * finalizer can never drift on a key name.
 *
 *   frames:{sid}            Stream — the durable, ordered append log of a
 *                           session's raw `[ts][size][jpeg]` batches. Replaces
 *                           the old on-disk `{sid}.frames` file. Retained until
 *                           finalize, so finalization can always rebuild the
 *                           archive from scratch after a worker crash; then
 *                           kept for streamRetainMs on a TTL that every new
 *                           batch clears (PERSIST) — so a stream WITHOUT a TTL
 *                           may hold frames no archive has yet.
 *   session:expiry          Sorted set — score = epoch-ms the session is
 *                           considered idle/ended. score > now ⇒ ACTIVE (the
 *                           stream worker drains it); score ≤ now ⇒ ENDED (it
 *                           gets finalized). This one ZSET is the active-session
 *                           registry AND the expiry queue. A member means a
 *                           frames finalize is still to come, so the LIVE sweep
 *                           and GET /frames read it too (pendingFinalize).
 *   frames:mp:{sid}         Hash — multipart-upload state mirrored from the
 *                           owning worker (uploadId, parts JSON, lastId,
 *                           running count/bytes/lastTs) so the finalizer and a
 *                           takeover worker can see/clean it.
 *   frames:owner:{sid}      String w/ TTL — the lease pinning a session to one
 *                           worker (NX + renew), giving per-session ordering +
 *                           single-writer multipart + horizontal scaling.
 *   finalize:{sid}          String w/ TTL — NX idempotency lock so a session is
 *                           finalized exactly once (owner OR orphan finalizer);
 *                           see FINALIZE_LOCK_TTL_MS.
 *   frames:cancel:{sid}     String w/ TTL — set by POST /v1/mobile/cancel: the
 *                           finalizer discards this session's recording,
 *                           including an archive an earlier finalize stored.
 *   mobile:app:{sid}        String w/ TTL — whether the app was last seen in
 *                           the foreground or the background (AppState), from
 *                           the message batches; see APP_STATE_TTL_MS.
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
export const framesCancelKey = (sid: string): string => `frames:cancel:${sid}`;
export const appStateKey = (sid: string): string => `mobile:app:${sid}`;
export const SESSION_EXPIRY_ZSET = "session:expiry";

/**
 * How long a cancel outlives the request: past the finalize that discards the
 * session, so a frames batch still in flight at cancel time is discarded too,
 * and past the retries of a finalize that keeps failing (the lock's 5-min
 * backoff each). One short key per cancelled session.
 */
export const CANCEL_RETAIN_MS = 24 * 60 * 60_000;

/** Where the app was, as the SDK's message batches last showed it. */
export type AppState = "foreground" | "background";

/**
 * The app state is kept this long past the last message batch that read it.
 * It only has to bridge the gap between two batches of a running app (the SDKs
 * flush every 5 s). A longer gap means the app was frozen or suspended in the
 * background; once the key expires the state is unknown, which the message
 * path treats like the background.
 */
export const APP_STATE_TTL_MS = 30 * 60_000;

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

/**
 * A NATIVE session stays LIVE (unlisted: the Recordings list hides LIVE native
 * rows) for at least this long past its last activity (endedAt), even with no
 * frames finalize pending. Frames reach the server in their own /images
 * batches, so the last /i can land before the frames that arm the session's
 * expiry score; idleMs plus a margin covers that gap, the same 150 s end
 * timeout the reference backend lists a mobile session after. The cost:
 * a frameless (event-only) native session is listed about 2 min later than a
 * web one (180 s after its last activity instead of 60 s).
 */
export const nativeSweepGraceMs = (): number => idleMs() + 30_000;

/**
 * TTL of the finalize:{sid} lock. A finalize that throws leaves its lock in
 * place, so this is also the backoff before the orphan poll retries it.
 */
export const FINALIZE_LOCK_TTL_MS = 300_000;

/**
 * How long an ENDED session (expiry score in the past) may wait for its frames
 * finalize before the LIVE sweep stops holding it and completes it without
 * its archive (the retried finalize records the archive later). The finalizer
 * polls every few seconds, but a finalize can still start or finish well after
 * the score passes: the orphan poll works through ended sessions one at a time
 * (a backlog after a restart), a rebuild or merge of a long recording takes a
 * while, and a finalize that failed once is retried only when its lock expires
 * (FINALIZE_LOCK_TTL_MS). So the cap is that backoff plus 3 min: one failed
 * attempt still gets its retry before the session is listed. The finalize
 * lock itself is no signal: it is held the same way while a finalize runs
 * and while a failed one backs off.
 *
 * Billing does not bound this. A held row's endedAt can be far older than its
 * score (/i stamps endedAt only for batches with activity, /images never), so
 * when the sweep completes an overdue row it stamps endedAt with the time it
 * completes it, as the finalizer's record() does; the row then settles 3 to
 * 10 min later like any other (BillingService.SETTLED).
 */
export const FINALIZE_OVERDUE_MAX_MS = FINALIZE_LOCK_TTL_MS + 3 * 60_000;

/** R2/S3 minimum non-final part size (5 MiB). Gzip output is buffered to this
 *  before a part is flushed mid-session; the last part has no minimum. */
export const PART_MIN_BYTES =
  Number(process.env.FRAMES_PART_MIN_BYTES) || 5 * 1024 * 1024;

/**
 * After finalize, the stream is KEPT (not deleted) for this long: a session
 * that RESUMES the same id (SDK backgrounds → foregrounds after the idle
 * timeout) XADDs onto the retained stream, and the re-finalize merges it into
 * the existing archive, deduping the frames both already hold.
 *
 * Trade-off (no disk ⇒ this retention costs Redis RAM): bounds memory to
 * recently-ended sessions, not all of them. Correctness doesn't depend on it:
 * a resume AFTER this window expires, or a /late with nothing new, still merges
 * into (or leaves untouched) the archive, never overwrites it — see
 * FramesFinalizerService.finalize.
 */
export const streamRetainMs = (): number =>
  Number(process.env.FRAMES_STREAM_TTL_MS) || 30 * 60_000;
