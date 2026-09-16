# Replayfy

Open-source session replay, product analytics, and crashlytics — self-hostable,
unlimited, AGPL-3.0. Capture what your users actually do, then replay it, slice
it, and (with your own LLM key) let AI surface what's hurting conversion.

> This is the open core. Billing/subscriptions and the fully-managed agentic
> assistant are Enterprise Edition and live only in the hosted product — the
> self-hosted build is unlimited and unmetered.

## Quick start

Requires Docker.

```bash
git clone <this-repo> replayfy && cd replayfy
cp .env.example .env          # change JWT_SECRET before exposing it
docker compose up             # builds + starts the whole stack
```

Then open **http://localhost:8080** and sign in with the seeded demo account:

- **email** `admin@local`  ·  **password** `admin`

That's it — the API, dashboard, Postgres, MongoDB, Redis, ClickHouse, and MinIO
object storage all come up together, migrations and a small demo workspace run
on first boot.

| What | URL |
| --- | --- |
| Dashboard | http://localhost:8080 |
| API | http://localhost:4000 (`/healthz`, `/readyz`) |
| Emails (Mailpit catcher) | http://localhost:8025 |
| Object storage console (MinIO) | http://localhost:9001 |

Set `SEED_DEMO=0` in `.env` to start empty.

## Configuration

Everything is env-driven with working local defaults — see `.env.example`.
Notable knobs:

- **Public URLs** — `APP_BASE_URL`, `API_BASE_URL`, `CORS_ORIGINS` (set these to
  your domain behind HTTPS for a real deployment).
- **AI (optional)** — set `LLM_PROVIDER` + a provider key (`OPENROUTER_API_KEY`
  or `ANTHROPIC_API_KEY`) + `LLM_MODEL` to turn on Storylines, signals, and
  investigations. Self-hosted AI is unmetered; you pay your provider directly.
- **Email** — defaults to the built-in Mailpit catcher. Point `EMAIL_PROVIDER=smtp`
  at your relay for real delivery.
- **Storage** — MinIO by default; any S3-compatible store works via the `S3_*` vars.

## SDKs

The capture SDKs are published and open source — install from their registries:
web (`@replayfyapp/browser`), React Native, Flutter, iOS, and Android.

## Layout

- `server/` — the ingest API (NestJS).
- `dashboard/` — the web app (React + Vite).
- `docker-compose.yml` / `.env.example` — the self-host stack.

## Licence

AGPL-3.0 (see `LICENSE`). The capture SDKs are MIT.
