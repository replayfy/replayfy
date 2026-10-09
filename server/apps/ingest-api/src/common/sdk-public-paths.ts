/**
 * The public SDK ingest surface: the only routes the web + mobile SDKs (and CI
 * symbol uploads) call. They authenticate with a workspace API key
 * (x-replay-api-key), never a cookie or dashboard session.
 *
 * Shared by two consumers that must agree exactly:
 *   • the path-aware CORS middleware (these paths reflect ANY origin), and
 *   • the ingest-only gate (an APP_ROLE=ingest node serves ONLY these paths +
 *     the health endpoints, so it can be exposed publicly while the full
 *     dashboard API stays private).
 *
 * Listed per route, not as a bare `/v1/replay` prefix, because that prefix also
 * hosts a DASHBOARD route (POST /v1/replay/symbolicate, JWT-authed) which must
 * not be reachable on an ingest-only node. A new SDK route has to be added here
 * or the SDK is CORS-blocked and 404s on ingest-only nodes.
 */
export const SDK_PUBLIC_PREFIXES = [
  "/v1/replay/batch", // web + mobile replay batches
  "/v1/replay/symbols", // CI symbol / mapping uploads
  "/v1/sdk", // GET /v1/sdk/config
  "/v1/mobile", // mobile session lifecycle + frames
] as const;

/** Health/identity endpoints every HTTP node keeps (LB probes, `GET /version`). */
export const HEALTH_PATHS: ReadonlySet<string> = new Set([
  "/healthz",
  "/readyz",
  "/version",
]);

/** Exact prefix match on a path segment boundary: `/v1/sdk` and `/v1/sdk/x`
 *  match; `/v1/sdkfoo` does not. Case-sensitive on purpose — the SDKs always
 *  send lowercase, and anything else fails closed on an ingest-only node. */
export function isSdkPublicPath(path: string): boolean {
  return SDK_PUBLIC_PREFIXES.some(
    (pre) => path === pre || path.startsWith(`${pre}/`),
  );
}
