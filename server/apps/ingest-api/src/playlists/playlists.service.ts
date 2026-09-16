import { Injectable, NotFoundException } from "@nestjs/common";
import {
  getPostgresClient,
  Prisma,
  type PlaylistKind,
} from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";

/**
 * Exactly the fields an AUTO-playlist filter can reference — matchesCondition's
 * switch is the only reader and enumerates them, so this select writes itself.
 *
 * This read runs PER INGEST BATCH for any workspace with an AUTO playlist, i.e.
 * every few seconds per active session. It used to `include: { endUser: true }`
 * and hydrate ~99 columns to read 11 — dragging Session.customProps (which the
 * ingest path GROWS on every batch, so the blob being re-fetched and discarded
 * gets bigger on exactly the axis this repeats on), EndUser.customProps,
 * eventNames and two BigInt counters through TOAST each time.
 */
const FILTER_SESSION_SELECT = {
  durationMs: true,
  pageCount: true,
  errorCount: true,
  rageCount: true,
  deadCount: true,
  startUrl: true,
  // The session's own device/geo (preferred over the user's — see envClause).
  browser: true,
  os: true,
  device: true,
  country: true,
  endUser: { select: { browser: true, os: true, device: true, country: true, plan: true } },
} as const;

/**
 * The 3 owner fields a playlist row shows. `owner: true` pulled the whole User
 * — including passwordHash — into the API process on every playlist list page.
 * It was never serialised (toSummary picks 3 fields), so this was not a leak;
 * it was a credential sitting in memory one careless `...p.owner` spread away
 * from becoming one. Perf here is a rounding error — this is about blast radius.
 */
const PLAYLIST_OWNER_SELECT = {
  select: { id: true, name: true, email: true },
} as const;

@Injectable()
export class PlaylistsService {
  private readonly db = getPostgresClient();

  constructor(private readonly stats: WorkspaceStatsService) {}

  async list(
    workspaceId: number,
    userId: number,
    opts: { cursor?: string; limit?: string; filter?: string },
  ) {
    // Default page size 3 — matches the sidebar's "recent playlists" cap; every
    // caller that wants more (command palette, "see all" flyout, add-to-playlist)
    // passes an explicit larger limit, so this only sets the no-limit fallback.
    const take = parseLimit(opts.limit, 3, 100);
    const cursorId = decodeCursor(opts.cursor);
    const where: Prisma.PlaylistWhereInput = { workspaceId };
    if (opts.filter === "pinned") where.pinned = true;
    if (opts.filter === "mine") where.ownerId = userId;
    if (opts.filter === "auto") where.kind = "AUTO";
    // MANUAL is what the "add this recording to a playlist" picker asks for —
    // an AUTO playlist re-runs its filter on a schedule and would drop a
    // hand-added session, so it must never be offered as a target.
    // Access pattern: rides @@index([workspaceId]) exactly as the `auto` filter
    // above does, with `kind` as a residual filter and keyset paging on id.
    // Playlists are bounded per workspace (tens, not millions) and the scan is
    // always workspace-scoped, so a dedicated (workspaceId, kind) index would
    // not be usable for the [pinned desc, id desc] ordering anyway and would
    // only add write cost.
    if (opts.filter === "manual") where.kind = "MANUAL";

    const rows = await this.db.playlist.findMany({
      where:
        cursorId !== undefined ? { ...where, id: { lt: cursorId } } : where,
      orderBy: [{ pinned: "desc" }, { id: "desc" }],
      // Nothing but the row itself: covers are gone, so the 4 preview sessions
      // that only existed to seed them are gone with them. That drops a Prisma
      // relation round-trip per page AND the Mongo batch read that followed it.
      include: {
        owner: PLAYLIST_OWNER_SELECT,
        _count: { select: { sessions: true } },
      },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);

    return paginated(
      items.map((p) => this.toSummary(p)),
      nextCursor,
    );
  }

  async create(
    workspaceId: number,
    userId: number,
    body: {
      title: string;
      description?: string;
      kind?: PlaylistKind;
      filter?: unknown;
      pinned?: boolean;
    },
  ) {
    const row = await this.db.playlist.create({
      data: {
        workspaceId,
        ownerId: userId,
        title: body.title,
        description: body.description,
        kind: body.kind ?? "MANUAL",
        filter: body.filter as Prisma.InputJsonValue,
        pinned: body.pinned ?? false,
      },
      include: { owner: PLAYLIST_OWNER_SELECT, _count: { select: { sessions: true } } },
    });
    // Seed AUTO playlists immediately so users see results without waiting
    // for the cron — they'd be confused by an empty list right after create.
    if (row.kind === "AUTO") {
      await this.refresh(workspaceId, row.id).catch(() => undefined);
    }
    this.stats.bump(workspaceId, { playlistsTotal: 1 }).catch(() => {});
    return this.toSummary(row);
  }

  /**
   * Re-evaluate an AUTO playlist's filter and rewrite its member list. Safe
   * to run repeatedly — we replace the entire memberships row-set in one
   * transaction so consumers never see a half-applied list.
   */
  async refresh(workspaceId: number, id: number) {
    const playlist = await this.db.playlist.findFirst({
      where: { id, workspaceId },
    });
    if (!playlist) throw new NotFoundException("Playlist not found");
    if (playlist.kind !== "AUTO" || !playlist.filter) {
      return { id, refreshed: 0 };
    }
    const where = PlaylistsService.filterToWhere(
      workspaceId,
      playlist.filter as PlaylistFilter,
    );
    const matching = await this.db.session.findMany({
      where,
      select: { id: true },
      take: 5_000,
    });
    const ids = matching.map((s) => s.id);
    await this.db.$transaction([
      this.db.playlistSession.deleteMany({ where: { playlistId: id } }),
      ...(ids.length > 0
        ? [
            this.db.playlistSession.createMany({
              data: ids.map((sessionId) => ({ playlistId: id, sessionId })),
              skipDuplicates: true,
            }),
          ]
        : []),
      this.db.playlist.update({
        where: { id },
        data: { itemCount: ids.length },
      }),
    ]);
    return { id, refreshed: ids.length };
  }

  /**
   * Responsive variant: given a single freshly-persisted session, walk the
   * workspace's AUTO playlists and add/remove this session from each based
   * on whether it now matches the filter. Called from the ingest worker
   * after every batch so customers don't wait 5 min for a new session to
   * show up in their auto-playlists.
   *
   * Query shape (fixed-cost, O(1) round-trips regardless of playlist count):
   *   1× findMany   — the AUTO playlists in the workspace
   *   1× findUnique — the session + its endUser join
   *   1× createMany — all new memberships (skipDuplicates handles idempotency)
   *   1× deleteMany — all removed memberships
   *   1× groupBy    — recomputed itemCount per affected playlist
   *   N× update     — itemCount writeback, fired in parallel via Promise.all
   *
   * The per-playlist match check is done IN JS against the loaded session
   * row, not via N indexed lookups. The filter shape is small (numeric +
   * string + bool comparators against ~10 Session/EndUser fields), so the
   * JS evaluator mirrors `conditionToWhere` exactly. See `matchesCondition`
   * below.
   */
  async evaluateForSession(workspaceId: number, sessionId: number) {
    const autos = await this.db.playlist.findMany({
      where: {
        workspaceId,
        kind: "AUTO",
        NOT: { filter: { equals: Prisma.JsonNull } },
      },
      select: { id: true, filter: true },
      // Safety ceiling. Workspaces rarely have > ~50 AUTO playlists.
      take: 500,
    });
    if (autos.length === 0) return;

    // Single session load — exactly the fields a playlist filter can reference
    // (matchesCondition is the only reader, and its switch enumerates them). If
    // the session has been deleted between enqueue and process we bail safely.
    const session = await this.db.session.findFirst({
      where: { id: sessionId, workspaceId },
      select: FILTER_SESSION_SELECT,
    });
    if (!session) return;

    // Bucket each playlist by whether the in-memory session matches its
    // filter. Pure JS — no DB round-trips here.
    const matchedIds: number[] = [];
    const unmatchedIds: number[] = [];
    for (const p of autos) {
      if (
        PlaylistsService.matchesPlaylistFilter(
          session,
          p.filter as PlaylistFilter,
        )
      ) {
        matchedIds.push(p.id);
      } else {
        unmatchedIds.push(p.id);
      }
    }
    const allIds = autos.map((p) => p.id);

    // Batched membership writes — one query each, regardless of how many
    // playlists changed state.
    await Promise.all([
      matchedIds.length > 0
        ? this.db.playlistSession.createMany({
            data: matchedIds.map((playlistId) => ({ playlistId, sessionId })),
            skipDuplicates: true,
          })
        : Promise.resolve(),
      unmatchedIds.length > 0
        ? this.db.playlistSession.deleteMany({
            where: { sessionId, playlistId: { in: unmatchedIds } },
          })
        : Promise.resolve(),
    ]);

    // Single groupBy returns the new itemCount for every affected
    // playlist. Playlists with zero members aren't returned — we default
    // to 0 below.
    const counts = await this.db.playlistSession.groupBy({
      by: ["playlistId"],
      where: { playlistId: { in: allIds } },
      _count: { sessionId: true },
    });
    const countByPid = new Map(
      counts.map((c) => [c.playlistId, c._count.sessionId]),
    );

    // Per-row count writeback. Different values per row means we can't
    // collapse into one UPDATE — but the writes run in parallel, so the
    // wall-clock cost is one round-trip not N.
    await Promise.all(
      allIds.map((pid) =>
        this.db.playlist.update({
          where: { id: pid },
          data: { itemCount: countByPid.get(pid) ?? 0 },
        }),
      ),
    );
  }

  /**
   * In-memory evaluator that mirrors `PlaylistsService.conditionToWhere`.
   * Returns true iff the session row satisfies every condition in the
   * filter. Kept in sync with `conditionToWhere` by hand — if you add a
   * field to one, add it to the other.
   *
   * Both halves of the AND chain are evaluated. There's no OR support
   * in the playlist filter shape today (single flat condition list).
   */
  private static matchesPlaylistFilter(
    session: Prisma.SessionGetPayload<{ select: typeof FILTER_SESSION_SELECT }>,
    filter: PlaylistFilter,
  ): boolean {
    for (const c of filter.conditions ?? []) {
      if (!PlaylistsService.matchesCondition(session, c)) return false;
    }
    return true;
  }

  private static matchesCondition(
    s: Prisma.SessionGetPayload<{ select: typeof FILTER_SESSION_SELECT }>,
    c: PlaylistCondition,
  ): boolean {
    const isTrue = c.value === "true";
    const wantPositive = c.op === "!=" ? !isTrue : isTrue;
    const num = (v: number) => PlaylistsService.cmpNum(v, c.value, c.op);
    const str = (v: string | null | undefined) =>
      PlaylistsService.cmpStr(v ?? "", c.value, c.op);
    /** Exact match on a device/geo value, honouring the = / != operator. */
    const env = (v: string | null | undefined) =>
      c.op === "!=" ? (v ?? null) !== c.value : (v ?? null) === c.value;

    switch (c.field) {
      case "hasErrors":
        return wantPositive ? s.errorCount > 0 : s.errorCount === 0;
      case "hasRageClicks":
        return wantPositive ? s.rageCount > 0 : s.rageCount === 0;
      case "hasDeadClicks":
        return wantPositive ? s.deadCount > 0 : s.deadCount === 0;
      case "duration": {
        // value is seconds; session stores ms.
        const target = Number(c.value);
        if (!Number.isFinite(target)) return true; // matches the SQL "null filter → no-op"
        return PlaylistsService.cmpNum(
          s.durationMs,
          String(target * 1000),
          c.op,
        );
      }
      case "pageCount":
        return num(s.pageCount);
      case "errorCount":
        return num(s.errorCount);
      case "startUrl":
        return str(s.startUrl);
      // The session's OWN device/geo, falling back to the user row only while
      // the session's is null — mirroring envClause() above. Reading EndUser
      // directly meant an AUTO playlist for "device = Mobile" claimed a user's
      // desktop sessions whenever their latest batch happened to be mobile.
      case "browser":
        return env(s.browser ?? s.endUser?.browser);
      case "os":
        return env(s.os ?? s.endUser?.os);
      case "device":
        return env(s.device ?? s.endUser?.device);
      case "country":
        return env(s.country ?? s.endUser?.country);
      case "plan":
        return c.op === "!="
          ? (s.endUser?.plan ?? null) !== c.value
          : (s.endUser?.plan ?? null) === c.value;
      default:
        return true; // unknown field → silently passes, matching `conditionToWhere`
    }
  }

  private static cmpNum(a: number, raw: string, op: string): boolean {
    const b = Number(raw);
    if (!Number.isFinite(b)) return true; // matches "filter drops the clause"
    switch (op) {
      case ">":
        return a > b;
      case ">=":
        return a >= b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case "!=":
        return a !== b;
      case "=":
      default:
        return a === b;
    }
  }

  private static cmpStr(a: string, raw: string, op: string): boolean {
    const A = a.toLowerCase();
    const B = (raw ?? "").toLowerCase();
    switch (op) {
      case "contains":
        return A.includes(B);
      case "startsWith":
        return A.startsWith(B);
      case "endsWith":
        return A.endsWith(B);
      case "!=":
        return a !== raw;
      case "=":
      default:
        return a === raw;
    }
  }

  /**
   * Cron-driven sweep of all AUTO playlists in the workspace.
   *
   * Each `refresh()` runs a unique filter against the sessions table —
   * the work per playlist is genuinely different, so this isn't a
   * collapse-into-one-query case. We DO run the refreshes concurrently
   * via Promise.all rather than sequential await so wall-clock time is
   * one playlist's latency, not N. The DB handles ~20 concurrent
   * filter scans comfortably; if a workspace ever has 500 we may need
   * to add a concurrency limiter, but the take cap keeps us bounded.
   */
  async refreshAllAuto(workspaceId: number) {
    const autos = await this.db.playlist.findMany({
      where: { workspaceId, kind: "AUTO" },
      select: { id: true },
      take: 500,
    });
    const results = await Promise.all(
      autos.map((p) =>
        this.refresh(workspaceId, p.id).catch(() => ({ refreshed: 0 })),
      ),
    );
    const total = results.reduce((a, r) => a + r.refreshed, 0);
    return { workspaceId, playlists: autos.length, totalMembers: total };
  }

  async get(workspaceId: number, id: number) {
    const row = await this.db.playlist.findFirst({
      where: { id, workspaceId },
      include: { owner: PLAYLIST_OWNER_SELECT, _count: { select: { sessions: true } } },
    });
    if (!row) throw new NotFoundException("Playlist not found");
    return this.toSummary(row);
  }

  async update(
    workspaceId: number,
    id: number,
    body: {
      title?: string;
      description?: string;
      pinned?: boolean;
      filter?: unknown;
    },
  ) {
    await this.assertExists(workspaceId, id);
    const row = await this.db.playlist.update({
      where: { id },
      data: {
        title: body.title,
        description: body.description,
        pinned: body.pinned,
        filter: body.filter as Prisma.InputJsonValue,
      },
      include: { owner: PLAYLIST_OWNER_SELECT, _count: { select: { sessions: true } } },
    });
    return this.toSummary(row);
  }

  async remove(workspaceId: number, id: number) {
    await this.assertExists(workspaceId, id);
    await this.db.playlist.delete({ where: { id } });
    this.stats.bump(workspaceId, { playlistsTotal: -1 }).catch(() => {});
    return { id };
  }

  async listSessions(
    workspaceId: number,
    id: number,
    cursor?: string,
    limit?: string,
  ) {
    await this.assertExists(workspaceId, id);
    const take = parseLimit(limit, 25, 100);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.playlistSession.findMany({
      where: {
        playlistId: id,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      // Exactly the 10 fields the row below renders. This used to
      // `include: { session: { include: { endUser: true } } }`, i.e. the whole
      // Session (~60 cols) AND the whole EndUser (23) per row per page — both
      // customProps blobs, eventNames, the BigInt counters and
      // every perf metric — to show a name and six numbers. Postgres TOASTs
      // large jsonb, so each unread blob was its own side-table fetch.
      select: {
        id: true,
        addedAt: true,
        session: {
          select: {
            id: true,
            publicId: true,
            durationMs: true,
            startedAt: true,
            startUrl: true,
            rageCount: true,
            errorCount: true,
            endUser: {
              select: { name: true, email: true, initials: true },
            },
          },
        },
      },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((m) => ({
        id: m.id,
        addedAt: m.addedAt.toISOString(),
        session: {
          id: m.session.id,
          publicId: m.session.publicId,
          durationMs: m.session.durationMs,
          startedAt: m.session.startedAt.toISOString(),
          startUrl: m.session.startUrl,
          rageCount: m.session.rageCount,
          errorCount: m.session.errorCount,
          endUser: m.session.endUser
            ? {
                name: m.session.endUser.name,
                email: m.session.endUser.email,
                initials: m.session.endUser.initials,
              }
            : null,
        },
      })),
      nextCursor,
    );
  }

  /**
   * Accept either a numeric session id or a `ses_…` public id. The player
   * passes the publicId because that's what the URL uses; the recordings
   * table passes the numeric apiId.
   */
  async addSession(
    workspaceId: number,
    playlistId: number,
    sessionRef: number | string,
  ) {
    await this.assertExists(workspaceId, playlistId);
    const sessionId = await this.resolveSessionId(workspaceId, sessionRef);
    const member = await this.db.playlistSession.upsert({
      where: { playlistId_sessionId: { playlistId, sessionId } },
      create: { playlistId, sessionId },
      update: {},
    });
    await this.db.playlist.update({
      where: { id: playlistId },
      data: {
        itemCount: await this.db.playlistSession.count({
          where: { playlistId },
        }),
      },
    });
    return { id: member.id, playlistId, sessionId };
  }

  private async resolveSessionId(
    workspaceId: number,
    ref: number | string,
  ): Promise<number> {
    if (typeof ref === "number" && Number.isFinite(ref)) return ref;
    const s = String(ref);
    if (/^\d+$/.test(s)) return Number(s);
    const row = await this.db.session.findFirst({
      where: { publicId: s, workspaceId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("Session not found");
    return row.id;
  }

  async removeSession(
    workspaceId: number,
    playlistId: number,
    sessionId: number,
  ) {
    await this.assertExists(workspaceId, playlistId);
    await this.db.playlistSession
      .delete({ where: { playlistId_sessionId: { playlistId, sessionId } } })
      .catch(() => undefined);
    await this.db.playlist.update({
      where: { id: playlistId },
      data: {
        itemCount: await this.db.playlistSession.count({
          where: { playlistId },
        }),
      },
    });
    return { playlistId, sessionId, removed: true };
  }

  private async assertExists(workspaceId: number, id: number) {
    // Existence check only — it reads no fields, so don't hydrate the row (and
    // its `filter` Json) just to test for null.
    const row = await this.db.playlist.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("Playlist not found");
  }

  // The summary accepts the include-with-sessions shape for listings *or*
  // the lighter shape used by create/update/refresh — both pass through.
  private toSummary = (
    p: Prisma.PlaylistGetPayload<{
      include: { owner: typeof PLAYLIST_OWNER_SELECT; _count: { select: { sessions: true } } };
    }>,
  ) => {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      pinned: p.pinned,
      kind: p.kind,
      filter: p.filter,
      itemCount: p._count.sessions,
      owner: p.owner
        ? { id: p.owner.id, name: p.owner.name, email: p.owner.email }
        : null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  };

  // -------------------------------------------------------------------------
  //  Playlist filter compiler (static — pure transformation, no `this` deps)
  // -------------------------------------------------------------------------

  /**
   * Translate the playlist's user-supplied condition list into a Prisma
   * SessionWhereInput. Conditions are ANDed together. Unknown fields are
   * dropped silently rather than throwing — we'd rather show *some* matches
   * than 500 an admin who fat-fingered an old field name.
   */
  private static filterToWhere(
    workspaceId: number,
    filter: PlaylistFilter,
  ): Prisma.SessionWhereInput {
    const ands: Prisma.SessionWhereInput[] = [{ workspaceId }];
    for (const c of filter.conditions ?? []) {
      const clause = PlaylistsService.conditionToWhere(c);
      if (clause) ands.push(clause);
    }
    return ands.length === 1 ? ands[0] : { AND: ands };
  }

  // Build a comparator clause from any numeric Prisma field. The dashboard
  // playlist editor allows >, <, >=, <=, =, != — translate each into the
  // matching Prisma filter atom. Returns null for invalid numbers so the
  // caller can drop the condition silently.
  private static numericClause(
    value: string,
    op: string,
  ): Prisma.IntFilter | null {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    switch (op) {
      case ">":
        return { gt: n };
      case ">=":
        return { gte: n };
      case "<":
        return { lt: n };
      case "<=":
        return { lte: n };
      case "!=":
        return { not: n };
      case "=":
      default:
        return { equals: n };
    }
  }

  // Build a string-comparison clause covering equals / contains / startsWith /
  // endsWith / not-equals. Used for `startUrl` and any enum field that the
  // dashboard models as "is" / "is not".
  private static stringClause(
    value: string,
    op: string,
  ): Prisma.StringFilter | string {
    switch (op) {
      case "contains":
        return { contains: value, mode: "insensitive" };
      case "startsWith":
        return { startsWith: value, mode: "insensitive" };
      case "endsWith":
        return { endsWith: value, mode: "insensitive" };
      case "!=":
        return { not: value };
      case "=":
      default:
        return value;
    }
  }

  private static conditionToWhere(
    c: PlaylistCondition,
  ): Prisma.SessionWhereInput | null {
    const isTrue = c.value === "true";
    // For bool fields the dashboard sends value=true/false plus op = / !=.
    // != with "true" means "is not true" → errorCount = 0. Same logic for the
    // other has* booleans below.
    const wantPositive = c.op === "!=" ? !isTrue : isTrue;
    switch (c.field) {
      case "hasErrors":
        return wantPositive
          ? { errorCount: { gt: 0 } }
          : { errorCount: { equals: 0 } };
      case "hasRageClicks":
        return wantPositive
          ? { rageCount: { gt: 0 } }
          : { rageCount: { equals: 0 } };
      case "hasDeadClicks":
        return wantPositive
          ? { deadCount: { gt: 0 } }
          : { deadCount: { equals: 0 } };
      case "duration": {
        // `value` is in SECONDS in the UI; sessions store ms. Convert here.
        const n = Number(c.value) * 1000;
        if (!Number.isFinite(n)) return null;
        const f = PlaylistsService.numericClause(String(n), c.op);
        return f ? { durationMs: f } : null;
      }
      case "pageCount": {
        const f = PlaylistsService.numericClause(c.value, c.op);
        return f ? { pageCount: f } : null;
      }
      case "errorCount": {
        const f = PlaylistsService.numericClause(c.value, c.op);
        return f ? { errorCount: f } : null;
      }
      case "startUrl": {
        const clause = PlaylistsService.stringClause(c.value, c.op);
        return { startUrl: clause as Prisma.StringNullableFilter };
      }
      case "browser":
        return PlaylistsService.envClause("browser", c);
      case "os":
        return PlaylistsService.envClause("os", c);
      case "device":
        return PlaylistsService.envClause("device", c);
      case "country":
        return PlaylistsService.envClause("country", c);
      case "plan":
        // plan is genuinely user-level — a property of the person, not the
        // device or place a given session came from.
        return {
          endUser:
            c.op === "!=" ? { plan: { not: c.value } } : { plan: c.value },
        };
      default:
        return null;
    }
  }

  /**
   * Match a device/geo field against the SESSION's own value, falling back to
   * the EndUser copy only while the session's is still null (web rows ingested
   * before those columns existed).
   *
   * These used to read EndUser directly, which is last-write-wins across every
   * device a person uses — so an AUTO playlist for "device = Mobile" silently
   * claimed that user's DESKTOP sessions whenever their most recent batch came
   * from a phone. Same shape as the recordings filter in sessions.service.
   */
  private static envClause(
    col: "browser" | "os" | "device" | "country",
    c: PlaylistCondition,
  ): Prisma.SessionWhereInput {
    const own = c.op === "!=" ? { not: c.value } : c.value;
    return {
      OR: [
        { [col]: own },
        { AND: [{ [col]: null }, { endUser: { [col]: own } }] },
      ],
    };
  }
}

interface PlaylistCondition {
  field: string;
  op: string;
  value: string;
}
interface PlaylistFilter {
  conditions?: PlaylistCondition[];
}
