import { Injectable, NotFoundException } from "@nestjs/common";
import { getPostgresClient, type Prisma } from "@replay/db-postgres";
import { countryFilterToIso2 } from "../common/geo";
import {
  decodeCursor,
  decodeCompositeCursor,
  paginateRows,
  paginateComposite,
  parseLimit,
} from "../common/cursor";
import { paginated } from "../common/api-response";
import { CohortsService } from "../cohorts/cohorts.service";
import { SessionReaperService } from "../billing/session-reaper.service";

interface ListParams {
  workspaceId: number;
  cursor?: string;
  limit?: string;
  search?: string;
  plan?: string;
  online?: string;
  sort?: string;
  cohortId?: string;
  // Server-side filters — previously the Users page applied these client-side
  // over the 25 loaded rows, so they only narrowed the current page.
  country?: string; // exact EndUser.country (stored as the display name)
  platform?: string; // "Android" | "iOS" | "Browser" — mapped onto EndUser.os
  userType?: string; // "Identified" (has email) | "Anonymous" (no email)
  lastSeenDays?: string; // "1" | "7" | "30" — lastSeenAt within N days
}

/**
 * The 15 EndUser columns a users-LIST row (and the CSV export) renders.
 *
 * Notably absent: `customProps`. It used to ride along because the users table
 * rendered dynamic trait columns off it — that shipped back to the single-user
 * page, so the list now fetches AND serialises a jsonb blob nothing reads, 100
 * rows per page load (plus every command-palette keystroke). It is also the one
 * column here that is unbounded and customer-controlled: identify() traits TOAST
 * out-of-line once they pass ~2KB, so this is the column most likely to get
 * expensive as real customers use it.
 *
 * The single-user get() deliberately keeps its full row — it renders customProps
 * as the Custom properties group and reads 19 of 23 columns — and its wider
 * payload still satisfies this shape structurally, so both share toSummary.
 */
const USER_SUMMARY_SELECT = {
  id: true,
  distinctId: true,
  email: true,
  name: true,
  initials: true,
  picture: true,
  plan: true,
  browser: true,
  os: true,
  device: true,
  city: true,
  country: true,
  flag: true,
  firstSeenAt: true,
  lastSeenAt: true,
  isOnline: true,
} as const;

/** The 9 Session columns a user's recordings row shows. */
const USER_SESSION_SELECT = {
  id: true,
  publicId: true,
  startedAt: true,
  durationMs: true,
  startUrl: true,
  pageCount: true,
  clickCount: true,
  rageCount: true,
  errorCount: true,
  // For the sessions table's "Path" cell: mobile sessions have no URL, so the
  // frontend shows the humanised device model ("iPhone 17 Pro") instead — same
  // as the recordings list. `platform` tells it web vs mobile.
  deviceModel: true,
  platform: true,
} as const;

/** The 6 Session columns the activity feed shows. */
const USER_ACTIVITY_SELECT = {
  id: true,
  publicId: true,
  startedAt: true,
  durationMs: true,
  pageCount: true,
  errorCount: true,
} as const;

/**
 * The 1 CohortMember column the detail's `cohortIds` needs, so the Add-to-cohort
 * picker can render a member row as Remove instead of a duplicate Add.
 */
const USER_COHORT_SELECT = {
  cohortId: true,
} as const;

@Injectable()
export class EndUsersService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly cohorts: CohortsService,
    private readonly reaper: SessionReaperService,
  ) {}

  /**
   * Shared filter → Prisma WHERE for BOTH the users list and its CSV export, so
   * a downloaded file matches the on-screen filtered set verbatim. This used to
   * drift: the export path honoured only search/plan/online/cohort and silently
   * ignored country/platform/userType/lastSeen, so exporting a filtered table
   * produced a wider file than the user saw. One builder = they can't diverge.
   *
   * Every branch is index-backed (see the inline notes): country/os/lastSeenAt
   * ride their @@index([workspaceId, …]); the cohort filter rides
   * CohortMember @@index([cohortId]) via the relation rather than a
   * join-and-distinct, so keyset pagination keeps working over the result.
   */
  private buildWhere(
    params: Pick<
      ListParams,
      | "workspaceId"
      | "plan"
      | "online"
      | "country"
      | "platform"
      | "userType"
      | "lastSeenDays"
      | "cohortId"
      | "search"
    >,
  ): Prisma.EndUserWhereInput {
    const where: Prisma.EndUserWhereInput = { workspaceId: params.workspaceId };
    if (params.plan) where.plan = params.plan;
    if (params.online === "true") where.isOnline = true;
    if (params.online === "false") where.isOnline = false;
    // Country is stored as the display name on EndUser (e.g. "United States"),
    // which is what the picker sends — exact match, index-backed by
    // @@index([workspaceId, country]).
    // The picker sends a display name ("Nigeria"); the column stores the ISO-2
    // code ("NG"). Normalise so the exact, index-backed match actually hits.
    if (params.country) where.country = countryFilterToIso2(params.country);
    // Platform maps onto the OS: Android/iOS are OS values; "Browser" is
    // everything else (desktop/web OSes). Backed by @@index([workspaceId, os]).
    if (params.platform === "Android") where.os = "Android";
    else if (params.platform === "iOS") where.os = "iOS";
    else if (params.platform === "Browser")
      where.os = { notIn: ["Android", "iOS"] };
    // Identified = has an email; Anonymous = none. Matches the FE's data-driven
    // `u.identified` test (identity is by email, not the rendered label).
    if (params.userType === "Identified") where.email = { not: null };
    else if (params.userType === "Anonymous") where.email = null;
    // Last-seen recency window. Rides the default-sort @@index([workspaceId,
    // lastSeenAt]) so the filter and the ordering share one index scan.
    const lsDays = Number(params.lastSeenDays);
    if (Number.isFinite(lsDays) && lsDays > 0) {
      where.lastSeenAt = { gte: new Date(Date.now() - lsDays * 86_400_000) };
    }
    // Cohort filter — narrow to users in this cohort's membership table.
    // CohortMember is the join table; we filter via the relation rather
    // than join-and-distinct so cursor pagination keeps working.
    if (params.cohortId) {
      const cid = Number(params.cohortId);
      if (Number.isFinite(cid))
        where.cohortMembers = { some: { cohortId: cid } };
    }
    if (params.search) {
      where.OR = [
        { email: { contains: params.search, mode: "insensitive" } },
        { name: { contains: params.search, mode: "insensitive" } },
        { city: { contains: params.search, mode: "insensitive" } },
        { distinctId: { contains: params.search, mode: "insensitive" } },
      ];
    }
    return where;
  }

  async list(params: ListParams) {
    const take = parseLimit(params.limit, 25, 100);
    const cursor = decodeCompositeCursor(params.cursor);
    const where = this.buildWhere(params);

    // Order by the ACTIVE sort column, tie-broken by id, and keyset-page on the
    // SAME (column, id) pair. The cursor MUST carry the sort value, not just id —
    // ordering by lastSeenAt DESC while paging on `id < cursor` strands every
    // user whose id is above the first page's last id (which is exactly what
    // stalled this list a few pages in on the 50k-user set). The keyset is
    // AND-composed with `where` so it never clashes with the search OR.
    let orderBy: Prisma.EndUserOrderByWithRelationInput[];
    let keyset: Prisma.EndUserWhereInput | undefined;
    let sortValueOf: (r: {
      id: number;
      name: string | null;
      firstSeenAt: Date | null;
      lastSeenAt: Date | null;
    }) => number | string | null;
    if (params.sort === "firstSeen") {
      orderBy = [{ firstSeenAt: "desc" }, { id: "desc" }];
      sortValueOf = (r) => r.firstSeenAt?.getTime() ?? 0;
      if (cursor) {
        const d = new Date(Number(cursor.sortValue));
        keyset = {
          OR: [{ firstSeenAt: { lt: d } }, { firstSeenAt: d, id: { lt: cursor.id } }],
        };
      }
    } else if (params.sort === "name") {
      // NULLS LAST so anonymous (name IS NULL) users sort AFTER named ones and
      // stay reachable by the keyset. A plain `name > n` is never true for a
      // NULL row, so a single-branch keyset strands every anonymous user past
      // page 1 (very common — most end-users are unidentified). Two-phase: page
      // the named rows first; once the cursor crosses into the null block
      // (sortValue === null) page the NULLs by id. The `{ name: null }` OR-branch
      // is what lets page N transition into the null block once names run out.
      orderBy = [{ name: { sort: "asc", nulls: "last" } }, { id: "desc" }];
      sortValueOf = (r) => r.name; // null preserved → marks the null phase
      if (cursor) {
        if (cursor.sortValue === null) {
          keyset = { name: null, id: { lt: cursor.id } };
        } else {
          const n = String(cursor.sortValue);
          keyset = {
            OR: [
              { name: { gt: n } },
              { name: n, id: { lt: cursor.id } },
              { name: null },
            ],
          };
        }
      }
    } else if (params.sort === "sessions") {
      // sessions-count sort orders by id (the aggregate is applied below), so the
      // id-only cursor already IS a valid keyset.
      orderBy = [{ id: "desc" }];
      sortValueOf = (r) => r.id;
      if (cursor) keyset = { id: { lt: cursor.id } };
    } else {
      // default: lastSeenAt DESC — most-recently-active first.
      orderBy = [{ lastSeenAt: "desc" }, { id: "desc" }];
      sortValueOf = (r) => r.lastSeenAt?.getTime() ?? 0;
      if (cursor) {
        const d = new Date(Number(cursor.sortValue));
        keyset = {
          OR: [{ lastSeenAt: { lt: d } }, { lastSeenAt: d, id: { lt: cursor.id } }],
        };
      }
    }

    const rows = await this.db.endUser.findMany({
      where: keyset ? { AND: [where, keyset] } : where,
      orderBy,
      select: USER_SUMMARY_SELECT,
      take: take + 1,
    });
    const { items, nextCursor } = paginateComposite(
      rows,
      take,
      sortValueOf,
      (r) => r.id,
    );
    // Header count: for the UNfiltered / uncohorted list serve the precomputed
    // workspace user count (WorkspaceStats.usersTotal — live-maintained on first
    // EndUser creation + reconciled every 30 min) via a single indexed PK read,
    // NOT a COUNT(*) over millions of EndUsers. When a plan/online/cohort/search
    // filter narrows the set the cached total no longer describes the filtered
    // rows, so we make no total claim (the list then relies on nextCursor/"more"
    // rather than render a wrong number). Mirrors the recordings count pattern.
    const otherFilters =
      !!params.plan ||
      !!params.online ||
      !!params.search ||
      !!params.country ||
      !!params.platform ||
      !!params.userType ||
      !!params.lastSeenDays;
    // A COHORT scope has an exact, already-maintained count — serve it so the
    // list stops reporting the page size (25) as the total for a 3k-member
    // cohort. Only valid when the cohort is the SOLE filter; combined with a
    // plan/country/etc. filter the membership count no longer describes the
    // narrowed rows, so fall through to "no total" like the other filters.
    // Access pattern: one PK read of Cohort.membersCount (kept live by the
    // cohort precompute), not a COUNT over CohortMember.
    let total:
      | { value: number; capped: boolean }
      | undefined = undefined;
    if (params.cohortId && !otherFilters) {
      const cid = Number(params.cohortId);
      if (Number.isFinite(cid)) {
        const c = await this.db.cohort.findFirst({
          where: { id: cid, workspaceId: params.workspaceId },
          select: { membersCount: true },
        });
        if (c) total = { value: c.membersCount, capped: false };
      }
    } else if (!params.cohortId && !otherFilters) {
      // Unfiltered: the precomputed workspace user count (indexed PK read), not
      // a COUNT(*) over millions of EndUsers.
      const s = await this.db.workspaceStats.findUnique({
        where: { workspaceId: params.workspaceId },
        select: { usersTotal: true },
      });
      if (s) total = { value: s.usersTotal, capped: false };
    }
    // For plan/country/platform/userType/online/lastSeen/search filters an exact
    // total would need a COUNT over an indexed predicate; left undefined so the
    // list relies on nextCursor/"more" rather than render a wrong number.
    return paginated(items.map(this.toSummary), nextCursor, total);
  }

  async get(workspaceId: number, id: number) {
    const user = await this.db.endUser.findFirst({
      where: { workspaceId, id },
    });
    if (!user) throw new NotFoundException("End user not found");
    const [sessionCount, recent, cohortRows] = await Promise.all([
      this.db.session.count({ where: { endUserId: id } }),
      this.db.session.findMany({
        where: { endUserId: id },
        orderBy: { id: "desc" },
        select: { publicId: true, startedAt: true },
        take: 1,
      }),
      // Access pattern: point lookup on the new @@index([endUserId]) — the
      // composite @@unique([cohortId, endUserId]) leads with cohortId, so it
      // can't serve this direction and CohortMember (millions of rows) would
      // seq-scan without it. Detail endpoint only, one query for the whole
      // page (not per-cohort), and it scales because a single user belongs to
      // a bounded number of cohorts and we select ints only — no blobs, no
      // joins onto Cohort.
      this.db.cohortMember.findMany({
        where: { endUserId: id },
        select: USER_COHORT_SELECT,
      }),
    ]);
    const avgDuration = await this.db.session.aggregate({
      where: { endUserId: id },
      _avg: { durationMs: true },
    });
    return {
      ...this.toSummary(user),
      sessions: sessionCount,
      avgDurationMs: Math.round(avgDuration._avg.durationMs ?? 0),
      lastSession: recent[0]
        ? {
            publicId: recent[0].publicId,
            startedAt: recent[0].startedAt.toISOString(),
          }
        : null,
      cohortIds: this.toCohortIds(cohortRows),
      customProps: (user.customProps ?? {}) as Record<string, unknown>,
      identifiers: {
        distinctId: user.distinctId,
        anonymousLinked: 0,
      },
      environment: {
        browser: user.browser,
        os: user.os,
        device: user.device,
        viewport: user.viewport,
        timezone: user.timezone,
        ip: user.ip,
      },
    };
  }

  async listSessions(
    workspaceId: number,
    endUserId: number,
    cursor?: string,
    limit?: string,
  ) {
    const take = parseLimit(limit, 25, 100);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.session.findMany({
      where: {
        workspaceId,
        endUserId,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      orderBy: { id: "desc" },
      select: USER_SESSION_SELECT,
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((s) => ({
        id: s.id,
        publicId: s.publicId,
        startedAt: s.startedAt.toISOString(),
        durationMs: s.durationMs,
        startUrl: s.startUrl,
        pageCount: s.pageCount,
        clickCount: s.clickCount,
        rageCount: s.rageCount,
        errorCount: s.errorCount,
        deviceModel: s.deviceModel,
        platform: s.platform,
      })),
      nextCursor,
    );
  }

  async activityChart(
    workspaceId: number,
    endUserId: number,
    days = 7,
    fromTs?: number,
    toTs?: number,
  ) {
    // `days` IS the window — the chart renders exactly this many day-buckets,
    // so the picker's label ("Last 7 days") is literally true.
    //
    // It used to be a FLOOR — max(days, tenure) — which started the chart at the
    // user's first-ever session. A 53-day-old user therefore got 53 candles
    // while the header still read "last 30 days", and no value of `days` below
    // their tenure could narrow it. A date filter has to mean a date range, so
    // the floor is gone.
    //
    // A custom absolute window ([fromTs,toTs] epoch ms, from the header
    // DatePicker's custom pick) WINS over `days`: the chart then spans exactly
    // that range (ending at toTs) instead of "N days ending now", matching the
    // counts/segments above. Span is derived from the window and clamped to
    // [1,365] either way, so a hand-typed ?days=/?from=/?to= can't ask for an
    // unbounded scan — the query stays a single indexed group-by-day scan on
    // (workspaceId,endUserId) returning at most `span` rows, never raw sessions.
    const useCustom = !!(fromTs && toTs && toTs > fromTs);
    const now = Date.now();
    const endMs = useCustom ? toTs! : now;
    const rawSpan = useCustom
      ? Math.round((toTs! - fromTs!) / 86400000)
      : Math.floor(days) || 7;
    const span = Math.min(365, Math.max(1, rawSpan));
    const since = new Date(useCustom ? fromTs! : now - (span - 1) * 86400000);
    const until = new Date(endMs);
    // SQL-side day-bucketing instead of pulling every row and reducing
    // in JS. Postgres `date_trunc('day', …)` groups in one indexed
    // scan; we get N rows back at most (one per day with any sessions),
    // never the raw session count.
    // Quoted identifiers: Prisma's default Postgres naming preserves the
    // model's PascalCase / camelCase, so raw SQL must quote every name.
    const rows = await this.db.$queryRaw<
      Array<{ day: Date; count: bigint }>
    >`
      SELECT date_trunc('day', "startedAt" AT TIME ZONE 'UTC') AS day,
             COUNT(*)::bigint AS count
        FROM "Session"
       WHERE "workspaceId" = ${workspaceId}
         AND "endUserId" = ${endUserId}
         AND "startedAt" >= ${since}
         AND "startedAt" <= ${until}
       GROUP BY day
    `;
    const buckets = new Map<string, number>();
    for (const r of rows) {
      buckets.set(r.day.toISOString().slice(0, 10), Number(r.count));
    }
    // Emit a dense series — fill missing days with 0 so the chart
    // doesn't have gaps. The labels loop runs in JS but is O(span),
    // not O(sessions), and ends at the window's last day (toTs or now).
    const labels: string[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(endMs - i * 86400000);
      labels.push(d.toISOString().slice(0, 10));
    }
    return labels.map((d) => ({ date: d, count: buckets.get(d) ?? 0 }));
  }

  async activity(
    workspaceId: number,
    endUserId: number,
    cursor?: string,
    limit?: string,
  ) {
    const take = parseLimit(limit, 20, 100);
    const cursorId = decodeCursor(cursor);
    const sessions = await this.db.session.findMany({
      where: {
        workspaceId,
        endUserId,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      orderBy: { id: "desc" },
      select: USER_ACTIVITY_SELECT,
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(sessions, take, (r) => r.id);
    return paginated(
      items.map((s) => ({
        kind: "session" as const,
        publicId: s.publicId,
        title: s.errorCount > 0 ? "Session with errors" : "Browsed",
        detail: `${Math.round(s.durationMs / 1000)}s · ${s.pageCount} pages${s.errorCount ? ` · ${s.errorCount} errors` : ""}`,
        ts: s.startedAt.toISOString(),
      })),
      nextCursor,
    );
  }

  /**
   * GDPR "right to be forgotten" — null out PII on the user row, fully ERASE
   * their sessions from every store (Postgres cascade + Mongo replay + all three
   * ClickHouse analytics tables + R2 frames, via the shared reaper), and
   * tombstone the EndUser so re-identification can't happen. Unlike retention
   * age-out (which keeps analytics and only prunes the replay), a forget is a
   * true erasure — the sessions leave the analytics too.
   *
   * We *don't* hard-delete the EndUser because cohort analytics rely on
   * stable IDs; nulling the PII achieves the same legal outcome without
   * breaking historical counts.
   */
  async forget(workspaceId: number, id: number) {
    const user = await this.db.endUser.findFirst({
      where: { id, workspaceId },
    });
    if (!user) return { id, workspaceId, forgotten: false };

    // Erase the user's sessions across EVERY store, keyset-paged over the
    // indexed (workspaceId, endUserId) so a power user with tens of thousands of
    // sessions is bounded to 500-row batches — never one giant fetch, never an
    // await-in-a-loop over individual rows. The cursor advances by id even if a
    // batch's best-effort store delete fails, so the loop always terminates.
    // eraseMany() reconciles the affected rollup days so counts stay honest.
    let cursor = 0;
    for (;;) {
      const page = await this.db.session.findMany({
        where: { workspaceId, endUserId: id, id: { gt: cursor } },
        select: {
          id: true,
          publicId: true,
          status: true,
          dataSizeBytes: true,
          endedAt: true,
        },
        orderBy: { id: "asc" },
        take: 500,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      await this.reaper.eraseMany(
        workspaceId,
        page.map((s) => ({
          workspaceId,
          id: s.id,
          publicId: s.publicId,
          status: s.status,
          dataSizeBytes: s.dataSizeBytes,
          endedAt: s.endedAt,
        })),
      );
      if (page.length < 500) break;
    }
    await this.db.endUser.update({
      where: { id },
      data: {
        // Rotate the distinctId away from the caller-supplied identifier so a
        // forgotten user can't be re-identified (it's the direct id, and it's
        // still surfaced by the list/CSV). It's `String NOT NULL` + unique per
        // workspace, so rotate to a non-identifying, still-unique value rather
        // than null. (browser/os/device are intentionally retained so device
        // cohorts keep working — see cohort forget note; they are coarse, not a
        // direct identifier.)
        distinctId: `forgotten_${id}`,
        email: null,
        name: "[forgotten]",
        initials: "??",
        city: null,
        country: null,
        flag: null,
        ip: null,
        timezone: null,
        viewport: null,
        customProps: { forgottenAt: new Date().toISOString() } as object,
        isOnline: false,
      },
    });
    // Anonymizing nulled this user's attributes (country/city/name/…) and the
    // session delete above removed their activity — both change cohort
    // membership. Re-evaluate: the drainer drops them from attribute cohorts
    // they no longer match, and the behavioral recompute handles the rest.
    this.cohorts.markUsersDirty(workspaceId, [id]).catch(() => {});
    return { id, workspaceId, forgotten: true };
  }

  /**
   * Stream the entire filtered set as CSV in 1000-row pages. Keeps memory
   * flat regardless of cohort size — important since manual cohorts can
   * hit tens of thousands of users. Caller supplies a `write(chunk)` sink
   * (the Express response in the controller).
   */
  async streamCsv(
    params: Pick<
      ListParams,
      | "workspaceId"
      | "search"
      | "plan"
      | "online"
      | "cohortId"
      | "country"
      | "platform"
      | "userType"
      | "lastSeenDays"
    >,
    write: (chunk: string) => void,
  ): Promise<void> {
    // Same builder the table uses, so a filtered export = the filtered view
    // (every column filter, not just search/plan/online/cohort).
    const where = this.buildWhere(params);

    const headers = [
      "id",
      "distinctId",
      "email",
      "name",
      "plan",
      "browser",
      "os",
      "device",
      "city",
      "country",
      "isOnline",
      "firstSeenAt",
      "lastSeenAt",
    ];
    write(headers.join(",") + "\n");

    const PAGE = 1000;
    let cursorId: number | undefined;
    while (true) {
      const rows = await this.db.endUser.findMany({
        where:
          cursorId !== undefined ? { ...where, id: { lt: cursorId } } : where,
        orderBy: { id: "desc" },
        select: USER_SUMMARY_SELECT,
        take: PAGE,
      });
      if (rows.length === 0) break;
      for (const u of rows) {
        const cells = [
          u.id,
          u.distinctId,
          u.email,
          u.name,
          u.plan,
          u.browser,
          u.os,
          u.device,
          u.city,
          u.country,
          u.isOnline ? "true" : "false",
          u.firstSeenAt.toISOString(),
          u.lastSeenAt.toISOString(),
        ];
        write(cells.map(EndUsersService.csvCell).join(",") + "\n");
      }
      if (rows.length < PAGE) break;
      cursorId = rows[rows.length - 1].id;
    }
  }

  private toSummary = (
    u: Prisma.EndUserGetPayload<{ select: typeof USER_SUMMARY_SELECT }>,
  ) => ({
    id: u.id,
    distinctId: u.distinctId,
    email: u.email,
    name: u.name,
    initials: u.initials,
    picture: u.picture,
    plan: u.plan,
    browser: u.browser,
    os: u.os,
    device: u.device,
    city: u.city,
    country: u.country,
    flag: u.flag,
    firstSeenAt: u.firstSeenAt.toISOString(),
    lastSeenAt: u.lastSeenAt.toISOString(),
    isOnline: u.isOnline,
  });

  private toCohortIds = (
    rows: Prisma.CohortMemberGetPayload<{ select: typeof USER_COHORT_SELECT }>[],
  ) => rows.map((r) => r.cohortId);

  // CSV-escape a single cell — wraps in quotes only when the value
  // contains a comma, newline, or quote (RFC 4180 §2.6 / §2.7).
  private static csvCell(v: unknown): string {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
}
