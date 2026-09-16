import { QueryClient } from "@tanstack/react-query";

/** Shared query client — same knobs as the reference dashboard. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 7 * 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});
