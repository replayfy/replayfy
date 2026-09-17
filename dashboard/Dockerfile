# Replayfy dashboard — self-host image (static build served by nginx).
#
# VITE_API_URL is baked in at BUILD time (Vite inlines import.meta.env). For a
# from-source build, point it at the public origin of the API. But the image is
# ALSO runtime-configurable: set API_BASE_URL on the container and the entrypoint
# writes /runtime-config.js at start (see docker-entrypoint.sh), which the app
# prefers over the baked value — so one published image works for any deployment.
FROM node:20.17.0-bookworm-slim AS build
WORKDIR /app
COPY . .
# The committed lockfile is generated on macOS and omits the Linux platform
# optional dep (@rollup/rollup-linux-*), an npm bug (npm/cli#4828) — with the
# lockfile present, neither `npm ci` nor `npm install` installs the Rollup
# native binary Vite needs, and the build dies with "Cannot find module
# @rollup/rollup-linux-*". The bug's own remedy is to drop the lockfile so npm
# re-resolves optional deps fresh for this platform (node_modules is already
# absent via .dockerignore). Versions still come from package.json's ranges.
RUN rm -f package-lock.json && npm install --no-audit --no-fund

ARG VITE_API_URL=http://localhost:4000
ARG VITE_STRIPE_PUBLISHABLE_KEY=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_STRIPE_PUBLISHABLE_KEY=$VITE_STRIPE_PUBLISHABLE_KEY
# `@ee` resolves to src/ee.stub.tsx when the proprietary src/ee/ is absent
# (the open-source build) — see vite.config.ts / tsconfig.json.
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Runs before nginx starts (the base image execs every *.sh here) and renders
# /runtime-config.js from $API_BASE_URL, so the API origin is a runtime knob.
COPY --chmod=0755 docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
EXPOSE 80
