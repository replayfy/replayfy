# Lightweight Session Replay

A focused session-replay platform: web SDK, ingest API, and admin dashboard.

## Storage layout

| Store      | Purpose                                        | Access layer       |
| ---------- | ---------------------------------------------- | ------------------ |
| Postgres   | Projects, API keys, sessions, segment manifest | Prisma             |
| MongoDB    | Replay JSON envelopes (rrweb snapshots, etc.)  | Prisma             |
| ClickHouse | Console, network, error projections            | `@clickhouse/client` |

> Prisma has no ClickHouse adapter, so ClickHouse is wrapped in the
> `@replay/db-clickhouse` package with a Prisma-style typed API.

## Apps

- `apps/ingest-api` — NestJS API (ingest + platform endpoints).
- `apps/admin-dashboard` — React + Vite admin UI (`http://127.0.0.1:5174`).
- `apps/web-demo` — SDK testbed (`http://127.0.0.1:4173`).
- `apps/landing-site` — SDK-instrumented demo site (`http://127.0.0.1:5173`).

## Local dev

```bash
# 1. Start infra
npm run db:up

# 2. Install + generate prisma clients + push schemas
npm install
npm run prisma:generate
npm run prisma:migrate

# 3. Build & run
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:5174> for the admin dashboard.

### Running roles separately (`APP_ROLE`)

`npm run dev:api` runs everything in one process (the default — `APP_ROLE`
unset). In production the same image is deployed as separate **roles** so the
SDK-facing ingest path, the Bull workers, the `@Cron` schedulers, and the
dashboard read API scale (and fail) independently. You can practice that split
locally — build once, then start each role in its own terminal on its own port:

```bash
npm run build          # build once; the role scripts run the compiled dist

npm run role:ingest    # APP_ROLE=ingest  :4000  SDK accept path + presence writes
npm run role:api       # APP_ROLE=api     :4001  dashboard reads
npm run role:worker    # APP_ROLE=worker  :4002  drains the Bull queues (perf env baked in)
npm run role:cron      # APP_ROLE=cron    :4003  the @Cron schedulers (run exactly one)
```

Point your SDK/testbed at the **ingest** node (`:4000`) and the dashboard at the
**api** node (`:4001`); in prod a path-routed load balancer does this. Note the
`cron` node must be running for the deferred sweeps to fire (the `worker` role
sets `INGEST_RESPONSIVE_EVAL=0`, which defers per-session finalize work to those
sweeps). Unknown `APP_ROLE` values crash at boot on purpose. Full topology,
env knobs, and rollout: [docs/deploy-roles.md](docs/deploy-roles.md).

## Stripe / billing setup

Billing is inert until these are wired. `StripeService` logs a warning and every
billing endpoint returns 503 when `STRIPE_SECRET_KEY` is absent — that is the
intended local-dev state, so you only need this section for a real deployment.

### 1. Prices

Create one recurring monthly Price per self-serve paid tier in the Stripe
dashboard and paste the **Price** ids (`price_…`, not the `prod_…` Product id)
into env:

| Env var | Plan | Price |
| ------- | ---- | ----- |
| `STRIPE_PRICE_STARTER`  | Starter  | $69/mo |
| `STRIPE_PRICE_GROWTH`   | Growth   | $249/mo |
| `STRIPE_PRICE_SCALE`    | Scale    | $599/mo |
| `STRIPE_PRICE_BUSINESS` | Business | $1,399/mo |

Free is never charged and Enterprise is invoiced manually, so neither has a
price. These ids are the **only** link between a Stripe subscription and the
plan we grant: the webhook reads the price off the subscription and maps it back
with `planForPriceId()`. A missing or duplicated id means a customer can pay and
never receive their plan. `validateStripePriceConfig()` in
`apps/ingest-api/src/billing/plan-catalog.ts` checks all of this at boot and
reports every problem it finds.

### 2. Webhook endpoint

Add an endpoint in Stripe pointing at:

```
POST https://<your-api-host>/v1/billing/webhook
```

Put its signing secret in `STRIPE_WEBHOOK_SECRET`. The route is deliberately
guardless — the Stripe signature over the **raw** request body is what
authenticates it — and it always answers 200 once verified so Stripe does not
retry an event we have already accepted.

Subscribe the endpoint to **exactly these event types**. Anything not enabled
here fails silently: the money moves in Stripe and our side never hears about
it.

| Event | What it drives |
| ----- | -------------- |
| `checkout.session.completed`      | Binds the new subscription/customer back to the workspace |
| `customer.subscription.created`   | Grants the plan the customer paid for |
| `customer.subscription.updated`   | Plan changes, status changes, scheduled cancellations |
| `customer.subscription.deleted`   | Drops the workspace back to Free |
| `invoice.paid`                    | Records the payment; clears a past-due block |
| `invoice.payment_succeeded`       | Overage/top-up collection settled |
| `invoice.payment_failed`          | Marks the workspace past due |
| `charge.refunded`                 | Negative entry in the billing audit trail |
| `charge.dispute.created`          | Chargeback opened |
| `charge.dispute.closed`           | Chargeback resolved |
| `payment_intent.succeeded`        | Grants purchased AI credits (top-ups) |
| `payment_method.attached`         | Lifts an overage cap once a working card is added |

Unlisted events that do arrive are still recorded as `kind: "other"` in
`BillingEvent`, so nothing money-related is ever invisible — but only the events
above are acted on.

### 3. Remaining env

`DASHBOARD_URL` — the public dashboard origin Stripe returns customers to after
Checkout and the Billing Portal. It has a localhost fallback, so **a production
deploy that forgets it sends paying customers to 127.0.0.1.**

`STRIPE_AUTOMATIC_TAX` — leave unset/`false` until Stripe Tax is activated with
an origin address and at least one registration. Enabling it beforehand makes
every checkout and plan change fail outright.

`VITE_STRIPE_PUBLISHABLE_KEY` in the dashboard repo — the matching publishable
key, same Stripe account and same test/live mode. Without it the embedded
checkout declines to open.

See `.env.example` in each repo for the full annotated list.

## Admin dashboard routes

- `/sessions` — filterable session list (search, project, platform, status, time range)
- `/sessions/:id` — rrweb player + synchronized console / network / errors / metadata tabs
- `/projects` — list / create projects
- `/projects/:id` — API keys, retention, sampling
- `/settings` — connection info

## API endpoints

Replay ingest:
- `POST /v1/replay/batch`

Query:
- `GET /v1/sessions?projectId=&search=&platform=&status=&from=&to=&limit=`
- `GET /v1/sessions/:id`
- `GET /v1/sessions/:id/events`
- `GET /v1/sessions/:id/logs`
- `DELETE /v1/sessions/:id`

Platform:
- `GET/POST /v1/projects`
- `GET/PUT/DELETE /v1/projects/:id`
- `POST/DELETE /v1/projects/:id/keys/:keyId?`
