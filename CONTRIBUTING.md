# Contributing to Replayfy

Thanks for helping improve Replayfy! This guide covers how to run it locally,
what to work on, and how to get a change merged.

## Ground rules

- Be respectful — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — see
  [SECURITY.md](SECURITY.md).
- By contributing you agree your work is licensed under the repository's licence
  (AGPL-3.0 for the server + dashboard; the SDKs are MIT).

## Repository layout

- `server/` — the ingest API (NestJS + TypeScript; Postgres, MongoDB, Redis,
  ClickHouse, S3-compatible object storage).
- `dashboard/` — the web app (React + Vite).
- `docker-compose.yml` / `.env.example` — the self-host stack.

This is the **open core**. Hosted-only concerns (billing/subscriptions and the
fully-managed agentic assistant) are Enterprise Edition and are not part of this
repository; the open build runs unlimited and unmetered without them.

## Running it locally

The fastest path is the whole stack in Docker:

```bash
cp .env.example .env
docker compose up
# dashboard → http://localhost:8080   (admin@local / admin)
```

To iterate on code, run a datastore-only stack and the apps on the host:

```bash
# from server/
nvm use            # Node 20.17.0 (see .nvmrc)
npm install
docker compose up -d postgres mongo redis clickhouse minio   # infra only
npm run prisma:generate && npm run build
npm run prisma:deploy && npm run ch:migrate && npm run seed
node apps/ingest-api/dist/bootstrap.js

# from dashboard/ (in another shell)
nvm use && npm install && npm run dev      # http://localhost:5173
```

## Making a change

1. Fork and branch from `main` (`feature/<short-name>` or `fix/<short-name>`).
2. Keep the change focused; one concern per PR.
3. Match the surrounding code — naming, structure, and comment style.
4. Before opening the PR, make sure it builds and type-checks:
   - server: `npm run build`
   - dashboard: `npm run typecheck && npm run build`
5. Write a clear PR description: what changed, why, and how you verified it.
   Screenshots for UI changes help.

## Reporting bugs & requesting features

Open an issue using the templates. For bugs, include repro steps, what you
expected, what happened, and your environment (self-host vs. which browser).

## Licence of contributions

Contributions to `server/` and `dashboard/` are accepted under **AGPL-3.0**.
Don't add dependencies under licences incompatible with AGPL distribution
(e.g. SSPL, or proprietary/no-licence packages).
