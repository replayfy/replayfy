// Runtime configuration for the dashboard.
//
// This ships as a no-op default. In the self-host Docker image the container's
// entrypoint (see /docker-entrypoint.d/40-runtime-config.sh, added by the
// Dockerfile) overwrites this file at start with the API origin from
// $API_BASE_URL, e.g.  window.__REPLAYFY_API_URL__ = "https://api.example.com";
//
// Empty means "use the build-time VITE_API_URL" (and the localhost dev default),
// so local development and a from-source build are unaffected.
window.__REPLAYFY_API_URL__ = "";
