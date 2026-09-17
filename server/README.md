# Replayfy — Server (Ingest API)

The Replayfy backend: the SDK **ingest** path plus the **platform / dashboard**
API. A NestJS + TypeScript monorepo (`apps/ingest-api`, shared `@replay/*`
packages under `packages/`).

> Part of the open core. The full product — this server + the dashboard + all
> the datastores — runs with a single `docker compose up` from the repository
> root; see the top-level README. This document is for running or deploying the
> server on its own.

## Storage layout

| Store | Purpose | Access layer |
| --- | --- | --- |
| PostgreSQL | Workspaces, users, API keys, sessions, analytics metadata | Prisma |
| MongoDB (replica set) | Replay timelines (rrweb JSON envelopes) | Prisma |
| ClickHouse | Console / network / error / event analytics + facets | `@replay/db-clickhouse` |
| Redis | Bull queues, cache, presence, rate limiting | ioredis |
| S3-compatible (MinIO / R2 / S3) | Replay frame archives + screenshots | `@aws-sdk/client-s3` |

> Prisma has no ClickHouse adapter, so ClickHouse is wrapped in the
> `@replay/db-clickhouse` package with a Prisma-style typed API.

## Local development

Requires **Node 20.17.0** (`.nvmrc` pins it — `nvm use`).

```bash
nvm use
npm install
npm run prisma:generate                 # generate the Prisma clients (gitignored)

# Datastores: bring up just the infra from the repo-root compose, or your own.
# Then apply schemas:
npm run prisma:deploy                    # Postgres migrate + Mongo push
npm run build && npm run ch:migrate      # ClickHouse schema (needs the build)
npm run seed                             # optional: a demo workspace + admin@local / admin

# Run the all-in-one process (HTTP + ingest + workers + cron):
node apps/ingest-api/dist/bootstrap.js   # http://localhost:4000  (/healthz, /readyz)
```

### Scaling with `APP_ROLE`

By default (`APP_ROLE` unset) the server runs every responsibility in one
process — the simplest topology. To scale the SDK-facing ingest path, the Bull
workers, the `@Cron` schedulers, and the dashboard read API independently, run
the same build as separate roles:

```bash
npm run role:ingest    # APP_ROLE=ingest  :4000  SDK accept path
npm run role:api       # APP_ROLE=api     :4001  dashboard reads
npm run role:worker    # APP_ROLE=worker  :4002  drains the Bull queues
npm run role:cron      # APP_ROLE=cron    :4003  the @Cron schedulers (run exactly one)
```

An unknown `APP_ROLE` crashes at boot on purpose.

## Configuration

Every setting is an environment variable with a working local default — see
[`.env.example`](.env.example) for the annotated list (datastores, object
storage, email, AI provider, public URLs, security). AI features are optional
and bring-your-own-key: set `LLM_PROVIDER` + a provider key + `LLM_MODEL` to
enable them.

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md) for a production deploy runbook, or use the
container image + `docker compose` from the repository root.
