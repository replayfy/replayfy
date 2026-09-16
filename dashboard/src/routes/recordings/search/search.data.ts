/* ============================================================================
   RvSearch grammar — the STATIC half of the search.

   What lives here is vocabulary the product defines and every workspace shares:
   the filter keys, their operators, and the fixed enum values (`has:error`,
   `duration:>2m`). It renders instantly and never waits on the network.

   What used to live here — CATALOG's users, sessions, browsers, pages, errors,
   releases, flags — was a fixture list of values invented for the prototype.
   Offering "maria@acme.io" to a workspace that has never seen her is a lie the
   UI cannot walk back once clicked, so those groups now come from
   GET /v1/sessions/suggest (see suggest.ts) and nothing in this file claims a
   value exists in anyone's data.

   Every key below maps to a real GET /v1/sessions param via tokensToParams. A
   key with no param behind it (os, city, release, platform, feature flag,
   console level, network status, error text) is NOT offered: a chip that
   quietly fails to filter is worse than no chip, because the list still returns
   rows and they look like a result.
   ========================================================================== */

export type SearchToken = {
  key: string;
  op: string;
  value: string;
  /** Set when a `user` token came from a suggestion, so the list can filter by
   *  the indexed endUserId instead of a substring match on the email. */
  endUserId?: number;
};
/** A token materialised into the active filter bar (adds id + join). */
export type FilterToken = SearchToken & { id: string; join: string | null };

export type PropDef = {
  label: string;
  icon: string;
  defOp: string;
  ops: string[];
  /** Fixed enum values. Empty when `dynamic` — the API supplies them. */
  values: string[];
  /** Values come from GET /v1/sessions/suggest, keyed by KEY_TO_TYPE. */
  dynamic?: boolean;
  hint: string;
};
export type SavedFilter = { name: string; tokens: SearchToken[] };

/* ---- filterable properties (operators) ----
   ops are ":" only, and duration is ">" only: the sessions list ANDs its params
   and has no negation or upper bound, so offering "≠" / "<" would hand back a
   chip the backend silently ignores. Restoring them is a backend change first. */
export const PROPS: Record<string, PropDef> = {
  has: {
    label: "Has",
    icon: "alert",
    defOp: ":",
    ops: [":"],
    // The five signals the list has a boolean param for. "console error" /
    // "network error" / "comment" were dropped with the fixtures: Session
    // counts them, but /v1/sessions exposes no filter for them.
    values: ["error", "rage", "dead click", "slow lcp", "long tasks"],
    hint: "sessions containing a signal",
  },
  user: {
    label: "User",
    icon: "user",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "identified user",
  },
  page: {
    label: "Page",
    icon: "path",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "visited path",
  },
  browser: {
    label: "Browser",
    icon: "globe",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "browser name",
  },
  device: {
    label: "Device",
    icon: "device",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "device type",
  },
  model: {
    label: "Device model",
    icon: "device",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "hardware model",
  },
  platform: {
    label: "Platform",
    icon: "globe",
    defOp: ":",
    ops: [":"],
    values: ["web", "ios", "android"],
    hint: "web / ios / android",
  },
  country: {
    label: "Country",
    icon: "flag",
    defOp: ":",
    ops: [":"],
    values: [],
    dynamic: true,
    hint: "geo country",
  },
  duration: {
    label: "Duration",
    icon: "clock",
    defOp: ">",
    ops: [">"],
    values: ["30s", "1m", "2m", "5m"],
    hint: "session length",
  },
};

/* ---- presets ----
   Pure grammar: each asserts a SHAPE of session, never that a particular value
   exists in this workspace. The prototype's "Checkout" (page:/checkout),
   "Mobile" (platform:mobile) and "Production" (release:latest) are gone — the
   first named a page no workspace is guaranteed to have, and the other two used
   keys the list cannot filter by.

   Still a hardcoded list, not the user's own saved filters: there is no
   saved-filter endpoint. Nothing here invents data, so it is not a lie — but
   the header calling them "Saved" overstates it until that endpoint exists. */
export const SAVED: SavedFilter[] = [
  { name: "Has errors", tokens: [{ key: "has", op: ":", value: "error" }] },
  { name: "Rage clicks", tokens: [{ key: "has", op: ":", value: "rage" }] },
  {
    name: "Slow sessions",
    tokens: [{ key: "duration", op: ">", value: "2m" }],
  },
];

/** Recent searches persist per browser — the user's OWN history, so an empty
 *  list on first run is the honest state. (The prototype seeded four invented
 *  queries here, two of which used filter keys that no longer exist.) */
const RECENTS_PREFIX = "rv-search-recents";
export const RECENTS_MAX = 5;

/* Keyed PER WORKSPACE. A recent can name a real person — `user:maria@acme.io`
   is the whole point of the feature — and switching workspace is a full page
   load (setWorkspace → location.assign), so a single global key would simply
   re-render one tenant's customers in another tenant's dropdown. The bare
   prefix is never used as a key; a null workspace stores nothing. */
const recentsKey = (ws: number | null): string | null =>
  ws == null ? null : `${RECENTS_PREFIX}:${ws}`;

export function loadRecents(ws: number | null): string[] {
  const key = recentsKey(ws);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          // `typeof v === "string"` alone admits "", which renders a blank row
          // that still clears every chip when clicked.
          .filter((v): v is string => typeof v === "string" && v.trim() !== "")
          .slice(0, RECENTS_MAX)
      : [];
  } catch {
    // Private-mode / corrupt JSON — recents are a convenience, never a reason
    // to take the search down.
    return [];
  }
}

export function saveRecents(ws: number | null, list: string[]): void {
  const key = recentsKey(ws);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    /* quota / private mode — ignore */
  }
}

/** Drop EVERY workspace's history. Called on logout: these entries name this
 *  account's customers, and the next person to sign in on a shared browser
 *  must not read them out of the search box. */
export function clearRecents(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k === RECENTS_PREFIX || k.startsWith(`${RECENTS_PREFIX}:`))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* private mode — nothing to clear */
  }
}
