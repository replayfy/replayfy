import { keepPreviousData, useQuery,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { getWorkspaceId, type ApiResult, type Page } from "./client";

/** djb2 hash of the fetcher source — a stable, unique site key without hand-writing
 *  query keys (bridge pattern from the reference useApi). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

type UseApiReturn<T> = {
  data: T | undefined;
  page: Page;
  loading: boolean;
  syncing: boolean;
  /** `data` is the previous deps' data (keepPreviousData placeholder). */
  stale: boolean;
  error: Error | null;
  refetch: () => void;
};

/**
 * Thin bridge over TanStack useQuery. The current workspace id is baked into the
 * key so switching workspaces namespaces (and invalidates) the cache automatically.
 * `loading` is only true on a genuinely empty cache; `syncing` is a background reconcile.
 */
export function useApi<T>(
  fetcher: () => Promise<ApiResult<T> | T>,
  deps: ReadonlyArray<unknown> = [],
  opts: {
    key?: string;
    enabled?: boolean;
    retry?: number | boolean;
    /* Poll this query every N ms. Opt-in per call, never a QueryClient default:
       a global interval would also re-pull every session's events/console/
       network, which are immutable once a recording ends. TanStack pauses the
       interval while the tab is unfocused (refetchIntervalInBackground is false
       by default), so this costs nothing when nobody is looking. */
    refetchInterval?: number;
  } = {},
): UseApiReturn<T> {
  const ref = useRef(fetcher);
  ref.current = fetcher;
  const siteKey = opts.key ?? djb2(fetcher.toString());

  const query = useQuery({
    queryKey: ["api", getWorkspaceId(), siteKey, ...deps],
    queryFn: async () => {
      const result = await ref.current();
      if (result && typeof result === "object" && "data" in (result as object)) {
        const r = result as ApiResult<T>;
        return { data: r.data, page: r.page ?? null };
      }
      return { data: result as T, page: null as Page };
    },
    placeholderData: keepPreviousData,
    enabled: opts.enabled,
    // Callers can opt out of retries — e.g. a share-token resolve, where a 4xx
    // (invalid / expired / revoked) will never recover, so the error state
    // should surface immediately rather than after retry backoff.
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    ...(opts.refetchInterval !== undefined
      ? { refetchInterval: opts.refetchInterval }
      : {}),
  });

  return {
    data: query.data?.data,
    page: query.data?.page ?? null,
    loading: query.isPending,
    syncing: query.isFetching && !query.isPending,
    /* True while `data` is the PREVIOUS deps' data, held by the
       keepPreviousData placeholder because the new key hasn't resolved. This is
       the signal a caller needs to avoid rendering one entity's data under
       another's id — serving placeholder data flips status to 'success', so
       `loading` is FALSE on a key switch and `data` is the old entity's.
       Gate loading UI on `loading || stale`, never on `syncing`: syncing is
       also true for a background refetch of the SAME key, which would blink a
       skeleton over data that is already correct. */
    stale: query.isPlaceholderData,
    error: (query.error as Error) ?? null,
    refetch: () => {
      void query.refetch();
    },
  };
}

type UseApiInfiniteReturn<T> = {
  /** Every loaded page's rows, flattened in order. */
  items: T[];
  /** The most recent page envelope (for `count` / totals). */
  page: Page;
  /** Cold load — no page yet. Gate the full-list skeleton on this. */
  loading: boolean;
  /** A subsequent page is in flight. Gate the END-of-list skeleton on this. */
  loadingMore: boolean;
  /** `items` is the PREVIOUS deps' data, held by keepPreviousData. */
  stale: boolean;
  hasMore: boolean;
  /** Fetch the next page. No-op while one is already loading or none remain. */
  fetchMore: () => void;
  error: Error | null;
  refetch: () => void;
};

/**
 * Infinite/cursor variant of {@link useApi} for lists that page. The fetcher
 * receives the cursor for the page to load (null for the first) and returns the
 * standard `ApiResult<T[]>`; the backend's `paginated()` envelope carries
 * `page.next_cursor` / `page.has_more`, which drive the next fetch. Rows across
 * pages are accumulated and flattened into `items`.
 *
 * Pair with `useInfiniteScroll(sentinelRef, fetchMore)` to load on scroll, and
 * render a trimmed skeleton while `loadingMore`.
 */
export function useApiInfinite<T>(
  fetcher: (cursor: string | null) => Promise<ApiResult<T[]> | T[]>,
  deps: ReadonlyArray<unknown> = [],
  opts: { key?: string; enabled?: boolean } = {},
): UseApiInfiniteReturn<T> {
  const ref = useRef(fetcher);
  ref.current = fetcher;
  const siteKey = opts.key ?? djb2(fetcher.toString());

  const query = useInfiniteQuery({
    queryKey: ["api-inf", getWorkspaceId(), siteKey, ...deps],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<{ data: T[]; page: Page }> => {
      const result = await ref.current(pageParam);
      if (result && typeof result === "object" && "data" in (result as object)) {
        const r = result as ApiResult<T[]>;
        return { data: r.data ?? [], page: r.page ?? null };
      }
      return { data: (result as T[]) ?? [], page: null };
    },
    // The last page carries next_cursor=null once exhausted → undefined stops it.
    getNextPageParam: (last) => last.page?.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    // Do NOT refetch every accumulated page on window focus. TanStack refetches
    // an infinite query by re-fetching ALL loaded pages sequentially from page
    // one, so a list scrolled to N pages fired N requests each time the tab
    // regained focus — the recordings list's real cost. Infinite lists stay
    // fresh via staleTime + explicit refetch; they don't need a focus re-pull.
    // (maxPages is deliberately NOT used: this is a forward-only list with no
    // getPreviousPageParam, so bounding pages would drop already-scrolled rows
    // with no way to get them back.)
    refetchOnWindowFocus: false,
    enabled: opts.enabled,
  });

  const pages = query.data?.pages ?? [];
  return {
    items: pages.flatMap((p) => p.data),
    // FIRST page's envelope: the total/count lives there (the backend only
    // computes it on the uncursored first request). next_cursor/has_more are
    // surfaced separately via `hasMore`, so this never needs the last page.
    page: pages.length ? pages[0].page : null,
    loading: query.isPending,
    loadingMore: query.isFetchingNextPage,
    stale: query.isPlaceholderData,
    hasMore: !!query.hasNextPage,
    fetchMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    error: (query.error as Error) ?? null,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** Invalidate a useApi cache entry by its `key`, for the CURRENT workspace.
 *  Mutations that change a number some OTHER surface displays (e.g. posting a
 *  comment, which the sidenav counts) call this — the alternative is a counts
 *  context or an event bus, i.e. re-implementing the query cache that already
 *  holds the value. */
export function useInvalidateApi(): (key: string) => void {
  const qc = useQueryClient();
  return (key: string) => {
    void qc.invalidateQueries({
      queryKey: ["api", getWorkspaceId(), key],
    });
  };
}
