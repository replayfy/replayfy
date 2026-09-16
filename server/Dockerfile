# Replayfy server (ingest API) — self-host image.
#
# npm-workspaces monorepo: the Prisma clients are generated INTO the source tree
# (gitignored, no postinstall), so `prisma:generate` must run in-image before the
# TypeScript build. One image serves both the one-shot `migrate` step and the
# long-running `api` (compose overrides the command for migrate).
FROM node:20.17.0-bookworm-slim

# Prisma's query engine needs OpenSSL + CA certs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Whole repo is the context (workspaces + every package.json + prisma schema are
# needed for `npm ci` and `prisma:generate`). node_modules/dist/.git are excluded
# via .dockerignore.
COPY . .

RUN npm ci --no-audit --no-fund \
    && npm run prisma:generate \
    && npm run build

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

EXPOSE 4000

# Default: the all-in-one API (APP_ROLE unset = every role in one process — the
# simplest self-host topology). The compose `migrate` service overrides this.
CMD ["node", "apps/ingest-api/dist/bootstrap.js"]
