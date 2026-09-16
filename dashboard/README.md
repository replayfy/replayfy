# Replayfy Dashboard

The Replayfy web app — session replay, product analytics, funnels, cohorts, and
crashlytics. React + Vite + TypeScript, talking to the Replayfy ingest API.

## Develop

Requires Node 20.17.0 (see `.nvmrc`).

```bash
nvm use
npm install
npm run dev        # http://localhost:5173
```

Point it at an API with `VITE_API_URL` (defaults to `http://localhost:4000`):

```bash
echo 'VITE_API_URL=http://localhost:4000' > .env.local
```

## Build

```bash
npm run typecheck && npm run build   # static bundle in dist/
```

## Run the whole product

For the full stack (API + datastores + this dashboard) in one command, use the
top-level `docker compose up` — see the repository root README.
