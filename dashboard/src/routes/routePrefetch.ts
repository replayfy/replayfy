/* ============================================================================
   Route chunk prefetch — warm a lazy route's JS before the user navigates.

   Every page is React.lazy (its own chunk), so clicking a nav link first has to
   DOWNLOAD that chunk while <Suspense> shows the generic SkPage fallback — the
   "generic skeleton flashes before the page's own skeleton" effect. Kicking the
   import off on hover/focus means the chunk is (usually) already cached by the
   time the click lands, so Suspense resolves instantly and that generic phase
   never renders — you go straight to the page's real skeleton + data.

   The import specifiers here are BYTE-IDENTICAL to the ones in router.tsx, so
   Vite/Rollup resolve them to the SAME chunk and the browser dedupes the fetch —
   this warms the cache, it does not double-download.
   ========================================================================== */
const IMPORTERS: Record<string, () => Promise<unknown>> = {
  overview: () => import("@/routes/overview/Overview"),
  recordings: () => import("@/routes/recordings/Recordings"),
  crashlytics: () => import("@/routes/crashlytics/Crashlytics"),
  funnels: () => import("@/routes/funnels/Funnels"),
  analytics: () => import("@/routes/analytics/Analytics"),
  users: () => import("@/routes/users/Users"),
  cohorts: () => import("@/routes/cohorts/Cohorts"),
  alerts: () => import("@/routes/alerts/Alerts"),
  comments: () => import("@/routes/comments/Comments"),
  settings: () => import("@/routes/settings/Settings"),
};

// Fire each importer at most once. A failed fetch clears its flag so a later
// hover can retry (a transient offline blip shouldn't wedge prefetch forever).
const started = new Set<string>();

/** Prefetch the chunk for a nav id (see NAV in nav.data). No-op for unknown ids
 *  and for ids already warmed. Safe to call on every mouseenter/focus. */
export function prefetchRoute(id: string): void {
  if (started.has(id) || !IMPORTERS[id]) return;
  started.add(id);
  IMPORTERS[id]().catch(() => started.delete(id));
}
