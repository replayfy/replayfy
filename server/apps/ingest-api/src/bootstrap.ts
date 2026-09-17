import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import { validateStripePriceConfig, BILLING_ENABLED } from "./billing/plan-catalog";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { getQueueToken } from "@nestjs/bull";
import type { Queue } from "bull";
import {
  json,
  urlencoded,
  raw,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { flushProjectionInserts } from "@replay/db-clickhouse";
import { hasRole, activeRoles, isSingleProcess } from "./common/app-roles";
import {
  REPLAY_QUEUE,
  RETENTION_QUEUE,
  WORKSPACE_DELETE_QUEUE,
} from "./queue/queue.constants";
import { EMAIL_QUEUE } from "./email/email.types";
import { BILLING_QUEUE } from "./billing/billing.types";
import { WorkspaceStatsService } from "./workspace-stats/workspace-stats.service";

// Every Bull queue in the app. A non-`worker` node LOCAL-pauses each so it
// stops consuming jobs — producers on any node keep enqueueing (a local pause
// only stops THIS process's worker, not the shared queue). Adding a queue here
// is the one place that has to know the full set.
const ALL_QUEUE_NAMES = [
  REPLAY_QUEUE,
  RETENTION_QUEUE,
  WORKSPACE_DELETE_QUEUE,
  EMAIL_QUEUE,
  BILLING_QUEUE,
] as const;

// Apply APP_ROLE gating after the container is built. Default (APP_ROLE unset)
// activates every role, so isSingleProcess() short-circuits and NOTHING is
// touched — behavior is identical to before this existed.
async function applyRoleGating(app: INestApplication): Promise<void> {
  if (isSingleProcess()) return;
  process.stdout.write(`APP_ROLE active: ${activeRoles().join(",")}\n`);

  // cron gate: a non-cron node must not run the @Cron schedulers (rollups,
  // signals, precompute, retention scheduling, cohort/playlist refresh
  // enqueues). Those are the pool-thieves that collapse ingest drain. Stop
  // them locally; a dedicated cron node still runs them. (@Interval frame
  // pollers are intentionally left running — they are light and finalize
  // sessions; their placement is a separate topology decision.)
  if (!hasRole("cron")) {
    const scheduler = app.get(SchedulerRegistry, { strict: false });
    let stopped = 0;
    for (const [, job] of scheduler.getCronJobs()) {
      job.stop();
      stopped++;
    }
    process.stdout.write(`  cron gate: stopped ${stopped} @Cron job(s)\n`);
  }

  // worker gate: a non-worker node must not drain Bull queues. Local-pause
  // each so this process stops consuming while producers still enqueue.
  if (!hasRole("worker")) {
    let paused = 0;
    for (const name of ALL_QUEUE_NAMES) {
      // A queue whose module isn't present in this build has no provider to
      // resolve and no local worker to pause — skip it rather than crash the
      // gate. This is how the open-source build (which ships without the
      // Enterprise billing module, the only registrar of BILLING_QUEUE) stays
      // multi-process-safe: nothing consumes that queue locally, so there is
      // nothing to pause.
      let queue: Queue | undefined;
      try {
        queue = app.get<Queue>(getQueueToken(name), { strict: false });
      } catch {
        continue;
      }
      // pause(true) = local-only: stop THIS worker, leave the shared queue live.
      await queue.pause(true);
      paused++;
    }
    process.stdout.write(`  worker gate: local-paused ${paused} queue(s)\n`);
  }
}
// NOTE: AppModule is imported DYNAMICALLY inside bootstrap() (below), NOT here.
// A static import compiles to `require("./app.module")` at load time — which runs
// BEFORE the loadEnv() calls below — so any module that reads process.env at
// import time would capture undefined. The one that bit us: llm.models.ts'
// `export const LLM_MODEL = process.env.LLM_MODEL` was captured as undefined, so
// every OpenRouter call went out with no model → 400 "No models provided".
// Loading .env first, then importing the module tree, fixes it for good.

// Load .env with OVERRIDE so the file is the single source of truth for config.
// Without override, dotenv leaves any pre-existing process.env value untouched —
// and PM2 re-inherits its cached launch env on every `reload`, so a STALE value
// captured once (we hit this with the email FROM address pinned to an old default)
// would silently shadow the corrected .env value forever, surviving every reload.
// Making .env authoritative kills that whole class of bug. Only keys present in
// .env are affected, so process-only vars (NODE_ENV from PM2, PATH, etc.) are
// left intact. .env.local still layers on top for local overrides, below.
loadEnv({ override: true });
loadEnv({ path: ".env.local", override: true });

async function bootstrap() {
  // Fail CLOSED on a missing session secret. jwt.ts / oauth.ts / mobile-token.ts
  // no longer fall back to a public default (that let anyone forge a token for
  // any workspace), so a deploy with JWT_SECRET unset must refuse to start here
  // — a clear boot error instead of a silent first-request 500.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      "JWT_SECRET is required and must be >=16 chars. Set a strong random value in the environment (see .env.example). Refusing to start with an insecure/absent token secret.",
    );
  }

  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Loud warning (not fail-closed, so local dev keeps working with an empty
  // allowlist) when CORS is left wide open. With CORS_ORIGINS unset the API
  // reflects ANY request origin back with credentials:true — acceptable in dev
  // (Bearer-header auth, no cookies), but a must-fix in prod. Surface it at boot
  // so a forgotten env var can't ship silently. See the CORS block below.
  if (corsOrigins.length === 0) {
    process.stdout.write(
      "\n!! CORS: CORS_ORIGINS is unset — reflecting ANY origin with credentials. " +
        "Set CORS_ORIGINS to your dashboard origin(s) before production.\n\n",
    );
  }

  // A provider key with no LLM_MODEL means every AI call 4xx-fails on a missing
  // model (there is no default — see llm.models.ts). Warn loudly so a self-host
  // that wired a key but forgot the model doesn't look silently broken.
  const hasLlmKey = !!(
    process.env.OPENROUTER_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.LLM_PLATFORM_KEY
  );
  if (hasLlmKey && !process.env.LLM_MODEL) {
    process.stdout.write(
      "\n!! LLM: a provider key is set but LLM_MODEL is not — AI calls will fail. " +
        "Set LLM_MODEL to a fully-qualified model id (e.g. anthropic/claude-sonnet-4 " +
        "for OpenRouter, or the bare id for Anthropic-direct).\n\n",
    );
  }

  // After loadEnv() above, so all module-level process.env reads in the app tree
  // (e.g. LLM_MODEL) see the loaded .env. See the note by the imports.
  const { AppModule } = await import("./app.module");
  const app = await NestFactory.create(AppModule, {
    // CORS is handled by the path-aware middleware below, NOT here: the built-in
    // `cors` option applies ONE policy to every route, but the public SDK ingest
    // routes must accept ANY origin (customer sites) while the dashboard API must
    // stay on the strict CORS_ORIGINS allowlist. The cors `origin` callback can't
    // see the request path, so it can't make that split — hence the middleware.
    cors: false,
    bodyParser: false,
  });

  // Trust the reverse proxy / load balancer in front of us, gated on TRUST_PROXY
  // (unset = off, so local/direct dev is unchanged). Behind an LB, req.ip is the
  // proxy's socket IP unless Express trusts it and reads X-Forwarded-For — and
  // req.ip is exactly what the ThrottlerGuard keys on (global 1000/60s + the
  // strict auth @Throttle) and what geoip-lite resolves session location from.
  // Without this, every client collapses into ONE throttle bucket (one actor can
  // 429-lock all logins) and all sessions geo-locate to the LB. Set TRUST_PROXY
  // to the hop count (e.g. `1` for a single LB) — NOT `true` if the app is
  // directly internet-reachable, since a client could then spoof X-Forwarded-For.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const value = Number.isNaN(Number(trustProxy))
      ? trustProxy
      : Number(trustProxy);
    (
      app.getHttpAdapter().getInstance() as {
        set?: (k: string, v: unknown) => void;
      }
    ).set?.("trust proxy", value);
    process.stdout.write(`trust proxy: ${String(value)}\n`);
  }

  // ── CORS (path-aware) ──────────────────────────────────────────────────────
  // This one app serves two very different audiences, so CORS is split by path:
  //   • Public SDK ingest routes (/v1/replay, /v1/sdk, /v1/mobile) are called by
  //     the web SDK running on CUSTOMERS' OWN domains (any origin). They auth
  //     with the workspace PUBLISHABLE key (x-replay-api-key) — never a cookie —
  //     so reflecting ANY origin with credentials OFF is correct AND safe: there
  //     is no ambient credential to steal. Without this, every customer site is
  //     CORS-blocked and NO session data can be ingested at all.
  //   • Every other route is the authenticated dashboard API — keep the strict
  //     CORS_ORIGINS allowlist + credentials:true (unchanged; the security audit
  //     set this deliberately). The dashboard authenticates with a Bearer token.
  // Implemented as middleware (Nest's built-in cors is disabled above) because
  // the split is by req.path, which the cors `origin` callback never sees.
  // Registered before helmet so preflight (OPTIONS) is answered first.
  const SDK_PUBLIC_PREFIXES = ["/v1/replay", "/v1/sdk", "/v1/mobile"];
  const CORS_METHODS = "GET,POST,PATCH,PUT,DELETE,OPTIONS";
  // The exact header set the SDK sends: Content-Encoding (gzipped batches) and
  // the x-replay-* auth/identity headers are NOT CORS-safelisted, so they must
  // be named explicitly or Safari/Chrome reject the preflight.
  const CORS_ALLOW_HEADERS =
    "Content-Type,Content-Encoding,Authorization,x-workspace-id,x-replay-api-key,x-replay-fingerprint,x-replay-identify";
  const isSdkPublicPath = (p: string): boolean =>
    SDK_PUBLIC_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (isSdkPublicPath(req.path)) {
      // Public ingest — reflect ANY origin, NO credentials (key-based auth).
      res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
      res.setHeader("Vary", "Origin");
    } else if (
      origin &&
      (corsOrigins.length === 0 || corsOrigins.includes(origin))
    ) {
      // Dashboard API — allowlisted origins only, WITH credentials. When
      // CORS_ORIGINS is unset (dev/ngrok) reflect any origin, matching the old
      // `origin: true` fallback (the boot warning above flags this for prod).
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      // Answer preflight here so it never falls through to a route/guard.
      res.setHeader("Access-Control-Allow-Methods", CORS_METHODS);
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
      res.setHeader("Access-Control-Max-Age", "86400");
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });

  // Security response headers. This is a cross-origin JSON API consumed by the
  // dashboard on a DIFFERENT origin, so CSP is off (no documents served) and the
  // Cross-Origin-Resource/Embedder policies are disabled — helmet's defaults
  // would set them to same-origin and BLOCK the dashboard from reading
  // responses. What we keep is the valuable, non-breaking set: nosniff,
  // frameguard (DENY), HSTS, referrer-policy, and X-Powered-By removal.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Belt-and-suspenders: drop the Express version fingerprint header.
  (
    app.getHttpAdapter().getInstance() as { disable?: (k: string) => void }
  ).disable?.("x-powered-by");

  // Global request validation. This is a NO-OP for the many @Body() params
  // still typed as plain interfaces (no class metadata → the pipe skips them),
  // so it can't break existing routes — validation + whitelisting only kick in
  // where a route uses a class-validator DTO. `whitelist` STRIPS properties not
  // declared on the DTO (structurally defeating mass-assignment, e.g. a client
  // sending `plan` to workspace create), and `transform` yields real DTO
  // instances. `forbidNonWhitelisted` is intentionally OFF for now so an extra
  // benign field is dropped rather than 400'd during the DTO rollout.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // gzip every response above ~1KB. The replay stream (/events) is large,
  // repetitive rrweb JSON that compresses ~6x (2.7MB -> ~450KB), so this is the
  // single biggest win for player load time (the un-paginated stream must be
  // sent whole); it also shrinks the dashboard metric/overview/users reads.
  // Tiny ingest 201s fall under the threshold and are untouched.
  //
  // SSE MUST bypass compression: the agent stream (text/event-stream) relies on
  // each token flushing to the client immediately, but gzip buffers to build a
  // compression window, so it would stall the live AI narration until the
  // stream closed. Skip it by content-type and defer to compression's own
  // default filter for everything else.
  app.use(
    compression({
      filter: (req, res) => {
        const type = String(res.getHeader("Content-Type") ?? "");
        if (type.includes("text/event-stream")) return false;
        return compression.filter(req, res);
      },
    }),
  );

  // HTTP request logger — one line per request: method, path, status, ms,
  // bytes. Skips the noisy SDK config + replay batch routes by default
  // (they're high-volume); set MORGAN_VERBOSE=1 to see everything.
  const morganFormat = process.env.MORGAN_VERBOSE
    ? "dev"
    : ":method :url :status :res[content-length] - :response-time ms";
  app.use(
    morgan(morganFormat, {
      skip: (req) =>
        !process.env.MORGAN_VERBOSE &&
        (req.url?.startsWith("/v1/replay/batch") === true ||
          req.url?.startsWith("/v1/sdk/config") === true),
    }),
  );

  // ── Compressed-body (gzip-bomb) guard ───────────────────────────────────
  // The body parsers below inherit body-parser's default inflate:true, so a
  // Content-Encoding: gzip/deflate request is transparently decompressed and the
  // size `limit` is enforced on the INFLATED bytes. That means a tiny compressed
  // body can force the server to inflate up to the limit before it's rejected —
  // an amplification vector, worst on the @SkipThrottle /v1/replay/batch path.
  // Two layers bound it:
  //   (1) reject an oversized COMPRESSED body up front, keyed on Content-Length,
  //       before any inflation happens. A real gzipped web batch is well under
  //       1MB on the wire, so 4MB is generous headroom.
  //   (2) a tighter INFLATED limit on /v1/replay/batch (below) so a high-ratio
  //       bomb with a small Content-Length still can't expand past a few MB —
  //       body-parser aborts the inflate stream the moment the limit is hit, so
  //       the bomb never fully decompresses.
  // The mobile /v1/mobile/* endpoints gzip at the APPLICATION layer (raw
  // octet-stream, no Content-Encoding header, gunzipped in mobile.service.ts), so
  // this guard doesn't touch them — that path is intentionally left intact.
  const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
    if (enc.includes("gzip") || enc.includes("deflate") || enc.includes("br")) {
      const len = Number(req.headers["content-length"] ?? 0);
      if (len > MAX_COMPRESSED_BYTES) {
        res
          .status(413)
          .json({ statusCode: 413, message: "Compressed payload too large" });
        return;
      }
    }
    next();
  });

  // Stripe webhook: its signature is over the RAW bytes, so this path must NOT
  // be JSON-parsed. Mounted before json() so express hands the controller a
  // Buffer on req.body; json() then skips an already-consumed body.
  app.use("/v1/billing/webhook", raw({ type: "*/*", limit: "1mb" }));
  // Symbol upload (build-pipeline path, NOT runtime SDK ingest): R8 mapping.txt
  // and unstripped NDK .so debug binaries arrive as a base64 data URL inside a
  // JSON body. base64 inflates ~4/3, so the controller's 50 MB *decoded* ceiling
  // is ~67 MB of JSON — well over the global 25 MB json() limit below, which
  // would 413 it long before the app-level cap could bind. Mount a route-SCOPED
  // json() with an 80 MB limit BEFORE the global one so this low-volume path
  // parses large symbols; the global 25 MB (which governs high-volume replay +
  // mobile ingest) is deliberately left untouched. 80 MB ≈ 60 MB decoded, giving
  // headroom above the 50 MB ceiling so a genuinely oversized symbol still parses
  // and hits the controller's intent-revealing 413 rather than a generic parser
  // 413. Ordering matters: the global json() below sees req._body already set for
  // this route and skips it.
  app.use("/v1/replay/symbols", json({ limit: "80mb" }));
  // Layer (2) of the gzip-bomb guard: the high-volume, @SkipThrottle web replay
  // ingest is the primary Content-Encoding: gzip path, so cap ITS inflated size
  // tightly. A legitimate batch inflates to ~2-3MB, so 8MB passes real traffic
  // with headroom while forcing a high-ratio bomb to abort after ~8MB instead of
  // the global 25MB. Mounted before the global json() so this route-scoped limit
  // wins (body-parser marks the body consumed, so the global json() then skips).
  // `type` also accepts text/plain: the SDK's unload beacon (navigator.sendBeacon)
  // ships the JSON as a text/plain Blob so the cross-origin request stays CORS-
  // safelisted (application/json would force a preflight sendBeacon can't do). The
  // body is still JSON, so parse it as JSON here regardless of the content-type.
  app.use(
    "/v1/replay/batch",
    json({ type: ["application/json", "text/plain"], limit: "8mb" }),
  );
  app.use(json({ limit: "25mb" }));
  app.use(urlencoded({ extended: true, limit: "25mb" }));
  // Mobile ingest sends binary bodies (gzipped message batches +
  // gzipped frames archives) as application/octet-stream. Parse those
  // into a Buffer on req.body; json()/urlencoded() above only touch
  // their own content types, so the three coexist.
  app.use(raw({ type: "application/octet-stream", limit: "25mb" }));

  const port = Number(process.env.PORT ?? 4000);
  // Bind to 0.0.0.0 by default so ngrok / phones on the same network can
  // hit the API. Localhost-only binding broke mobile testing previously.
  const host = process.env.HOST ?? "0.0.0.0";
  // Stripe price ids, checked ONCE at boot. Both directions of the env → price
  // mapping fail silently at runtime: a missing id creates Checkout against
  // nothing, and — the expensive direction — an unrecognised id means the
  // subscription webhook for a plan the customer has ALREADY PAID FOR cannot be
  // mapped back to a tier, so the grant is dropped while Stripe considers the
  // event delivered. Logged rather than thrown: running with Stripe entirely
  // unwired is a legitimate local-dev state, but it must never be quiet.
  // Only meaningful in the cloud build — the open-source / self-hosted build has
  // no billing, so skip the check (and its alarming warning) entirely.
  const priceProblems = BILLING_ENABLED ? validateStripePriceConfig() : [];
  if (priceProblems.length > 0) {
    process.stdout.write(
      `\n!! STRIPE PRICE CONFIG — ${priceProblems.length} problem(s). Customers can be charged for a plan the server cannot grant:\n` +
        priceProblems.map((p) => `   - ${p}\n`).join("") +
        `\n`,
    );
  }

  // init() BEFORE gating: @nestjs/schedule registers its @Cron jobs and Bull
  // starts its consumers during the onApplicationBootstrap lifecycle, which
  // fires inside init() (listen() would trigger it otherwise). Gating before
  // init sees an empty SchedulerRegistry and no queues. init() is idempotent —
  // the later listen() skips re-init and only binds the port.
  await app.init();

  // Gate by APP_ROLE right after init and BEFORE listening — so the gate is in
  // place before this node takes any HTTP traffic. No-op unless APP_ROLE is set.
  // Caveat: init() already started the @Cron schedulers and Bull consumers, and
  // gating stops/pauses them a beat later (the cron stop is synchronous; the
  // queue pause awaits). A boundary-aligned cron tick or one already-fetched job
  // can therefore fire once in that init→gate window on a wrong-role node. It's
  // one-shot and harmless (the work is still done correctly, just on the wrong
  // node once); the airtight fix is role-conditional registration so a
  // wrong-role node never attaches the consumer/scheduler in the first place.
  await applyRoleGating(app);

  // Graceful shutdown: flush the in-memory batchers — the CH projection
  // micro-batcher (~200ms window) and the WorkspaceStats coalescer (~1s window)
  // — so a rolling deploy doesn't drop their last window. Best-effort and
  // time-boxed (3s) so a stuck flush can never wedge a restart. Registered
  // manually (not via enableShutdownHooks) so it's the only signal handler and
  // can't collide with Nest's.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal} — flushing buffered writes…\n`);
    try {
      const stats = app.get(WorkspaceStatsService, { strict: false });
      await Promise.race([
        Promise.all([flushProjectionInserts(), stats.flushPendingBumps()]),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {
      // best-effort — the CH backfill + WorkspaceStats reconcile are backstops
    }
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => void shutdown(sig));
  }

  // Only bind HTTP if this node actually serves requests. A pure worker/cron
  // node (APP_ROLE=worker,cron) has no HTTP surface, so skipping listen() means
  // it never contends for the port and needs no PORT of its own — its @Cron
  // schedulers and Bull consumers (started in init(), above) keep the event loop
  // alive. Default/unset APP_ROLE activates every role, so this still listens.
  if (hasRole("api") || hasRole("ingest")) {
    await app.listen(port, host);
    process.stdout.write(
      `Replay ingest API listening on http://${host}:${port}\n`,
    );
  } else {
    process.stdout.write(
      `APP_ROLE=${activeRoles().join(",")} — background node, no HTTP surface (not binding a port)\n`,
    );
  }
}

void bootstrap();
