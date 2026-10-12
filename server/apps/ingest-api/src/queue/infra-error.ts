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

// Deterministic DATA errors: the store is up and rejected this payload's values.
// Prisma's engine raises some of them (e.g. a number that doesn't fit its INT4
// column) as PrismaClientUnknownRequestError, which is on the infra list above,
// so they must be recognised first. Retrying or pausing never fixes them: the
// same payload fails the same way. On 2026-10-08 one session's INT4 overflow
// opened the circuit again and again, pausing ALL ingestion for one bad batch.
// The JSON-escape alternatives are Prisma's engine refusing a malformed string
// in the query (a lone UTF-16 surrogate or a control character), e.g.
// "unexpected end of hex escape at line 1 column 3121".
const DATA_ERROR_MESSAGE_RE =
  /unable to fit integer value|integer out of range|out of range for type|numeric field overflow|value too long for type|invalid input syntax for type|unexpected end of hex escape|lone leading surrogate|invalid escape|invalid unicode code point|control character \(\\u0000-\\u001F\) found/i;

// A Postgres SQLSTATE means the server ANSWERED. Only these classes say it is
// unavailable or refusing work: 08 connection exception, 53 insufficient
// resources, 57 operator intervention (shutting down, cannot connect now), 58
// system error, plus 25006 read-only transaction (failover, read replica). Any
// other (22 data exception, 23 constraint, 42 syntax/undefined, 54 program
// limit such as an index row too large for a client string, ...) rejected this
// payload: pausing the queue would never fix it, so it is a data error. The
// engine reports it as `PostgresError { code: "54000" ...`; raw queries as
// Prisma P2010 with the SQLSTATE in meta.code.
const PG_INFRA_SQLSTATE_RE = /^(08|53|57|58)|^25006$/;
const PG_SQLSTATE_IN_MESSAGE_RE = /PostgresError \{ code: "([0-9A-Z]{5})"/;

function sqlstateOf(e: unknown, message: string): string | undefined {
  const inMessage = PG_SQLSTATE_IN_MESSAGE_RE.exec(message)?.[1];
  if (inMessage) return inMessage;
  const metaCode = (e as { meta?: { code?: unknown } })?.meta?.code;
  return typeof metaCode === "string" && /^[0-9A-Z]{5}$/.test(metaCode)
    ? metaCode
    : undefined;
}

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

    // A data error means the store answered: never infra, whatever the class.
    if (DATA_ERROR_MESSAGE_RE.test(message)) return false;
    const sqlstate = sqlstateOf(e, message);
    if (sqlstate) return PG_INFRA_SQLSTATE_RE.test(sqlstate);

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
