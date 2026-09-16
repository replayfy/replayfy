/* ============================================================================
   Eager route fallbacks — the REAL page skeletons, in the main bundle.

   A route's own skeleton normally lives inside its lazy chunk, so while that
   chunk downloads <Suspense> can only fall back to the generic SkPage. For the
   two pages whose layout is distinctive enough that the generic skeleton reads
   as "broken" (the recordings 3-pane workspace, the funnel detail builder),
   this module re-exports their real full-page skeletons EAGERLY so the router
   can use them as the fallback — the chunk then downloads behind the actual
   page shape, and the loaded page's own skeleton is identical, so there is no
   swap. Both skeletons import only the `Sk` bars, never rrweb / the player, so
   pulling them into the main bundle costs a few KB, nothing more.
   ========================================================================== */
import { RvWorkspaceSkeleton } from "@/routes/recordings/RvWorkspaceSkeleton";

export { FnDetailSkeleton } from "@/routes/funnels/FnDetailSkeleton";

/** Recordings' 3-pane skeleton, seeded from the SAME persisted panel widths the
 *  page itself reads (rv-railw / rv-inspw-v2), so the fallback and the loaded
 *  workspace line up. Defaults match Recordings.tsx (272 / 336). */
export function RecordingsFallback() {
  const railW = +(localStorage.getItem("rv-railw") ?? "") || 272;
  const inspW = +(localStorage.getItem("rv-inspw-v2") ?? "") || 336;
  return <RvWorkspaceSkeleton railW={railW} inspW={inspW} />;
}
