import { QueryClient } from "@tanstack/react-query";

/** How long a cached answer is served without a refetch (ms) — the client-wide
 *  default. Exported so a per-query staleTime (useApi `staleTime`) can fall
 *  back to the same value instead of a second copy of it. */
export const DEFAULT_STALE_MS = 30_000;

/** Shared query client — same knobs as the reference dashboard. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: DEFAULT_STALE_MS,
      gcTime: 7 * 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
