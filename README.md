# Replayfy

**The open-source product experience platform.** Session replay, product
analytics, funnels, crashlytics, cohorts, and an agentic AI assistant — in one
self-hostable stack. Capture what your users actually do, then replay it, slice
it, and let AI tell you what's hurting conversion and stability.

**Why Replayfy.** Your users' sessions are the ground truth of what your product
actually does — they should be *evidence*, not just replays you never watch.
Replayfy exists so AI can read that evidence end-to-end and tell you, in plain
language, what's working, what's broken, and why. That belief is what it's built
around.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
&nbsp;·&nbsp; [Documentation](https://docs.replayfy.app)
&nbsp;·&nbsp; [Quickstart](https://docs.replayfy.app/quickstart)

> **Open core.** This repository is the full product — unlimited and unmetered
> when you self-host. Only subscription **billing** and the **fully-managed**
> agentic assistant are Enterprise Edition and live in the hosted product. The
> AI itself is here; bring your own model key and it all works. See
> [Open core vs. Cloud](#open-core-vs-cloud) below.

---

## What you get

Everything below is in this repo and runs on your own infrastructure.

### 🎬 Session replay
Pixel-accurate replay of real sessions across **web and mobile** — DOM/rrweb on
the web, a native frame pipeline on iOS, Android, React Native, and Flutter.
Scrub the timeline, jump by event, see console, network, and user actions
inline, and land straight on the moment something broke.
→ [docs](https://docs.replayfy.app/products/session-replay)

### 📊 Product analytics
Autocaptured and custom events, DAU/WAU/MAU, retention, and traffic breakdowns
by referrer, source, UTM, and marketing channel — computed natively in
ClickHouse so it stays fast at scale.
→ [analytics](https://docs.replayfy.app/products/product-analytics) ·
[events](https://docs.replayfy.app/guides/track-events)

### 🫧 Funnels
Multi-step conversion funnels with per-step p50/p95 timing, drop-off analysis,
build-a-cohort-from-the-drop-off, and conversion alerts when a step regresses.
→ [docs](https://docs.replayfy.app/products/funnels)

### 🧯 Crashlytics
Crashes, exceptions, and UI-freeze detection grouped into issues with error
classes and trends — jump from an issue straight to the sessions that hit it.
→ [docs](https://docs.replayfy.app/products/crashlytics)

### 👥 Cohorts
Attribute and behavioral cohorts, kept fresh incrementally, with CSV export —
then filter replay, analytics, and funnels by any cohort.
→ [docs](https://docs.replayfy.app/products/cohorts)

### 🔔 Alerts
Conversion and funnel alerts delivered by email to multiple recipients, so a
regression finds you instead of the other way around.
→ [docs](https://docs.replayfy.app/products/alerts)

### 🤖 Agentic AI assistant — bring your own key
The full **Replayfy AI** ships here, not a demo of it. Ask it a question in
plain language ("why did checkout conversion drop this week?") and it plans,
reads your real analytics/funnels/sessions, and narrates a grounded answer with
citations you can click through to the exact recording. It also generates
Storylines, surfaces signals, and runs incident investigations. Point it at any
OpenAI-compatible or Anthropic model with your own key — self-hosted AI is
unmetered; you pay your provider directly.
→ [docs](https://docs.replayfy.app/platform/replayfy-ai) · see
[Turning on AI](#turning-on-ai)

### 🔌 Integrations
Per-workspace OAuth integrations for alerting and issue-tracking (webhooks,
PagerDuty, Jira, Sentry, Lark, and more) so signals reach the tools your team
already lives in.
→ [docs](https://docs.replayfy.app/platform/integrations)

### 🔒 Privacy & masking
Configurable masking of text, inputs, and selected elements at capture time,
plus retention controls — sensitive data never has to leave the browser.
→ [docs](https://docs.replayfy.app/guides/privacy-and-masking)

### 🏢 Unlimited workspaces
Create as many workspaces (projects) and invite as many members as you want.
No project cap, no seat cap, no metering when you self-host.

---

## Quick start

Requires Docker. **No clone, no build** — grab two files and go:

```bash
mkdir replayfy && cd replayfy
curl -O https://raw.githubusercontent.com/replayfy/replayfy/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/replayfy/replayfy/main/.env.example
# change JWT_SECRET in .env before exposing it
docker compose up             # pulls the pre-built images and starts the stack
```

`docker compose up` pulls multi-arch (amd64 + arm64) images from the GitHub
Container Registry — there's nothing to compile. Pin a version with
`REPLAYFY_IMAGE_TAG` (defaults to `latest`); see [Releases](#releases).

That's it — the API, dashboard, Postgres, MongoDB, Redis, ClickHouse, and MinIO
object storage all come up together; migrations run on first boot, and (by
default) a small demo workspace is seeded.

| What | URL |
| --- | --- |
| Dashboard | http://localhost:8080 |
| API | http://localhost:4000 (`/healthz`, `/readyz`) |
| Emails (Mailpit catcher) | http://localhost:8025 |
| Object storage console (MinIO) | http://localhost:9001 |

### Signing in

Open **http://localhost:8080**. How you get your first account depends on
`SEED_DEMO`:

- **`SEED_DEMO=1` (default)** — a demo workspace ("Loop, Inc.") is seeded with a
  ready-to-use owner account:
  - **email** `admin@local`  ·  **password** `admin`
- **`SEED_DEMO=0` (start empty)** — no account exists yet. Open
  **http://localhost:8080/signup** and create one; sign-up is open (not
  invite-only) and the account you create becomes the **owner** of the workspace
  it sets up. Sign-up sends a verification email first — on the default stack
  that lands in the **Mailpit catcher at http://localhost:8025**, so open it and
  click the link to finish. (If you point `EMAIL_PROVIDER` at a real relay,
  configure it or the verification link won't arrive.)

There is no instance-wide super-admin — every user owns the workspaces they
create. Full walkthrough:
[docs.replayfy.app/quickstart](https://docs.replayfy.app/quickstart).

### Build from source (contributors)

Working on Replayfy, or running local changes? Clone the repo and layer the build
override, which compiles the images instead of pulling them:

```bash
git clone https://github.com/replayfy/replayfy.git && cd replayfy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

The dashboard image is runtime-configurable (`API_BASE_URL`), so the published
image works for any deployment — not just localhost.

### Deploy to a cloud host

Prefer a managed platform to your own VPS? Setup and caveats for each are in the
[deploy guide](https://docs.replayfy.app/self-hosting/deploy).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/replayfy/replayfy)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://docs.replayfy.app/self-hosting/deploy#railway)
&nbsp;
[![Deploy on Brimble](https://img.shields.io/badge/Deploy%20on-Brimble-6D28D9)](https://docs.replayfy.app/self-hosting/deploy#brimble)

---

## Turning on AI

AI is optional and off until you give it a provider. Set three variables in
`.env` and restart:

```dotenv
LLM_PROVIDER=openrouter            # or "anthropic"
OPENROUTER_API_KEY=sk-or-...       # or ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=anthropic/claude-sonnet-4.5
```

Until then the assistant stays visible but tells you it needs a key — nothing
crashes, and the rest of the product works exactly the same. Self-hosted AI is
unmetered by Replayfy; you're billed directly by your model provider.
→ [docs](https://docs.replayfy.app/platform/replayfy-ai)

---

## Configuration

Everything is env-driven with working local defaults — see `.env.example`.
Notable knobs:

- **Public URLs** — `APP_BASE_URL`, `API_BASE_URL`, `CORS_ORIGINS`. Set these to
  your domain, behind HTTPS, for a real deployment.
- **Auth** — `JWT_SECRET` (change it before exposing anything).
- **AI** — `LLM_PROVIDER` + a provider key + `LLM_MODEL` (see above).
- **Email** — defaults to the built-in Mailpit catcher. Point
  `EMAIL_PROVIDER=smtp` at your relay (or `resend`) for real delivery.
- **Storage** — MinIO by default; any S3-compatible store (AWS S3, Cloudflare
  R2, Backblaze B2, …) works via the `S3_*` vars.

Production deployment guide: [`DEPLOYMENT.md`](server/DEPLOYMENT.md).

---

## SDKs

The capture SDKs are separate, **MIT-licensed**, open-source repos, published to
each platform's registry. Install and initialize per the platform docs:

| Platform | Package | Docs |
| --- | --- | --- |
| Web | `@replayfyapp/browser` | [web](https://docs.replayfy.app/platforms/web) |
| React Native | `@replayfyapp/react-native` | [react-native](https://docs.replayfy.app/platforms/react-native) |
| Flutter | `replayfy_flutter` | [flutter](https://docs.replayfy.app/platforms/flutter) |
| iOS | `replayfy/ios-sdk` | [ios](https://docs.replayfy.app/platforms/ios) |
| Android | `app.replayfy:android-sdk` | [android](https://docs.replayfy.app/platforms/android) |

Point your SDK's ingest host at your self-hosted API (`API_BASE_URL`); the
install snippet in **Settings → Install** is filled in with your host
automatically.

---

## Architecture

A single `docker compose up` brings up:

- **`server/`** — the ingest + API service (NestJS). Handles capture ingestion,
  analytics, funnels, crashlytics, the AI agent, and all reads. Runs
  all-in-one by default; scale the worker out with `APP_ROLE` when you grow.
- **`dashboard/`** — the web app (React + Vite), served by nginx.
- **Postgres** — relational data (workspaces, users, config, issues).
- **MongoDB** — web replay timelines (rrweb).
- **ClickHouse** — the analytics/event store (everything that has to scale).
- **Redis** — queues and caches.
- **Object storage** — session assets and backups (MinIO locally; any
  S3-compatible store in production).
- **Mailpit** — a local email catcher (swap for your SMTP relay / Resend).

---

## Documentation

Full docs live at **[docs.replayfy.app](https://docs.replayfy.app)**:

- [Introduction](https://docs.replayfy.app/introduction) ·
  [Quickstart](https://docs.replayfy.app/quickstart)
- Products —
  [Session replay](https://docs.replayfy.app/products/session-replay) ·
  [Product analytics](https://docs.replayfy.app/products/product-analytics) ·
  [Funnels](https://docs.replayfy.app/products/funnels) ·
  [Crashlytics](https://docs.replayfy.app/products/crashlytics) ·
  [Cohorts](https://docs.replayfy.app/products/cohorts) ·
  [Alerts](https://docs.replayfy.app/products/alerts)
- Platform —
  [Replayfy AI](https://docs.replayfy.app/platform/replayfy-ai) ·
  [Integrations](https://docs.replayfy.app/platform/integrations) ·
  [API & keys](https://docs.replayfy.app/platform/api-and-keys) ·
  [Administration](https://docs.replayfy.app/platform/administration)
- Guides —
  [Identify users](https://docs.replayfy.app/guides/identify-users) ·
  [Track events](https://docs.replayfy.app/guides/track-events) ·
  [Privacy & masking](https://docs.replayfy.app/guides/privacy-and-masking) ·
  [Search & filters](https://docs.replayfy.app/guides/search-and-filters)

---

## Releases

Images are versioned so you can pin a build and report exactly what you're
running.

- **Pin a version:** set `REPLAYFY_IMAGE_TAG` in `.env` (e.g. `REPLAYFY_IMAGE_TAG=0.1.0`).
  It defaults to `latest`. Tags follow [semver](https://semver.org) — `0.1.0`,
  `0.1`, and `latest` all point at published images.
- **Which version am I on?** It's in **Settings** (a small footer under every
  tab), or query the API directly: `curl https://your-host/version` →
  `{"version":"0.1.0","commit":"…","builtAt":"…"}`. Include it in bug reports.
- **Cutting a release** (maintainers): push a `vX.Y.Z` tag. CI builds the
  matching `ghcr.io/replayfy/*:X.Y.Z` images and opens a GitHub Release with
  generated notes. See [releases](https://github.com/replayfy/replayfy/releases).

## Open core vs. Cloud

Replayfy is **open core**. This repository is the whole product, and when you
self-host it is unlimited and unmetered — no project cap, no seat cap, no
feature flags waiting behind a paywall. The AI assistant is included; you just
bring your own model key.

Two things are Enterprise Edition and live only in [Replayfy
Cloud](https://replayfy.app): subscription **billing/plans**, and the
**fully-managed** AI (no keys, no server config, usage-based). Cloud is simply
the same product run for you, with the AI metered and managed.

If you're a company getting real value from Replayfy and you'd rather not run
the infrastructure yourself, **[Replayfy Cloud](https://replayfy.app)** is how
this project stays funded and maintained — that's the whole trade. But there's
no obligation and no nag screen: the self-hosted build is complete, and it stays
that way.

---

## Contributing

Issues and pull requests are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) and our
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). To report a security issue
privately, see [`SECURITY.md`](SECURITY.md).

## Licence

The server and dashboard in this repository are **AGPL-3.0** — see
[`LICENSE`](LICENSE) and [`LICENSING.md`](LICENSING.md) for what that means and
for the Enterprise Edition boundary. The capture SDKs are **MIT**.
