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

# Build identity, surfaced at GET /version so a self-hoster can report exactly
# which build they're on. APP_VERSION defaults to package.json's version; CI
# overrides it with the release tag and passes the commit + build time.
ARG APP_VERSION
ARG GIT_SHA
ARG BUILD_TIME
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    BUILD_TIME=${BUILD_TIME}

EXPOSE 4000

# Default: the all-in-one API (APP_ROLE unset = every role in one process — the
# simplest self-host topology). The compose `migrate` service overrides this.
CMD ["node", "apps/ingest-api/dist/bootstrap.js"]
