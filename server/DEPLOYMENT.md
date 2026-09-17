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
| Redis | Bull queues, cache, presence, rate-limit | `REDIS_URL` |
| S3-compatible storage (MinIO / R2 / S3) | replay frame archives + screenshots | `S3_*` (or legacy `R2_*`) |
| SMTP or Resend | transactional email | `EMAIL_PROVIDER` + `SMTP_*` (or `RESEND_API_KEY`); unset ⇒ email is logged-only |
| LLM provider (optional) | AI features, bring-your-own-key | `LLM_PROVIDER`, `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`, `LLM_MODEL` |

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
- `DASHBOARD_URL`, `APP_BASE_URL`, `API_BASE_URL` — OAuth callbacks + the deep
  links in emails fall back to `127.0.0.1:*`. A social-login user or an emailed
  link lands on localhost if these are wrong.

**Security posture (must set / verify):**
- `CORS_ORIGINS` — comma-separated dashboard origin(s), e.g. `https://app.replayfy.app`.
  Unset ⇒ the API reflects **any** origin with credentials **and logs a loud boot
  warning**. Set it.
- `TRUST_PROXY` — set to the proxy hop count (usually `1`) when behind a load
  balancer. Without it the rate limiter buckets every client together (one actor
  can 429-lock all logins) and geoip resolves to the LB. Do **not** set `true` if
  the app is directly internet-reachable.
- `PRISMA_LOG` — leave **unset** in prod (=`1` logs full SQL incl. PII).

**Email — silently logs-only until configured:**
- `EMAIL_PROVIDER` selects the transport: `resend` | `smtp` | `console`. Unset
  infers it — Resend if `RESEND_API_KEY` is set, SMTP if `SMTP_HOST` is set, else
  `console` (log-only). For SMTP set `SMTP_HOST/PORT/SECURE/USER/PASS`; `EMAIL_FROM`
  sets the From header. Until configured, every email is logged, never sent — one
  boot warning, no job failures.

**AI (optional; bring-your-own-key):**
- Set `LLM_PROVIDER` + a provider key (`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`)
  + `LLM_MODEL` (fully-qualified id — no default). With no key AI simply stays off;
  with a key set but `LLM_MODEL` unset, AI calls fail and the boot log warns. AI is
  unmetered — you pay your provider directly.

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
| worker | `npm run role:worker` | 4002 | drains Bull queues (replay, retention, email, workspace-delete) |
| cron | `npm run role:cron` | 4003 | `@Cron` schedulers (rollups, signals, precompute, retention, cohort refresh) |

The repository ships a `Dockerfile` here and a `docker-compose.yml` at the repo
root — the easiest way to run the whole stack. For a bespoke deploy, supply your
own process supervision (systemd / pm2 / container orchestrator).

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
- The browser fetches replay archives directly from your object-storage public
  URL (`S3_PUBLIC_BASE_URL`), so make sure that host is reachable from clients.

---

## 7. Post-deploy verification

```bash
curl -fsS https://<api-host>/healthz         # {"ok":true,...}
curl -fsS https://<api-host>/readyz          # {"ok":true,"checks":{postgres,redis,clickhouse,mongo all true}}
```

Then watch the boot log for:
- `!! CORS: CORS_ORIGINS is unset …` → set `CORS_ORIGINS`.
- `!! LLM: a provider key is set but LLM_MODEL is not …` → set `LLM_MODEL` (if using AI).
- `trust proxy: 1` → confirms `TRUST_PROXY` took effect.
