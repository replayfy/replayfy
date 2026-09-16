/* ============================================================================
   RvSearch ⇄ GET /v1/sessions/{suggest,facets} — the one place this UI knows
   the autocomplete's wire shape.

   Every dynamic group in the search dropdown is a row the API typed for us.
   We never infer a row's kind from its text: the server says `type`, we group
   by it, and a type this file has no entry for is dropped rather than guessed
   at (see SUGGEST_META). That keeps "which values exist" a question only the
   workspace's own data can answer.

   THE SPLIT THIS FILE EXISTS TO DRAW — by CARDINALITY, and nothing else:

     · BOUNDED (browser, device, country): the value set is small and
       slow-moving, so /v1/sessions/facets ships the COMPLETE set once per page
       mount, cached, and we filter it locally. Zero requests per keystroke.
     · UNBOUNDED (user, page): EndUser runs to millions and the path space is
       effectively infinite. Their complete set can never be shipped, so they
       stay on the debounced server typeahead with skeletons, where a trigram /
       substring search does the narrowing.

   Which types are bounded is the SERVER's answer (`types` in the facets
   response), never a list hardcoded here. That keeps the split with ONE owner:
   if a dimension stops being cacheable, the backend drops it from `types` and
   this UI stops serving it locally WITHOUT a matching frontend release.

   Facets is therefore an OPTIMISATION, never a dependency: no facets (loading,
   404, 5xx, ClickHouse down) means an empty `types`, which means nothing is
   bounded, which means every type falls back to the server typeahead — i.e.
   exactly the behaviour that shipped before this file learned about facets. A
   failed preload must never be able to hide a value from the user's filter.
   ========================================================================== */
import { useEffect, useMemo, useState } from "react";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";

/** One autocomplete row, as returned by the API. */
export type Suggestion = {
  /** Server-assigned kind — "user" | "page" | "browser" | … Never inferred here. */
  type: string;
  value: string;
  /** Sessions carrying this value (frequency ranking); absent for some types. */
  count?: number;
  /** EndUser.id for `type: "user"` — lets the list filter by endUserId rather
   *  than by a free-text match on the email. */
  id?: number;
  /** Secondary line (e.g. a user's name beside their email). */
  sub?: string;
};

type SuggestMeta = {
  /** Group header in the dropdown. */
  label: string;
  /** Glyph key in RvSearch's `G` map. */
  icon: string;
  /** Filter-token key this row's value becomes when picked. MUST be a key that
   *  tokensToParams can map onto a real GET /v1/sessions param — offering a
   *  value that silently fails to filter is the same lie as inventing it. */
  key: string;
};

/**
 * The types this UI can both display AND filter by.
 *
 * Deliberately smaller than the set the backend can suggest: the sessions list
 * has no param for os / city / release / platform, so autocompleting them would
 * hand the user a token that quietly returns unfiltered results. When the list
 * grows those filters, add the type here and to PROPS in search.data.ts.
 */
export const SUGGEST_META: Record<string, SuggestMeta> = {
  user: { label: "Users", icon: "user", key: "user" },
  page: { label: "Pages", icon: "path", key: "page" },
  browser: { label: "Browsers", icon: "globe", key: "browser" },
  device: { label: "Devices", icon: "device", key: "device" },
  deviceModel: { label: "Device models", icon: "device", key: "model" },
  country: { label: "Countries", icon: "flag", key: "country" },
};

/** Group order in the dropdown — the API ranks WITHIN a type, not across them. */
export const SUGGEST_TYPES = Object.keys(SUGGEST_META);

/** Filter-token key → the suggest type that feeds its values ("browser:" mode). */
export const KEY_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(SUGGEST_META).map(([type, m]) => [m.key, type]),
);

/* One pause, one request. 180ms is below the ~200ms that reads as lag but long
   enough that ordinary typing (~120ms/char) never fires mid-word. */
const DEBOUNCE_MS = 180;

export function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Accepts `{ items: [...] }` (the house envelope) or a bare array. */
function normalize(res: unknown): Suggestion[] {
  const rows = Array.isArray(res)
    ? res
    : Array.isArray((res as { items?: unknown })?.items)
      ? (res as { items: unknown[] }).items
      : [];
  return rows.flatMap((r) => {
    const row = r as Partial<Suggestion>;
    // A row with no type can't be grouped by the server's answer, and a type we
    // can't map to a filter can't be applied — drop both rather than guess.
    if (typeof row.type !== "string" || !SUGGEST_META[row.type]) return [];
    if (typeof row.value !== "string" || !row.value) return [];
    return [
      {
        type: row.type,
        value: row.value,
        count: typeof row.count === "number" ? row.count : undefined,
        id: typeof row.id === "number" ? row.id : undefined,
        sub: typeof row.sub === "string" ? row.sub : undefined,
      },
    ];
  });
}

/* ── The BOUNDED half: preloaded, cached, filtered locally ───────────────── */

export type FacetSet = {
  /** Types served from `byType` instead of the network. The server's list,
   *  intersected with what this UI can actually render AND apply. */
  types: string[];
  /** Complete value set per bounded type, in the server's own count-desc order. */
  byType: Record<string, Suggestion[]>;
};

const NO_FACETS: FacetSet = { types: [], byType: {} };

/** `{ types, items }` → rows bucketed by type. Feeds the SAME normalizer as
 *  suggest, because the API deliberately returns the same row shape. */
function normalizeFacets(res: unknown): FacetSet {
  const raw = (res as { types?: unknown })?.types;
  const declared = Array.isArray(raw)
    ? raw.filter((t): t is string => typeof t === "string")
    : [];
  /* SUGGEST_META stays the ONE gate on what's offerable. A type the server
     calls bounded but this UI has no entry for is not served locally and not
     rendered — it simply stays on the server path, exactly as an unknown type
     always has. So the backend widening `types` can never ship a group that
     renders nothing, or a chip /v1/sessions has no param for. */
  const types = declared.filter((t) => SUGGEST_META[t]);
  const byType: Record<string, Suggestion[]> = {};
  for (const t of types) byType[t] = [];
  for (const row of normalize(res)) byType[row.type]?.push(row);
  /* A declared type with zero rows STAYS bounded rather than falling back: the
     workspace genuinely has no sessions carrying that dimension in the read's
     window, and the server typeahead — same table, same window — would return
     the same nothing. Falling back would spend a request per keystroke to
     re-learn it. (The backend gives an empty set a much shorter TTL for exactly
     this case: it means mid-onboarding, when the first value landing matters.) */
  return { types, byType };
}

/**
 * The workspace's bounded value sets — ONE request per page mount, not one per
 * keystroke.
 *
 * Call this on the Recordings route itself, not just in the dropdown: useApi is
 * TanStack-backed and this fetcher has a fixed key with no deps, so the route's
 * call and RvSearch's own call are the SAME cache entry. The route warms it in
 * parallel with the sessions list, and by the time the search mounts (the list
 * resolves first — the route skeletons behind it) the values are already in
 * hand and the dropdown opens with zero requests.
 *
 * Staleness is bounded by the SERVER's TTL, not this one. Freshness note: the
 * read behind it is a ~30-day trailing window, so this list is "values seen
 * recently" by construction — an approximation far coarser than any client
 * cache. The blast radius is the filter VOCABULARY, never filter RESULTS:
 * /v1/sessions is uncached, so an applied `browser=Chrome` chip always returns
 * the true set. The worst case is a just-appeared value not being OFFERED for
 * one TTL — never a wrong count.
 */
export function useFacets(enabled = true): FacetSet {
  const { data, error } = useApi<unknown>(() => Sessions.facets<unknown>(), [], {
    key: "sessions/facets",
    // Gated by the caller: an empty workspace (counts.recordings === 0) skips
    // the facets preload entirely — nothing to filter, so nothing to warm.
    enabled,
    /* No retries, same reasoning as suggest but for a different end: this is a
       best-effort preload with a working fallback underneath it, so a failure
       should degrade to the typeahead on the NEXT keystroke rather than hold
       the bounded groups back through a retry backoff. */
    retry: 0,
  });
  return useMemo(() => {
    // An error here is not surfaced: the fallback below serves every one of
    // these types from the network, so there is nothing the user must be told
    // and nothing they cannot do. Degraded, not broken — and never silent about
    // a VALUE, only about which path served it.
    if (error || data === undefined) return NO_FACETS;
    return normalizeFacets(data);
  }, [data, error]);
}

export type SuggestState = {
  items: Suggestion[];
  /** In flight for the CURRENT query — render the group skeletons. */
  busy: boolean;
  error: Error | null;
};

/**
 * Debounced, race-safe value autocomplete — the UNBOUNDED path.
 *
 * Race safety is structural, not a hand-rolled sequence counter: `q` and
 * `types` are part of the TanStack query key, so a slow reply resolves into the
 * cache entry for the query that ASKED for it and can never land under a newer
 * one. While the newer key resolves, `stale` (isPlaceholderData) is true and the
 * previous query's rows are still in `data` — so callers must render the
 * skeleton on `busy`, never those rows, or a stale value list would sit under a
 * newer prefix.
 */
function useServerSuggest(
  rawQuery: string,
  types: string[],
  enabled: boolean,
): SuggestState {
  const raw = rawQuery.trim();
  const q = useDebounced(raw);
  const typeKey = types.join(",");
  /* `settled` is what makes this ONE request per pause rather than two. The
     debounced `q` lags `raw` by a frame on the first keystroke, so without it
     the first character fires an immediate q="" request (every dimension's
     top values — the most expensive shape this endpoint has) and then the real
     one 180ms later. It is not `q !== ""`: in "browser:" mode an empty part is
     a legitimate query, and that one SHOULD fetch the top values. */
  const settled = q === raw;
  // `enabled` gates the request itself: the dropdown's empty state (recents /
  // saved) and the static grammar groups must never wait on the network.
  const on = enabled && types.length > 0 && settled;
  const { data, loading, stale, error } = useApi<unknown>(
    () => Sessions.suggest<unknown>({ q, groups: types }),
    [q, typeKey],
    {
      key: "sessions/suggest",
      enabled: on,
      /* No retries. A suggest that fails is superseded by the next keystroke
         anyway, and the default 3-with-backoff kept the skeleton spinning for
         seconds on a 4xx that will never come good — the dropdown looked like
         it was still working when it was not. Fail fast, say so, move on. */
      retry: 0,
    },
  );
  /* Typing again while a request is in flight must not leave the OLD values on
     screen: `stale` marks data that belongs to a previous q, and `!settled`
     covers the window where the query is deliberately disabled while the
     debounce catches up. Both are "the answer on screen is not for what you
     typed" — i.e. skeleton, not rows. An errored suggest is NOT busy: it
     resolves to zero items and the caller renders the honest failure. */
  const busy =
    enabled && types.length > 0
      ? !settled || ((loading || stale) && !error)
      : false;
  return {
    items: on && !busy ? normalize(data) : [],
    busy,
    error: (error as Error) ?? null,
  };
}

/**
 * The dropdown's one value source — routes each requested type to the path its
 * CARDINALITY calls for, and merges the two into a single typed row list.
 *
 * Bounded types are answered from the preloaded facets, so they:
 *  · cost zero requests, at mount or per keystroke;
 *  · are never `busy`, so their groups never render a skeleton — the whole
 *    point being that they are already in hand when the dropdown opens;
 *  · filter on the same case-insensitive substring the server's ILIKE applies,
 *    so a value's visibility does not depend on which path served it.
 *
 * Everything else — and EVERYTHING, when facets is unavailable — goes to the
 * debounced server typeahead untouched. Callers see one SuggestState and do not
 * need to know which half a row came from; `busy` refers only to the server
 * half, which is precisely the half a skeleton should stand in for.
 */
export function useSuggest(
  rawQuery: string,
  types: string[],
  enabled: boolean,
): SuggestState {
  const facets = useFacets();
  // Not `types.filter(bounded)` on the render path: the server call must be
  // given the complement, and both must agree on the split, so derive once.
  const serverTypes = useMemo(
    () => types.filter((t) => !facets.types.includes(t)),
    [types, facets.types],
  );
  const server = useServerSuggest(rawQuery, serverTypes, enabled);
  const local = useMemo(() => {
    if (!enabled) return [];
    const q = rawQuery.trim().toLowerCase();
    return types
      .filter((t) => facets.types.includes(t))
      .flatMap((t) =>
        // `includes`, matching the server's unanchored `%q%` (which escapes its
        // LIKE metacharacters, so both are a literal substring test). The set is
        // the complete one and capped in the hundreds, so this is trivial work
        // on a value list the browser already holds. No slice here: how many
        // rows a group SHOWS is the dropdown's call, not this hook's.
        (facets.byType[t] ?? []).filter(
          (r) => !q || r.value.toLowerCase().includes(q),
        ),
      );
  }, [enabled, types, facets.types, facets.byType, rawQuery]);
  return useMemo(
    // Order across types is irrelevant — the dropdown groups by `type` and
    // SUGGEST_TYPES fixes the order. A type is served by exactly one path, so
    // the two halves can never contribute duplicate rows to the same group.
    () => ({
      items: local.length ? [...local, ...server.items] : server.items,
      busy: server.busy,
      error: server.error,
    }),
    [local, server.items, server.busy, server.error],
  );
}
