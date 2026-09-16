import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Cache } from "cache-manager";
import { createHash, randomBytes } from "crypto";
import {
  getPostgresClient,
  type SessionStatus,
  type Prisma,
} from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import {
  listLogs,
  suggestSessionDimensions,
  searchSessionIds,
  SUGGEST_DIMENSIONS,
  type ProjectionRow,
} from "@replay/db-clickhouse";
import {
  decodeCursor,
  decodeCompositeCursor,
  paginateRows,
  paginateComposite,
  parseLimit,
} from "../common/cursor";
import {
  resolveIncidentSessionIds,
  resolveIssueSessionIds,
  resolveFunnelStepSessionIds,
} from "../common/incident-scope";
import { SessionReaperService } from "../billing/session-reaper.service";
import { paginated, type PaginatedTotal } from "../common/api-response";
import { PresenceService } from "../presence/presence.service";
import { NotificationsService } from "../notifications/notifications.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";

type SharePanels = {
  events: boolean;
  console: boolean;
  network: boolean;
  perf: boolean;
  comments: boolean;
  // Mobile-only panels. Ignored by the web share page; surfaced by the
  // mobile share page so a shared native session mirrors its dashboard tabs.
  crashes: boolean;
  screens: boolean;
};

const DEFAULT_PANELS: SharePanels = {
  events: true,
  console: true,
  network: true,
  perf: true,
  comments: false,
  crashes: true,
  screens: true,
};

/**
 * Rows per group in the search autocomplete. Bounds EVERY group of the response
 * — the dropdown renders a handful under each header, and this is what keeps a
 * keystroke from returning thousands of rows.
 */
const SUGGEST_PER_GROUP = 6;

/**
 * pg_trgm indexes trigrams and cannot extract one from 1–2 characters, so an
 * ILIKE shorter than this cannot use EndUser's gin_trgm_ops indexes. See the
 * @@index comments on EndUser in schema.prisma.
 */
const SUGGEST_TRGM_MIN_CHARS = 3;

/**
 * The dimensions /v1/sessions/facets is AUTHORITATIVE for — the bounded half of
 * the autocomplete, split from the unbounded half by CARDINALITY alone.
 *
 * Two independent conditions, and a type needs BOTH:
 *
 *  1. The value set is small and slow-moving, so the COMPLETE set can be shipped
 *     once and filtered client-side. `user` (EndUser → millions) and `page` (an
 *     effectively infinite path space) fail this and stay on the typeahead.
 *  2. GET /v1/sessions has a query param that can actually APPLY it. This is the
 *     reason os / city / release / plan / platform are absent even though the
 *     ClickHouse helper answers all five for free: the list has no param for
 *     them, so offering one would hand the user a chip that returns UNFILTERED
 *     results wearing a filter label — the same lie as inventing the value.
 *     Cheap to compute is not a reason to offer. Mirrors SUGGEST_META in the
 *     dashboard's recordings/search/suggest.ts.
 *
 * This list is the SINGLE owner of the split: the dashboard intersects it with
 * SUGGEST_META and routes locally ONLY what appears here — so a type dropped
 * from here falls back to the server typeahead with no frontend release.
 * Widening it requires a matching filter param on `list` above, first.
 */
const FACET_TYPES = ["browser", "device", "deviceModel", "country"] as const;

/**
 * Complete-set size per facet type. Deliberately the helper's own ceiling
 * (SUGGEST_MAX_PER_TYPE, raised 20→500 for this caller): a bounded list is
 * filtered client-side, so a truncated one is not "fewer suggestions" — it is a
 * value the user can no longer filter by AT ALL. The real sets sit far below it
 * (country ≤ the ISO ~250; browser/device a handful each), so this asks for
 * everything and the clamp never bites. `LIMIT n BY type` runs after the GROUP
 * BY, so the larger n reads no more data.
 */
const FACET_PER_TYPE = 500;

/**
 * How long a NON-EMPTY facet set is served from Redis.
 *
 * Staleness here is the real risk, not latency: a cached browser list missing a
 * workspace's first-ever Firefox session silently hides those sessions from the
 * filter, and unlike a fixture a stale cache LOOKS right. So the defence is a
 * bound on how long that can last, not an argument that it cannot happen.
 *
 * 5 minutes, because:
 *  · The blast radius is the filter VOCABULARY, never filter RESULTS. GET
 *    /v1/sessions is uncached, so an applied `browser=Firefox` always returns
 *    the true set. The worst case is a just-appeared value not being OFFERED for
 *    ≤5 min — never a wrong count, never a hidden session on an applied filter.
 *  · The read underneath is ALREADY a ~30-day trailing window, so this list is
 *    "values seen recently" by construction. A browser that stopped appearing 31
 *    days ago is dropped by the query, not by this TTL — the cache is a far
 *    finer-grained approximation than the read it caches, which is what makes a
 *    TTL in minutes meaningful rather than theatre.
 *  · It still collapses the traffic this endpoint exists to remove: Recordings
 *    preloads once per mount, so 5 min covers a whole working session of
 *    navigating in and out of the route for one query per workspace.
 * Not the api-keys cache's 1 hour: an hour of a missing first-Firefox is exactly
 * the silent hiding above, and this read is far too cheap to buy an hour of it.
 */
const FACET_TTL_SECONDS = 5 * 60;

/**
 * TTL for an EMPTY facet set — much shorter, because caching "nothing" is the
 * worst case this endpoint has.
 *
 * An empty set is not neutral on the wire: `types` still declares these
 * dimensions bounded, and the dashboard deliberately keeps a declared-but-empty
 * type LOCAL rather than falling back (a workspace with no sessions genuinely
 * has no values, and the typeahead — same table, same window — would return the
 * same nothing). So an empty answer means the dropdown shows no browsers and
 * does NOT ask the server again for the whole TTL. That is precisely the state a
 * brand-new workspace is in mid-onboarding, when the first session landing is
 * the thing the user is watching for. 30s keeps that fill-in feeling immediate,
 * and an empty workspace's read is the cheapest one there is — nothing to prune.
 */
const FACET_EMPTY_TTL_SECONDS = 30;

/**
 * Ceiling on the cache-MISS read. Recordings preloads facets on mount, so a cold
 * cache on a huge workspace must not be able to hold the page.
 *
 * Bounding it is safe ONLY because of the degrade path: `types: []` is the
 * wire's own way of saying "authoritative for nothing", which sends every type
 * back to the debounced typeahead — the exact behaviour that shipped before
 * facets existed. Degraded, never wrong: the fallback answers from the same
 * table, so a timeout costs a request per keystroke, never a hidden value.
 */
const FACET_TIMEOUT_MS = 3_000;

/** The facets wire shape. `items` rows are deliberately the same shape suggest
 *  returns — the dashboard feeds both through one normalizer. */
type SessionFacets = { types: string[]; items: SessionSuggestion[] };

/**
 * One autocomplete row. The server assigns `type` — the dashboard groups by it
 * and never infers a row's kind from its text. `id`/`sub` are user-only;
 * `count` (the frequency ranking) is session-dimension-only.
 */
type SessionSuggestion = {
  type: string;
  value: string;
  count?: number;
  id?: number;
  sub?: string;
};

/** The ONLY EndUser columns a recordings row renders (see SUMMARY_SELECT). */
const SUMMARY_END_USER = {
  select: {
    id: true,
    distinctId: true,
    email: true,
    name: true,
    initials: true,
    // Avatar URL for the player-header identity chip (identify() `picture`). A
    // discrete column, so it rides this narrow select — the customProps blob is
    // deliberately NOT joined here (size + share-link boundary).
    picture: true,
    plan: true,
    flag: true,
    city: true,
    country: true,
    browser: true,
    os: true,
    device: true,
    timezone: true,
    isOnline: true,
  },
} as const;

/**
 * The end user, as served to WHOEVER HOLDS A SHARE LINK. Unauthenticated, and
 * the link travels — it gets pasted into Slack, forwarded, and opened by people
 * who have no account here. So this select is an authorization boundary, not an
 * optimization, and the omissions are the point:
 *
 *   · email        — the customer's end user's address.
 *   · distinctId   — often IS the address: when identify() passes an email and
 *                    no id, ingest uses the email AS the distinctId
 *                    (replay-persistence.service.ts).
 *   · customProps  — arbitrary identify() traits. Whatever the customer chose to
 *                    send: phone, plan, internal account ids. Never renderable
 *                    on a share anyway — SharePanels has no properties panel.
 *   · ip           — geo already arrives resolved as flag/city/country.
 *   · id, timezone, isOnline, state, viewport, firstSeenAt, lastSeenAt — unread
 *                    by the share page.
 *
 * `include: { endUser: true }` used to serve this route, dragging all 23 columns
 * (and TOASTing the customProps jsonb on every anonymous view) to render nine.
 * Not fetching is what makes the leak impossible: a field that never enters
 * process memory can't be emitted by a future serializer, and can't surface in
 * a log line or an error dump. Selecting-then-stripping only holds while
 * everybody remembers to strip.
 *
 * Reading anything absent here is a compile error, not a silent undefined —
 * same contract as SUMMARY_SELECT above.
 */
const SHARE_END_USER = {
  select: {
    // `id` is an internal autoincrement, useless without a session; kept so the
    // share payload still satisfies the client's endUser contract.
    id: true,
    name: true,
    initials: true,
    plan: true,
    flag: true,
    city: true,
    country: true,
    browser: true,
    os: true,
    device: true,
    // Last-resort location fallback for sessions recorded before the per-session
    // columns existed; the session's own timezone is preferred over it.
    timezone: true,
  },
} as const;


/**
 * Exactly what a recordings row renders — nothing else leaves the database.
 *
 * The list used to fetch the whole Session row plus `include: { endUser: true }`,
 * i.e. ~60 Session columns and all 23 EndUser columns for EVERY row of EVERY
 * page, to render ~35 of them. The waste wasn't just column count: it dragged
 * BOTH `customProps` blobs across (Session's and EndUser's), and Postgres TOASTs
 * a large jsonb — storing it out-of-line and fetching it from a side table on
 * every single read — plus BigInt counters (dataSizeBytes, peakHeapBytes),
 * `eventNames`, and every web/native perf metric, none of which a row shows.
 *
 * Keep this list in sync with toSummary: it is typed off this select, so
 * reading a field that isn't here is a compile error rather than a silent
 * undefined. The single-session detail deliberately keeps the wide include — it
 * genuinely reads customProps and one row can afford it — and its wider payload
 * still satisfies this narrower shape structurally, so both share toSummary.
 */
const SUMMARY_SELECT = {
  id: true,
  publicId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  pageCount: true,
  clickCount: true,
  rageCount: true,
  deadCount: true,
  errorCount: true,
  consoleCount: true,
  consoleErrorCount: true,
  networkCount: true,
  tapCount: true,
  hasFullSnapshot: true,
  replayPrunedAt: true,
  frameCount: true,
  commentCount: true,
  startUrl: true,
  entryReferrer: true,
  platform: true,
  sdkName: true,
  sdkVersion: true,
  appVersion: true,
  appBuild: true,
  bookmarked: true,
  viewed: true,
  userAgent: true,
  viewport: true,
  // The session's own device + geo (see the Session model) — these are why the
  // row no longer has to read them off the shared, last-write-wins user row.
  browser: true,
  os: true,
  osVersion: true,
  device: true,
  deviceModel: true,
  city: true,
  country: true,
  flag: true,
  timezone: true,
  endUser: SUMMARY_END_USER,
} as const;

/** The session as served to a share link: the summary shape, a de-identified
 *  user, and the panels' own data. `customProps` is deliberately absent — see
 *  SHARE_END_USER. */
const SHARE_SELECT = {
  ...SUMMARY_SELECT,
  endUser: SHARE_END_USER,
  paths: { select: { sequence: true, url: true } },
  segments: {
    select: {
      sequence: true,
      eventCount: true,
      startedAt: true,
      endedAt: true,
      mongoBatchId: true,
    },
  },
} as const;

export interface ListSessionsParams {
  workspaceId: number;
  cursor?: string;
  limit?: string;
  search?: string;
  status?: SessionStatus;
  // Each of device / plan / browser / country can be comma-separated to
  // request an IN (...) match (matches the chip multi-select).
  device?: string;
  deviceModel?: string;
  platform?: string;
  plan?: string;
  browser?: string;
  country?: string;
  hasErrors?: string;
  hasRage?: string;
  hasDead?: string;
  /** Sessions whose worst LCP exceeds the web.dev "poor" cutoff (2.5s). */
  hasSlowLcp?: string;
  /** Sessions with at least one long-task ≥ 50ms. */
  hasLongTasks?: string;
  minDurationMs?: string;
  /** Scope the result set to sessions in a single playlist. Used when
   *  the user clicks a playlist card on the Playlists page. */
  playlistId?: string;
  /** Date range — sessions started at or after sinceMs (epoch ms),
   *  optionally before untilMs. Drives the Recordings date picker. */
  sinceMs?: string;
  untilMs?: string;
  quick?: "issues" | "live" | "bookmarked";
  sort?: "recent" | "duration" | "errors";
  endUserId?: string;
  /** CSV of internal Session.id values (== ClickHouse session_id, see
   *  ch-session-row.ts) — scopes the list to an explicit set, e.g. the sessions
   *  that reached a funnel step. */
  sessionIds?: string;
  /** Incident id — scopes the list to the sessions currently attributed to that
   *  incident ("View sessions" on an Overview signal). A NAMED scope rather than
   *  a CSV because an incident's session set is unbounded and will not fit in a
   *  URL; it is resolved to ids server-side in `list`. */
  incident?: string;
  /** Issue-backed scope — the crash/error twin of `incident`. */
  issue?: string;
  /** Funnel-step drill-down: saved funnel id + 0-based step index, plus the
   *  analysed date range (ms). Resolved server-side to ids like `incident`. */
  funnel?: string;
  fstep?: string;
  ffrom?: string;
  fto?: string;
}

/**
 * `ListSessionsParams` after the async work `buildListWhere` cannot do itself.
 * Internal to this service — the controller never constructs one.
 */
type ResolvedListParams = ListSessionsParams & {
  /**
   * Session ids the `incident` scope resolved to. Present (possibly EMPTY)
   * whenever `incident` was supplied, absent when it was not — the difference
   * between "this scope matched nothing" and "there is no scope", which
   * `buildListWhere` depends on.
   */
  incidentSessionIds?: number[];
  /**
   * Session ids ClickHouse matched for the free-text `search` term. Present
   * (possibly EMPTY) whenever a non-blank `search` was supplied, absent
   * otherwise — the same "matched nothing" vs "no search" distinction
   * `buildListWhere` relies on for the incident scope.
   */
  searchSessionIds?: number[];
};

@Injectable()
export class SessionsService {
  private readonly db = getPostgresClient();
  private readonly mongo = getMongoClient();

  /**
   * In-flight facet reads, keyed by workspace — single-flight, NOT a cache (the
   * entry is deleted the moment it settles; Redis below is the cache).
   *
   * Recordings preloads facets on mount, so a cold cache plus a few colleagues
   * opening the route at once is N identical ClickHouse reads racing to write
   * the same key. This collapses them to one per workspace per API instance. It
   * is bounded by concurrency, not by workspace count, and cannot leak: the
   * `finally` removes the entry on both the resolve and the reject path.
   */
  private readonly facetsInFlight = new Map<number, Promise<SessionFacets>>();

  constructor(
    private readonly presence: PresenceService,
    private readonly notifications: NotificationsService,
    private readonly stats: WorkspaceStatsService,
    private readonly reaper: SessionReaperService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /**
   * Rows the header count will scan before it stops and answers "N+".
   *
   * The cap is the ONLY thing standing between this and a filtered COUNT(*) over
   * a workspace's whole Session table on every filter change — there is no index
   * that makes a filtered count O(1), so the answer is to bound the work, not to
   * optimise it away.
   *
   * 10,000 rather than 1,000 because a cap below the real distribution degrades
   * to a constant: the fixture literal this replaces was 1,284, so a 1k cap would
   * render "1,000+" for that very workspace and the fix would read as a
   * downgrade. At 10k the dense case is a ~10k-entry index scan (single-digit ms,
   * flat whether the workspace holds 10k or 10M) and the overwhelming majority of
   * workspace/filter pairs still get an EXACT number.
   */
  private static readonly LIST_COUNT_CAP = 10_000;

  /** How long a filtered count is served from Redis. Short: the count sits next
   *  to a live list, and a filter re-applied within the window must not show a
   *  number the rows beneath it have already outgrown. Long enough that
   *  re-filtering, back-navigation and N open tabs collapse to one read. */
  private static readonly LIST_COUNT_TTL_SECONDS = 20;

  /** How long a funnel-step drill-down's resolved session-id set is served from
   *  Redis. The funnel deep-link fixes (funnel, step, from, to) for the whole
   *  infinite-scroll, so every page after the first would otherwise re-run the
   *  full ClickHouse windowFunnel to rebuild an identical id set. 2 min: long
   *  enough that paging + back-navigation reuse one CH pass, short enough that a
   *  step's membership can't read stale for long. */
  private static readonly FUNNEL_SCOPE_TTL_SECONDS = 120;

  /** Free-text search scope caps (mirrors the funnel/incident scopes). CH returns
   *  the NEWEST matching ids up to this bound; a term matching more keeps the most
   *  recent — a 10k `id IN (…)` is still a trivial Postgres probe. Cached briefly
   *  in Redis so page 2..N of the infinite scroll don't re-run the CH scan. */
  private static readonly SEARCH_SCOPE_CAP = 10_000;
  private static readonly SEARCH_SCOPE_TTL_SECONDS = 60;

  async list(params: ListSessionsParams) {
    const take = parseLimit(params.limit, 25, 100);
    const cursor = decodeCompositeCursor(params.cursor);
    /* The ONE async step the predicate needs: incident → its attributed session
       ids. It happens here, not inside buildListWhere, because that builder is
       synchronous by design and is the single predicate the page read and the
       header count both consume — making it async would mean either resolving
       twice (two answers, one banner) or splitting the predicate in two, which
       is the drift its docblock exists to prevent. Resolved once, then handed to
       both readers as data.

       A present-but-unparseable id (?incident=abc) resolves to the EMPTY set,
       not to "no scope": returning the whole workspace under a banner that names
       an incident is the one outcome worse than an empty list.

       This runs on EVERY page, not just the first, and that is deliberate: the
       ids ARE the predicate, so a later page cannot be built without them. It is
       one extra index-only probe per scroll — bounded by the incident's own
       signal count and by INCIDENT_SCOPE_CAP, never by workspace size — and it
       is the reason the resolve must stay index-only rather than merely fast on
       the first page. Caching it would trade that flat cost for a scope that can
       disagree with the count rendered above it; not worth it at this bound. */
    const resolved: ResolvedListParams = { ...params };
    if (params.incident !== undefined && params.incident !== "") {
      const scope = await resolveIncidentSessionIds(
        this.db,
        params.workspaceId,
        Number(params.incident),
      );
      resolved.incidentSessionIds = scope.ids;
    } else if (params.issue !== undefined && params.issue !== "") {
      // Same shape, issue-backed. Mutually exclusive with `incident`: two id
      // scopes would have to intersect, and no caller asks for that.
      const scope = await resolveIssueSessionIds(
        this.db,
        params.workspaceId,
        Number(params.issue),
      );
      resolved.incidentSessionIds = scope.ids;
    } else if (
      params.funnel !== undefined &&
      params.funnel !== "" &&
      params.fstep !== undefined
    ) {
      // Funnel-step drill-down — resolved to a bounded, newest-first id set via
      // one ClickHouse windowFunnel pass, then keyset-paged by the list exactly
      // like the incident/issue scopes. Same `incidentSessionIds` channel, so it
      // inherits the paging + the "AND-composed cursor" fix for free.
      //
      // CACHED (Redis): the funnel deep-link fixes (funnel, step, from, to) for
      // the whole recordings infinite-scroll, so page 2..N were re-running the
      // ENTIRE windowFunnel just to rebuild an identical id set — the reported
      // slowness. Cache the resolved id set keyed by (ws, funnel, step, from, to)
      // so only the first page pays the CH pass and the rest read a ~KB list.
      // Access pattern: point get/set on ONE exact key (never a scan), TTL-bounded.
      // Only cache when the deep-link carries a REAL custom window — the SAME
      // gate resolveFunnelStepSessionIds uses (fromTs && toTs && toTs > fromTs).
      // A degenerate range (ft <= ff, 0, NaN from a hand-edited URL) makes the
      // resolver silently fall back to a now()-anchored set, which must NOT be
      // frozen under a fixed key. `!== undefined` alone let those through.
      const ff = params.ffrom ? Number(params.ffrom) : undefined;
      const ft = params.fto ? Number(params.fto) : undefined;
      const cacheable =
        ff !== undefined &&
        ft !== undefined &&
        Number.isFinite(ff) &&
        Number.isFinite(ft) &&
        ff > 0 &&
        ft > ff;
      const scopeKey = cacheable
        ? `fnscope:${params.workspaceId}:${params.funnel}:${params.fstep}:${ff}:${ft}`
        : "";
      // A miss returns null (Redis store) OR undefined (memory store), so treat
      // any NON-array as a miss — never `=== undefined`, which let a Redis null
      // through as the id set and produced `where.id IN (null)`. A cached EMPTY
      // [] is a real answer ("step matched no sessions") and is served as-is.
      let scopeIds = scopeKey
        ? await this.cache.get<number[]>(scopeKey).catch(() => undefined)
        : undefined;
      if (!Array.isArray(scopeIds)) {
        const scope = await resolveFunnelStepSessionIds(
          this.db,
          params.workspaceId,
          Number(params.funnel),
          Number(params.fstep),
          { fromTs: ff, toTs: ft },
        );
        scopeIds = scope.ids;
        if (scopeKey)
          await this.cache
            .set(scopeKey, scopeIds, {
              ttl: SessionsService.FUNNEL_SCOPE_TTL_SECONDS,
            })
            .catch(() => {});
      }
      resolved.incidentSessionIds = scopeIds;
    }

    // Free-text search → a bounded, recency-ranked id set from ClickHouse (see
    // db-clickhouse searchSessionIds). Routed to CH, NOT a Postgres startUrl
    // ILIKE, because Session is the hottest table and a substring scan there
    // walks the workspace for a rare term (no GIN there by design). Resolved on
    // EVERY page like the incident/funnel scope, so cache it briefly — a point
    // get/set on ONE key (never a scan), TTL-bounded — so the infinite scroll's
    // page 2..N reuse one CH scan. A non-array cache read is a MISS (Redis null
    // vs memory undefined); a cached empty [] is a real "term matched nothing".
    const searchTerm = (params.search ?? "").trim();
    if (searchTerm) {
      const searchKey = `srchscope:${params.workspaceId}:${searchTerm}`;
      let searchIds = await this.cache
        .get<number[]>(searchKey)
        .catch(() => undefined);
      if (!Array.isArray(searchIds)) {
        searchIds = await searchSessionIds({
          workspaceId: params.workspaceId,
          term: searchTerm,
          limit: SessionsService.SEARCH_SCOPE_CAP,
        });
        await this.cache
          .set(searchKey, searchIds, {
            ttl: SessionsService.SEARCH_SCOPE_TTL_SECONDS,
          })
          .catch(() => {});
      }
      resolved.searchSessionIds = searchIds;
    }
    const where = this.buildListWhere(resolved);

    // Order by the ACTIVE sort column, tie-broken by id, and keyset-page on the
    // SAME (column, id) pair. The default is startedAt DESC — genuinely
    // most-recent-first. It used to be id DESC, which only reads as "most recent"
    // while ingestion keeps id monotonic with startedAt; a backfill/import/seed
    // decorrelates them and the list then shows older-above-newer + strands rows.
    const orderBy: Prisma.SessionOrderByWithRelationInput[] =
      params.sort === "duration"
        ? [{ durationMs: "desc" }, { id: "desc" }]
        : params.sort === "errors"
          ? [{ errorCount: "desc" }, { id: "desc" }]
          : [{ startedAt: "desc" }, { id: "desc" }];
    // The cursor seed for the active sort (epoch-ms for the startedAt default).
    const sortValueOf = (r: {
      startedAt: Date;
      durationMs: number | null;
      errorCount: number;
    }): number =>
      params.sort === "duration"
        ? (r.durationMs ?? 0)
        : params.sort === "errors"
          ? r.errorCount
          : r.startedAt.getTime();
    // Keyset predicate: "the next page after (v, id)" under DESC ordering is
    // `col < v OR (col = v AND id < id)`. Rides @@index([workspaceId, <col> Desc]).
    let keyset: Prisma.SessionWhereInput | undefined;
    if (cursor) {
      const v = Number(cursor.sortValue);
      if (params.sort === "duration") {
        keyset = {
          OR: [{ durationMs: { lt: v } }, { durationMs: v, id: { lt: cursor.id } }],
        };
      } else if (params.sort === "errors") {
        keyset = {
          OR: [{ errorCount: { lt: v } }, { errorCount: v, id: { lt: cursor.id } }],
        };
      } else {
        const d = new Date(v);
        keyset = {
          OR: [{ startedAt: { lt: d } }, { startedAt: d, id: { lt: cursor.id } }],
        };
      }
    }

    // FIRST PAGE ONLY. The total does not change as you page, so the client
    // holds the one it got and paging stays exactly as cheap as it is today —
    // scrolling the rail adds zero count cost. Concurrent with the page read, so
    // it only adds latency if it is slower than the list, which in the dense
    // case it is not.
    const [rows, total] = await Promise.all([
      this.db.session.findMany({
        /* AND-composed, NOT `{ ...where, id: { lt: cursorId } }`.
           The spread this replaces assigned `id` a second time, so it silently
           DELETED any id scope the predicate carried — `where.id = { in: ids }`
           from an explicit id set. The first page was correctly scoped and every
           page after it was the unfiltered workspace, which read as "the funnel
           step has thousands of sessions" rather than as a bug. That was already
           live for the funnel drill-down (?sessionIds=); the incident scope
           routes through the same `where.id`, so it inherits the fix rather than
           working around it.

           Keyset paging rides the sort column's index (default:
           `@@index([workspaceId, startedAt Desc])`): the `(col, id) < cursor`
           predicate is a range-restricted index scan AND-ed with any explicit
           `id IN (…)` scope, not a filter applied after the fact. */
        where: keyset ? { AND: [where, keyset] } : where,
        orderBy,
        select: SUMMARY_SELECT,
        take: take + 1,
      }),
      cursor === undefined
        ? this.countList(resolved, where)
        : Promise.resolve(undefined),
    ]);
    const { items, nextCursor } = paginateComposite(
      rows,
      take,
      sortValueOf,
      (r) => r.id,
    );
    // Snapshot live presence once for the whole page (one Redis round-trip)
    // rather than per row. Redis-backed so the live-dot is correct across
    // ingest nodes — a session is "live" if it sent a batch within the window.
    const livePublicIds = await this.presence.liveSessionIds(
      params.workspaceId,
      Date.now(),
    );
    return paginated(
      items.map((s) => this.toSummary(s, livePublicIds)),
      nextCursor,
      total,
    );
  }

  /**
   * The Recordings list predicate — the SINGLE definition of "a row this list
   * shows", built once and consumed by both `list` (page of rows) and
   * `countList` (how many rows). A private method rather than a free function
   * per the no-free-functions rule in *.service.ts.
   *
   * This being one builder is a CORRECTNESS property, not tidiness: a count and
   * a list from two hand-maintained predicates disagree the first time one is
   * edited, and a header that contradicts the rows under it is the exact bug
   * this change exists to fix. Everything except the keyset cursor lives here —
   * the cursor is per-page and must NOT narrow the total.
   */
  private buildListWhere(params: ResolvedListParams): Prisma.SessionWhereInput {
    const where: Prisma.SessionWhereInput = {
      workspaceId: params.workspaceId,
      // LEGACY rows only. Sub-minimum-duration anonymous sessions used to be
      // flagged and hidden; the settle sweep now DELETES them outright
      // (retention.service.ts → billing.settleSweep), so this predicate only
      // still excludes rows flagged before that switch. Kept because those rows
      // exist and must stay hidden — but it is no longer the reason a session is
      // missing from this list, which matters for the `?incident=` scope: an
      // incident resolves to zero sessions because they were DELETED (Signal
      // cascades on Session), not because they were filtered out here.
      excludedShort: false,
    };

    if (params.status) where.status = params.status;
    if (params.quick === "live") where.status = "LIVE";
    if (params.quick === "bookmarked") where.bookmarked = true;
    if (params.quick === "issues")
      where.OR = [
        { errorCount: { gt: 0 } },
        { rageCount: { gt: 0 } },
        { deadCount: { gt: 0 } },
      ];
    if (params.endUserId) where.endUserId = Number(params.endUserId);
    /* Explicit id scopes — the funnel-step drill-down (?sessionIds= CSV) and the
       incident scope (?incident=, resolved to ids in `list`). Session.id === CH
       session_id, so both filter the list directly as an indexed PK lookup, and
       both are bounded id sets (the funnel's sample; INCIDENT_SCOPE_CAP).

       INTERSECTED, never overwritten: if a URL carries both, each must NARROW
       the list. Assigning `where.id` twice would silently let the second scope
       widen the list back to its own set and quietly discard the first.

       An EMPTY set is a REAL answer — "this scope currently matches no sessions"
       — not "no scope". The previous `if (ids.length)` guard dropped the filter
       entirely on an empty set, which returned the ENTIRE WORKSPACE under a
       banner claiming the rows belonged to one funnel step. For incidents that
       path is not an edge case but the routine one (signal attribution only
       covers the current window, so an older incident legitimately resolves to
       zero sessions), and "every session you have" is the worst possible answer
       to "show me this incident's sessions". */
    const idScopes: number[][] = [];
    // Truthiness, not `!== undefined`, for the CSV: `?sessionIds=` (empty) has
    // always meant "no scope" and funnel links never emit it. An all-garbage CSV
    // still parses to [] and now correctly matches nothing.
    if (params.sessionIds) idScopes.push(this.parseIdCsv(params.sessionIds));
    if (params.incidentSessionIds !== undefined)
      idScopes.push(params.incidentSessionIds);
    if (idScopes.length) {
      const [first, ...rest] = idScopes;
      // Set membership rather than Array.includes: the incident set runs to
      // INCIDENT_SCOPE_CAP, and a nested includes would be O(n·m) over it.
      const ids = rest.reduce((acc, next) => {
        const keep = new Set(next);
        return acc.filter((x) => keep.has(x));
      }, first);
      where.id = { in: ids };
    }
    // Values may be comma-separated (multi-select chips) — `in` handles both
    // cases. Match case-insensitively so "Chrome" matches whatever the UA
    // parser produced.
    const splitCSV = (v?: string) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const devices = splitCSV(params.device);
    const deviceModels = splitCSV(params.deviceModel);
    const platforms = splitCSV(params.platform);
    const plans = splitCSV(params.plan);
    const browsers = splitCSV(params.browser);
    const countries = splitCSV(params.country);
    // device/browser now filter the SESSION's own columns. They used to filter
    // EndUser's, which is last-write-wins across every device the person uses —
    // so "device=Mobile" returned a user's DESKTOP sessions whenever their most
    // recent batch happened to be mobile.
    //
    // Sessions ingested before those columns existed hold NULL, so each clause
    // falls back to the EndUser value for exactly those rows — matching what
    // toSummary renders for them. Without the fallback a historical row would
    // display "Desktop" and then vanish from a device=Desktop filter. Once
    // `backfill:session-devices` has run, no row is NULL and the fallback stops
    // firing. Merged into where.AND (not where.OR) because OR is already taken
    // by the search + funnel-step clauses above.
    //
    // Access pattern: this list is always workspace-scoped and keyset-ordered,
    // so it rides @@index([workspaceId, id desc]) — a range scan bounded to one
    // workspace that stops after a page — and device/browser apply as residual
    // filters during that scan, exactly like excludedShort and the playable
    // predicate below. A dedicated [workspaceId, device] btree would NOT be used
    // (`mode: insensitive` compiles to ILIKE) and would only cost writes on the
    // hottest table. Now that the vocabulary is canonical (common/device-facts
    // emits Desktop/Mobile/Tablet, Chrome/Safari/…), dropping `insensitive` and
    // indexing is a viable follow-up if these filters ever get selective enough
    // to need it.
    const sessionOrUser = (
      col: "device" | "browser" | "country",
      values: string[],
    ): Prisma.SessionWhereInput => ({
      OR: [
        { [col]: { in: values, mode: "insensitive" as const } },
        {
          [col]: null,
          endUser: { [col]: { in: values, mode: "insensitive" as const } },
        },
      ],
    });
    const envClauses: Prisma.SessionWhereInput[] = [];
    if (devices.length) envClauses.push(sessionOrUser("device", devices));
    // deviceModel is the raw hardware model (iPhone 17, Pixel 8) — a per-session
    // column with no EndUser fallback (EndUser holds one last-write-wins device),
    // so it filters the Session's own column directly. Populated for mobile only;
    // web sessions store NULL and never match a model filter (by design).
    if (deviceModels.length)
      envClauses.push({ deviceModel: { in: deviceModels, mode: "insensitive" } });
    // platform (web/ios/android) is the Session's own column — no EndUser copy.
    // Powers the Segments band deep-link ("web" → all web sessions).
    if (platforms.length)
      envClauses.push({ platform: { in: platforms, mode: "insensitive" } });
    // browser filters the SESSION's own column with NO EndUser fallback. The
    // fallback matched a session's NULL browser against the EndUser's
    // last-write-wins browser — but the only sessions with a NULL browser are
    // NATIVE MOBILE sessions (an app has no browser), so it made e.g.
    // "browser=Edge" return every mobile session of anyone who once used web
    // Edge (3,264 vs the true 26 on the demo workspace). Session.browser is the
    // correct per-session value in production (derived from the UA at ingest,
    // webDeviceFacts), so matching it directly agrees with the ClickHouse facet
    // source; a native session with no browser correctly matches no browser.
    if (browsers.length)
      envClauses.push({ browser: { in: browsers, mode: "insensitive" } });
    // country is per-session for the same reason: someone who travels had every
    // past session re-labelled with their newest location.
    if (countries.length) envClauses.push(sessionOrUser("country", countries));
    if (envClauses.length) {
      where.AND = where.AND
        ? [
            ...(Array.isArray(where.AND) ? where.AND : [where.AND]),
            ...envClauses,
          ]
        : envClauses;
    }
    // plan stays user-level — it IS a property of the person, not the session.
    if (plans.length) {
      where.endUser = { plan: { in: plans, mode: "insensitive" as const } };
    }
    // Session-side toggles. AND-combined; treat any string presence as "on".
    if (params.hasErrors === "1" || params.hasErrors === "true")
      where.errorCount = { gt: 0 };
    if (params.hasRage === "1" || params.hasRage === "true")
      where.rageCount = { gt: 0 };
    if (params.hasDead === "1" || params.hasDead === "true")
      where.deadCount = { gt: 0 };
    // Perf chips — driven by the denormalised aggregates written during
    // ingest, so this stays index-friendly (workspaceId + worstLcp is
    // a composite index on Session).
    if (params.hasSlowLcp === "1" || params.hasSlowLcp === "true")
      where.worstLcp = { gt: 2500 };
    if (params.hasLongTasks === "1" || params.hasLongTasks === "true")
      where.longTaskCount = { gt: 0 };
    if (params.minDurationMs) {
      const ms = Number(params.minDurationMs);
      if (Number.isFinite(ms) && ms > 0) where.durationMs = { gte: ms };
    }
    // Playlist scope — narrows to sessions that are members of this
    // playlist. Filters via the relation rather than a join+distinct so
    // cursor pagination keeps working.
    if (params.playlistId) {
      const pid = Number(params.playlistId);
      if (Number.isFinite(pid))
        where.playlistMemberships = { some: { playlistId: pid } };
    }
    // Date range — sessions whose `startedAt` falls inside the window
    // the user picked from the Recordings date dropdown. Open-ended
    // when `untilMs` isn't provided (rolling presets like "last 7 days"
    // don't have an upper bound).
    if (params.sinceMs || params.untilMs) {
      const since = params.sinceMs
        ? new Date(Number(params.sinceMs))
        : undefined;
      const until = params.untilMs
        ? new Date(Number(params.untilMs))
        : undefined;
      where.startedAt = {
        ...(since && !Number.isNaN(since.getTime()) ? { gte: since } : {}),
        ...(until && !Number.isNaN(until.getTime()) ? { lte: until } : {}),
      };
    }
    if (params.search) {
      // Free-text search — a UNION of three fully index-backed branches, so it
      // scales to millions of sessions per workspace with NO trigram GIN on the
      // hot Session table (a write cost the schema deliberately avoids):
      //   · publicId — EXACT match on the `@unique` btree. A `ses_…` id is an
      //     opaque random string; the real use case is pasting a full id to jump
      //     to that recording, not matching a substring of it.
      //   · session text (URL / browser / os / device / city / identify id) —
      //     resolved to a bounded, newest-first id set in ClickHouse (see the
      //     `searchSessionIds` resolve in list()), applied here as an indexed
      //     `Session.id IN (…)` (Session.id == CH session_id). A rare / no-match
      //     term is a CH columnar probe → a small/empty id list → an INSTANT
      //     empty page, never a Postgres workspace walk. `?? []` matters: search
      //     ran (searchSessionIds is defined) so an unmatched term must contribute
      //     NOTHING, not fall through to a table scan.
      //   · endUser email/name — CH has no email/name column, so this stays on
      //     the EndUser email/name trgm GINs (outer IN rides Session(workspaceId,
      //     endUserId)). Gated at ≥3 chars: pg_trgm can't serve 1–2-char terms, so
      //     below that this branch would seq-scan EndUser — skip it there.
      const eu =
        params.search.trim().length >= 3
          ? [
              {
                endUser: {
                  OR: [
                    { email: { contains: params.search, mode: "insensitive" as const } },
                    { name: { contains: params.search, mode: "insensitive" as const } },
                  ],
                },
              },
            ]
          : [];
      where.OR = [
        { publicId: { equals: params.search } },
        { id: { in: params.searchSessionIds ?? [] } },
        ...eu,
      ];
    }

    // Hide unplayable mobile recordings. A native session (iOS/Android — incl.
    // Flutter & React Native, which keep the ios/android platform) can't be
    // replayed until its frame archive is gzip-streamed to R2, which happens at
    // session end (status flips LIVE→COMPLETED). Web sessions replay immediately
    // from the rrweb DOM stream, so any status is fine. So: show everything
    // EXCEPT a still-LIVE native session.
    //
    // One AND-ed predicate on the SAME workspace-scoped, keyset-paginated query
    // — no second round-trip. Scales: workspaceId + the `id < cursor` keyset
    // (id-desc) already bound the scan to one page; this residual only skips
    // LIVE native rows — a tiny, transient set (the per-minute retention sweep
    // flips LIVE→COMPLETED within minutes) — so it never scans past the page.
    // NULL-safe: legacy / unknown-platform rows are treated as web-like (shown).
    const playableFilter: Prisma.SessionWhereInput = {
      OR: [
        { platform: { notIn: ["ios", "android"] } },
        { platform: null },
        { status: "COMPLETED" },
      ],
    };
    where.AND = where.AND
      ? [
          ...(Array.isArray(where.AND) ? where.AND : [where.AND]),
          playableFilter,
        ]
      : playableFilter;

    return where;
  }

  /**
   * How many sessions match the CURRENT filter — the Recordings header figure.
   *
   * Access pattern: the same workspace-scoped predicate the page read uses,
   * taken from the same `where` OBJECT (passed in, not rebuilt), so the count
   * and the rows are one predicate over one store in one snapshot and cannot
   * disagree. It rides @@index([workspaceId, id desc]) exactly like the list —
   * a range scan pinned to one workspace — with the same residual filters
   * (excludedShort, platform/status, browser/device ILIKE) applied during the
   * scan.
   *
   * Scales because it is CAPPED, not because counting is cheap:
   *  - DENSE filter (unfiltered, browser=Chrome): Postgres stops the scan at
   *    LIST_COUNT_CAP + 1 matching entries and we answer "10,000+". Flat cost
   *    whether the workspace holds 10k rows or 10M. This is the common path.
   *  - SPARSE filter (a rare browser AND hasErrors): the cap is never reached,
   *    so the scan walks the workspace's id range. Hundreds of ms at millions of
   *    rows — BUT the existing page read (findMany take: 26) has the IDENTICAL
   *    worst case on the IDENTICAL predicate: with a rare filter it also
   *    exhausts the range to find 26 rows. This roughly doubles a cost the page
   *    already pays; it does not introduce a new worst case. That sparse-scan
   *    characteristic is pre-existing (the residual filters back no index) and
   *    fixing it is an indexing task of its own — flagged, not smuggled in here.
   *
   * Bounded further by: first-page-only (the caller), and Redis below, so a
   * workspace pays this once per filter per TTL rather than once per request.
   *
   * `select: { id: true }` + `take: cap + 1` rather than the raw `SELECT
   * count(*) FROM (… LIMIT n)` a hand-written statement would allow: Prisma
   * cannot compile a WhereInput to SQL, so raw would mean a SECOND, hand-copied
   * predicate — reintroducing precisely the count-vs-list drift this design
   * exists to make impossible. Postgres still stops at the LIMIT; the only cost
   * is marshalling ≤10k ints (tens of KB, single-digit ms). Correctness over the
   * micro-optimisation, deliberately.
   */
  /**
   * CSV of internal session ids → a de-duplicated numeric id set. Non-numeric
   * entries are dropped, so an all-garbage CSV yields `[]` — which the caller
   * treats as "matches nothing", not "no filter".
   *
   * A private method rather than a module-level function, per the
   * no-free-functions rule for *.service.ts.
   */
  private parseIdCsv(csv: string): number[] {
    return [
      ...new Set(
        csv
          .split(",")
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isFinite(n)),
      ),
    ];
  }

  private async countList(
    params: ResolvedListParams,
    where: Prisma.SessionWhereInput,
  ): Promise<PaginatedTotal> {
    const cap = SessionsService.LIST_COUNT_CAP;
    const key = this.listCountCacheKey(params);
    try {
      const hit = await this.cache.get<PaginatedTotal>(key);
      if (hit) return hit;
    } catch {
      // Best-effort, matching readFacetsCache: a Redis hiccup degrades this to
      // an uncached count, never fails the list.
    }
    const rows = await this.db.session.findMany({
      where,
      select: { id: true },
      take: cap + 1,
    });
    const total: PaginatedTotal = {
      value: Math.min(rows.length, cap),
      capped: rows.length > cap,
    };
    try {
      // `{ ttl }`, NOT a bare number — see writeFacetsCache for why the raw
      // overload silently falls through to the module's 1-hour default.
      await this.cache.set(key, total, {
        ttl: SessionsService.LIST_COUNT_TTL_SECONDS,
      });
    } catch {
      /* best-effort — an unwritten cache costs a repeat count, nothing more */
    }
    return total;
  }

  /**
   * Cache key for a filtered count. Workspace scoping is STRUCTURAL: workspaceId
   * is interpolated on its own, ahead of the digest, and arrives as a `number`
   * from @CurrentWorkspaceId (JWT-derived, never caller-supplied), so no filter
   * value can widen the key into another tenant's namespace — a collision here
   * would quietly show one workspace's count above another's rows.
   *
   * The digest covers exactly the params `buildListWhere` reads, in a fixed
   * order. `cursor` and `limit` are EXCLUDED because they do not affect the
   * predicate (and the count is first-page-only anyway), and `sort` is excluded
   * because ordering changes which rows come first, never how many match — so
   * flipping sort reuses the count instead of paying for it again.
   *
   * `v1` is the shape version: bump it whenever buildListWhere's inputs or
   * PaginatedTotal's shape change, or a TTL of entries counted under the old
   * predicate will outlive the deploy.
   */
  private listCountCacheKey(params: ResolvedListParams): string {
    const digest = createHash("sha1")
      .update(
        JSON.stringify([
          params.search ?? "",
          params.status ?? "",
          params.device ?? "",
          // platform + deviceModel ARE read by buildListWhere but were absent
          // from this digest, so ?platform=web, ?platform=android and no-scope
          // all hashed to one key — the header showed whichever total the last
          // cache-miss happened to compute (the rows filtered correctly; only
          // the count was cross-contaminated). Both now scope the key.
          params.platform ?? "",
          params.deviceModel ?? "",
          params.plan ?? "",
          params.browser ?? "",
          params.country ?? "",
          params.hasErrors ?? "",
          params.hasRage ?? "",
          params.hasDead ?? "",
          params.hasSlowLcp ?? "",
          params.hasLongTasks ?? "",
          params.minDurationMs ?? "",
          params.playlistId ?? "",
          params.sinceMs ?? "",
          params.untilMs ?? "",
          params.quick ?? "",
          params.endUserId ?? "",
          params.sessionIds ?? "",
          // The RESOLVED ids, not the raw `incident` param. They are what
          // buildListWhere actually reads, so the key cannot drift from the
          // predicate — and because attribution shifts as the window moves, an
          // incident whose session set changed gets a new key rather than
          // serving a stale total for the TTL. Without this the digest is
          // identical for ?incident=1, ?incident=2 and no scope at all, and the
          // header renders one incident's count above another's rows.
          params.incidentSessionIds?.join(",") ?? "",
        ]),
      )
      .digest("hex");
    // v3: platform + deviceModel joined the digest (they were read by the
    // predicate but not keyed, so their counts were cross-contaminated). Bump
    // so entries counted under the v2 predicate must not outlive the deploy.
    return `sessions:count:v3:${params.workspaceId}:${digest}`;
  }

  /**
   * Recordings search autocomplete. Answers every requested group in ONE
   * round-trip per store: the session dimensions come from a single ClickHouse
   * statement, `user` from Postgres, and the two run concurrently.
   *
   * Empty/absent `q` is a legitimate query — the dashboard's "browser:" value
   * mode opens the dropdown with no text and expects the top values — so it is
   * answered rather than rejected, with both paths staying index-backed and
   * bounded (see the per-query notes below).
   */
  async suggest(
    workspaceId: number,
    params: { q?: string; groups: string[] },
  ): Promise<{ items: SessionSuggestion[] }> {
    const q = (params.q ?? "").trim();
    // An unknown group is DROPPED, not thrown: the dropdown asks for all of its
    // groups in one request, so a stale or typo'd name must degrade to a missing
    // section rather than 500 the entire autocomplete.
    const groups = new Set(
      params.groups.filter(
        (g) => g === "user" || SUGGEST_DIMENSIONS.includes(g),
      ),
    );
    if (!groups.size) return { items: [] };
    const dimensions = [...groups].filter((g) => g !== "user");
    const [users, dims] = await Promise.all([
      groups.has("user")
        ? this.suggestUsers(workspaceId, q)
        : Promise.resolve<SessionSuggestion[]>([]),
      // Scales: ONE statement for all dimensions, not one per group. Pinned to
      // this workspace by replay.sessions' primary index, pruned to ~30 daily
      // partitions by the helper's sinceDays bound, reading two columns per
      // branch, and capped at SUGGEST_PER_GROUP rows per type by `LIMIT n BY
      // type` — so the response size is bounded by group count, not by data.
      dimensions.length
        ? suggestSessionDimensions({
            workspaceId,
            types: dimensions,
            q: q || undefined,
            perType: SUGGEST_PER_GROUP,
          })
        : Promise.resolve<SessionSuggestion[]>([]),
    ]);
    return { items: [...users, ...dims] };
  }

  /**
   * The workspace's BOUNDED filter vocabulary — the complete browser / device /
   * country value sets, fetched once per workspace and filtered client-side.
   *
   * Takes NO `q`, deliberately. A query param would make the response per-
   * keystroke again and therefore uncacheable, which is the entire cost this
   * endpoint exists to remove: ~5 browsers and ~20 countries per workspace is a
   * small, slow-moving set, so recomputing it on every character typed is work
   * spent re-learning an answer that did not change. The unbounded dimensions
   * keep their `q` on `suggest` above, where narrowing is the only option.
   *
   * `types` is the contract's load-bearing field: it declares which types this
   * response is authoritative for, and the dashboard routes ONLY those locally.
   * Everything omitted — and everything, when this degrades — falls through to
   * the typeahead, so this endpoint can fail without hiding a value.
   */
  async facets(workspaceId: number): Promise<SessionFacets> {
    const cached = await this.readFacetsCache(workspaceId);
    if (cached) return cached;
    const inFlight = this.facetsInFlight.get(workspaceId);
    if (inFlight) return inFlight;
    const run = this.computeFacets(workspaceId).finally(() => {
      this.facetsInFlight.delete(workspaceId);
    });
    this.facetsInFlight.set(workspaceId, run);
    return run;
  }

  /**
   * Cache key. Workspace scoping is STRUCTURAL, not a convention: workspaceId is
   * the sole interpolation and arrives as a `number` from @CurrentWorkspaceId
   * (JWT-derived, never a caller-supplied string), so no value can widen the key
   * into another tenant's namespace or collide with one. That matters more here
   * than for most caches — a collision would not corrupt data, it would quietly
   * show one workspace's browser/country list inside another's dropdown.
   *
   * `v1` is the shape version: FACET_TYPES changing must not serve entries
   * written under the old set for a TTL. Bump it whenever the row shape or the
   * type list changes.
   */
  private facetsCacheKey(workspaceId: number): string {
    return `sessions:facets:v2:${workspaceId}`;
  }

  private async readFacetsCache(
    workspaceId: number,
  ): Promise<SessionFacets | undefined> {
    try {
      return await this.cache.get<SessionFacets>(
        this.facetsCacheKey(workspaceId),
      );
    } catch {
      // Best-effort, matching ApiKeyCache: a Redis hiccup must degrade this to
      // an uncached read, never fail the preload.
      return undefined;
    }
  }

  /**
   * The cache-MISS path: one ClickHouse read, bounded by a timeout, then cached.
   *
   * Scales: delegates to `suggestSessionDimensions`, which answers all three
   * types in ONE statement rather than one per type — never a scan. Every branch
   * is pinned to this workspace by replay.sessions' primary index (workspace_id,
   * session_id) and reads exactly two columns per branch (session_id + its own),
   * which is what a columnar store is for. `LIMIT n BY type` caps the response at
   * FACET_PER_TYPE rows per type, so its size is bounded by the type count and
   * the ISO country set — by vocabulary, not by session volume. This runs
   * ALL-TIME (allTime: true) so the dropdown counts match the Recordings list's
   * all-time total; that stays cheap because the count is uniqExact over two
   * columns with NO FINAL merge, and the whole result is cached so a workspace
   * pays it once per TTL rather than once per mount.
   */
  private async computeFacets(workspaceId: number): Promise<SessionFacets> {
    const types = [...FACET_TYPES];
    let items: SessionSuggestion[];
    try {
      items = await this.withFacetsTimeout(
        suggestSessionDimensions({
          workspaceId,
          types,
          // No `q`: this is the COMPLETE set by definition. See `facets` above.
          perType: FACET_PER_TYPE,
          // ALL-TIME so the dropdown counts match the Recordings list's all-time
          // total. Cheap here: uniqExact over 2 columns, NO FINAL, and this whole
          // result is cached per workspace (see below) — paid once per TTL.
          allTime: true,
        }),
      );
    } catch {
      // Timed out, or ClickHouse is unreachable. `types: []` is not a fudge —
      // it is exactly true ("authoritative for nothing right now") and is the
      // documented signal that sends every type back to the typeahead. NOT
      // cached: a transient failure must not pin the degraded answer for a TTL,
      // and the next mount should get the real set. Returned rather than thrown
      // because the dashboard treats a 5xx and an empty `types` identically, and
      // a best-effort preload has a working fallback under it either way.
      return { types: [], items: [] };
    }
    // The EMPTY set gets its own short TTL. It is the one answer that is both
    // plausible and self-erasing — a brand-new workspace whose first session is
    // seconds away — and the dashboard keeps a declared-but-empty type local
    // rather than falling back, so a long TTL here would be a dropdown that
    // stays blank well after the data arrived.
    await this.writeFacetsCache(workspaceId, { types, items }, items.length);
    return { types, items };
  }

  private async writeFacetsCache(
    workspaceId: number,
    value: SessionFacets,
    rowCount: number,
  ): Promise<void> {
    try {
      // `{ ttl }`, NOT a bare `set(key, value, seconds)`. The @types advertise a
      // raw-number overload so both typecheck, but cache-manager-ioredis reads
      // `options.ttl` off the third argument — a number has no `.ttl`, so that
      // form silently falls through to the store's default (AppCacheModule's 1
      // hour) and this TTL would never apply. Verified against Redis: the bare
      // number yields `TTL 3578`, this form yields the value below.
      await this.cache.set(this.facetsCacheKey(workspaceId), value, {
        ttl: rowCount ? FACET_TTL_SECONDS : FACET_EMPTY_TTL_SECONDS,
      });
    } catch {
      /* best-effort — an unwritten cache costs a repeat read, nothing more */
    }
  }

  /**
   * Bounds the miss-path read so a cold cache cannot hold the Recordings mount.
   * The loser is abandoned, not cancelled — the ClickHouse client has no cancel
   * hook here — so the timer must not keep the process alive or the event loop
   * busy past the request; `clearTimeout` in the `finally` is what guarantees
   * that, and `unref` would not (this races, so the timer often outlives its
   * usefulness by the full FACET_TIMEOUT_MS otherwise).
   */
  private withFacetsTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("facets: ClickHouse read timed out")),
        FACET_TIMEOUT_MS,
      );
    });
    return Promise.race([work, limit]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * The `user` group: identified people whose email/name matches `q`, most
   * recently seen first. Emits EndUser.id on every row — the dashboard filters
   * the list by the indexed `endUserId` with it, and without it a user chip
   * degrades to a substring `search` that also matches startUrl text.
   */
  private async suggestUsers(
    workspaceId: number,
    q: string,
  ): Promise<SessionSuggestion[]> {
    const where: Prisma.EndUserWhereInput = { workspaceId };
    // Scales via one of two index paths — never a scan — and `take` caps both:
    //  - q >= 3 chars: the unanchored `email/name ILIKE '%q%'` rides EndUser's
    //    two gin_trgm_ops GIN indexes, which the planner bitmap-ORs (the reason
    //    they are two single-column indexes, not one composite).
    //  - shorter/empty q: NO ILIKE at all. pg_trgm cannot build a trigram from
    //    1–2 chars, so such a filter would fall through to a seq scan of every
    //    EndUser in the workspace. Omitting it leaves the recently-active list
    //    on @@index([workspaceId, lastSeenAt]), which serves this exact ORDER BY
    //    so the LIMIT stops the read early.
    if (q.length >= SUGGEST_TRGM_MIN_CHARS) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }
    const rows = await this.db.endUser.findMany({
      where,
      // Only what a dropdown row renders: its label, its secondary line, and the
      // id the resulting chip filters by.
      select: { id: true, email: true, name: true },
      orderBy: { lastSeenAt: "desc" },
      take: SUGGEST_PER_GROUP,
    });
    return rows.flatMap((r) => {
      // Label with the email, falling back to the name. Anonymous EndUsers carry
      // neither and are unlabelable — drop rather than render an empty row.
      const value = r.email ?? r.name;
      if (!value) return [];
      return [
        {
          type: "user",
          value,
          id: r.id,
          // Second line only when it says something the label doesn't.
          sub: r.email && r.name ? r.name : undefined,
        },
      ];
    });
  }

  async getByPublicId(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      include: {
        endUser: true,
        paths: { orderBy: { sequence: "asc" } },
        segments: { orderBy: { sequence: "asc" } },
        playlistMemberships: {
          select: { playlistId: true, playlist: { select: { title: true } } },
        },
      },
    });
    if (!session) throw new NotFoundException("Session not found");
    const detail = this.toDetail(session);
    return {
      ...detail,
      // Surface which playlists this session belongs to so the player can
      // show a filled-in "In playlist" indicator instead of a generic +Add.
      playlists: session.playlistMemberships.map((m) => ({
        id: m.playlistId,
        title: m.playlist.title,
      })),
    };
  }

  async patchByPublicId(
    workspaceId: number,
    publicId: string,
    patch: { bookmarked?: boolean; viewed?: boolean },
  ) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
    });
    if (!session) throw new NotFoundException("Session not found");
    const updated = await this.db.session.update({
      where: { id: session.id },
      data: { bookmarked: patch.bookmarked, viewed: patch.viewed },
      include: { endUser: true, paths: true, segments: true },
    });
    return this.toDetail(updated);
  }

  async deleteByPublicId(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: {
        id: true,
        publicId: true,
        status: true,
        dataSizeBytes: true,
        endedAt: true,
      },
    });
    if (!session) throw new NotFoundException("Session not found");
    // Explicit user delete -> full erase across every store via the shared
    // reaper (this route used to leak the R2 frames archive + all three
    // ClickHouse tables). eraseMany() also reconciles the affected day's rollup
    // so the Overview "Sessions" total can't drift above the live count when the
    // deleted session predates the nightly window. A user "delete" means gone,
    // analytics included — unlike retention age-out, which keeps analytics.
    await this.reaper.eraseMany(workspaceId, [
      {
        workspaceId,
        id: session.id,
        publicId: session.publicId,
        status: session.status,
        dataSizeBytes: session.dataSizeBytes,
        endedAt: session.endedAt,
      },
    ]);
    return { id: session.id, publicId };
  }

  async listSegments(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      include: { segments: { orderBy: { sequence: "asc" } } },
    });
    if (!session) throw new NotFoundException("Session not found");
    return session.segments.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      eventCount: s.eventCount,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt.toISOString(),
      mongoBatchId: s.mongoBatchId,
    }));
  }

  /**
   * The COMPLETE rrweb replay stream for the web/mobile player — intentionally
   * NOT paginated. The Replayer cannot build without the FullSnapshot and must
   * be able to seek to ANY point in the recording, so a batch cap (this used to
   * cap at 200) silently truncated longer sessions and could drop the snapshot.
   * The event *tab* is a SEPARATE, structured, paginated log served by
   * `listTimeline` (/timeline) — nothing but the player reads this endpoint, so
   * returning the full stream here is safe. A session's batch set is bounded by
   * its length and ordered by sequence. (Streaming the tail of very long
   * sessions, rather than one big response, is a future optimization.)
   */
  async listEvents(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
    });
    if (!session) throw new NotFoundException("Session not found");
    // Scope by projectId (= workspaceId) too: a client sessionId is only unique
    // within a workspace, so fetching by sessionId alone could return another
    // workspace's replay when ids collide. The session was already verified in
    // this workspace above, so this just guarantees the batches are ours.
    const batches = await this.mongo.replayBatch.findMany({
      where: { sessionId: publicId, projectId: String(workspaceId) },
      orderBy: { sequence: "asc" },
    });
    return paginated(
      batches.map((b) => ({
        sequence: b.sequence,
        segmentId: b.segmentId,
        sentAt: Number(b.sentAt),
        startedAt: Number(b.startedAt),
        endedAt: Number(b.endedAt),
        eventCount: b.eventCount,
        events: b.events,
      })),
      null,
    );
  }

  async listConsole(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
    level?: string,
  ) {
    return this.listKindLogs(
      workspaceId,
      publicId,
      "console",
      cursor,
      limit,
      level ? { level } : undefined,
    );
  }

  async listNetwork(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
    status?: string,
    method?: string,
  ) {
    return this.listKindLogs(workspaceId, publicId, "network", cursor, limit, {
      status,
      method,
    });
  }

  async listErrors(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
  ) {
    return this.listKindLogs(workspaceId, publicId, "error", cursor, limit);
  }

  /**
   * Native-platform tap + gesture stream. Each row carries the
   * widget metadata, screen-relative bounds + tap point, the
   * gesture variant ("tap" | "long_press" | "swipe_*" | "pinch"),
   * pinch scale (divided back to fractional on the wire), and the
   * route the event fired on.
   */
  async listTaps(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
    route?: string,
    gesture?: string,
  ) {
    return this.listKindLogs(workspaceId, publicId, "tap", cursor, limit, {
      route,
      gesture,
    });
  }

  /**
   * Custom event stream. `kind` query filters by variant:
   * "track" | "bug_report" | "session_property" | "session_tag" |
   * "push_token" | "session_favorite".
   */
  async listCustoms(
    workspaceId: number,
    publicId: string,
    cursor?: string,
    limit?: string,
    kind?: string,
  ) {
    // The custom variant is stored in the `level` column (cheap
    // LowCardinality filter) — we reuse the existing extra.level
    // path on listKindLogs.
    return this.listKindLogs(workspaceId, publicId, "custom", cursor, limit, {
      level: kind,
    });
  }

  /**
   * Screen-navigation event stream. Returns route names in
   * order with their fire timestamps. Dashboard derives
   * time-on-screen from consecutive event deltas.
   */
  async listScreens(workspaceId: number, publicId: string) {
    // Primary source — ClickHouse `kind='screen'` rows persisted from
    // the SDK's `custom { kind: "screen" }` events (added with the
    // 2026-05 setRoute change). New sessions land here.
    // Screens are naturally bounded per session, and the sidebar badge
    // (`pageCount`) counts ALL of them — so the panel must not silently cap
    // at the 50-row default that console/network use, or the list shows 50
    // under a "260 screens" badge. Pull the full set (500 ceiling).
    const primary = await this.listKindLogs(
      workspaceId,
      publicId,
      "screen",
      undefined,
      "500",
    );
    if (primary.items.length > 0) return primary;
    // Fallback — sessions captured BEFORE the SDK started emitting
    // screen events still carry `pageCount` on the Session row,
    // populated by `upsertPaths` from the batch envelope's page.url.
    // Returning those as screen rows means the panel matches the
    // sidebar badge for legacy sessions instead of showing "0 rows"
    // under a "2 screens" badge.
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: { id: true, startedAt: true, durationMs: true },
    });
    if (!session) return primary;
    const paths = await this.db.sessionPath.findMany({
      where: { sessionId: session.id },
      orderBy: { sequence: "asc" },
    });
    if (paths.length === 0) return primary;
    // Distribute paths evenly across the session duration — we don't
    // have a per-path timestamp on the SessionPath row. This is a
    // best-effort timeline; new sessions get exact offsets via the
    // ClickHouse path above.
    const totalMs = Math.max(1, session.durationMs ?? 1);
    const startTs = session.startedAt.getTime();
    const items = paths.map((p, i) => ({
      kind: "screen",
      eventId: `path-${p.id}`,
      sequence: p.sequence,
      ts: startTs + Math.round((i * totalMs) / paths.length),
      offsetMs: Math.round((i * totalMs) / paths.length),
      message: p.url,
      route: p.url,
      level: "screen",
    }));
    return paginated(items, null);
  }

  /**
   * Aggregate the SDK's perf custom events for a single session. The SDK
   * emits these as `type: "performance"` events with `data: { kind: "perf",
   * metric, value, unit, ts? }`. They're stored verbatim in MongoDB
   * (`replayBatch.events`) — we scan the batches and reduce in-memory.
   *
   * Output shape is small and stable so the dashboard can render it
   * without further massaging:
   *   {
   *     lcp:  { value, unit, rating } | null,
   *     cls:  { value, unit, rating } | null,
   *     fid:  { value, unit, rating } | null,    // legacy, deprecated
   *     inp:  { value, unit, rating } | null,    // replaces FID
   *     fcp:  { value, unit, rating } | null,
   *     ttfb: { value, unit, rating } | null,
   *     longTasks: { count, totalMs, slowestMs },
   *     memory:    { peakBytes, samples: [{ ts, bytes }] }
   *   }
   *
   * We cap memory.samples at 60 points (the dashboard's chart only has
   * room for ~that many anyway); over-sample by reservoir-style decimation.
   */
  /**
   * Native (mobile) performance, built from the ClickHouse `perf`
   * projection rows the binary SDK emits (performanceEvent {name,value}).
   * Returns the shape NativePerfPanel reads — each vital `{ value }` (the
   * panel computes its own rating from value) plus charting series. Web
   * sessions keep the Mongo-batch path below.
   */
  private async getNativePerformance(workspaceId: number, publicId: string) {
    const rows = await listLogs({
      sessionPublicId: publicId,
      workspaceId,
      kind: "perf",
      limit: 5000,
    });
    const series = (name: string) =>
      rows
        .filter((r) => r.method === name)
        .map((r) => ({
          ts: Number(r.offset_ms ?? 0),
          v: Number(r.duration_ms ?? 0),
        }));

    const mem = series("memoryUsage");
    const thermal = series("thermalState");
    const battery = series("batteryLevel");
    const cpu = series("mainThreadCPU");

    // Discrete warnings the dashboard overlays (mirrors the reference
    // player's PerfWarnings): the distinct warning types that occurred in
    // the session, with their first timestamp + count + worst value.
    const warn = new Map<
      string,
      { type: string; firstTs: number; count: number; worst: number }
    >();
    const addWarn = (
      type: string,
      samples: { ts: number; v: number }[],
      test: (v: number) => boolean,
    ) => {
      for (const s of samples) {
        if (!test(s.v)) continue;
        const w = warn.get(type);
        if (w) {
          w.count += 1;
          if (s.v > w.worst) w.worst = s.v;
        } else {
          warn.set(type, { type, firstTs: s.ts, count: 1, worst: s.v });
        }
      }
    };
    addWarn("thermalState", thermal, (v) => v >= 1); // light or worse
    addWarn("memoryWarning", series("memoryWarning"), () => true);
    addWarn(
      "isLowPowerModeEnabled",
      series("isLowPowerModeEnabled"),
      (v) => v === 1,
    );
    addWarn("lowDiskSpace", series("lowDiskSpace"), () => true);
    addWarn("batteryLevel", battery, (v) => v > 0 && v <= 20); // low battery
    addWarn("background", series("background"), (v) => v === 1);
    const warnings = Array.from(warn.values()).sort(
      (a, b) => a.firstTs - b.firstTs,
    );

    const memPeakMb = mem.length
      ? Math.round(Math.max(...mem.map((s) => s.v)) / (1024 * 1024))
      : null;
    const thermalWorst = thermal.length
      ? Math.max(...thermal.map((s) => s.v))
      : null;
    const batteryLast = battery.length ? battery[battery.length - 1].v : null;

    // Worst battery drain (%/min) over consecutive falling samples.
    let drain: number | null = null;
    for (let i = 1; i < battery.length; i++) {
      const dv = battery[i - 1].v - battery[i].v;
      const dtMin = (battery[i].ts - battery[i - 1].ts) / 60000;
      if (dtMin > 0 && dv > 0) {
        const rate = dv / dtMin;
        if (drain == null || rate > drain) drain = rate;
      }
    }

    return {
      coldStart: null,
      anr: null,
      anrCount: 0,
      anrOccurrences: [],
      frameDrop: null,
      frozenFrames: null,
      memoryRss: memPeakMb == null ? null : { value: memPeakMb, unit: "mb" },
      thermalState:
        thermalWorst == null ? null : { value: thermalWorst, unit: "state" },
      batteryLevel:
        batteryLast == null ? null : { value: batteryLast, unit: "pct" },
      batteryDrain:
        drain == null
          ? null
          : { value: Math.round(drain * 10) / 10, unit: "pct" },
      batteryState: null,
      mainThreadCpu: cpu.length
        ? { value: Math.round(Math.max(...cpu.map((s) => s.v))), unit: "pct" }
        : null,
      // Discrete warnings overlaid on the player (reference PerfWarnings).
      warnings,
      nativeSeries: {
        // CPU % + memory MB over time — the always-populated graph the
        // reference player charts. (Android CPU lands too now.)
        cpu: cpu.map((s) => ({ ts: s.ts, v: s.v })),
        memoryRssMb: mem.map((s) => ({
          ts: s.ts,
          bytes: Math.round(s.v / (1024 * 1024)),
        })),
        batteryLevel: battery.map((s) => ({ ts: s.ts, bytes: s.v })),
      },
    };
  }

  async getPerformance(workspaceId: number, publicId: string) {
    // Workspace scope check — same pattern as other session endpoints.
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: { id: true, platform: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    // Mobile sessions store perf in ClickHouse, not Mongo rrweb batches.
    if (session.platform === "android" || session.platform === "ios") {
      return this.getNativePerformance(workspaceId, publicId);
    }
    // Scope by projectId (= workspaceId): never read another workspace's batches
    // if a client sessionId collides across workspaces.
    const batches = await this.mongo.replayBatch.findMany({
      where: { sessionId: publicId, projectId: String(workspaceId) },
      orderBy: { sequence: "asc" },
      take: 1000,
      select: { events: true },
    });

    type Sample = { ts: number; bytes: number };
    type Vital = { value: number; unit: string; rating?: string };
    let lcp: Vital | null = null;
    let cls: Vital | null = null;
    let fid: Vital | null = null;
    let inp: Vital | null = null;
    let fcp: Vital | null = null;
    let ttfb: Vital | null = null;
    let longCount = 0;
    let longTotal = 0;
    let longSlowest = 0;
    let memPeak = 0;
    const memSamples: Sample[] = [];
    // Native vitals — populated only for android/ios sessions; web
    // sessions never emit these metric names so the fields stay null
    // + the dashboard auto-mounts the appropriate panel based on
    // session.platform.
    let coldStartMs: Vital | null = null;
    // For frame_drop_pct we keep the WORST (max) because the
    // dashboard renders a single headline value. Same for
    // memory_rss_mb (peak) and thermal_state (max = hottest). Frozen
    // frames are summed across the session.
    let worstFrameDrop: Vital | null = null;
    let frozenFrameCount = 0;
    let worstAnr: Vital | null = null;
    let anrCount = 0;
    let worstMemRssMb: Vital | null = null;
    let worstThermalState: Vital | null = null;
    let lastBatteryLevel: Vital | null = null;
    let lastBatteryState: Vital | null = null;
    let worstBatteryDrain: Vital | null = null;
    // Sampled-over-time series for the dashboard's mini-charts.
    const frameDropSamples: Sample[] = [];
    const memRssSamples: Sample[] = [];
    const batteryLevelSamples: Sample[] = [];
    // Per-ANR occurrence list — kept ungrouped here; dashboard
    // groups by stack signature on render. Bounded by anrCount
    // per session (~tens at worst); not decimated.
    const anrSamples: Array<{
      ts: number;
      durationMs: number;
      rating?: string;
      details: string | null;
    }> = [];

    for (const b of batches) {
      const evs = (b.events ?? []) as Array<{
        type?: string;
        ts?: number;
        data?: {
          kind?: string;
          metric?: // Web vitals
            | "lcp"
            | "cls"
            | "fid"
            | "inp"
            | "fcp"
            | "ttfb"
            | "long_task"
            | "memory"
            // Native (android/ios) vitals
            | "cold_start_ms"
            | "frame_drop_pct"
            | "frozen_frame_count"
            | "anr_ms"
            | "memory_rss_mb"
            | "thermal_state"
            | "battery_level_pct"
            | "battery_state"
            | "battery_drain_pct_per_min";
          value?: number;
          unit?: string;
          rating?: string;
          ts?: number;
          /**
           * Stack trace shipped by Android ANR watchdog (main-thread
           * stack at the moment the ANR fired). Capped to ~8 KB by
           * the SDK. iOS HangWatchdog leaves this null today (mach
           * thread_get_state would be needed to walk the main thread
           * from a background thread; see HangWatchdog.swift docs).
           */
          details?: string;
        };
      }>;
      for (const ev of evs) {
        if (ev.type !== "performance") continue;
        const d = ev.data;
        if (!d || d.kind !== "perf") continue;
        const value = typeof d.value === "number" ? d.value : 0;
        // For LCP/CLS/INP/FID we keep the LATEST update. web-vitals
        // streams incremental high-water marks via reportAllChanges,
        // so the last one we see is the canonical final value.
        // FCP/TTFB fire once each — last write wins is also correct.
        const vital: Vital = { value, unit: d.unit ?? "ms", rating: d.rating };
        switch (d.metric) {
          case "lcp":
            lcp = vital;
            break;
          case "cls":
            cls = { ...vital, unit: d.unit ?? "score" };
            break;
          case "fid":
            fid = vital;
            break;
          case "inp":
            inp = vital;
            break;
          case "fcp":
            fcp = vital;
            break;
          case "ttfb":
            ttfb = vital;
            break;
          case "long_task":
            longCount += 1;
            longTotal += value;
            if (value > longSlowest) longSlowest = value;
            break;
          case "memory":
            if (value > memPeak) memPeak = value;
            memSamples.push({ ts: d.ts ?? ev.ts ?? 0, bytes: value });
            break;
          // ---- Native (android/ios) vitals --------------------
          case "cold_start_ms":
            // One-shot at process start — last write wins is fine
            // (would only differ if customer manually re-emits).
            coldStartMs = vital;
            break;
          case "frame_drop_pct":
            if (!worstFrameDrop || value > worstFrameDrop.value) {
              worstFrameDrop = vital;
            }
            frameDropSamples.push({
              ts: d.ts ?? ev.ts ?? 0,
              bytes: value,
            });
            break;
          case "frozen_frame_count":
            // Each emission is a DELTA (per-window count), not a
            // cumulative total — sum across the session.
            frozenFrameCount += Math.round(value);
            break;
          case "anr_ms":
            anrCount += 1;
            if (!worstAnr || value > worstAnr.value) worstAnr = vital;
            // Append per-occurrence detail (timestamp + duration +
            // optional main-thread stack). Lets the dashboard render
            // a "Recent ANRs" table grouped by stack signature — same
            // UX Crashlytics gives crashes.
            anrSamples.push({
              ts: d.ts ?? ev.ts ?? 0,
              durationMs: value,
              rating: d.rating,
              details: typeof d.details === "string" ? d.details : null,
            });
            break;
          case "memory_rss_mb":
            if (!worstMemRssMb || value > worstMemRssMb.value) {
              worstMemRssMb = vital;
            }
            memRssSamples.push({
              ts: d.ts ?? ev.ts ?? 0,
              bytes: value,
            });
            break;
          case "thermal_state":
            // Encoded 0..3 (nominal/fair/serious/critical). Higher
            // == hotter. We headline the worst.
            if (!worstThermalState || value > worstThermalState.value) {
              worstThermalState = vital;
            }
            break;
          case "battery_level_pct":
            lastBatteryLevel = vital;
            batteryLevelSamples.push({
              ts: d.ts ?? ev.ts ?? 0,
              bytes: value,
            });
            break;
          case "battery_state":
            // Encoded 0..3 (unknown/unplugged/charging/full). Last
            // write wins — the dashboard cares about CURRENT state.
            lastBatteryState = vital;
            break;
          case "battery_drain_pct_per_min":
            if (!worstBatteryDrain || value > worstBatteryDrain.value) {
              worstBatteryDrain = vital;
            }
            break;
        }
      }
    }

    // Decimate to ≤60 samples so the dashboard chart stays snappy and the
    // payload doesn't bloat for long sessions (one sample / 10s = 360
    // points per hour).
    const MAX_SAMPLES = 60;
    const decimate = (arr: Sample[]): Sample[] =>
      arr.length <= MAX_SAMPLES
        ? arr
        : arr.filter((_, i) => i % Math.ceil(arr.length / MAX_SAMPLES) === 0);

    return {
      // ---- Web vitals ----
      lcp,
      cls,
      fid,
      inp,
      fcp,
      ttfb,
      longTasks: {
        count: longCount,
        totalMs: longTotal,
        slowestMs: longSlowest,
      },
      memory: { peakBytes: memPeak, samples: decimate(memSamples) },
      // ---- Native vitals (null for web sessions) ----
      // Headline cards — single-value vitals the dashboard renders
      // as cards w/ rating colour. Mirrors how lcp/cls/fid are
      // returned above.
      coldStart: coldStartMs,
      frameDrop: worstFrameDrop,
      frozenFrames:
        frozenFrameCount > 0
          ? { value: frozenFrameCount, unit: "count" }
          : null,
      anr: worstAnr,
      anrCount,
      // Per-ANR occurrence list with optional main-thread stack
      // (Android only — iOS HangWatchdog leaves stack null pending
      // mach thread_get_state work; see HangWatchdog.swift docs).
      anrOccurrences: anrSamples,
      memoryRss: worstMemRssMb,
      thermalState: worstThermalState,
      batteryLevel: lastBatteryLevel,
      batteryState: lastBatteryState,
      batteryDrain: worstBatteryDrain,
      // Series for the chart mini-views.
      nativeSeries: {
        frameDrop: decimate(frameDropSamples),
        memoryRssMb: decimate(memRssSamples),
        batteryLevel: decimate(batteryLevelSamples),
      },
    };
  }

  async timeline(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      include: { paths: { orderBy: { sequence: "asc" } } },
    });
    if (!session) throw new NotFoundException("Session not found");
    const logs = await listLogs({
      sessionPublicId: publicId,
      workspaceId,
      limit: 2000,
    });
    return {
      sessionId: session.id,
      publicId: session.publicId,
      durationMs: session.durationMs,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      paths: session.paths.map((p) => ({ sequence: p.sequence, url: p.url })),
      events: logs
        .map((l) => ({
          kind: l.kind,
          eventId: l.event_id,
          eventType: l.event_type,
          ts: Number(l.timestamp),
          offsetMs: Number(l.offset_ms),
          level: l.level || undefined,
          message: l.message || undefined,
          method: l.method || undefined,
          url: l.url || undefined,
          statusCode: l.status_code || undefined,
          // Perf rows store value × 1000 in `duration_ms`; expose
          // the divided float as `value` and the raw integer field
          // as undefined so the timeline renderer doesn't confuse
          // it with a network duration.
          durationMs:
            l.kind === "perf" ? undefined : l.duration_ms || undefined,
          value: l.kind === "perf" ? Number(l.duration_ms) / 1000 : undefined,
          metric: l.kind === "perf" ? l.method || undefined : undefined,
          rating: l.kind === "perf" ? l.level || undefined : undefined,
          unit: l.kind === "perf" ? l.message || undefined : undefined,
          error: l.error || undefined,
          stack: l.stack || undefined,
          // Native-platform tap + gesture metadata. Surfaces in
          // EventsPanel as distinct rows with icons + meta.
          uiClass: l.ui_class || undefined,
          uiValue: l.ui_value || undefined,
          uiId: l.ui_id || undefined,
          uiType: l.ui_type || undefined,
          isSensitive: l.is_sensitive === 1 ? true : undefined,
          gesture: l.gesture || undefined,
          pinchScale: l.pinch_scale_x1000
            ? l.pinch_scale_x1000 / 1000
            : undefined,
          route: l.route || undefined,
        }))
        .sort((a, b) => a.ts - b.ts),
    };
  }

  private async listKindLogs(
    workspaceId: number,
    publicId: string,
    kind: "console" | "network" | "error" | "tap" | "custom" | "screen",
    cursor?: string,
    limit?: string,
    extra?: Record<string, string | undefined>,
  ) {
    const take = parseLimit(limit, 50, 500);
    // Resolve publicId -> numeric session_id so the ClickHouse read hits the
    // session_events sort key (workspace_id, session_id, sequence, timestamp)
    // and range-reads exactly ONE session. Filtering by the non-key
    // session_public_id column instead prunes only to the workspace and then
    // row-scans every event of every session in it — O(workspace) at 500k
    // sessions (the Console/Network tab slowness). Indexed unique-publicId read.
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException("Session not found");
    const rows = await listLogs({
      sessionId: session.id,
      workspaceId,
      kind,
      limit: 5000,
    });
    let filtered: ProjectionRow[] = rows;
    if (extra?.level)
      filtered = filtered.filter((r) => r.level === extra.level);
    if (extra?.status)
      filtered = filtered.filter((r) => String(r.status_code) === extra.status);
    if (extra?.method)
      filtered = filtered.filter((r) => r.method === extra.method);
    // `route` filter on tap rows so the dashboard can show
    // "every tap on /Checkout"; the column is empty for non-tap
    // kinds so filtering them out by mistake would zero the
    // result set — guard with kind.
    if (extra?.route && (kind === "tap" || kind === "screen"))
      filtered = filtered.filter((r) => r.route === extra.route);
    // `gesture` filter for tap rows. Useful for the future
    // "long-press only" / "pinch only" segmentation.
    if (extra?.gesture && kind === "tap")
      filtered = filtered.filter((r) => r.gesture === extra.gesture);
    const cursorTs = decodeCursor(cursor);
    const startIdx =
      cursorTs !== undefined
        ? filtered.findIndex((r) => Number(r.timestamp) > cursorTs)
        : 0;
    const slice =
      startIdx === -1
        ? []
        : filtered.slice(
            Math.max(startIdx, 0),
            Math.max(startIdx, 0) + take + 1,
          );
    const items = slice.length > take ? slice.slice(0, take) : slice;
    const nextCursor =
      slice.length > take
        ? Buffer.from(`c:${items[items.length - 1].timestamp}`).toString(
            "base64url",
          )
        : null;
    return paginated(items.map(this.mapLog), nextCursor);
  }

  private mapLog = (row: ProjectionRow) => {
    // Console rows carry their structured `args` inside `raw` (the
    // JSON-stringified event data). Parse it so the dashboard can render
    // objects with a collapsible tree instead of "[object Object]".
    let consoleArgs: unknown[] | undefined;
    if (row.kind === "console" && row.raw) {
      try {
        const parsed = JSON.parse(row.raw);
        if (Array.isArray(parsed.args)) consoleArgs = parsed.args;
      } catch {
        /* ignore */
      }
    }
    // Custom-event rows carry their structured properties inside
    // `raw`. Parse so dashboard renders them as a tree the same
    // way it handles console.args. The CustomEventData shape is
    // `{kind, name, properties}`.
    let customProperties: Record<string, unknown> | undefined;
    if ((row.kind === "custom" || row.kind === "screen") && row.raw) {
      try {
        const parsed = JSON.parse(row.raw);
        if (parsed && typeof parsed.properties === "object") {
          customProperties = parsed.properties;
        }
      } catch {
        /* ignore */
      }
    }
    // Perf rows store value × 1000 to keep the column integer.
    // Divide back so the dashboard reads the float it expects.
    const perfValue =
      row.kind === "perf" ? Number(row.duration_ms) / 1000 : undefined;
    return {
      kind: row.kind,
      eventId: row.event_id,
      sequence: row.sequence,
      ts: Number(row.timestamp),
      offsetMs: Number(row.offset_ms),
      level: row.level || undefined,
      message: row.message || undefined,
      args: consoleArgs,
      method: row.method || undefined,
      url: row.url || undefined,
      statusCode: row.status_code || undefined,
      durationMs:
        row.kind === "perf" ? undefined : row.duration_ms || undefined,
      error: row.error || undefined,
      stack: row.stack || undefined,
      requestHeaders: SessionsService.parseJson(row.request_headers),
      responseHeaders: SessionsService.parseJson(row.response_headers),
      requestBody: row.request_body || undefined,
      responseBody: row.response_body || undefined,
      connectionRtt: row.connection_rtt || undefined,
      connectionEffectiveType: row.connection_effective_type || undefined,
      // Native-platform tap fields. All undefined for non-tap kinds.
      uiClass: row.ui_class || undefined,
      uiValue: row.ui_value || undefined,
      uiId: row.ui_id || undefined,
      uiType: row.ui_type || undefined,
      bounds:
        row.bounds_w > 0 || row.bounds_h > 0
          ? {
              x: row.bounds_x,
              y: row.bounds_y,
              w: row.bounds_w,
              h: row.bounds_h,
            }
          : undefined,
      point:
        row.point_x > 0 || row.point_y > 0
          ? { x: row.point_x, y: row.point_y }
          : undefined,
      isSensitive: row.is_sensitive === 1 ? true : undefined,
      gesture: row.gesture || undefined,
      pinchScale: row.pinch_scale_x1000
        ? row.pinch_scale_x1000 / 1000
        : undefined,
      route: row.route || undefined,
      // Custom event properties parsed from `raw`.
      properties: customProperties,
      // Perf event value (post-divide).
      value: perfValue,
      // Perf metric name lives in `method` for storage; expose
      // under `metric` too for dashboard clarity.
      metric: row.kind === "perf" ? row.method || undefined : undefined,
      unit: row.kind === "perf" ? row.message || undefined : undefined,
      rating: row.kind === "perf" ? row.level || undefined : undefined,
    };
  };

  // ---------------------------------------------------------------------------
  // Share-links
  // ---------------------------------------------------------------------------

  async createShare(
    workspaceId: number,
    userId: number,
    publicId: string,
    body: { panels?: Partial<SharePanels>; expiresInHours?: number },
  ) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
    });
    if (!session) throw new NotFoundException("Session not found");
    const panels: SharePanels = { ...DEFAULT_PANELS, ...(body.panels ?? {}) };
    const token = randomBytes(24).toString("base64url");
    const expiresAt = body.expiresInHours
      ? new Date(Date.now() + body.expiresInHours * 3_600_000)
      : null;
    const share = await this.db.sessionShare.create({
      data: {
        sessionId: session.id,
        workspaceId,
        token,
        panels: panels as unknown as Prisma.InputJsonValue,
        createdById: userId,
        expiresAt,
      },
    });
    return {
      id: share.id,
      token: share.token,
      url: `/share/${share.token}`,
      panels,
      expiresAt: share.expiresAt?.toISOString() ?? null,
      createdAt: share.createdAt.toISOString(),
    };
  }

  async listShares(workspaceId: number, publicId: string) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
    });
    if (!session) throw new NotFoundException("Session not found");
    const shares = await this.db.sessionShare.findMany({
      where: { sessionId: session.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      // Hard cap. A session realistically has 1-3 active share links;
      // 100 protects us from a buggy automation creating thousands.
      take: 100,
    });
    return shares.map((s) => ({
      id: s.id,
      token: s.token,
      url: `/share/${s.token}`,
      panels: s.panels as unknown as SharePanels,
      expiresAt: s.expiresAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  async revokeShare(workspaceId: number, publicId: string, shareId: number) {
    const session = await this.db.session.findFirst({
      where: { publicId, workspaceId },
    });
    if (!session) throw new NotFoundException("Session not found");
    await this.db.sessionShare.update({
      where: { id: shareId },
      data: { revokedAt: new Date() },
    });
    return { id: shareId, revokedAt: new Date().toISOString() };
  }

  /**
   * Resolve a share token to its bundle. Used by the unauthenticated public
   * `/v1/share/:token` route. Returns `null` if the token is unknown, revoked,
   * or expired — caller turns that into 404.
   */
  async resolveShare(token: string) {
    const share = await this.db.sessionShare.findUnique({
      where: { token },
      include: {
        // SHARE_SELECT, not `include: { endUser: true }`: this route is
        // unauthenticated and the link travels, so the query is the boundary —
        // the address, the distinctId and the identify() traits are never read
        // out of Postgres at all. See SHARE_END_USER.
        session: { select: SHARE_SELECT },
      },
    });
    if (!share || share.revokedAt) return null;
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) return null;

    // Fire-and-forget bookkeeping: bump view count + first-view stamp,
    // and notify the share creator the first time anyone opens the link.
    // We don't await — the share fetch is on the public hot path and
    // shouldn't be held up by notification work.
    void this.markShareViewed(share);

    return {
      panels: share.panels as unknown as SharePanels,
      workspaceId: share.workspaceId,
      session: this.toShareDetail(share.session),
    };
  }

  /**
   * The share bundle's session. Deliberately NOT toDetail:
   *
   *   · toDetail is typed off `include: { endUser: true }` — every column — and
   *     emits `customProperties` (the identify() traits). Handing an anonymous
   *     visitor the same payload an authenticated engineer gets is how the
   *     address ended up in a public response in the first place.
   *   · `email` is reported as null and `distinctId` as "" (the column is NOT
   *     NULL, so its Prisma type is `string`) — emptied rather than omitted, so
   *     the client's endUser contract still holds and resolveIdentity treats
   *     both as absent. They are literals here, not reads: SHARE_END_USER never
   *     selected them, so there is nothing to leak even if someone later adds a
   *     field to the mapper below.
   *   · `isOnline` is a presence signal about a real person and a shared
   *     recording is historical; it is not the recipient's business.
   */
  private toShareDetail = (
    s: Prisma.SessionGetPayload<{ select: typeof SHARE_SELECT }>,
  ) => ({
    ...this.toSummary({
      ...s,
      endUser: s.endUser
        ? { ...s.endUser, distinctId: "", email: null, isOnline: false, picture: null }
        : null,
    }),
    paths: s.paths.map((p) => ({ sequence: p.sequence, url: p.url })),
    segments: s.segments.map((seg) => ({
      sequence: seg.sequence,
      eventCount: seg.eventCount,
      startedAt: seg.startedAt.toISOString(),
      endedAt: seg.endedAt.toISOString(),
      mongoBatchId: seg.mongoBatchId,
    })),
  });

  /**
   * Side effect of a public share-link open. Increments `viewCount` on
   * every call but only fires a notification on the FIRST view (gated
   * by `firstViewedAt`) so the share creator doesn't get one ping per
   * refresh / per panel fetch / per recipient.
   */
  /* Typed structurally, not off the visitor's payload. It used to take the whole
     `include: { endUser: true }` share — which is WHY the public bundle carried
     an address: one query served two audiences, and the wider of the two won.
     This one names only what it needs; the address it wants for the notification
     is fetched below, for the sharer, who is entitled to it. */
  private async markShareViewed(share: {
    id: number;
    sessionId: number;
    workspaceId: number;
    createdById: number | null;
    firstViewedAt: Date | null;
    session: { publicId: string };
  }): Promise<void> {
    try {
      // Two-step: bump count always; stamp + notify only when first.
      const isFirstView = !share.firstViewedAt;
      await this.db.sessionShare.update({
        where: { id: share.id },
        data: {
          viewCount: { increment: 1 },
          firstViewedAt: isFirstView ? new Date() : undefined,
        },
      });
      if (!isFirstView || !share.createdById) return;
      /* Read the label HERE rather than widening the visitor's query. This
         notification goes to the person who created the link, so the address is
         theirs to see — but it is wanted once, on first view, on a path that is
         already fire-and-forget, so it costs a query nobody waits for instead of
         a column every anonymous visitor gets. */
      const labelled = await this.db.session.findUnique({
        where: { id: share.sessionId },
        select: { endUser: { select: { name: true, email: true } } },
      });
      const userName =
        labelled?.endUser?.name ?? labelled?.endUser?.email ?? "Anonymous";
      await this.notifications.emit({
        workspaceId: share.workspaceId,
        userId: share.createdById,
        kind: "SHARE_VIEWED",
        payload: {
          sessionPublicId: share.session.publicId,
          sharedUserName: userName,
          shareId: share.id,
        },
      });
    } catch (e) {
      // Swallow — the share fetch must still succeed even if Postgres
      // is momentarily flaky on the writes side.
      process.stderr.write(`markShareViewed failed: ${(e as Error).message}\n`);
    }
  }

  private toSummary = (
    s: Prisma.SessionGetPayload<{ select: typeof SUMMARY_SELECT }>,
    livePublicIds?: Set<string>,
  ) => ({
    id: s.id,
    publicId: s.publicId,
    // Live status is the AND of three things:
    //   1. The row is still flagged LIVE (cron flips stale rows hourly).
    //   2. The last batch landed within the live threshold (60s).
    //   3. The websocket gateway sees an active presence for this session.
    // Without #3 the dashboard would keep calling a session LIVE for up to
    // 60s after the last batch even though the user has clearly left.
    status: (() => {
      if (s.status !== "LIVE") return s.status;
      const recent = Date.now() - s.endedAt.getTime() < 60_000;
      const present = livePublicIds ? livePublicIds.has(s.publicId) : recent;
      return recent && present ? "LIVE" : ("COMPLETED" as SessionStatus);
    })(),
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt.toISOString(),
    durationMs: s.durationMs,
    pageCount: s.pageCount,
    clickCount: s.clickCount,
    // tapCount is the native-platform analog of clickCount. The
    // recordings list combines them ("interactions") so mobile
    // sessions don't show 0 in the Clicks column when the user
    // actually tapped.
    tapCount: s.tapCount,
    rageCount: s.rageCount,
    deadCount: s.deadCount,
    errorCount: s.errorCount,
    // Precomputed side-tab counts. Lets the player render badges
    // immediately on session-open without firing the corresponding
    // panel fetch. Recordings list also displays them in compact
    // metadata rows.
    consoleCount: s.consoleCount,
    consoleErrorCount: s.consoleErrorCount,
    networkCount: s.networkCount,
    // Web-replay availability — lets the dashboard show an accurate "no replay"
    // empty-state without downloading the batch set (a session can have a
    // duration but no playable frames when the rrweb base never landed).
    // Also false once retention has pruned an aged-out replay — the Session and
    // all of its analytics live on; only the watchable frames are gone.
    hasReplay: s.hasFullSnapshot && s.replayPrunedAt === null,
    // True specifically when a replay EXISTED and was pruned by retention age-out
    // — lets the player show a "replay expired" state, distinct from a session
    // that never had a replay at all (hasFullSnapshot === false).
    replayExpired: s.hasFullSnapshot && s.replayPrunedAt !== null,
    frameCount: s.frameCount,
    commentCount: s.commentCount,
    startUrl: s.startUrl,
    entryReferrer: s.entryReferrer,
    platform: s.platform,
    sdkName: s.sdkName,
    sdkVersion: s.sdkVersion,
    // Host-app version + build (for the dashboard symbolication
    // endpoint to key mapping.txt + .so lookups). Null for older
    // sessions / web SDK / SDK < 0.0.2.
    appVersion: s.appVersion,
    appBuild: s.appBuild,
    bookmarked: s.bookmarked,
    viewed: s.viewed,
    // userAgent/viewport are session-level — keep them on the summary so
    // the player header can derive browser/OS even when the session is
    // anonymous (endUser=null) or the EndUser row has empty browser/os.
    userAgent: s.userAgent,
    viewport: s.viewport,
    // The session's OWN device + geo, surfaced at the top level — not only
    // inside endUser. Mobile anonymous sessions (before identify()) have NO
    // EndUser row at all, so reading device/country off endUser dropped them
    // entirely; the row would show "—" and no flag despite the columns being
    // populated. The client prefers these and falls back to endUser's mirror.
    browser: s.browser,
    os: s.os,
    osVersion: s.osVersion,
    device: s.device,
    deviceModel: s.deviceModel,
    city: s.city,
    country: s.country,
    flag: s.flag,
    endUser: s.endUser
      ? {
          id: s.endUser.id,
          distinctId: s.endUser.distinctId,
          email: s.endUser.email,
          name: s.endUser.name,
          initials: s.endUser.initials,
          // identify() avatar URL → player-header identity chip.
          picture: s.endUser.picture,
          plan: s.endUser.plan,
          // Where THIS session came from, not wherever the user was last seen.
          flag: s.flag ?? s.endUser.flag,
          city: s.city ?? s.endUser.city,
          country: s.country ?? s.endUser.country,
          // What THIS session ran on. EndUser's copies are last-write-wins
          // across every device the person uses, so reading them here made all
          // of one user's recordings claim their most recent device. Sessions
          // ingested before the per-session columns fall back to the old value.
          browser: s.browser ?? s.endUser.browser,
          os: s.os ?? s.endUser.os,
          // Per-session only — the row shows "iOS 17 · iPhone 15 Pro Max". These
          // aren't on EndUser (it's one last-write-wins device), so no fallback.
          osVersion: s.osVersion,
          deviceModel: s.deviceModel,
          device: s.device ?? s.endUser.device,
          // Timezone is the dashboard's last-resort fallback for location
          // when the server-side IP geo couldn't resolve (private IPs in
          // dev, residential proxies). UI maps tz → country in JS.
          timezone: s.timezone ?? s.endUser.timezone,
          isOnline: s.endUser.isOnline,
        }
      : null,
  });

  private toDetail = (
    s: Prisma.SessionGetPayload<{
      include: { endUser: true; paths: true; segments: true };
    }>,
  ) => ({
    ...this.toSummary(s),
    userAgent: s.userAgent,
    viewport: s.viewport,
    // SDK custom properties — identify() traits + setSessionProperty() beyond
    // the promoted columns (plan/email/name/…). Sourced from the session's OWN
    // customProps (snapshotted per batch in ingest), NOT EndUser.customProps:
    // the user-level blob is last-write-wins across every session a returning
    // user has, so it would show identical props for two different sessions of
    // the same user. Falls back to the EndUser blob for sessions recorded
    // before per-session snapshotting existed. Detail-only (not on the list
    // summary) to keep Recordings rows lean.
    customProperties:
      (s.customProps as Record<string, unknown> | null) ??
      (s.endUser?.customProps as Record<string, unknown> | null) ??
      null,
    paths: s.paths.map((p) => ({ sequence: p.sequence, url: p.url })),
    segments: s.segments.map((seg) => ({
      sequence: seg.sequence,
      eventCount: seg.eventCount,
      startedAt: seg.startedAt.toISOString(),
      endedAt: seg.endedAt.toISOString(),
      mongoBatchId: seg.mongoBatchId,
    })),
  });

  // ClickHouse stores headers as a JSON string; surface it as an object
  // for the dashboard. Silently swallows parse failures so a malformed
  // row doesn't break the whole response.
  private static parseJson(s: string): Record<string, string> | undefined {
    if (!s) return undefined;
    try {
      return JSON.parse(s) as Record<string, string>;
    } catch {
      return undefined;
    }
  }
}
