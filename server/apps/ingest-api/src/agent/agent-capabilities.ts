import { Injectable, OnModuleInit } from "@nestjs/common";
import { getPostgresClient, PlaylistKind } from "@replay/db-postgres";
import {
  sessionCards,
  querySessions,
  topTrackEvents,
  adhocFunnel,
  type SessionQueryFilter,
} from "@replay/db-clickhouse";
import { IssuesService } from "../issues/issues.service";
import { FunnelsService } from "../funnels/funnels.service";
import { CohortsService } from "../cohorts/cohorts.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { WorkspaceSignalDailyService } from "../workspace-signal-daily/workspace-signal-daily.service";
import { ReleaseService } from "../releases/release.service";
import { InsightsService } from "../insights/insights.service";
import { CommentsService } from "../comments/comments.service";
import { AlertsService } from "../alerts/alerts.service";
import { PlaylistsService } from "../playlists/playlists.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { buildIssueBody } from "../integrations/issue-format.util";
import { ConversionService } from "./conversion.service";
import { ResultSetService } from "./result-set.service";
import { InvestigationService } from "./investigation.service";
import type { AgentContext, ActionPreview } from "./capability";
import { CapabilityRegistry } from "./capability";
import {
  SDK_PLATFORMS,
  SDK_KEYS_SETTINGS_PATH,
  resolveSdkPlatform,
} from "./sdk-install.constants";

/**
 * Registers the Phase-1 capability set into the CapabilityRegistry at module
 * init. Each executor wraps an EXISTING deterministic service — Replayfy owns
 * the analytics; the capability is just the registered, permissioned,
 * workspace-scoped entry point the planner may invoke. Every executor reads
 * workspaceId from ctx (never from input).
 */
@Injectable()
export class AgentCapabilities implements OnModuleInit {
  private readonly db = getPostgresClient();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly issues: IssuesService,
    private readonly funnels: FunnelsService,
    private readonly signalDaily: WorkspaceSignalDailyService,
    private readonly investigation: InvestigationService,
    private readonly dashboard: DashboardService,
    private readonly cohorts: CohortsService,
    private readonly releases: ReleaseService,
    private readonly insights: InsightsService,
    private readonly comments: CommentsService,
    private readonly alerts: AlertsService,
    private readonly playlists: PlaylistsService,
    private readonly integrations: IntegrationsService,
    private readonly conversion: ConversionService,
    private readonly resultSets: ResultSetService,
  ) {}

  /** Resolve a resource's display label WITHIN the workspace, for action
   *  previews. A foreign or missing id degrades to "#<id>" (and the executor's
   *  own workspace-scoped assert then rejects it). */
  private async label(
    kind: "funnel" | "cohort" | "playlist" | "alert",
    workspaceId: number,
    id: number,
  ): Promise<string> {
    if (kind === "funnel") {
      const r = await this.db.funnel.findFirst({
        where: { id, workspaceId },
        select: { name: true },
      });
      return r?.name ? `'${r.name}'` : `#${id}`;
    }
    if (kind === "cohort") {
      const r = await this.db.cohort.findFirst({
        where: { id, workspaceId },
        select: { name: true },
      });
      return r?.name ? `'${r.name}'` : `#${id}`;
    }
    if (kind === "playlist") {
      const r = await this.db.playlist.findFirst({
        where: { id, workspaceId },
        select: { title: true },
      });
      return r?.title ? `'${r.title}'` : `#${id}`;
    }
    const r = await this.db.alert.findFirst({
      where: { id, workspaceId },
      select: { name: true },
    });
    return r?.name ? `'${r.name}'` : `#${id}`;
  }

  /** Build a standard update/delete ActionPreview. */
  private actionPreview(
    operation: "update" | "delete",
    noun: string,
    label: string,
    details: Record<string, unknown>,
  ): ActionPreview {
    const verb = operation === "delete" ? "Delete" : "Update";
    return {
      operation,
      summary: `${verb} ${noun} ${label}`,
      permanent: operation === "delete",
      reversible: operation !== "delete",
      details: { [noun]: label, ...details },
    };
  }

  /**
   * The time windows the agent may ask for.
   *
   * A BOUNDED ENUM, deliberately — not a free-form `sinceDays: number`. The model
   * selects from a set the server defines, so an unbounded or absurd window
   * ("give me 9999 days") is UNREPRESENTABLE rather than merely rejected. That is
   * the same discipline the capability registry itself uses: the model picks a
   * name we minted, it never authors the value.
   *
   * These are exactly the ranges the underlying services already support —
   * dashboard.metrics resolves `{today:1, "24h":1, "7d":7, "30d":30}[range] ?? 7`,
   * so an unknown value was always going to clamp to 7d anyway. Widening this
   * enum beyond what that map knows would silently fall back to 7d and lie to the
   * user about the window they asked for, so keep the two in step.
   *
   * Cost note: these read the DAILY ROLLUPS (WorkspaceSignalDaily) plus a
   * partition-pruned ClickHouse query, so the work is O(days), not O(sessions) —
   * 7d vs 30d is 14 rows vs 60. The dashboard already runs 30d on every load (and
   * `intelligence` DEFAULTS to it), so nothing here is new load; agent results are
   * additionally cached by the execution engine against the workspace watermark.
   */
  private static readonly RANGES = ["24h", "7d", "30d"] as const;

  /** The range the model asked for, validated against RANGES. Defaults to 7d. */
  private rangeOf(input: Record<string, unknown>): string {
    const r = typeof input.range === "string" ? input.range : "";
    return (AgentCapabilities.RANGES as readonly string[]).includes(r)
      ? r
      : "7d";
  }

  /** The same window as a day count, for services that take days not a range. */
  private rangeDays(input: Record<string, unknown>): number {
    return { "24h": 1, "7d": 7, "30d": 30 }[this.rangeOf(input)] ?? 7;
  }

  /**
   * A user's sessions from the SOURCE OF TRUTH — Postgres Session by endUserId,
   * the exact rows the dashboard's user page and recordings list show. The old
   * per-user path read replay.session_cards, a DERIVED analysis projection that
   * is empty for the ~92% of users no card was ever materialised for, so the
   * agent answered "0 sessions" for users who plainly have them (the reported
   * bug: 0 vs the dashboard's 14).
   *
   * Window: DEFAULT is all-time — "how many sessions does X have" is a lifetime
   * question, not a last-7-days one, and defaulting to 7d is exactly why "check
   * 30 days" still read zero (this user's newest session is >7d old). An explicit
   * range narrows it AND is echoed back as `coverage` so the narrator states the
   * window it searched instead of implying it looked at all history.
   *
   * Access pattern: one indexed count + one indexed page on
   * @@index([endUserId, startedAt desc]) — pinned to a single user, never a scan.
   */
  private async userSessionsAnswer(
    workspaceId: number,
    distinctId: string,
    input: Record<string, unknown>,
    limit: number,
  ) {
    const eu = await this.db.endUser.findFirst({
      where: { workspaceId, distinctId },
      select: { id: true },
    });
    if (!eu) {
      return {
        user: distinctId,
        found: false,
        totalSessions: 0,
        coverage: "all time",
        sessions: [],
      };
    }
    const hasRange =
      typeof input.range === "string" &&
      (AgentCapabilities.RANGES as readonly string[]).includes(input.range);
    const sinceMs = hasRange
      ? Date.now() - this.rangeDays(input) * 86_400_000
      : undefined;
    const where = {
      endUserId: eu.id,
      ...(sinceMs ? { startedAt: { gte: new Date(sinceMs) } } : {}),
    };
    const [totalSessions, rows] = await Promise.all([
      this.db.session.count({ where }),
      this.db.session.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        select: {
          publicId: true,
          platform: true,
          browser: true,
          device: true,
          durationMs: true,
          errorCount: true,
          rageCount: true,
          startedAt: true,
          bookmarked: true,
        },
      }),
    ]);
    return {
      user: distinctId,
      found: true,
      totalSessions,
      coverage: hasRange ? `last ${this.rangeDays(input)} days` : "all time",
      sessions: rows.map((s) => ({
        recording: s.publicId,
        platform: s.platform,
        browser: s.browser,
        device: s.device,
        durationMs: s.durationMs,
        errors: s.errorCount,
        rage: s.rageCount,
        startedAt: s.startedAt?.toISOString() ?? null,
        bookmarked: s.bookmarked,
      })),
    };
  }

  /** The public id of a user's most recent session (source of truth), or null.
   *  Replaces the replay.session_cards pick that returned nothing for users with
   *  no materialised cards. */
  private async latestUserRecording(
    endUserId: number,
  ): Promise<string | null> {
    const s = await this.db.session.findFirst({
      where: { endUserId },
      orderBy: { startedAt: "desc" },
      select: { publicId: true },
    });
    return s?.publicId ?? null;
  }

  /**
   * THE EXACT payload that will be sent to Linear.
   *
   * Called by BOTH the preview and the executor, so what the user approves is
   * byte-identical to what leaves the building. That property has to be
   * structural, not a convention: previously each computed its own payload and
   * they had already drifted — the preview rendered `title.slice(0, 120)` while
   * the executor sent `title.slice(0, 250)`, so a long title was confirmed as one
   * string and filed as another.
   *
   * Worse, the BODY was never previewed at all. It is built by buildIssueBody()
   * from model-authored fields (summary, impact, confidence, release, platforms,
   * browsers, up to 20 session deep links, next steps), so a user could confirm a
   * benign-looking title while the issue carried content they had never seen.
   * A confirmation gate the user cannot see through is not a gate.
   */
  private linearPayload(input: Record<string, unknown>): {
    title: string;
    description: string;
  } {
    return {
      title: String(input.title ?? "").slice(0, 250),
      description: buildIssueBody(input),
    };
  }

  /** The EXACT payload sent to GitHub — see linearPayload for why this is shared. */
  private githubPayload(input: Record<string, unknown>): {
    title: string;
    body: string;
    labels: string[];
  } {
    const labels = Array.isArray(input.labels)
      ? (input.labels.filter((x) => typeof x === "string") as string[])
      : [];
    return {
      title: String(input.title ?? "").slice(0, 250),
      body: buildIssueBody(input),
      labels: labels.length ? labels.slice(0, 20) : ["replayfy"],
    };
  }

  /** The EXACT payload sent to Slack — see linearPayload for why this is shared.
   *  Slack takes structured fields (it renders Block-Kit server-side), so the
   *  payload IS these fields; previewing them shows the user everything that
   *  will be posted. */
  private slackPayload(input: Record<string, unknown>): {
    title: string;
    summary?: string;
    impact?: string;
    confidence?: string;
    release?: string;
    platforms: string[];
    sessions: string[];
    nextSteps: string[];
  } {
    const s = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const a = (v: unknown): string[] =>
      Array.isArray(v)
        ? (v.filter((x) => typeof x === "string") as string[])
        : [];
    return {
      title: String(input.title ?? "").slice(0, 150),
      summary: s(input.summary),
      impact: s(input.impact),
      confidence: s(input.confidence),
      release: s(input.release),
      platforms: a(input.platforms),
      sessions: a(input.sessions),
      nextSteps: a(input.nextSteps),
    };
  }

  onModuleInit(): void {
    const clamp = (v: unknown, def: number, max: number) =>
      Math.min(Math.max(Number(v) || def, 1), max);
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;

    // ── Investigation Intelligence — the broad deterministic evidence sweep ──
    this.registry.register({
      name: "investigation.diagnose",
      skill: "Investigation Intelligence",
      description:
        "Run a broad investigation of the workspace: what changed period-over-period (metric deltas), the correlated problems/incidents, top crashes/errors with release correlation, and failing journeys — returned as STRUCTURED evidence with derived confidence. Use this for open-ended 'why did X change / what's going on / what's broken' questions before answering. `range` sets the window compared against the preceding one — pass the window the USER asked about (default 7d).",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", enum: [...AgentCapabilities.RANGES] },
        },
      },
      executor: async (input, ctx: AgentContext) =>
        this.investigation.diagnose(ctx.workspaceId, this.rangeOf(input)),
    });

    // ── Session Intelligence ────────────────────────────────────────────────
    this.registry.register({
      name: "session.search",
      skill: "Session Intelligence",
      description:
        "The lowest-scoring (worst-experience) sessions, optionally below a max score. Returns session ids (recordings) to cite, with rage/error counts and start URL.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 30_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: {
          maxScore: { type: "number" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        const maxScore = Number.isFinite(Number(input.maxScore))
          ? Math.min(100, Math.max(0, Number(input.maxScore)))
          : 100;
        const rows = await this.db.session.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            excludedShort: false,
            sessionScore: { lt: maxScore },
          },
          orderBy: { sessionScore: "asc" },
          take: clamp(input.limit, 8, 50),
          select: {
            publicId: true,
            sessionScore: true,
            rageCount: true,
            errorCount: true,
            startUrl: true,
            platform: true,
          },
        });
        return rows.map((r) => ({
          recording: r.publicId,
          score: r.sessionScore,
          rage: r.rageCount,
          errors: r.errorCount,
          startUrl: r.startUrl,
          platform: r.platform,
        }));
      },
    });

    this.registry.register({
      name: "journey.top",
      skill: "Session Intelligence",
      description:
        "Top failing user journeys (screen/URL sequences) with their failure rates and session counts.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) =>
        this.db.journeyCluster.findMany({
          where: { workspaceId: ctx.workspaceId, failRate: { gt: 0 } },
          orderBy: [{ failRate: "desc" }, { sessionCount: "desc" }],
          take: clamp(input.limit, 5, 20),
          select: {
            label: true,
            sessionCount: true,
            failCount: true,
            failRate: true,
          },
        }),
    });
    this.registry.register({
      name: "session.find",
      skill: "Session Intelligence",
      description:
        "Find sessions by outcome (converted|abandoned|crashed|errored|normal) OR by user id. With a userId it returns that user's ACTUAL sessions from the source of truth (recording, platform, browser, device, duration, errors) plus totalSessions and the `coverage` window searched — use totalSessions for 'how many sessions does this user have' and default to all-time. With only an outcome it returns a compact analysis card per session (summary, journey, signals, metrics, recording). `range` (24h|7d|30d) narrows the userId path.",
      permissions: [],
      workspaceScoped: true,
      inputSchema: {
        type: "object",
        properties: {
          outcome: { type: "string" },
          userId: { type: "string" },
          range: { type: "string" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        // userId path → the SOURCE OF TRUTH (Postgres Session by endUserId), not
        // the derived session_cards projection that is empty for most users and
        // made the agent report 0 sessions for users the dashboard shows.
        if (typeof input.userId === "string" && input.userId.trim()) {
          return this.userSessionsAnswer(
            ctx.workspaceId,
            input.userId.trim(),
            input,
            clamp(input.limit, 8, 50),
          );
        }
        const cards = await sessionCards({
          workspaceId: ctx.workspaceId,
          outcome:
            typeof input.outcome === "string" ? input.outcome : undefined,
          limit: clamp(input.limit, 8, 50),
        });
        return cards.map((c) => ({
          recording: c.session_public_id,
          outcome: c.outcome,
          summary: c.summary,
          journey: c.journey,
          platform: c.platform,
          release: c.release,
          durationMs: c.duration_ms,
          errors: c.error_count,
          crashes: c.crash_count,
          score: c.session_score,
        }));
      },
    });

    this.registry.register({
      name: "session.query",
      skill: "Session Intelligence",
      operation: "read",
      freshness: "live",
      description:
        "Find sessions by ATTRIBUTES: platform, country, os, browser, release, urlContains, errored/frustrated, recency (sinceDays), fired a tracked `event`, or converted:true (resolves this workspace's conversion definition). This is the capability for 'show me <segment> users who <did X>'. Returns the matching sessions (recording ids to cite) + `total` (distinct SESSIONS) + `distinctUsers` (distinct IDENTIFIED users — use this for 'how many USERS', never `total`) + a resultRef the 'show recordings' button re-runs paginated.",
      permissions: [],
      workspaceScoped: true,
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string" },
          country: { type: "string" },
          os: { type: "string" },
          browser: { type: "string" },
          release: { type: "string" },
          urlContains: { type: "string" },
          event: { type: "string" },
          errored: { type: "boolean" },
          frustrated: { type: "boolean" },
          converted: { type: "boolean" },
          sinceDays: { type: "number" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        const filter: SessionQueryFilter = {
          platform: str(input.platform),
          country: str(input.country),
          os: str(input.os),
          browser: str(input.browser),
          release: str(input.release),
          urlContains: str(input.urlContains),
          event: str(input.event),
          errored: input.errored === true,
          frustrated: input.frustrated === true,
          sinceDays: Number.isFinite(Number(input.sinceDays))
            ? Number(input.sinceDays)
            : undefined,
        };
        // outcome=converted → resolve the workspace's conversion definition.
        // Event-kind conversions filter by that event; url/endpoint kinds aren't
        // yet queryable here (returns the attribute matches + a note).
        let note: string | undefined;
        if (input.converted === true && !filter.event) {
          const conv = await this.conversion.resolve(ctx.workspaceId);
          if (conv.defined && conv.kind === "event" && conv.value) {
            filter.event = conv.value;
          } else if (conv.defined) {
            note = `Conversion is defined as ${conv.kind} (${conv.value}); filtering sessions by that isn't supported yet — showing attribute matches.`;
          } else {
            note =
              "No conversion is defined for this workspace — define one to filter by 'converted'.";
          }
        }
        const { sessions, total, distinctUsers } = await querySessions({
          workspaceId: ctx.workspaceId,
          filter,
          limit: clamp(input.limit, 25, 100),
        });
        // Hydrate recording public ids from Postgres (CH stores numeric ids).
        const ids = sessions.map((s) => s.session_id);
        const pubs =
          ids.length > 0
            ? await this.db.session.findMany({
                where: { workspaceId: ctx.workspaceId, id: { in: ids } },
                select: { id: true, publicId: true },
              })
            : [];
        const pubById = new Map(pubs.map((p) => [p.id, p.publicId]));
        const rows = sessions
          .filter((s) => pubById.has(s.session_id))
          .map((s) => ({
            recording: pubById.get(s.session_id) as string,
            platform: s.platform,
            country: s.country,
            os: s.os,
            browser: s.browser,
            release: s.release,
            durationMs: s.duration_ms,
            errors: s.errors_count,
            rage: s.rage_count,
            startPath: s.start_path,
          }));
        // Persist the re-runnable reference so "Show recordings (N)" can page the
        // FULL set (not just this preview) via GET /v1/agent/recordings — without
        // re-running the AI or minting a playlist. The stored filter is the
        // resolved one (converted → its event).
        const resultRefId = await this.resultSets.create(ctx.workspaceId, {
          kind: "query",
          filter,
          count: total,
        });
        return {
          total,
          distinctUsers, // deduped identified users — answer "how many USERS" with this, not total (sessions)
          shown: rows.length,
          sessions: rows,
          ...(note ? { note } : {}),
          resultRef: {
            kind: "query" as const,
            id: resultRefId,
            filter,
            count: total,
          },
        };
      },
    });

    this.registry.register({
      name: "events.discover",
      skill: "Session Intelligence",
      operation: "read",
      freshness: "near-live",
      description:
        "The tracked (custom) event names this workspace records, ranked by how many sessions fired each. Use it to learn what events exist before composing a funnel from a metric, or to offer candidates when asking which event marks something.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" }, limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) => {
        const rows = await topTrackEvents({
          workspaceId: ctx.workspaceId,
          q: str(input.q),
          limit: clamp(input.limit, 20, 50),
        });
        return rows.map((r) => ({ event: r.value, sessions: r.count }));
      },
    });

    // ── Crash Intelligence ──────────────────────────────────────────────────
    this.registry.register({
      name: "sdk.install",
      skill: "Setup Intelligence",
      description:
        "Help a user install the Replayfy SDK. Returns the copy-paste snippet + steps for a platform (web, react, next, vue, react-native, ios, android, flutter, node, python). It does NOT create or reveal API keys — it points the user to Settings to get their own key. Use when someone asks how to install, set up, add the SDK, or start recording sessions.",
      permissions: [],
      workspaceScoped: true,
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description:
              "web | react | next | vue | react-native | ios | android | flutter | node | python. Omit to list the options.",
          },
        },
      },
      executor: async (input: Record<string, unknown>) => {
        const key =
          typeof input.platform === "string"
            ? resolveSdkPlatform(input.platform)
            : null;
        // No platform (or an unknown one): hand back the menu so the model can
        // ask, rather than guessing wrong.
        if (!key) {
          return {
            needPlatform: true,
            platforms: Object.entries(SDK_PLATFORMS).map(([id, p]) => ({
              id,
              label: p.label,
              kind: p.kind,
            })),
            keysUrl: SDK_KEYS_SETTINGS_PATH,
            note: "Ask which platform, then call again with it. I can't create or read API keys — the user copies their own key from Settings.",
          };
        }
        const p = SDK_PLATFORMS[key];
        return {
          platform: key,
          label: p.label,
          kind: p.kind,
          install: p.install,
          snippet: p.snippet,
          // The one thing the agent must not do itself. It routes the user here.
          keysUrl: SDK_KEYS_SETTINGS_PATH,
          steps: [
            `Open ${SDK_KEYS_SETTINGS_PATH} and copy your project key — I can't mint or reveal keys for you.`,
            "Add the snippet below and swap in that key.",
            "Deploy — recorded sessions appear in Recordings within a minute.",
          ],
        };
      },
    });

    this.registry.register({
      name: "issue.list",
      skill: "Crash Intelligence",
      description:
        "List grouped errors/crashes (Issues) ranked by impact — type, culprit, affected user/session counts, releases, a recording. Optional status OPEN|REGRESSED|RESOLVED|IGNORED.",
      permissions: [],
      workspaceScoped: true,
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        // list() now returns a paginated envelope; this capability wants the rows.
        const { items: rows } = await this.issues.list(ctx.workspaceId, {
          status: typeof input.status === "string" ? input.status : undefined,
          limit: clamp(input.limit, 8, 50),
        });
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          culprit: r.culprit,
          kind: r.behavioral ? "behavioral" : r.isCrash ? "crash" : "error",
          platform: r.platform,
          occurrences: r.occurrenceCount,
          users: r.userCount,
          sessions: r.sessionCount,
          firstRelease: r.firstRelease,
          lastRelease: r.lastRelease,
          recording: r.lastPublicId,
        }));
      },
    });

    // ── Investigation Intelligence ──────────────────────────────────────────
    this.registry.register({
      name: "incident.list",
      skill: "Investigation Intelligence",
      description:
        "This workspace's open incidents (correlated problems or opportunities), ranked by impact, with affected counts and change vs prior period. polarity NEGATIVE (problems) | POSITIVE (opportunities).",
      permissions: [],
      workspaceScoped: true,
      inputSchema: {
        type: "object",
        properties: {
          polarity: { type: "string" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        const polarity =
          input.polarity === "POSITIVE" || input.polarity === "NEGATIVE"
            ? (input.polarity as "POSITIVE" | "NEGATIVE")
            : undefined;
        const rows = await this.db.incident.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            status: "OPEN",
            ...(polarity ? { polarity } : {}),
          },
          orderBy: { rank: "desc" },
          take: clamp(input.limit, 6, 20),
          select: {
            id: true,
            title: true,
            signalType: true,
            polarity: true,
            screen: true,
            sessionCount: true,
            userCount: true,
            deltaPctX100: true,
          },
        });
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.signalType,
          polarity: r.polarity,
          screen: r.screen,
          sessions: r.sessionCount,
          users: r.userCount,
          changePct: Math.round(r.deltaPctX100 / 100),
        }));
      },
    });

    // ── Metric Intelligence ─────────────────────────────────────────────────
    this.registry.register({
      name: "metric.pulse",
      skill: "Metric Intelligence",
      description:
        "The workspace's health score over a window, its delta versus the preceding window of the same length, and the signal counts in it (crashes, backend failures, slow APIs, frustration, conversions). `range` sets that window — pass the one the USER asked about (default 7d).",
      permissions: [],
      workspaceScoped: true,
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", enum: [...AgentCapabilities.RANGES] },
        },
      },
      // Reads the WorkspaceSignalDaily rollup, so the window costs rows-per-day,
      // not rows-per-session: 30d is 60 rows against 7d's 14.
      executor: async (input, ctx: AgentContext) =>
        this.signalDaily.pulse(ctx.workspaceId, this.rangeDays(input)),
    });

    // ── Metric Intelligence (overview) ──────────────────────────────────────
    this.registry.register({
      name: "metric.overview",
      skill: "Metric Intelligence",
      description:
        "The workspace's business-health metrics (DAU/WAU/MAU, active users, sessions, avg duration, conversion rate, returning rate, crashes) — each with its value, prior-period value, and change %. `range` sets the window and what it is compared against — pass the one the USER asked about (default 7d).",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: {
        type: "object",
        properties: {
          range: { type: "string", enum: [...AgentCapabilities.RANGES] },
        },
      },
      executor: async (input, ctx: AgentContext) =>
        this.dashboard.metrics(ctx.workspaceId, this.rangeOf(input)),
    });

    // ── Funnel Intelligence (read) ──────────────────────────────────────────
    this.registry.register({
      name: "funnel.list",
      skill: "Funnel Intelligence",
      description:
        "The funnels this workspace has defined (name, steps). Use it to check whether a relevant funnel already exists before offering to create one.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: { type: "object", properties: {} },
      executor: async (_input, ctx: AgentContext) =>
        this.funnels.list(ctx.workspaceId, {}),
    });

    this.registry.register({
      name: "funnel.adhoc",
      skill: "Funnel Intelligence",
      operation: "read",
      freshness: "near-live",
      description:
        "Compute a funnel / DROP-OFF on the fly from an ORDERED list of tracked event names — NO pre-defined funnel needed. This is the capability for 'where do users drop off between <event A> and <event B>?'. First get the real event names from events.discover (topTrackEvents), then pass them here in the intended order (2-8 steps). Returns sessions reaching each step (monotonically non-increasing) so you can state the drop-off between steps.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: {
        type: "object",
        properties: {
          events: { type: "array", items: { type: "string" } },
          sinceDays: { type: "number" },
        },
        required: ["events"],
      },
      validate: (input) =>
        Array.isArray(input.events) && input.events.length >= 2
          ? null
          : "events must be an ordered array of at least 2 tracked event names",
      executor: async (input, ctx: AgentContext) => {
        const { steps, enteredSessions, sinceDays } = await adhocFunnel({
          workspaceId: ctx.workspaceId,
          events: (input.events as unknown[]).map((e) => str(e) ?? ""),
          sinceDays: Number.isFinite(Number(input.sinceDays))
            ? Number(input.sinceDays)
            : undefined,
        });
        // Annotate each step with the drop from the previous one, so the
        // narrator can state where users fall off without recomputing.
        const withDrops = steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1].sessions : s.sessions;
          const droppedFromPrev = i > 0 ? prev - s.sessions : 0;
          return {
            step: i + 1,
            event: s.event,
            sessions: s.sessions,
            droppedFromPrev,
            dropPctFromPrev:
              i > 0 && prev > 0
                ? Math.round((droppedFromPrev / prev) * 1000) / 10
                : 0,
          };
        });
        const last = steps[steps.length - 1]?.sessions ?? 0;
        return {
          steps: withDrops,
          enteredSessions,
          completedSessions: last,
          overallConversionPct:
            enteredSessions > 0
              ? Math.round((last / enteredSessions) * 1000) / 10
              : 0,
          // Disclose the lookback so the narrator states it — the user must never
          // assume an ad-hoc funnel spans all sessions (default = last 90 days).
          windowDays: sinceDays,
          coverage: `last ${sinceDays} days`,
        };
      },
    });

    this.registry.register({
      name: "funnel.userStatus",
      skill: "Funnel Intelligence",
      operation: "read",
      freshness: "near-live",
      description:
        "Did a specific user make it through a funnel? ('did Nasirudeen make it through payment?'). Give the user (email / name / id) and optionally funnelId (else the workspace's first funnel). Returns whether they completed, the furthest step reached, per-step reached flags, and a recording to open at that point.",
      permissions: [],
      workspaceScoped: true,
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: {
        type: "object",
        properties: {
          userId: { type: "string" },
          funnelId: { type: "number" },
        },
        required: ["userId"],
      },
      executor: async (input, ctx: AgentContext) => {
        const q = str(input.userId) ?? "";
        if (!q)
          return { found: false, note: "Provide a user (email, name, or id)." };
        const user = await this.db.endUser.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [
              { distinctId: q },
              { email: { equals: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          },
          select: { id: true, distinctId: true, email: true, name: true },
        });
        if (!user) {
          return { found: false, note: `No identified user matching "${q}".` };
        }
        const identity = {
          userId: user.distinctId,
          email: user.email,
          name: user.name,
        };

        let funnelId = Number.isFinite(Number(input.funnelId))
          ? Number(input.funnelId)
          : undefined;
        if (!funnelId) {
          const list = (await this.funnels.list(ctx.workspaceId, {})) as {
            items?: Array<{ id: number }>;
          };
          funnelId = list.items?.[0]?.id;
        }
        if (!funnelId) {
          return {
            found: true,
            user: identity,
            note: "No funnel defined — create one to check per-user progress.",
          };
        }

        // Compute the funnel scoped to THIS user (FunnelFilter.userId = distinctId);
        // per-step count > 0 means the user reached that step.
        const result = await this.funnels.compute(ctx.workspaceId, {
          funnelId,
          filter: { userId: user.distinctId },
          metric: "session",
        });
        const steps = Array.isArray(result.steps) ? result.steps : [];
        let furthest = -1;
        for (const s of steps) {
          if ((s.count ?? 0) > 0) furthest = s.index;
        }
        const completed =
          steps.length > 0 && (steps[steps.length - 1].count ?? 0) > 0;

        // The user's most recent session from the source of truth (Postgres
        // Session by endUserId) — session_cards was empty for most users, so
        // this used to return no recording to view even when the user had
        // sessions. A specific converted-session pick would need per-session
        // outcome (a card field); the latest real session is the honest link.
        const recording = await this.latestUserRecording(user.id).catch(
          () => null,
        );

        return {
          found: true,
          user: identity,
          funnel: { id: funnelId, name: result.name, totalSteps: steps.length },
          completed,
          furthestStep:
            furthest >= 0
              ? { index: furthest, name: steps[furthest].name }
              : null,
          reachedSteps: steps.map((s) => ({
            index: s.index,
            name: s.name,
            reached: (s.count ?? 0) > 0,
          })),
          recording,
        };
      },
    });

    // ── User Intelligence ───────────────────────────────────────────────────
    this.registry.register({
      name: "user.search",
      skill: "User Intelligence",
      description:
        "Find end-users by email, id, or name (partial match). Returns id, email, name, country, last seen.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 30_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
      executor: async (input, ctx: AgentContext) => {
        const q = String(input.query).slice(0, 200);
        const rows = await this.db.endUser.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { distinctId: { contains: q } },
              { name: { contains: q, mode: "insensitive" } },
            ],
          },
          orderBy: { lastSeenAt: "desc" },
          take: clamp(input.limit, 8, 30),
          select: {
            distinctId: true,
            email: true,
            name: true,
            country: true,
            lastSeenAt: true,
          },
        });
        return rows.map((r) => ({
          userId: r.distinctId,
          email: r.email,
          name: r.name,
          country: r.country,
          lastSeen: r.lastSeenAt,
        }));
      },
    });

    this.registry.register({
      name: "user.topErrors",
      skill: "User Intelligence",
      operation: "read",
      freshness: "live",
      description:
        "End-users ranked by how many errors they hit over a window ('the user with the highest error today'). sinceDays defaults to 1 (today). Returns each user's identity, total errors, and session count.",
      permissions: [],
      workspaceScoped: true,
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: {
          sinceDays: { type: "number" },
          limit: { type: "number" },
        },
      },
      executor: async (input, ctx: AgentContext) => {
        const days =
          Number.isFinite(Number(input.sinceDays)) &&
          Number(input.sinceDays) > 0
            ? Number(input.sinceDays)
            : 1;
        const since = new Date(Date.now() - days * 86_400_000);
        // Access pattern: WHERE workspaceId=? AND startedAt>=since AND
        // errorCount>0 AND endUserId NOT NULL, GROUP BY endUserId ORDER BY sum
        // desc LIMIT n — served by @@index([workspaceId, startedAt desc]);
        // windowed + capped, never a full scan. One batched EndUser hydrate.
        const grouped = await this.db.session.groupBy({
          by: ["endUserId"],
          where: {
            workspaceId: ctx.workspaceId,
            endUserId: { not: null },
            errorCount: { gt: 0 },
            startedAt: { gte: since },
          },
          _sum: { errorCount: true },
          _count: { _all: true },
          orderBy: { _sum: { errorCount: "desc" } },
          take: clamp(input.limit, 10, 50),
        });
        const ids = grouped
          .map((g) => g.endUserId)
          .filter((x): x is number => x != null);
        if (ids.length === 0) return [];
        const users = await this.db.endUser.findMany({
          where: { workspaceId: ctx.workspaceId, id: { in: ids } },
          select: {
            id: true,
            distinctId: true,
            email: true,
            name: true,
            country: true,
          },
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        return grouped
          .map((g) => {
            const u = g.endUserId != null ? byId.get(g.endUserId) : undefined;
            return {
              userId: u?.distinctId ?? null,
              email: u?.email ?? null,
              name: u?.name ?? null,
              country: u?.country ?? null,
              errors: g._sum.errorCount ?? 0,
              sessions: g._count._all,
            };
          })
          .filter((r) => r.userId != null);
      },
    });

    // ── Release Intelligence ────────────────────────────────────────────────
    this.registry.register({
      name: "release.compare",
      skill: "Release Intelligence",
      description:
        "Release intelligence: each release with adoption, crash-free rate, error/crash counts and how it compares to the prior release. Use for 'did release X regress / compare releases / what changed after the last deploy' questions.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      inputSchema: { type: "object", properties: {} },
      executor: async (_input, ctx: AgentContext) =>
        this.releases.intelligence(ctx.workspaceId),
    });

    // ── Performance Intelligence ────────────────────────────────────────────
    this.registry.register({
      name: "performance.slowPages",
      skill: "Performance Intelligence",
      description:
        "The slowest pages/screens in the workspace over the last 7 days (by load / interaction latency), with their sample counts. Use for 'what's slow / performance problems / latency' questions.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) =>
        this.insights.slowPages(
          ctx.workspaceId,
          "7d",
          String(clamp(input.limit, 10, 50)),
        ),
    });

    this.registry.register({
      name: "performance.friction",
      skill: "Performance Intelligence",
      description:
        "Pages/screens ranked by user friction (rage + dead clicks, errors) over the last 7 days. Use for 'where are users struggling / most frustrating pages' questions.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) =>
        this.insights.frictionByPage(
          ctx.workspaceId,
          "7d",
          String(clamp(input.limit, 10, 50)),
        ),
    });

    // ── Comment Intelligence ────────────────────────────────────────────────
    this.registry.register({
      name: "comment.list",
      skill: "Comment Intelligence",
      description:
        "Recent comments teammates have left on sessions in this workspace (body, author, the session it's on). Use for 'what has the team flagged / any notes on these sessions' questions.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 30_000 },
      retry: { attempts: 1 },
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) =>
        this.comments.listForWorkspace(
          ctx.workspaceId,
          undefined,
          String(clamp(input.limit, 20, 100)),
        ),
    });

    // ── Alert Intelligence (read) ───────────────────────────────────────────
    this.registry.register({
      name: "alert.list",
      skill: "Alert Intelligence",
      description:
        "The threshold alerts this workspace has defined (metric, comparator, threshold, active, last fired). Use it to check whether a relevant alert already exists before offering to create one.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 30_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "array" },
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      executor: async (input, ctx: AgentContext) =>
        this.alerts.list(ctx.workspaceId, {
          limit: clamp(input.limit, 50, 200),
        }),
    });

    // ── Alert Intelligence (WRITE, create-only) ─────────────────────────────
    this.registry.register({
      name: "alert.create",
      skill: "Alert Intelligence",
      description:
        "Create a threshold alert on a daily signal metric — this is what backs 'alert me if this happens again'. metric ∈ {crashes, backendFail, slowApi, frustrated, formAbandon, navLoop, convFailure, convSuccess, healthScore}; comparator ∈ {ABOVE, BELOW}; threshold is a number. Set email:true to also email the user's ACCOUNT email (in-app is always on; a different address is set by the user, not you). Fires to workspace admins when today's value crosses it. Create-only.",
      permissions: ["alerts.write"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          metric: { type: "string" },
          comparator: { type: "string" },
          threshold: { type: "number" },
          email: { type: "boolean" },
        },
        required: ["name", "metric", "comparator", "threshold"],
      },
      executor: async (input, ctx: AgentContext) => {
        const alert = await this.alerts.create(ctx.workspaceId, ctx.userId, {
          name: typeof input.name === "string" ? input.name : "",
          metric: typeof input.metric === "string" ? input.metric : "",
          comparator:
            typeof input.comparator === "string" ? input.comparator : "",
          threshold: Number(input.threshold),
          emailEnabled: input.email === true,
        });
        return { created: true, alert };
      },
    });

    this.registry.register({
      name: "alert.watchIssue",
      skill: "Alert Intelligence",
      operation: "create",
      description:
        "Alert the workspace admins if a specific Issue comes up again (regresses after being resolved). Give the issueId (from issue.list). Detection is near-real-time (minutes). Create-only — this is 'alert me if this happens again' for an issue.",
      permissions: ["alerts.write"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          issueId: { type: "number" },
          name: { type: "string" },
          email: { type: "boolean" },
        },
        required: ["issueId"],
      },
      executor: async (input, ctx: AgentContext) => {
        const alert = await this.alerts.watchIssue(
          ctx.workspaceId,
          ctx.userId,
          Number(input.issueId),
          typeof input.name === "string" ? input.name : undefined,
          input.email === true,
        );
        return { created: true, alert };
      },
    });

    // ── Conversion definition (read + define) ───────────────────────────────
    this.registry.register({
      name: "conversion.status",
      skill: "Funnel Intelligence",
      operation: "read",
      freshness: "near-live",
      description:
        "How this workspace defines a CONVERSION (what 'success' / 'completed payment' means) and how trustworthy it is: returns the current definition + source (tracked=explicit event, defined=url/endpoint rule, inferred, none) plus auto-suggested candidates (top tracked events + 2xx endpoints) to define one. Use this BEFORE answering conversion/payment questions, or before offering to define a conversion.",
      permissions: [],
      workspaceScoped: true,
      cache: { ttlMs: 60_000 },
      retry: { attempts: 1 },
      outputSchema: { type: "object" },
      inputSchema: { type: "object", properties: {} },
      executor: async (_input, ctx: AgentContext) => {
        const [current, suggestions] = await Promise.all([
          this.conversion.resolve(ctx.workspaceId),
          this.conversion.suggest(ctx.workspaceId),
        ]);
        return { current, suggestions };
      },
    });

    this.registry.register({
      name: "conversion.define",
      skill: "Funnel Intelligence",
      operation: "create",
      // Opts into the confirmation gate. What this writes becomes a WorkspaceKnowledge
      // fact, which contextBlock renders into EVERY later planner/narrator prompt as
      // trusted truth — so it is a durable change to how the AI reasons, not an
      // ordinary cheap create. The description below already said "ONLY after the
      // user picked or confirmed a candidate"; this is what makes the code enforce it
      // rather than merely ask the model to.
      requiresConfirmation: true,
      description:
        "Define/confirm what counts as a conversion for this workspace. kind ∈ {event, url, endpoint}; value = the tracked-event name / URL path / endpoint path; status (endpoint only) = the success HTTP status (e.g. 200). Stored as a workspace fact the whole AI then uses. Do this ONLY after the user picked or confirmed a candidate — never guess silently. The user must confirm before it is stored.",
      permissions: ["funnels.write"],
      workspaceScoped: true,
      writes: true,
      reversible: true,
      // Show the user the RULE THEY ARE ACTUALLY APPROVING, verbatim — never a
      // model-authored label. The generic fallback preview would say only
      // "create via conversion.define", which is not enough to consent to.
      preview: async (input) => {
        const kind = typeof input.kind === "string" ? input.kind : "";
        const value = typeof input.value === "string" ? input.value : "";
        const status = Number.isFinite(Number(input.status))
          ? Number(input.status)
          : undefined;
        return {
          operation: "create" as const,
          summary: `Define this workspace's conversion as ${kind}: ${value}${status ? ` (status ${status})` : ""}`,
          permanent: false,
          reversible: true,
          details: { kind, value, ...(status ? { status } : {}) },
        };
      },
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string" },
          value: { type: "string" },
          status: { type: "number" },
        },
        required: ["kind", "value"],
      },
      executor: async (input, ctx: AgentContext) => {
        const conversion = await this.conversion.define(
          ctx.workspaceId,
          {
            kind: typeof input.kind === "string" ? input.kind : "",
            value: typeof input.value === "string" ? input.value : "",
            status: Number.isFinite(Number(input.status))
              ? Number(input.status)
              : undefined,
          },
          ctx.userId,
        );
        return { defined: true, conversion };
      },
    });

    // ── Cohort Intelligence (WRITE, create-only) ────────────────────────────
    this.registry.register({
      name: "cohort.create",
      skill: "Cohort Intelligence",
      description:
        "Create a cohort (a saved group of users). For an AUTO (auto-updating) cohort, provide `filter` in the CANONICAL shape {type:'and',groups:[{type:'or',conditions:[{field,op,value}]}]} — groups are AND'd, conditions within a group OR'd. Supported fields: plan|browser|os|device|country|city|email|name|distinctId (op '='|'≠'|'contains'|'startsWith'|'endsWith'|'in'); is_online; last_seen (op 'within_last_days'|'more_than_days_ago', value=days); sessions_count (op '≥'|'>'|'=', value=N); and event = users who FIRED a tracked event (op 'fired'|'not_fired', value=event name, e.g. 'payment_success'). Use `event` for 'users who completed/did X'. Omit filter for a MANUAL cohort. Create-only.",
      permissions: ["cohorts.write"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, filter: { type: "object" } },
        required: ["name"],
      },
      executor: async (input, ctx: AgentContext) => {
        // Normalise + VALIDATE the filter so we never store one the engine can't
        // read (which would silently match EVERY user). A provided-but-invalid
        // filter is rejected with the supported-field list so the AI can retry.
        let filter: unknown = undefined;
        if (input.filter != null && typeof input.filter === "object") {
          const norm = CohortsService.normalizeFilter(input.filter);
          if (!norm) {
            throw new Error(
              "That cohort filter can't be expressed. Supported condition fields: plan, browser, os, device, country, city, email, name, distinctId, is_online, last_seen, sessions_count, and event (users who fired a tracked event, e.g. {field:'event',op:'fired',value:'payment_success'}). Provide a canonical filter {type:'and',groups:[{type:'or',conditions:[…]}]}.",
            );
          }
          filter = norm;
        }
        const cohort = await this.cohorts.create(ctx.workspaceId, ctx.userId, {
          name: String(input.name).slice(0, 120),
          kind: filter ? "AUTO" : "MANUAL",
          filter,
          // Stamp provenance so the Cohorts UI badges it "Created with Replayfy AI".
          createdByAi: true,
        });
        return { created: true, cohort };
      },
    });

    // ── Funnel Intelligence (WRITE, create-only) ────────────────────────────
    this.registry.register({
      name: "funnel.create",
      skill: "Funnel Intelligence",
      description:
        "Create a conversion funnel from ordered steps. Each step: {name, kind: page|click|event|tap|screen, matchType: contains|equals|startsWith|regex, value}. Create-only.",
      permissions: ["funnels.write"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          steps: { type: "array" },
        },
        required: ["name", "steps"],
      },
      executor: async (input, ctx: AgentContext) => {
        const f = await this.funnels.create(ctx.workspaceId, ctx.userId, {
          name: String(input.name).slice(0, 120),
          steps: (Array.isArray(input.steps) ? input.steps : []) as never,
          // Stamp provenance so the Funnels UI badges it "Created with Replayfy AI".
          createdByAi: true,
        });
        return { created: true, funnel: f };
      },
    });

    // ── Playlist Intelligence (WRITE, create-only) ──────────────────────────
    this.registry.register({
      name: "playlist.create",
      skill: "Playlist Intelligence",
      description:
        "Create a playlist grouping specific sessions by their session ids (e.g. from session.find / issue.list recordings). Create-only.",
      permissions: ["playlists.write"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          sessionIds: { type: "array" },
        },
        required: ["title", "sessionIds"],
      },
      executor: async (input, ctx: AgentContext) => {
        const publicIds = (
          Array.isArray(input.sessionIds) ? input.sessionIds : []
        )
          .filter((x): x is string => typeof x === "string")
          .slice(0, 200);
        // Resolve public ids WITHIN the workspace — a foreign id never resolves.
        const sessions =
          publicIds.length > 0
            ? await this.db.session.findMany({
                where: {
                  workspaceId: ctx.workspaceId,
                  publicId: { in: publicIds },
                },
                select: { id: true },
              })
            : [];
        const playlist = await this.db.playlist.create({
          data: {
            workspaceId: ctx.workspaceId,
            title: String(input.title).slice(0, 120),
            kind: PlaylistKind.MANUAL,
            itemCount: sessions.length,
          },
          select: { id: true },
        });
        if (sessions.length > 0) {
          await this.db.playlistSession.createMany({
            data: sessions.map((s) => ({
              playlistId: playlist.id,
              sessionId: s.id,
            })),
            skipDuplicates: true,
          });
        }
        return {
          created: true,
          playlistId: playlist.id,
          count: sessions.length,
        };
      },
    });

    // ── Actions: UPDATE (Level 3 — preview + confirm) ───────────────────────
    this.registry.register({
      name: "funnel.update",
      skill: "Funnel Intelligence",
      operation: "update",
      reversible: true,
      description:
        "Update an existing funnel — rename, replace its steps, pin, or change the window. Needs the funnel id + the fields to change. Shows a preview and runs only after you confirm.",
      permissions: ["funnels.update"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          steps: { type: "array" },
          pinned: { type: "boolean" },
          windowDays: { type: "number" },
        },
        required: ["id"],
      },
      preview: async (input, ctx: AgentContext) =>
        this.actionPreview(
          "update",
          "funnel",
          await this.label("funnel", ctx.workspaceId, Number(input.id)),
          this.changeSet(input, ["name", "steps", "pinned", "windowDays"]),
        ),
      executor: async (input, ctx: AgentContext) => {
        const body: Parameters<FunnelsService["update"]>[2] = {};
        if (typeof input.name === "string")
          body.name = input.name.slice(0, 120);
        if (Array.isArray(input.steps)) body.steps = input.steps as never;
        if (typeof input.pinned === "boolean") body.pinned = input.pinned;
        if (Number.isFinite(Number(input.windowDays)))
          body.windowDays = Number(input.windowDays);
        const funnel = await this.funnels.update(
          ctx.workspaceId,
          Number(input.id),
          body,
        );
        return { updated: true, funnel };
      },
    });

    this.registry.register({
      name: "cohort.update",
      skill: "Cohort Intelligence",
      operation: "update",
      reversible: true,
      description:
        "Update an existing cohort — rename, change its description, or replace its filter. Needs the cohort id. Preview + confirm.",
      permissions: ["cohorts.update"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          description: { type: "string" },
          filter: { type: "object" },
        },
        required: ["id"],
      },
      preview: async (input, ctx: AgentContext) =>
        this.actionPreview(
          "update",
          "cohort",
          await this.label("cohort", ctx.workspaceId, Number(input.id)),
          this.changeSet(input, ["name", "description", "filter"]),
        ),
      executor: async (input, ctx: AgentContext) => {
        const body: Parameters<CohortsService["update"]>[2] = {};
        if (typeof input.name === "string")
          body.name = input.name.slice(0, 120);
        if (typeof input.description === "string")
          body.description = input.description;
        if (input.filter !== undefined) body.filter = input.filter;
        const cohort = await this.cohorts.update(
          ctx.workspaceId,
          Number(input.id),
          body,
        );
        return { updated: true, cohort };
      },
    });

    this.registry.register({
      name: "playlist.update",
      skill: "Playlist Intelligence",
      operation: "update",
      reversible: true,
      description:
        "Update an existing playlist — rename (title), change its description, or pin it. Needs the playlist id. Preview + confirm.",
      permissions: ["playlists.update"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          pinned: { type: "boolean" },
        },
        required: ["id"],
      },
      preview: async (input, ctx: AgentContext) =>
        this.actionPreview(
          "update",
          "playlist",
          await this.label("playlist", ctx.workspaceId, Number(input.id)),
          this.changeSet(input, ["title", "description", "pinned"]),
        ),
      executor: async (input, ctx: AgentContext) => {
        const body: Parameters<PlaylistsService["update"]>[2] = {};
        if (typeof input.title === "string")
          body.title = input.title.slice(0, 120);
        if (typeof input.description === "string")
          body.description = input.description;
        if (typeof input.pinned === "boolean") body.pinned = input.pinned;
        const playlist = await this.playlists.update(
          ctx.workspaceId,
          Number(input.id),
          body,
        );
        return { updated: true, playlist };
      },
    });

    this.registry.register({
      name: "alert.update",
      skill: "Alert Intelligence",
      operation: "update",
      reversible: true,
      description:
        "Update an existing alert — rename, change its threshold/comparator/metric, or pause/resume (active). Needs the alert id. Preview + confirm.",
      permissions: ["alerts.update"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          name: { type: "string" },
          threshold: { type: "number" },
          comparator: { type: "string" },
          metric: { type: "string" },
          active: { type: "boolean" },
        },
        required: ["id"],
      },
      preview: async (input, ctx: AgentContext) =>
        this.actionPreview(
          "update",
          "alert",
          await this.label("alert", ctx.workspaceId, Number(input.id)),
          this.changeSet(input, [
            "name",
            "threshold",
            "comparator",
            "metric",
            "active",
          ]),
        ),
      executor: async (input, ctx: AgentContext) => {
        const body: Parameters<AlertsService["update"]>[2] = {};
        if (typeof input.name === "string") body.name = input.name;
        if (Number.isFinite(Number(input.threshold)))
          body.threshold = Number(input.threshold);
        if (typeof input.comparator === "string")
          body.comparator = input.comparator;
        if (typeof input.metric === "string") body.metric = input.metric;
        if (typeof input.active === "boolean") body.active = input.active;
        const alert = await this.alerts.update(
          ctx.workspaceId,
          Number(input.id),
          body,
        );
        return { updated: true, alert };
      },
    });

    // ── Actions: DELETE (Level 4 — destructive, ALWAYS preview + confirm) ────
    for (const d of [
      {
        name: "funnel.delete",
        skill: "Funnel Intelligence" as const,
        noun: "funnel" as const,
        perm: "funnels.delete",
        run: (ws: number, id: number) => this.funnels.remove(ws, id),
      },
      {
        name: "cohort.delete",
        skill: "Cohort Intelligence" as const,
        noun: "cohort" as const,
        perm: "cohorts.delete",
        run: (ws: number, id: number) => this.cohorts.remove(ws, id),
      },
      {
        name: "playlist.delete",
        skill: "Playlist Intelligence" as const,
        noun: "playlist" as const,
        perm: "playlists.delete",
        run: (ws: number, id: number) => this.playlists.remove(ws, id),
      },
      {
        name: "alert.delete",
        skill: "Alert Intelligence" as const,
        noun: "alert" as const,
        perm: "alerts.delete",
        run: (ws: number, id: number) => this.alerts.remove(ws, id),
      },
    ]) {
      this.registry.register({
        name: d.name,
        skill: d.skill,
        operation: "delete",
        reversible: false,
        description: `Permanently delete a ${d.noun} by id. Destructive — shows a preview and runs ONLY after explicit confirmation.`,
        permissions: [d.perm],
        workspaceScoped: true,
        writes: true,
        inputSchema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
        preview: async (input, ctx: AgentContext) =>
          this.actionPreview(
            "delete",
            d.noun,
            await this.label(d.noun, ctx.workspaceId, Number(input.id)),
            { permanent: true },
          ),
        executor: async (input, ctx: AgentContext) => {
          await d.run(ctx.workspaceId, Number(input.id));
          return { deleted: true, id: Number(input.id) };
        },
      });
    }

    // ── Integration Intelligence: Linear (external — preview + confirm) ──────
    this.registry.register({
      name: "linear.createIssue",
      skill: "Linear Intelligence",
      operation: "external",
      reversible: false,
      description:
        "Create a Linear issue from an investigation. Provide a title + the findings (summary, business impact, confidence, affected release/platforms/browsers, replay/session ids, suggested next steps); the backend formats a full issue so an engineer can start debugging immediately. External action — shows a preview and posts to Linear ONLY after confirmation.",
      permissions: ["linear.issue.create"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          impact: { type: "string" },
          confidence: { type: "string" },
          release: { type: "string" },
          platforms: { type: "array" },
          browsers: { type: "array" },
          sessions: { type: "array" },
          nextSteps: { type: "array" },
        },
        required: ["title"],
      },
      // Checked BEFORE the confirmation prompt: if Linear isn't connected, tell
      // the user to connect it instead of asking them to confirm an issue we
      // can't actually file.
      precondition: async (_input, ctx: AgentContext) =>
        (await this.integrations.isConnected(ctx.workspaceId, "LINEAR"))
          ? null
          : "Linear isn't connected for this workspace yet. Connect it in Settings → Integrations, then I can file the issue.",
      // Previews the REAL payload — same builder the executor uses, so the title
      // and the full Markdown body the user approves are exactly what we file.
      preview: async (input, ctx: AgentContext) => {
        const payload = this.linearPayload(input);
        return {
          operation: "external" as const,
          summary: `Create Linear issue: ${payload.title}`,
          permanent: false,
          reversible: false,
          details: {
            destination: "Linear",
            connected: await this.integrations.isConnected(
              ctx.workspaceId,
              "LINEAR",
            ),
            title: payload.title,
            // The complete outgoing issue body. Render this verbatim at confirm
            // time — it is the thing being consented to.
            body: payload.description,
          },
        };
      },
      executor: async (input, ctx: AgentContext) => {
        const r = await this.integrations.createLinearIssue(
          ctx.workspaceId,
          this.linearPayload(input),
        );
        // createLinearIssue soft-returns {created:false, message} for expected
        // states (not connected / no team / Linear rejected) rather than
        // throwing — but for the agent a not-created result is a FAILURE, not a
        // success. Throw so the engine marks the step failed and confirmAction
        // reports the real reason instead of the optimistic preview summary.
        if (!r.created) {
          throw new Error(r.message || "Linear issue was not created.");
        }
        return r;
      },
    });

    // ── Integration Intelligence: GitHub (external — preview + confirm) ──────
    this.registry.register({
      name: "github.createIssue",
      skill: "GitHub Intelligence",
      operation: "external",
      reversible: false,
      description:
        "Create a GitHub issue from an investigation, in the workspace's connected repo. Provide a title + the findings (summary, business impact, confidence, affected release/platforms/browsers, replay/session ids, suggested next steps); the backend formats a full Markdown issue so an engineer can start debugging immediately. Optional labels. External action — shows a preview and posts to GitHub ONLY after confirmation.",
      permissions: ["github.issue.create"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          impact: { type: "string" },
          confidence: { type: "string" },
          release: { type: "string" },
          platforms: { type: "array" },
          browsers: { type: "array" },
          sessions: { type: "array" },
          nextSteps: { type: "array" },
          labels: { type: "array" },
        },
        required: ["title"],
      },
      // Checked BEFORE the confirmation prompt: if GitHub isn't connected, tell
      // the user to connect it instead of asking them to confirm an issue we
      // can't actually file.
      precondition: async (_input, ctx: AgentContext) =>
        (await this.integrations.isConnected(ctx.workspaceId, "GITHUB"))
          ? null
          : "GitHub isn't connected for this workspace yet. Connect it in Settings → Integrations, then I can file the issue.",
      // Previews the REAL payload — see linearPayload.
      preview: async (input, ctx: AgentContext) => {
        const payload = this.githubPayload(input);
        return {
          operation: "external" as const,
          summary: `Create GitHub issue: ${payload.title}`,
          permanent: false,
          reversible: false,
          details: {
            destination: "GitHub",
            connected: await this.integrations.isConnected(
              ctx.workspaceId,
              "GITHUB",
            ),
            title: payload.title,
            // The complete outgoing issue body + labels — render verbatim.
            body: payload.body,
            labels: payload.labels,
          },
        };
      },
      executor: async (input, ctx: AgentContext) => {
        const r = await this.integrations.createGithubIssue(
          ctx.workspaceId,
          this.githubPayload(input),
        );
        // A not-created result is a FAILURE for the agent — throw so the engine
        // marks the step failed and reports the real reason (mirrors Linear).
        if (!r.created) {
          throw new Error(r.message || "GitHub issue was not created.");
        }
        return r;
      },
    });

    // ── Integration Intelligence: Slack (external — preview + confirm) ──────
    this.registry.register({
      name: "slack.postMessage",
      skill: "Slack Intelligence",
      operation: "external",
      reversible: false,
      description:
        "Post a rich notification to the workspace's connected Slack channel (Slack has no issues — this is the 'notify the team' action). Provide a title + the findings (summary, business impact, confidence, affected release/platforms, replay/session ids, suggested next steps); the backend formats a Block-Kit message. External action — shows a preview and posts to Slack ONLY after confirmation.",
      permissions: ["slack.message.post"],
      workspaceScoped: true,
      writes: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          impact: { type: "string" },
          confidence: { type: "string" },
          release: { type: "string" },
          platforms: { type: "array" },
          sessions: { type: "array" },
          nextSteps: { type: "array" },
        },
        required: ["title"],
      },
      precondition: async (_input, ctx: AgentContext) =>
        (await this.integrations.isConnected(ctx.workspaceId, "SLACK"))
          ? null
          : "Slack isn't connected for this workspace yet. Connect it in Settings → Integrations, then I can post the message.",
      // Previews the REAL payload — see linearPayload. Slack renders Block-Kit
      // server-side from these fields, so previewing the fields shows the user
      // everything that will be posted.
      preview: async (input, ctx: AgentContext) => {
        const payload = this.slackPayload(input);
        return {
          operation: "external" as const,
          summary: `Post to Slack: ${payload.title}`,
          permanent: false,
          reversible: false,
          details: {
            destination: "Slack",
            connected: await this.integrations.isConnected(
              ctx.workspaceId,
              "SLACK",
            ),
            // Every field that will be posted — render verbatim.
            ...payload,
          },
        };
      },
      executor: async (input, ctx: AgentContext) => {
        const r = await this.integrations.postSlackMessage(
          ctx.workspaceId,
          this.slackPayload(input),
        );
        if (!r.posted) {
          throw new Error(r.message || "Slack message was not posted.");
        }
        return r;
      },
    });
  }

  /** Collect the changed fields (present in input) for an update preview. */
  private changeSet(
    input: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    for (const k of keys) {
      if (input[k] === undefined) continue;
      changes[k] = Array.isArray(input[k])
        ? `${(input[k] as unknown[]).length} item(s)`
        : input[k];
    }
    return { changes };
  }
}
