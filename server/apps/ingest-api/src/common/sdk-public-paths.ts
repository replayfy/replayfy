/**
 * The public SDK ingest surface: the only routes the web + mobile SDKs (and CI
 * symbol uploads) call. They authenticate with the workspace PUBLISHABLE key
 * (x-replay-api-key), never a cookie or dashboard session.
 *
 * Shared by two consumers that must agree exactly:
 *   • the path-aware CORS middleware (these paths reflect ANY origin), and
 *   • the ingest-only gate (an APP_ROLE=ingest node serves ONLY these paths +
 *     the health endpoints, so it can be exposed publicly while the full
 *     dashboard API stays private).
 */
export const SDK_PUBLIC_PREFIXES = ["/v1/replay", "/v1/sdk", "/v1/mobile"] as const;

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
