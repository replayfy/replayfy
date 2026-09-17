#!/bin/sh
# Render the browser-visible API origin into /runtime-config.js at container
# start, so ONE pre-built dashboard image serves any deployment instead of being
# frozen to the origin it was built for. The nginx base image runs every
# executable *.sh in /docker-entrypoint.d/ before starting nginx.
#
# Set API_BASE_URL (preferred) or VITE_API_URL on the container. Empty leaves the
# value blank, and the app falls back to the VITE_API_URL baked into the bundle.
set -e
API="${API_BASE_URL:-${VITE_API_URL:-}}"
cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__REPLAYFY_API_URL__ = "${API}";
EOF
echo "runtime-config: window.__REPLAYFY_API_URL__ = \"${API}\""
