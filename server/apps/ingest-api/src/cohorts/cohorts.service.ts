import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import type { Redis } from "ioredis";
import { countryFilterToIso2 } from "../common/geo";
import {
  getPostgresClient,
  Prisma,
  type CohortKind,
} from "@replay/db-postgres";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";
import { REDIS_CLIENT } from "../common/redis.module";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";

/**
 * Cohort filter shape (matches what the dashboard builder produces):
 *
 *   { type: "and", groups: [ { type: "or", conditions: [Condition, ...] }, ... ] }
 *
 * Each condition is { field, op, value }. We translate the whole thing into a
 * Prisma `EndUser.findMany` where-clause. Anything we don't recognise becomes
 * a no-op (returns true for that condition).
 */
export interface Condition {
  field: string;
  op: string;
  value: unknown;
}
export interface Group {
  type: "or";
  conditions: Condition[];
}
export interface CohortFilter {
  type: "and";
  groups: Group[];
}

/**
 * The 3 owner fields a cohort row shows. `owner: true` hydrated the whole User —
 * passwordHash included — into the API process on every cohorts list page. The
 * mapper only ever emits id/name/email, so this was never a leak; it's about not
 * keeping a credential in memory to render a name.
 */
const COHORT_OWNER_SELECT = {
  select: { id: true, name: true, email: true },
} as const;

@Injectable()
export class CohortsService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly stats: WorkspaceStatsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // Filter compiler — translates the dashboard builder's saved tree
  // (AND-of-OR-of-conditions) into a Prisma where clause. Kept as
  // static methods inside the class so they're scoped + testable
  // together rather than free-floating module helpers.
  private static conditionToWhere(
    c: Condition,
  ): Prisma.EndUserWhereInput | null {
    const v = c.value;
    const F = c.field;
    // Country is stored as an ISO-2 code ("NG") but the picker sends a display
    // name ("Nigeria"); normalise it (and each value of an `in` list) so the
    // exact-match ops actually hit. Every other field passes through unchanged.
    const nc = (x: unknown): unknown =>
      F === "country" && typeof x === "string"
        ? (countryFilterToIso2(x) ?? x)
        : x;
    if (
      [
        "plan",
        "browser",
        "os",
        "device",
        "country",
        "city",
        "email",
        "name",
        "distinctId",
      ].includes(F)
    ) {
      const key = F as keyof Prisma.EndUserWhereInput;
      // Case-INSENSITIVE equality for these categorical/text fields. The UI and
      // the ingest path don't always agree on casing (e.g. "iOS" vs "ios",
      // "Mobile" vs "mobile", or an email typed in a different case), which made
      // exact `=`/`≠` silently match nothing. contains/startsWith already used
      // insensitive mode; this makes `=`/`≠` consistent with them.
      if (c.op === "=")
        return {
          [key]: { equals: String(nc(v)), mode: "insensitive" },
        } as Prisma.EndUserWhereInput;
      if (c.op === "≠" || c.op === "!=")
        return {
          NOT: { [key]: { equals: String(nc(v)), mode: "insensitive" } },
        } as Prisma.EndUserWhereInput;
      if (c.op === "contains")
        return {
          [key]: { contains: String(v), mode: "insensitive" },
        } as Prisma.EndUserWhereInput;
      if (c.op === "startsWith")
        return {
          [key]: { startsWith: String(v), mode: "insensitive" },
        } as Prisma.EndUserWhereInput;
      if (c.op === "endsWith")
        return {
          [key]: { endsWith: String(v), mode: "insensitive" },
        } as Prisma.EndUserWhereInput;
      if (c.op === "in" && Array.isArray(v))
        return {
          [key]: { in: v.map(nc) as never[] },
        } as Prisma.EndUserWhereInput;
      return null;
    }
    if (F === "is_online") {
      return { isOnline: c.op === "is_true" || c.op === "=" || v === true };
    }
    if (F === "last_seen") {
      const days = Number(v) || 0;
      if (days <= 0) return null;
      const cutoff = new Date(Date.now() - days * 86400000);
      if (c.op === "within_last_days") return { lastSeenAt: { gte: cutoff } };
      if (c.op === "more_than_days_ago") return { lastSeenAt: { lt: cutoff } };
      return null;
    }
    if (F === "sessions_count") {
      const n = Number(v) || 0;
      // Translate to a relation count via `sessions: { some: ... }` — Prisma can't
      // count + compare directly without raw SQL, so we approximate with "has at
      // least N sessions" using nested cursor. For ≥1 this is just `some: {}`.
      if (c.op === "≥" && n <= 1) return { sessions: { some: {} } };
      if (c.op === ">" && n < 1) return { sessions: { some: {} } };
      if (c.op === "=" && n === 0) return { sessions: { none: {} } };
      // For N > 1, fall back to a custom approach handled by the evaluator below.
      return {
        __sessionsCount: { op: c.op, value: n },
      } as unknown as Prisma.EndUserWhereInput;
    }
    // Behavioral: fired (or didn't fire) a tracked event. Session.eventNames is
    // the Postgres mirror of a session's track-event names, so "user did X" is a
    // relation check — no ClickHouse round-trip. This is what makes a "payment
    // completers" cohort a REAL cohort instead of matching everyone.
    if (F === "event") {
      const ev = String(v ?? "").trim();
      if (!ev) return null;
      const fired = { sessions: { some: { eventNames: { has: ev } } } };
      const notFired = { sessions: { none: { eventNames: { has: ev } } } };
      if (["fired", "did", "=", "is"].includes(c.op)) return fired;
      if (["not_fired", "didNot", "≠", "!=", "is_not"].includes(c.op))
        return notFired;
      return fired; // default: fired
    }
    return null;
  }

  private static groupToWhere(g: Group): Prisma.EndUserWhereInput {
    const parts = g.conditions
      .map((c) => CohortsService.conditionToWhere(c))
      .filter(Boolean) as Prisma.EndUserWhereInput[];
    return parts.length === 0 ? {} : { OR: parts };
  }

  private static filterToWhere(
    filter: CohortFilter | undefined,
  ): Prisma.EndUserWhereInput {
    if (!filter?.groups?.length) return {};
    return { AND: filter.groups.map((g) => CohortsService.groupToWhere(g)) };
  }

  /** Every condition field the cohort engine understands (dashboard + AI). */
  static readonly SUPPORTED_FIELDS = new Set([
    "plan",
    "browser",
    "os",
    "device",
    "country",
    "city",
    "email",
    "name",
    "distinctId",
    "is_online",
    "last_seen",
    "sessions_count",
    "event",
  ]);

  /**
   * Keep only conditions that (a) name a supported field AND (b) compile to a
   * non-null where. A supported field paired with an incompatible op
   * (e.g. `last_seen` with `=`) compiles to null, and a group whose conditions
   * ALL compile to null collapses to `{}` in `groupToWhere` — which Prisma
   * reads as "no constraint" = match EVERYONE. Validating that each condition
   * compiles (not just that its field is supported) is what makes
   * normalizeFilter's "reject the inexpressible" guarantee actually hold.
   */
  private static validConditions(conds: Condition[]): Condition[] {
    return (Array.isArray(conds) ? conds : []).filter(
      (c) =>
        c &&
        typeof c.field === "string" &&
        CohortsService.SUPPORTED_FIELDS.has(c.field) &&
        CohortsService.conditionToWhere(c) != null,
    );
  }

  /**
   * Normalise an arbitrary filter into a VALID canonical CohortFilter, or null
   * when it can't be expressed. This is the guard that stops a garbage filter
   * (e.g. the AI's old `{event,converted,sinceDays}`) from silently matching
   * everyone: a null result must be rejected by the caller, never stored.
   * Accepts the canonical `{type:"and",groups:[…]}` shape (dropping any
   * condition that doesn't compile) plus the shorthands the AI tends to send —
   * `{event:"…"}` / `{kind:"event",value:"…"}` and top-level attribute keys.
   */
  static normalizeFilter(raw: unknown): CohortFilter | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    // Already canonical — keep only conditions that actually compile.
    if (Array.isArray(r.groups)) {
      const groups: Group[] = [];
      for (const g of r.groups as Array<Record<string, unknown>>) {
        const valid = CohortsService.validConditions(
          Array.isArray(g?.conditions) ? (g.conditions as Condition[]) : [],
        );
        if (valid.length > 0) groups.push({ type: "or", conditions: valid });
      }
      return groups.length > 0 ? { type: "and", groups } : null;
    }
    // Shorthand: "fired event X".
    const ev =
      typeof r.event === "string" && r.event.trim()
        ? r.event.trim()
        : r.kind === "event" && typeof r.value === "string" && r.value.trim()
          ? r.value.trim()
          : null;
    if (ev) {
      return {
        type: "and",
        groups: [
          {
            type: "or",
            conditions: [{ field: "event", op: "fired", value: ev }],
          },
        ],
      };
    }
    // Shorthand: top-level supported attribute keys (e.g. {plan:"pro"}). Emit the
    // op that actually COMPILES for each field — a blanket "=" is invalid for
    // last_seen (needs within_last_days) / sessions_count and would otherwise
    // collapse the group to match-everyone. validConditions then drops any that
    // still don't compile, and an all-dropped filter is rejected (null).
    const conditions: Condition[] = [];
    for (const [k, val] of Object.entries(r)) {
      if (
        CohortsService.SUPPORTED_FIELDS.has(k) &&
        (typeof val === "string" || typeof val === "number")
      ) {
        const op =
          k === "last_seen"
            ? "within_last_days"
            : k === "sessions_count"
              ? "≥"
              : "=";
        conditions.push({ field: k, op, value: val });
      }
    }
    const valid = CohortsService.validConditions(conditions);
    return valid.length > 0
      ? { type: "and", groups: [{ type: "or", conditions: valid }] }
      : null;
  }

  // Strip the `__sessionsCount` placeholder marker so Prisma doesn't choke on
  // an unknown key. (We use it to flag the not-yet-implemented N>1 case.)
  private static sanitizeWhere(w: Record<string, unknown>): void {
    if (!w) return;
    for (const key of Object.keys(w)) {
      if (key === "__sessionsCount") {
        delete w[key];
        continue;
      }
      const v = w[key];
      if (v && typeof v === "object")
        CohortsService.sanitizeWhere(v as Record<string, unknown>);
    }
  }

  /**
   * Compile a saved cohort filter into a Prisma EndUser where, RESOLVING the
   * `sessions_count` conditions that `conditionToWhere` can only emit as a
   * `__sessionsCount` sentinel (op vs N where a plain relation `some`/`none`
   * can't express the count — e.g. `≥ 5`, `= 3`, `≤ 2`). Each sentinel is
   * turned into a concrete, indexed `id IN (…)` predicate sourced from ONE
   * set-based `GROUP BY … HAVING count(*)` per distinct (op,N) over Session —
   * backed by @@index([workspaceId, endUserId]), never a per-user count loop.
   *
   * This is the guard that stops a STRIPPED sentinel from collapsing the group
   * to `{}` — which Prisma reads as "no constraint" = match the ENTIRE
   * workspace. (Before this, every behavioral `sessions_count ≥ N` cohort
   * silently contained all users.) Attribute/relation/event conditions pass
   * through untouched; a filter with no sentinel does zero extra queries.
   */
  private async compileWhere(
    workspaceId: number,
    filter: CohortFilter | undefined,
  ): Promise<Prisma.EndUserWhereInput> {
    const where = {
      workspaceId,
      ...CohortsService.filterToWhere(filter),
    } as Record<string, unknown>;

    // Find every sentinel leaf `{ __sessionsCount: { op, value } }` in the tree
    // (collect first, mutate after — never mutate mid-walk).
    const leaves: Array<{
      node: Record<string, unknown>;
      op: string;
      value: number;
    }> = [];
    const walk = (o: unknown): void => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) {
        for (const el of o) walk(el);
        return;
      }
      const rec = o as Record<string, unknown>;
      const sc = rec.__sessionsCount as
        { op?: unknown; value?: unknown } | undefined;
      if (sc && typeof sc.op === "string" && typeof sc.value === "number") {
        leaves.push({ node: rec, op: sc.op, value: sc.value });
      }
      for (const v of Object.values(rec)) walk(v);
    };
    walk(where);

    if (leaves.length > 0) {
      // op → SQL comparator. Fixed whitelist, NEVER user-derived, so the raw
      // fragment can't be injected; the count value is parameterized. An
      // unknown op resolves to the empty set → match NOBODY (never everyone).
      const CMP: Record<string, string> = {
        "≥": ">=",
        ">": ">",
        "=": "=",
        "≤": "<=",
        "<": "<",
      };
      const cache = new Map<string, number[]>();
      for (const leaf of leaves) {
        const key = `${leaf.op}:${leaf.value}`;
        if (!cache.has(key)) {
          const cmp = CMP[leaf.op];
          // Set-based aggregate — which identified users in this workspace have
          // a session count matching the predicate. Grouped scan over the
          // (workspaceId, endUserId) index; bounded by the same 100k ceiling
          // refresh() caps the member set at.
          const rows = cmp
            ? await this.db.$queryRaw<Array<{ endUserId: number }>>(Prisma.sql`
                SELECT "endUserId"
                FROM "Session"
                WHERE "workspaceId" = ${workspaceId} AND "endUserId" IS NOT NULL
                GROUP BY "endUserId"
                HAVING count(*) ${Prisma.raw(cmp)} ${leaf.value}
                ORDER BY "endUserId"
                LIMIT 100000
              `)
            : [];
          cache.set(
            key,
            rows.map((r) => Number(r.endUserId)),
          );
        }
        delete leaf.node.__sessionsCount;
        leaf.node.id = { in: cache.get(key) ?? [] };
      }
    }

    // Strip any stray sentinel (defensive) and return a pure Prisma where.
    CohortsService.sanitizeWhere(where);
    return where as Prisma.EndUserWhereInput;
  }

  async list(
    workspaceId: number,
    userId: number,
    opts: {
      cursor?: string;
      limit?: string;
      kind?: CohortKind;
      search?: string;
    },
  ) {
    const take = parseLimit(opts.limit, 25, 100);
    const cursorId = decodeCursor(opts.cursor);
    const where: Prisma.CohortWhereInput = { workspaceId };
    if (opts.kind) where.kind = opts.kind;
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: "insensitive" } },
        { description: { contains: opts.search, mode: "insensitive" } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.db.cohort.findMany({
        where:
          cursorId !== undefined ? { ...where, id: { lt: cursorId } } : where,
        orderBy: { id: "desc" },
        include: { owner: COHORT_OWNER_SELECT },
        take: take + 1,
      }),
      // Workspace total — counted only on the FIRST page so the header stat
      // stays exact as pages load (matching the sessions list). The count filter
      // is workspace-scoped + indexed; cohort counts are small.
      cursorId === undefined
        ? this.db.cohort.count({ where })
        : Promise.resolve(undefined),
    ]);
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((c) => this.toSummary(c)),
      nextCursor,
      total !== undefined ? { value: total, capped: false } : undefined,
    );
  }

  async create(
    workspaceId: number,
    userId: number,
    body: {
      name: string;
      description?: string;
      kind?: CohortKind;
      filter?: unknown;
      /** Set by the assistant's `cohort.create` capability — provenance only, so
       *  the UI can badge it "Created with Replayfy AI". User-made cohorts omit it. */
      createdByAi?: boolean;
    },
  ) {
    const row = await this.db.cohort.create({
      data: {
        workspaceId,
        ownerId: userId,
        name: body.name,
        description: body.description,
        kind: body.kind ?? "MANUAL",
        createdByAi: body.createdByAi === true,
        filter: body.filter as Prisma.InputJsonValue,
      },
      include: { owner: COHORT_OWNER_SELECT },
    });
    // Seed members immediately for AUTO cohorts so the list shows real
    // counts without waiting for the cron / manual Precompute click.
    if (row.kind === "AUTO" && row.filter) {
      const fresh = await this.refresh(workspaceId, row.id).catch(() => null);
      if (fresh) {
        this.stats.bump(workspaceId, { cohortsTotal: 1 }).catch(() => {});
        return fresh;
      }
    }
    this.stats.bump(workspaceId, { cohortsTotal: 1 }).catch(() => {});
    return this.toSummary(row);
  }

  /**
   * In-memory evaluator that mirrors `conditionToWhere` + `groupToWhere`
   * + `filterToWhere`. AND-of-OR semantics:
   *   - All groups must match (AND)
   *   - Within each group, any one condition matching is enough (OR)
   *
   * Returns true on empty filter (matches the Prisma `{}` behavior).
   */
  private static matchesCohortFilter(
    user: Prisma.EndUserGetPayload<Record<string, never>>,
    sessionsCount: number,
    firedEvents: string[],
    filter: CohortFilter | undefined,
  ): boolean {
    if (!filter?.groups?.length) return true;
    for (const g of filter.groups) {
      const conditions = g.conditions ?? [];
      if (conditions.length === 0) continue;
      const anyMatch = conditions.some((c) =>
        CohortsService.matchesCohortCondition(
          user,
          sessionsCount,
          firedEvents,
          c,
        ),
      );
      if (!anyMatch) return false;
    }
    return true;
  }

  private static matchesCohortCondition(
    user: Prisma.EndUserGetPayload<Record<string, never>>,
    sessionsCount: number,
    firedEvents: string[],
    c: Condition,
  ): boolean {
    const F = c.field;
    const v = c.value;
    // Mirrors the string-field branch of conditionToWhere — same fields,
    // same operator set. Case-insensitive where Prisma was insensitive.
    if (
      [
        "plan",
        "browser",
        "os",
        "device",
        "country",
        "city",
        "email",
        "name",
        "distinctId",
      ].includes(F)
    ) {
      const raw = (user as Record<string, unknown>)[F];
      const userValue = raw == null ? "" : String(raw);
      const filterValue = String(v ?? "");
      // `=`/`≠` are case-INSENSITIVE to mirror conditionToWhere's
      // mode:"insensitive" — the SQL path (create/refresh/nightly reconcile)
      // and this in-JS drainer path MUST agree, else a mixed-case cohort
      // (os = "ios" vs stored "iOS") flaps membership every drain/reconcile.
      if (c.op === "=")
        return userValue.toLowerCase() === filterValue.toLowerCase();
      if (c.op === "≠" || c.op === "!=")
        return userValue.toLowerCase() !== filterValue.toLowerCase();
      if (c.op === "contains")
        return userValue.toLowerCase().includes(filterValue.toLowerCase());
      if (c.op === "startsWith")
        return userValue.toLowerCase().startsWith(filterValue.toLowerCase());
      if (c.op === "endsWith")
        return userValue.toLowerCase().endsWith(filterValue.toLowerCase());
      if (c.op === "in" && Array.isArray(v))
        return (v as unknown[]).map(String).includes(userValue);
      return false;
    }
    if (F === "is_online") {
      const wantTrue = c.op === "is_true" || c.op === "=" || v === true;
      return wantTrue ? !!user.isOnline : !user.isOnline;
    }
    if (F === "last_seen") {
      const days = Number(v) || 0;
      if (days <= 0) return true; // conditionToWhere returns null → no-op
      const cutoffMs = Date.now() - days * 86400000;
      const lastSeen = user.lastSeenAt ? user.lastSeenAt.getTime() : 0;
      if (c.op === "within_last_days") return lastSeen >= cutoffMs;
      if (c.op === "more_than_days_ago") return lastSeen < cutoffMs;
      return false;
    }
    if (F === "sessions_count") {
      const n = Number(v) || 0;
      switch (c.op) {
        case "≥":
          return sessionsCount >= n;
        case ">":
          return sessionsCount > n;
        case "=":
          return sessionsCount === n;
        default:
          return true;
      }
    }
    if (F === "event") {
      const ev = String(v ?? "").trim();
      if (!ev) return true; // conditionToWhere returns null → no-op
      const did = firedEvents.includes(ev);
      if (["not_fired", "didNot", "≠", "!=", "is_not"].includes(c.op))
        return !did;
      return did; // fired / did / = / is (default)
    }
    return false;
  }

  /**
   * Cron-driven sweep — refreshes every AUTO cohort in a workspace.
   * Each refresh does unique filter work, so we can't collapse into
   * one query. We DO run them concurrently via Promise.all so total
   * wall time = max(refresh latency) instead of sum.
   */
  async refreshAllAuto(workspaceId: number) {
    const autos = await this.db.cohort.findMany({
      where: {
        workspaceId,
        kind: "AUTO",
        NOT: { filter: { equals: Prisma.JsonNull } },
      },
      select: { id: true },
      take: 500,
    });
    const results = await Promise.all(
      autos.map((c) => this.refresh(workspaceId, c.id).catch(() => null)),
    );
    const total = results.reduce((a, r) => a + (r?.membersCount ?? 0), 0);
    return { workspaceId, cohorts: autos.length, totalMembers: total };
  }

  // ---- Incremental attribute-cohort maintenance -------------------------
  // Cohort membership has two drivers with very different cost profiles:
  //   • STATIC attributes (plan/browser/os/device/country/city/email/name/
  //     distinctId) change only on an identify/edit — rare, and a one-row check.
  //   • ACTIVITY (sessions_count, event, is_online, last_seen) changes on every
  //     session or with the passage of time — frequent, and an aggregate.
  // Recomputing every cohort every 5 min paid the activity cost for everything.
  // Instead: attribute-only cohorts are maintained INCREMENTALLY (a user is
  // marked dirty ONLY when a static attr actually changed; a 15s drainer
  // re-evaluates just those users and applies +/- deltas), while cohorts that
  // reference any activity field are recomputed on a slower cron (behavioral).

  private static readonly ACTIVITY_FIELDS = new Set([
    "sessions_count",
    "event",
    "is_online",
    "last_seen",
  ]);

  /** A cohort is "behavioral" (→ periodic recompute) if any condition references
   *  an activity/time field; otherwise attribute-only (→ incremental drainer). */
  static isBehavioral(filter: CohortFilter | undefined): boolean {
    if (!filter?.groups) return false;
    for (const g of filter.groups)
      for (const c of g.conditions ?? [])
        if (CohortsService.ACTIVITY_FIELDS.has(c.field)) return true;
    return false;
  }

  private static readonly DIRTY_WS_KEY = "cohort:dirty:ws";
  private dirtyUserKey(workspaceId: number): string {
    return `cohort:dirty:${workspaceId}`;
  }

  /** Mark end-users as needing attribute-cohort re-evaluation. Called from the
   *  ingest path ONLY when a static attribute actually changed (or a user was
   *  created/removed). O(1) Redis SADD — never touches Postgres, so it can't
   *  storm the ingest worker the way the old inline evaluateForUser did. The
   *  15s drainer coalesces: a user marked 500× in the window is evaluated once. */
  async markUsersDirty(
    workspaceId: number,
    endUserIds: number[],
  ): Promise<void> {
    if (endUserIds.length === 0) return;
    await this.redis
      .pipeline()
      .sadd(this.dirtyUserKey(workspaceId), ...endUserIds.map(String))
      .sadd(CohortsService.DIRTY_WS_KEY, String(workspaceId))
      .exec();
  }

  /** Drain the dirty-user set and re-evaluate attribute-only cohort membership.
   *  Runs every 15s on the CRON role (role-gated). Bounded per tick so a burst
   *  can't make one tick unbounded; the rest drains next tick. */
  @Cron("*/15 * * * * *")
  async drainDirtyCohorts(): Promise<void> {
    const batch = Number(process.env.COHORT_DRAIN_BATCH ?? 500);
    const wsList = await this.redis.smembers(CohortsService.DIRTY_WS_KEY);
    for (const wsStr of wsList) {
      const workspaceId = Number(wsStr);
      if (!Number.isFinite(workspaceId)) {
        await this.redis.srem(CohortsService.DIRTY_WS_KEY, wsStr);
        continue;
      }
      const popped = await this.redis.spop(
        this.dirtyUserKey(workspaceId),
        batch,
      );
      const ids = popped.map(Number).filter((n) => Number.isFinite(n));
      // Retire the workspace from the ws-set once its user-set is empty. This
      // is a check-then-act against concurrent markUsersDirty on ingest/API
      // nodes (SADD user → SADD ws): a mark landing between the SCARD and the
      // SREM would be stranded (ws gone from the set → never re-drained until
      // the nightly reconcile). Re-check SCARD AFTER the SREM and re-add the ws
      // if a user reappeared, closing the window.
      const userKey = this.dirtyUserKey(workspaceId);
      if ((await this.redis.scard(userKey)) === 0) {
        await this.redis.srem(CohortsService.DIRTY_WS_KEY, wsStr);
        if ((await this.redis.scard(userKey)) > 0) {
          await this.redis.sadd(CohortsService.DIRTY_WS_KEY, wsStr);
        }
      }
      if (ids.length === 0) continue;
      await this.evaluateAttributeCohorts(workspaceId, ids).catch((e) => {
        process.stderr.write(
          `cohort drain failed for ws=${workspaceId}: ${(e as Error).message}\n`,
        );
      });
    }
  }

  /** Batched attribute-only cohort evaluation for a set of users. One user load,
   *  one cohort load, in-JS matching (no per-user session query — attribute-only
   *  cohorts don't need it), then per-cohort createMany/deleteMany with a single
   *  DELTA update of membersCount. */
  private async evaluateAttributeCohorts(
    workspaceId: number,
    endUserIds: number[],
  ): Promise<void> {
    const autos = await this.db.cohort.findMany({
      where: {
        workspaceId,
        kind: "AUTO",
        NOT: { filter: { equals: Prisma.JsonNull } },
      },
      select: { id: true, filter: true },
      take: 500,
    });
    const attrCohorts = autos.filter(
      (c) => !CohortsService.isBehavioral(c.filter as unknown as CohortFilter),
    );
    const users = await this.db.endUser.findMany({
      where: { workspaceId, id: { in: endUserIds } },
    });
    // Popped ids not found = deleted/forgotten users → drop from every cohort.
    if (users.length < endUserIds.length) {
      const present = new Set(users.map((u) => u.id));
      const missing = endUserIds.filter((id) => !present.has(id));
      if (missing.length)
        await this.removeUsersFromAllCohorts(workspaceId, missing);
    }
    if (attrCohorts.length === 0 || users.length === 0) return;

    for (const c of attrCohorts) {
      const filter = c.filter as unknown as CohortFilter;
      const matched: number[] = [];
      const unmatched: number[] = [];
      for (const u of users) {
        (CohortsService.matchesCohortFilter(u, 0, [], filter)
          ? matched
          : unmatched
        ).push(u.id);
      }
      let delta = 0;
      if (matched.length > 0) {
        const ins = await this.db.cohortMember.createMany({
          data: matched.map((endUserId) => ({ cohortId: c.id, endUserId })),
          skipDuplicates: true,
        });
        delta += ins.count;
      }
      if (unmatched.length > 0) {
        const del = await this.db.cohortMember.deleteMany({
          where: { cohortId: c.id, endUserId: { in: unmatched } },
        });
        delta -= del.count;
      }
      if (delta !== 0) {
        await this.db.cohort
          .update({
            where: { id: c.id },
            data: {
              membersCount: { increment: delta },
              lastComputedAt: new Date(),
            },
          })
          .catch(() => {});
      }
    }
  }

  /** Remove users from ALL cohorts in a workspace (on delete/forget),
   *  decrementing each affected cohort's membersCount by how many it held. */
  async removeUsersFromAllCohorts(
    workspaceId: number,
    endUserIds: number[],
  ): Promise<void> {
    if (endUserIds.length === 0) return;
    // Which cohorts hold any of these users (indexed: CohortMember.endUserId +
    // cohort.workspaceId). We only need the DISTINCT cohort ids — the counts
    // come from the deleteMany below, not from this snapshot, so a concurrent
    // add/remove in the gap can't make membersCount drift.
    const members = await this.db.cohortMember.findMany({
      where: { endUserId: { in: endUserIds }, cohort: { workspaceId } },
      select: { cohortId: true },
      distinct: ["cohortId"],
    });
    if (members.length === 0) return;
    // Per-cohort deleteMany so the decrement is exactly the rows THIS call
    // deleted (del.count) — never a value read before the delete.
    await Promise.all(
      members.map(({ cohortId }) =>
        this.db.cohortMember
          .deleteMany({ where: { cohortId, endUserId: { in: endUserIds } } })
          .then((del) =>
            del.count > 0
              ? this.db.cohort.update({
                  where: { id: cohortId },
                  data: { membersCount: { decrement: del.count } },
                })
              : undefined,
          )
          .catch(() => {}),
      ),
    );
  }

  /** Refresh ONLY behavioral/activity cohorts — the ones the incremental drainer
   *  can't own because their membership moves with sessions/time. Driven by the
   *  slower cohort cron; attribute-only cohorts are skipped (they're incremental). */
  async refreshBehavioralCohorts(workspaceId: number) {
    const autos = await this.db.cohort.findMany({
      where: {
        workspaceId,
        kind: "AUTO",
        NOT: { filter: { equals: Prisma.JsonNull } },
      },
      select: { id: true, filter: true },
      take: 500,
    });
    const behavioral = autos.filter((c) =>
      CohortsService.isBehavioral(c.filter as unknown as CohortFilter),
    );
    const results = await Promise.all(
      behavioral.map((c) => this.refresh(workspaceId, c.id).catch(() => null)),
    );
    return {
      workspaceId,
      cohorts: behavioral.length,
      totalMembers: results.reduce((a, r) => a + (r?.membersCount ?? 0), 0),
    };
  }

  /** Nightly drift-reconcile: full-refresh EVERY auto cohort (attribute +
   *  behavioral) so the incremental deltas can't drift indefinitely — a lost
   *  dirty-mark, a failed delta write, or a Redis flush self-heals within a day.
   *  Runs on the CRON role, off-peak, keyset-bounded over the workspaces that
   *  own cohorts (groupBy on Cohort @@index([workspaceId])) — never a fleet-wide
   *  scan. Serial per workspace so it can't spike the pool. */
  @Cron(process.env.COHORT_RECONCILE_CRON || "37 3 * * *")
  async reconcileAllCohortsNightly(): Promise<void> {
    let cursor = 0;
    for (;;) {
      const wss = await this.db.cohort.groupBy({
        by: ["workspaceId"],
        where: { workspaceId: { gt: cursor }, kind: "AUTO" },
        orderBy: { workspaceId: "asc" },
        take: 200,
      });
      if (wss.length === 0) break;
      for (const w of wss) {
        await this.refreshAllAuto(w.workspaceId).catch(() => undefined);
      }
      cursor = wss[wss.length - 1].workspaceId;
      if (wss.length < 200) break;
    }
  }

  async get(workspaceId: number, id: number) {
    const row = await this.db.cohort.findFirst({
      where: { id, workspaceId },
      include: { owner: COHORT_OWNER_SELECT },
    });
    if (!row) throw new NotFoundException("Cohort not found");
    return this.toSummary(row);
  }

  async update(
    workspaceId: number,
    id: number,
    body: { name?: string; description?: string; filter?: unknown },
  ) {
    await this.assertExists(workspaceId, id);
    const row = await this.db.cohort.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        filter: body.filter as Prisma.InputJsonValue,
      },
      include: { owner: COHORT_OWNER_SELECT },
    });
    return this.toSummary(row);
  }

  async remove(workspaceId: number, id: number) {
    await this.assertExists(workspaceId, id);
    await this.db.cohort.delete({ where: { id } });
    this.stats.bump(workspaceId, { cohortsTotal: -1 }).catch(() => {});
    return { id };
  }

  /**
   * Add EndUsers to a MANUAL cohort. AUTO cohorts can't accept manual
   * adds — their membership is derived from the saved filter, so a manual
   * insert would just get blown away on the next refresh. We reject with
   * a 400-ish error in that case rather than silently dropping the row.
   */
  async addMembers(
    workspaceId: number,
    cohortId: number,
    userIds: number[],
    opts: { recount?: boolean } = {},
  ) {
    const cohort = await this.assertExists(workspaceId, cohortId);
    if (cohort.kind !== "MANUAL") {
      throw new ForbiddenException(
        "Auto cohorts derive membership from a filter — switch to manual to add users.",
      );
    }
    const ids = (userIds ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));
    if (ids.length === 0) return { added: 0 };
    // Confirm every user belongs to this workspace before we touch the
    // join table — otherwise an attacker with one workspace's token could
    // attach foreign users.
    const owned = await this.db.endUser.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    const safeIds = owned.map((u) => u.id);
    if (safeIds.length === 0) return { added: 0 };
    // createMany with skipDuplicates so re-adding is a no-op.
    const res = await this.db.cohortMember.createMany({
      data: safeIds.map((userId) => ({ cohortId, endUserId: userId })),
      skipDuplicates: true,
    });
    // Bulk drains (e.g. a drop-off cohort) pass recount:false and refresh the
    // count ONCE after the whole loop via recountMembers — re-counting a growing
    // join table on every page is K counts over the same rows.
    if (opts.recount === false) {
      return { added: res.count };
    }
    // Recompute count so the cohorts list shows the right number without
    // waiting for a full refresh.
    const total = await this.db.cohortMember.count({ where: { cohortId } });
    await this.db.cohort.update({
      where: { id: cohortId },
      data: { membersCount: total, lastComputedAt: new Date() },
    });
    return { added: res.count, total };
  }

  /** Refresh a MANUAL cohort's membersCount from the join table — once, after a
   *  bulk addMembers drain that skipped the per-page recounts. */
  async recountMembers(workspaceId: number, cohortId: number): Promise<number> {
    await this.assertExists(workspaceId, cohortId);
    const total = await this.db.cohortMember.count({ where: { cohortId } });
    await this.db.cohort.update({
      where: { id: cohortId },
      data: { membersCount: total, lastComputedAt: new Date() },
    });
    return total;
  }

  async removeMember(workspaceId: number, cohortId: number, endUserId: number) {
    const cohort = await this.assertExists(workspaceId, cohortId);
    if (cohort.kind !== "MANUAL") {
      throw new ForbiddenException(
        "Auto cohorts derive membership from a filter.",
      );
    }
    await this.db.cohortMember.deleteMany({ where: { cohortId, endUserId } });
    const total = await this.db.cohortMember.count({ where: { cohortId } });
    await this.db.cohort.update({
      where: { id: cohortId },
      data: { membersCount: total, lastComputedAt: new Date() },
    });
    return { removed: true, total };
  }

  async listMembers(
    workspaceId: number,
    id: number,
    cursor?: string,
    limit?: string,
  ) {
    await this.assertExists(workspaceId, id);
    const take = parseLimit(limit, 25, 100);
    const cursorId = decodeCursor(cursor);
    const rows = await this.db.cohortMember.findMany({
      where: {
        cohortId: id,
        ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
      },
      include: { endUser: true },
      orderBy: { id: "desc" },
      take: take + 1,
    });
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    return paginated(
      items.map((m) => ({
        id: m.id,
        addedAt: m.addedAt.toISOString(),
        endUser: {
          id: m.endUser.id,
          name: m.endUser.name,
          email: m.endUser.email,
          plan: m.endUser.plan,
          isOnline: m.endUser.isOnline,
        },
      })),
      nextCursor,
    );
  }

  /**
   * Compute count + first 5 matching users for a candidate filter without saving.
   * Used by the cohort builder for live preview.
   */
  async preview(workspaceId: number, filter: CohortFilter) {
    // Same sentinel-resolving compile as refresh() so the live preview count
    // matches what the cohort will actually contain (not the whole workspace).
    const where = await this.compileWhere(workspaceId, filter);
    const [count, sample] = await Promise.all([
      this.db.endUser.count({ where }),
      this.db.endUser.findMany({
        where,
        take: 5,
        orderBy: { lastSeenAt: "desc" },
        select: {
          id: true,
          name: true,
          email: true,
          initials: true,
          distinctId: true,
          plan: true,
        },
      }),
    ]);
    return { count, sample };
  }

  /** Evaluate the saved filter, wipe + re-insert CohortMember rows. */
  async refresh(workspaceId: number, id: number) {
    await this.assertExists(workspaceId, id);
    const cohort = await this.db.cohort.findUnique({ where: { id } });
    if (!cohort) throw new NotFoundException("Cohort not found");

    if (cohort.kind === "AUTO" && cohort.filter) {
      // Resolves sessions_count>1 conditions to real id-set predicates — a
      // stripped sentinel would otherwise make this select the ENTIRE workspace.
      const where = await this.compileWhere(
        workspaceId,
        cohort.filter as unknown as CohortFilter,
      );
      // Hard cap. Recomputing a cohort the size of the entire user
      // base in one go would OOM the API; 100k is a sane upper bound
      // for a single workspace's identified-user count.
      const matches = await this.db.endUser.findMany({
        where,
        select: { id: true },
        take: 100_000,
      });
      await this.db.$transaction([
        this.db.cohortMember.deleteMany({ where: { cohortId: id } }),
        this.db.cohortMember.createMany({
          data: matches.map((m) => ({ cohortId: id, endUserId: m.id })),
          skipDuplicates: true,
        }),
      ]);
    }

    const count = await this.db.cohortMember.count({ where: { cohortId: id } });
    const updated = await this.db.cohort.update({
      where: { id },
      data: { membersCount: count, lastComputedAt: new Date() },
      include: { owner: COHORT_OWNER_SELECT },
    });
    return this.toSummary(updated);
  }

  private async assertExists(workspaceId: number, id: number) {
    const row = await this.db.cohort.findFirst({ where: { id, workspaceId } });
    if (!row) throw new NotFoundException("Cohort not found");
    return row;
  }

  private toSummary = (
    c: Prisma.CohortGetPayload<{
      include: { owner: typeof COHORT_OWNER_SELECT };
    }>,
  ) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    // Surface the saved filter so the Cohorts page can render the active
    // conditions as chips instead of an empty row.
    filter: c.filter,
    membersCount: c.membersCount,
    lastComputedAt: c.lastComputedAt?.toISOString() ?? null,
    createdByAi: c.createdByAi,
    owner: c.owner
      ? { id: c.owner.id, name: c.owner.name, email: c.owner.email }
      : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  });
}
