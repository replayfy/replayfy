/**
 * Classify a thrown error as an INFRASTRUCTURE / availability failure (a backing
 * store is down, unreachable, timing out, over quota, or refusing writes) vs. a
 * normal data/logic error (bad payload, unique conflict, validation).
 *
 * The distinction drives the queue circuit breaker: an infra error means "the
 * store is unavailable — pause and wait", NOT "this job is broken — retry it to
 * death". Getting it wrong in the SAFE direction (treating a data error as
 * infra) would only pause briefly then resume, so we bias conservative: return
 * true ONLY on a clear availability signal, false for everything else.
 *
 * This is the incident we are hardening against: an Atlas free-tier cluster hit
 * its 512 MB quota and returned `AtlasError 8000: … Writes are blocked`, which
 * surfaced as a Prisma "Raw query failed. Code: `unknown`" — every replay-batch
 * job burned its 3 attempts in ~7s and fell into the failed set.
 */

// Prisma known-request codes that mean "can't reach / talk to the database".
// P2xxx (unique/notfound/validation) are deliberately EXCLUDED — those are data
// errors and must fail normally, never trip the breaker.
const PRISMA_INFRA_CODES = new Set([
  "P1001", // can't reach database server
  "P1002", // database server reachable but timed out
  "P1008", // operation timed out
  "P1011", // TLS error opening the connection
  "P1017", // server has closed the connection
]);

// Prisma codes that are AMBIGUOUS (capacity / retryable), NOT store-down — a
// per-job retry handles them, so they must never pause the whole queue:
//   P2024 = timed out fetching a connection from the pool (pool saturated)
//   P2034 = transaction write-conflict / deadlock (retry succeeds)
// A genuine outage still trips the breaker through the unambiguous signals
// below (P1001/P1002, connection resets, write-blocked), raised on other jobs.
const PRISMA_NON_INFRA_CODES = new Set(["P2024", "P2034"]);

// Prisma error class names that are inherently connectivity/engine failures.
const PRISMA_INFRA_NAMES = new Set([
  "PrismaClientInitializationError",
  "PrismaClientRustPanicError",
  "PrismaClientUnknownRequestError", // Atlas quota surfaced here
]);

// Mongo driver error class names that mean the node/cluster is unavailable.
const MONGO_INFRA_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoTopologyClosedError",
  "PoolClearedError",
]);

// Mongo server error codes for unavailability / failover / limits / quota.
const MONGO_INFRA_SERVER_CODES = new Set([
  8000, // AtlasError (includes "over your space quota")
  50, // MaxTimeMSExpired
  91, // ShutdownInProgress
  189, // PrimarySteppedDown
  262, // ExceededTimeLimit
  10107, // NotWritablePrimary
  11600, // InterruptedAtShutdown
  13435, // NotPrimaryNoSecondaryOk
]);

// Last-resort message match — covers driver/OS-level failures that don't carry a
// clean code (ECONN*, DNS, "writes are blocked", "too many connections"). Kept
// to SPECIFIC store-down phrases: bare "timed out" / "unavailable" are dropped
// because they also describe benign capacity blips (e.g. pool timeouts) and
// would trip the whole queue. (MaxTimeMSExpired is caught by server code 50.)
const INFRA_MESSAGE_RE =
  /econnrefused|econnreset|etimedout|enotfound|epipe|socket hang up|connection (closed|reset|refused|terminated|lost)|server selection|topology (was )?(destroyed|closed)|not (writable )?primary|no primary|primary stepped down|writes are blocked|over your (space )?quota|space quota|quota exceeded|shutdown in progress|too many connections|pool (was )?cleared/i;

function codeOf(e: unknown): string | number | undefined {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" || typeof c === "number" ? c : undefined;
}

/** True when `err` (or anything in its `.cause` chain) signals that a backing
 *  store is unavailable — i.e. the job should WAIT, not exhaust its retries. */
export function isInfraError(err: unknown): boolean {
  let e: unknown = err;
  // Walk the cause chain (Prisma / drivers commonly wrap the root failure).
  for (let depth = 0; e && depth < 5; depth++) {
    const name = (e as { name?: string })?.name ?? "";
    const code = codeOf(e);
    const message = (e as { message?: string })?.message ?? "";

    // Ambiguous-capacity codes never count as infra AT THIS LEVEL — but keep
    // walking, so a real store-down nested in the cause chain still trips.
    const ambiguous =
      typeof code === "string" && PRISMA_NON_INFRA_CODES.has(code);
    if (!ambiguous) {
      if (PRISMA_INFRA_NAMES.has(name)) return true;
      if (MONGO_INFRA_NAMES.has(name)) return true;
      if (typeof code === "string" && PRISMA_INFRA_CODES.has(code)) return true;
      if (typeof code === "number" && MONGO_INFRA_SERVER_CODES.has(code))
        return true;
      if (INFRA_MESSAGE_RE.test(message)) return true;
    }

    e = (e as { cause?: unknown })?.cause;
  }
  return false;
}
