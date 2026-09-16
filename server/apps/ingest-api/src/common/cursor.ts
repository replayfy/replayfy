/**
 * Opaque base64-encoded numeric cursor. Frontend treats it as a string.
 * Encoding: base64("c:<id>")
 */
export function encodeCursor(id: number): string {
  return Buffer.from(`c:${id}`).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined | null,
): number | undefined {
  if (!cursor) return undefined;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    if (!raw.startsWith("c:")) return undefined;
    const n = Number(raw.slice(2));
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Slice a `take = limit + 1` result set into items + nextCursor.
 * Items must be sorted such that `idOf(last)` becomes the cursor seed.
 */
export function paginateRows<T>(
  rows: T[],
  limit: number,
  idOf: (row: T) => number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: encodeCursor(idOf(last)) };
}

/**
 * Composite keyset cursor: carries the leading SORT value plus the `id`
 * tie-breaker, so pagination stays correct when the list is ordered by a column
 * OTHER than id (startedAt / lastSeenAt / name …) whose values don't track id.
 *
 * The id-only cursor above is only valid when the sort column IS id (or tracks
 * it). Ordering by startedAt DESC while paging on `id < cursor` silently strands
 * rows whenever id and startedAt decorrelate (a backfill, an import, seeded
 * data) — the list stops early or skips rows. This cursor pairs the sort value
 * with id so the keyset predicate is exact.
 *
 * JSON-encoded so the sort value can be a number (epoch-ms for dates, or a raw
 * int) OR a string (e.g. a name), with no delimiter ambiguity.
 */
export function encodeCompositeCursor(
  sortValue: number | string | null,
  id: number,
): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

export function decodeCompositeCursor(
  cursor: string | undefined | null,
): { sortValue: number | string | null; id: number } | undefined {
  if (!cursor) return undefined;
  try {
    const arr = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(arr) || arr.length !== 2) return undefined;
    const [sortValue, id] = arr as [unknown, unknown];
    if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
    // sortValue may be null — a nullable sort column (e.g. EndUser.name) pages
    // in two phases (non-null values, then the NULL block), and the cursor
    // carries `null` to mark that it has crossed into the null phase.
    if (
      sortValue !== null &&
      typeof sortValue !== "number" &&
      typeof sortValue !== "string"
    ) {
      return undefined;
    }
    return { sortValue, id };
  } catch {
    return undefined;
  }
}

/**
 * Slice a `take = limit + 1` result set into items + a COMPOSITE nextCursor
 * seeded from the last row's (sortValue, id). Use with a keyset predicate built
 * from the same (sortValue, id) pair.
 */
export function paginateComposite<T>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => number | string | null,
  idOf: (row: T) => number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) {
    return { items: rows, nextCursor: null };
  }
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: encodeCompositeCursor(sortValueOf(last), idOf(last)),
  };
}

export function parseLimit(
  value: string | number | undefined,
  fallback = 25,
  max = 200,
): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || (n as number) <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n as number), 1), max);
}
