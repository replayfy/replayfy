# Deployment runbook — ingest API

Step-by-step production deploy for the ingest API (NestJS monorepo). No
infrastructure is assumed — provision the datastores however you like (managed
or self-hosted) and point the env vars at them.

Deploy target: a Linux server. Runtime: **Node 20.17.0** (`.nvmrc` pins it;
`nvm use`). Never run this on the machine's default Node 16.

---

## 1. External services to provision first

All run separately from the app; the app only needs a URL + credentials for each.

| Service | Purpose | Env var(s) |
| --- | --- | --- |
| PostgreSQL | primary relational store (Prisma) | `DATABASE_URL_POSTGRES` |
| MongoDB (replica set) | rrweb replay timelines | `DATABASE_URL_MONGO` |
| ClickHouse | session/event analytics + facets | `CLICKHOUSE_URL/USER/PASSWORD/DATABASE` |
| Redis | Bull queues, cache, presence, rate-limit, AI metering | `REDIS_URL` |
| Cloudflare R2 (or S3) | thumbnails / media | `R2_*` |
| AWS SES | transactional email | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `EMAIL_DOMAIN` (+ optional `EMAIL_FROM`, `AWS_SES_CONFIGURATION_SET`) — all three AWS vars required or email is logged-only |
| Stripe | billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` |
| LLM provider | AI features | `LLM_MODEL`, `LLM_PLATFORM_KEY` (+ `LLM_KMS_KEY` for BYOK) |

Put ClickHouse, Redis, Postgres, Mongo behind a private network / firewall — the
app binds `0.0.0.0` and does not authenticate infra callers itself.

---

## 2. Environment variables

`.env.example` is the authoritative, commented list — copy it and fill in. The
must-set-for-prod vars and their failure modes:

**Fail-closed (app refuses to start / requests fail until set):**
- `JWT_SECRET` — session-token signing key, ≥16 chars. App **refuses to boot**
  without it. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DATABASE_URL_POSTGRES`, `DATABASE_URL_MONGO` — Prisma throws at connect if unset.

**Silent-localhost-default (WILL point at the wrong place if unset — set them):**
- `REDIS_URL` — defaults to `redis://127.0.0.1:6380`. For managed Redis needing
  TLS, use the `rediss://` scheme (now honored) and include the ACL username if any.
- `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DATABASE`
  — default to `localhost:8123` / `default` / empty-password / `default`.
- `DASHBOARD_URL`, `APP_BASE_URL`, `API_BASE_URL` — Stripe return URLs + OAuth
  callbacks fall back to `127.0.0.1:*`. A paying/social-login user lands on
  localhost if these are wrong.

**Security posture (must set / verify):**
- `CORS_ORIGINS` — comma-separated dashboard origin(s), e.g. `https://app.replayfy.app`.
  Unset ⇒ the API reflects **any** origin with credentials **and logs a loud boot
  warning**. Set it.
- `TRUST_PROXY` — set to the proxy hop count (usually `1`) when behind a load
  balancer. Without it the rate limiter buckets every client together (one actor
  can 429-lock all logins) and geoip resolves to the LB. Do **not** set `true` if
  the app is directly internet-reachable.
- `PRISMA_LOG` — leave **unset** in prod (=`1` logs full SQL incl. PII).

**Email — silently logs-only until set:**
- `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` — AWS SES credentials
  (separate from the `R2_*` keys). If **any** is missing, every transactional /
  billing / alert email is **logged only, never sent** — one boot warning, no job
  failures, no retries. `EMAIL_DOMAIN` sets the verified sender (`hello@$EMAIL_DOMAIN`,
  which must be a verified SES identity); `EMAIL_FROM` overrides the whole From header.

**Billing (money path — charged-but-not-granted if wrong):**
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (from the endpoint you create in §6),
  and one `STRIPE_PRICE_{STARTER,GROWTH,SCALE,BUSINESS}` per paid tier. Price ids
  are validated (logged, not thrown) at boot — watch the boot log.

**AI (breaks AI if unset while AI is enabled):**
- `LLM_MODEL` — no default; unset ⇒ every AI call 400s. `LLM_MODEL_FAST` optional.

---

## 3. Build (exact order — the build fails if reordered)

```bash
nvm use                 # Node 20.17.0
npm ci
npm run prisma:generate # generates BOTH Prisma clients (packages/db-*/client). REQUIRED before build.
npm run build           # tsc -b → apps/ingest-api/dist/bootstrap.js
```

`dist/` and the generated Prisma clients are gitignored, so a clean checkout
**must** generate + build on the deploy host. Skipping `prisma:generate` makes
the build fail with `cannot find ../client`.

---

## 4. Database migrations

Postgres uses **Prisma Migrate** (`db push` is retired for Postgres; Mongo still
uses `db push`). See `packages/db-postgres/prisma/migrations/README.md`.

**First deploy against an EXISTING (already-populated) database — one-time, per
environment.** `0_init` is a baseline that CREATEs every table; running deploy
against a populated DB without resolving it first fails with P3005.

```bash
# 1. (recommended) confirm the DB is at the 0_init baseline — prints ONLY the publicKey ALTER:
npx prisma migrate diff \
  --from-url "$DATABASE_URL_POSTGRES" \
  --to-schema-datamodel ./packages/db-postgres/prisma/schema.prisma --script

# 2. mark the baseline applied (so deploy won't try to re-create tables):
npx prisma migrate resolve --applied 0_init \
  --schema=./packages/db-postgres/prisma/schema.prisma

# 3. apply everything after the baseline:
npm run prisma:deploy
```

**Every subsequent deploy** (and first deploy against an EMPTY DB): just

```bash
npm run prisma:deploy   # postgres: prisma migrate deploy + mongo: db push
```

---

## 5. Run the processes (APP_ROLE model)

One build, four roles. A full-volume prod runs them as four separate process
groups (role scripts in `package.json`); low volume can run a single default
process (`APP_ROLE` unset = does everything).

| Role | Command | Port | Does |
| --- | --- | --- | --- |
| ingest | `npm run role:ingest` | 4000 | SDK replay + mobile ingest |
| api | `npm run role:api` | 4001 | dashboard read/write API |
| worker | `npm run role:worker` | 4002 | drains Bull queues (replay, retention, email, billing, workspace-delete) |
| cron | `npm run role:cron` | 4003 | `@Cron` schedulers (rollups, signals, precompute, retention, cohort refresh) |

Supply your own process supervision (systemd / pm2 / container orchestrator).
There is no committed Dockerfile/Procfile/systemd unit — that is deliberately
left to your infra.

**Important routing nuance:** role gating stops crons + local-pauses queues on
the wrong node, but it does **not** unregister HTTP controllers — every role node
still serves the full API surface on its port. So the load balancer must route
ingest traffic to ingest nodes and dashboard traffic to api nodes; the app will
not refuse a mis-routed request.

Graceful shutdown is handled: SIGTERM/SIGINT flushes the in-memory batchers
(3s box) then closes. For zero-downtime rolling deploys, drain via `/readyz`
(below) before sending SIGTERM.

---

## 6. Reverse proxy / load balancer

- **Health probes** (no auth, `@SkipThrottle`):
  - `GET /healthz` — liveness (process only). Point the "restart if failing" probe here.
  - `GET /readyz` — readiness; pings Postgres/Redis/ClickHouse/Mongo, returns
    `503` until all are up. Point the "route traffic here" probe here.
- Set `TRUST_PROXY` (§2) so `req.ip` is the real client.
- Terminate TLS at the proxy; forward `X-Forwarded-*`.
- **Stripe webhook:** create an endpoint at `POST /v1/billing/webhook`, subscribe
  it to the events listed in the repo README's Stripe section, and put the signing
  secret in `STRIPE_WEBHOOK_SECRET`. This path must receive the RAW body (the app
  already mounts it as raw; just don't let the proxy rewrite the body).

---

## 7. Post-deploy verification

```bash
curl -fsS https://<api-host>/healthz         # {"ok":true,...}
curl -fsS https://<api-host>/readyz          # {"ok":true,"checks":{postgres,redis,clickhouse,mongo all true}}
```

Then watch the boot log for:
- `!! CORS: CORS_ORIGINS is unset …` → set `CORS_ORIGINS`.
- `!! STRIPE PRICE CONFIG — N problem(s)` → fix the `STRIPE_PRICE_*` ids before selling.
- `trust proxy: 1` → confirms `TRUST_PROXY` took effect.
- A real Stripe test event should grant the plan end-to-end (charged **and** provisioned).
