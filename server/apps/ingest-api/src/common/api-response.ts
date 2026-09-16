export interface ApiMeta {
  request_id: string;
  ts: number;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiPage {
  next_cursor: string | null;
  has_more: boolean;
  count: number;
  /**
   * Rows matching the query's FULL predicate, not just this page — `count` is
   * the page size and always has been. OPTIONAL, and absent unless the service
   * opted in: keyset pagination does not compute a total, so a list that has
   * not paid for one must say nothing rather than imply zero.
   *
   * Read it together with `total_capped` or not at all.
   */
  total?: number;
  /**
   * `true` means `total` is a FLOOR, not an equality: the count stopped at its
   * cap and the real figure is `total` or more. The UI must render "10,000+".
   * Dropping the "+" turns a bounded truth into a wrong exact number.
   */
  total_capped?: boolean;
}

export interface ApiSuccessList<T> {
  ok: true;
  data: T[];
  page: ApiPage;
  meta: ApiMeta;
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
  meta: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiSuccessList<T> | ApiError;

/**
 * Marker symbol attached to a list payload by services so the response
 * interceptor knows to emit `page` instead of wrapping into `data` as scalar.
 */
export const PAGINATED = Symbol.for("@replay/paginated");

export interface PaginatedTotal {
  /** Matching rows, exact below the cap; the cap itself when `capped`. */
  value: number;
  /** `value` is a floor — the count stopped at its cap. Renders as "N+". */
  capped: boolean;
}

export interface PaginatedPayload<T> {
  [PAGINATED]: true;
  items: T[];
  nextCursor: string | null;
  /** Absent unless the service computed one — see ApiPage.total. */
  total?: PaginatedTotal;
}

/**
 * `total` is a THIRD, OPTIONAL argument on purpose: every existing caller keeps
 * the exact envelope it emits today (no `total` key, no behaviour change), and
 * only a list that has actually counted opts in. Omitting it is not "unknown
 * total" — it is "this list makes no claim about a total".
 */
export function paginated<T>(
  items: T[],
  nextCursor: string | null,
  total?: PaginatedTotal,
): PaginatedPayload<T> {
  return { [PAGINATED]: true, items, nextCursor, ...(total ? { total } : {}) };
}

export function isPaginatedPayload<T>(
  value: unknown,
): value is PaginatedPayload<T> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[PAGINATED] === true,
  );
}
