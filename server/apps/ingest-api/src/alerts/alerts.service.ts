import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import {
  getPostgresClient,
  Prisma,
  AlertMetric,
  AlertComparator,
  NotificationKind,
} from "@replay/db-postgres";
import { EmailService } from "../email/email.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { decodeCursor, paginateRows, parseLimit } from "../common/cursor";
import { paginated } from "../common/api-response";

/** One external channel this alert fans out to when it fires. Only names WHICH
 *  connected provider to notify (+ an optional per-alert severity override); the
 *  connection secret/URL is resolved from WorkspaceIntegration at dispatch. */
type AlertDestination = {
  provider: "PAGERDUTY" | "WEBHOOK" | "SLACK";
  severity?: "critical" | "error" | "warning" | "info";
};

/** The daily-signal columns the evaluator's join selects; one per AlertMetric. */
interface DailyRow {
  id: number | bigint;
  workspaceId: number;
  name: string;
  metric: string;
  comparator: string;
  threshold: number;
  crashes: number;
  backendFail: number;
  slowApi: number;
  frustrated: number;
  formAbandon: number;
  navLoop: number;
  convFailure: number;
  convSuccess: number;
  healthScore: number;
}

interface Breach {
  id: number;
  workspaceId: number;
  name: string;
  metric: AlertMetric;
  comparator: AlertComparator;
  threshold: number;
  value: number;
}

/** One row of the funnel-conversion evaluator's current-vs-prior rollup JOIN. */
interface FunnelConvRow {
  id: number | bigint;
  workspaceId: number;
  funnelId: number;
  name: string;
  funnelName: string;
  comparator: string;
  threshold: number;
  win: number;
  cur_e: number | bigint;
  cur_c: number | bigint;
  pri_e: number | bigint;
  pri_c: number | bigint;
}

/** A funnel-conversion alert that breached, ready to deliver. `curRate`/`priRate`
 *  are fractions (0..1); `value` is the current conversion % stored as lastValue. */
interface FunnelBreach {
  id: number;
  workspaceId: number;
  funnelId: number;
  name: string;
  funnelName: string;
  comparator: AlertComparator;
  threshold: number;
  win: number;
  curRate: number;
  priRate: number | null;
  value: number;
}

/**
 * The alerts-list row. Narrow by construction: the page renders each alert, the
 * issue it was created for, and the channel it routes to — `kind` picks which of
 * the two column families is meaningful (metric/comparator/threshold vs issueId),
 * and emailEnabled/emailTo render the email leg of the channel next to
 * `destinations`. Nothing here is fetched that the row doesn't draw.
 */
const ALERT_LIST_SELECT = {
  id: true,
  name: true,
  kind: true,
  metric: true,
  comparator: true,
  threshold: true,
  issueId: true,
  incidentId: true,
  // FUNNEL_CONVERSION rows draw the watched funnel + its comparison window and,
  // being email-only, expose emailTo so the page can edit the recipient list.
  funnelId: true,
  windowDays: true,
  emailEnabled: true,
  emailTo: true,
  active: true,
  destinations: true,
  lastValue: true,
  lastFiredAt: true,
  createdAt: true,
};

/** The watched Funnel as the alerts list renders it: `id` keys the batched
 *  lookup + links the row, `name` labels "which funnel this alert watches". */
const ALERT_FUNNEL_SELECT = {
  id: true,
  name: true,
};

/**
 * The watched Issue as the alerts list renders it — deliberately three columns:
 * `id` is the map key + the row's link target, `title` is the "issue this alert
 * was created for" label, `status` is what makes that label live rather than a
 * dead string (a recurrence subscription reads differently when its issue is
 * OPEN vs RESOLVED vs REGRESSED). Rank/counts/fingerprint stay with the Issues
 * page; this row doesn't draw them.
 */
const ALERT_ISSUE_SELECT = {
  id: true,
  title: true,
  status: true,
};

/**
 * Alert Intelligence — user-defined threshold alerts on a workspace's daily
 * signal metrics (crashes, backend failures, slow APIs, frustration, conversion
 * failures, health score…). Each metric maps 1:1 to a WorkspaceSignalDaily
 * column, so an alert watches the SAME deterministic counters the dashboard
 * shows — never an invented metric. The evaluator cron checks active alerts
 * against TODAY's row and notifies workspace admins when a threshold is crossed.
 *
 * The AI can CREATE alerts (create-only, via the agent's alert.create
 * capability) — this is what backs "alert me if this happens again". Editing and
 * deleting stay with the human through the REST API, matching the platform's
 * create+read-only AI rule.
 */
@Injectable()
export class AlertsService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(AlertsService.name);

  /** Keyset page size for the evaluator's active-alert walk. */
  private static readonly PAGE = 500;
  /** Don't re-notify a still-breached alert more often than this. */
  private static readonly COOLDOWN_HOURS = 6;
  /** A funnel-conversion window with fewer entrants than this won't fire — a tiny
   *  denominator makes the conversion % (and its drop vs prior) too noisy. */
  private static readonly FUNNEL_MIN_ENTERED = 50;
  /** metric enum → the daily-row value (getter, so no untyped string indexing).
   *  The join selects every column; we pick the one this alert watches. */
  private static readonly METRIC_VALUE: Record<
    AlertMetric,
    (r: DailyRow) => number
  > = {
    crashes: (r) => Number(r.crashes),
    backendFail: (r) => Number(r.backendFail),
    slowApi: (r) => Number(r.slowApi),
    frustrated: (r) => Number(r.frustrated),
    formAbandon: (r) => Number(r.formAbandon),
    navLoop: (r) => Number(r.navLoop),
    convFailure: (r) => Number(r.convFailure),
    convSuccess: (r) => Number(r.convSuccess),
    healthScore: (r) => Number(r.healthScore),
  };

  /** metric enum → the PagerDuty/severity band the fired alert maps to. */
  private static readonly METRIC_SEVERITY: Record<
    AlertMetric,
    "critical" | "error" | "warning" | "info"
  > = {
    crashes: "critical",
    backendFail: "error",
    convFailure: "error",
    slowApi: "warning",
    frustrated: "warning",
    formAbandon: "warning",
    navLoop: "warning",
    healthScore: "warning",
    convSuccess: "info",
  };

  constructor(
    private readonly email: EmailService,
    private readonly integrations: IntegrationsService,
  ) {}

  /**
   * Create an alert. Workspace-scoped; validates metric/comparator/threshold.
   * The create-only entry point shared by the REST controller and the AI
   * capability (workspaceId + userId are injected by the caller, never trusted
   * from input).
   */
  async create(
    workspaceId: number,
    userId: number,
    body: {
      name?: string;
      metric?: string;
      comparator?: string;
      threshold?: number;
      emailEnabled?: boolean;
      /** Custom recipient (human/REST only) — omit to use the creator's account
       *  email. The AI never sets this; it only toggles emailEnabled. */
      emailTo?: string;
      /** External channels to fan out to when the alert fires — a JSON array of
       *  connected providers (PagerDuty/Webhook/Slack). Validated + normalised. */
      destinations?: unknown;
    },
  ) {
    const name = (body.name ?? "").trim().slice(0, 120);
    if (!name) {
      throw new BadRequestException("Alert name is required.");
    }
    const metric = this.parseMetric(body.metric);
    const comparator = this.parseComparator(body.comparator);
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold)) {
      throw new BadRequestException("threshold must be a number.");
    }
    const destinations = this.parseDestinations(body.destinations);
    await this.assertDestinationsConnected(workspaceId, destinations);
    return this.db.alert.create({
      data: {
        workspaceId,
        createdById: userId,
        name,
        metric,
        comparator,
        threshold,
        emailEnabled: body.emailEnabled === true,
        emailTo: body.emailTo?.trim() || null,
        // Only touch the column when there's something to store, so a workspace
        // that never routes externally doesn't depend on it.
        ...(destinations.length ? { destinations } : {}),
      },
      select: {
        id: true,
        name: true,
        metric: true,
        comparator: true,
        threshold: true,
        active: true,
        destinations: true,
        createdAt: true,
      },
    });
  }

  /**
   * Create a FUNNEL_CONVERSION alert on a saved funnel's OVERALL conversion.
   * comparator DROP_PCT (default) fires on a relative drop vs the prior
   * equal-length window; ABOVE/BELOW compare the current conversion % against the
   * threshold. Workspace-scoped: the funnel must belong to the workspace (point
   * read, like watchIssue). v1 is overall-only (no stepIndex — per-step needs a
   * per-step daily rollup).
   */
  async createFunnelAlert(
    workspaceId: number,
    userId: number,
    body: {
      funnelId?: number;
      name?: string;
      comparator?: string;
      threshold?: number;
      windowDays?: number;
      /** Email recipients (default = the creator's account email when empty).
       *  Funnel-conversion alerts are EMAIL-ONLY — no in-app bell, no external
       *  channels. */
      recipients?: string[];
    },
  ) {
    const funnelId = Number(body.funnelId);
    if (!Number.isInteger(funnelId)) {
      throw new BadRequestException("funnelId is required.");
    }
    const funnel = await this.db.funnel.findFirst({
      where: { id: funnelId, workspaceId },
      select: { id: true, name: true },
    });
    if (!funnel) throw new BadRequestException("Funnel not found.");
    const comparator = this.parseFunnelComparator(body.comparator);
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new BadRequestException("threshold must be a non-negative number.");
    }
    const windowDays =
      body.windowDays != null && Number.isFinite(Number(body.windowDays))
        ? Math.max(1, Math.min(90, Math.floor(Number(body.windowDays))))
        : null;
    const name =
      (body.name ?? "").trim().slice(0, 120) || `${funnel.name} conversion`;
    // Email-only. Recipients are stored comma-joined in emailTo; an empty list
    // stores null and falls back to the creator's account email at send time.
    const emailTo = this.normalizeRecipients(body.recipients);
    return this.db.alert.create({
      data: {
        workspaceId,
        createdById: userId,
        name,
        kind: "FUNNEL_CONVERSION",
        funnelId,
        comparator,
        threshold,
        windowDays,
        emailEnabled: true,
        emailTo,
      },
      select: {
        id: true,
        name: true,
        kind: true,
        comparator: true,
        threshold: true,
        windowDays: true,
        emailTo: true,
        active: true,
        createdAt: true,
      },
    });
  }

  /** Normalise + dedupe + validate an email recipient list into the comma-joined
   *  `emailTo` form (or null when empty → creator-email fallback). Capped at 20. */
  private normalizeRecipients(recipients?: string[]): string | null {
    if (!Array.isArray(recipients)) return null;
    const clean = [
      ...new Set(
        recipients
          .map((e) => String(e).trim().toLowerCase())
          .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
      ),
    ].slice(0, 20);
    return clean.length ? clean.join(",") : null;
  }

  /** ABOVE | BELOW | DROP_PCT (default DROP_PCT — "alert when conversion drops").
   *  Case-insensitive, mirroring parseComparator. */
  private parseFunnelComparator(v: unknown): AlertComparator {
    const s = String(v ?? "DROP_PCT").toUpperCase();
    if (s === "ABOVE" || s === "BELOW" || s === "DROP_PCT") {
      return s as AlertComparator;
    }
    throw new BadRequestException(
      "comparator must be ABOVE, BELOW, or DROP_PCT.",
    );
  }

  /**
   * A workspace's alerts, newest first, each with the Issue it watches resolved.
   * Indexed ([workspaceId, createdAt desc]); capped take, never a full scan.
   * TWO queries for the whole page regardless of alert count — the list, then one
   * batched Issue lookup (see resolveIssues).
   */
  async list(
    workspaceId: number,
    opts: { limit?: number; cursor?: string } = {},
  ) {
    // Keyset pagination on the PK (id desc ≈ createdAt desc for autoincrement):
    // workspace-scoped range scan that stops after one page, served by the
    // (workspaceId, id) ordering — scales to millions of alerts.
    const take = parseLimit(opts.limit, 50, 200);
    const cursorId = decodeCursor(opts.cursor);
    const [rows, total] = await Promise.all([
      this.db.alert.findMany({
        where: {
          workspaceId,
          ...(cursorId !== undefined ? { id: { lt: cursorId } } : {}),
        },
        orderBy: { id: "desc" },
        take: take + 1,
        select: ALERT_LIST_SELECT,
      }),
      // Workspace total — first page only, so the header stat stays exact as
      // pages load (workspace-scoped indexed count; alert counts are small).
      cursorId === undefined
        ? this.db.alert.count({ where: { workspaceId } })
        : Promise.resolve(undefined),
    ]);
    const { items, nextCursor } = paginateRows(rows, take, (r) => r.id);
    // Two batched hydrations for the whole page (issues + funnels), never one
    // query per row — same pattern as resolveIssues.
    const [issueById, funnelById] = await Promise.all([
      this.resolveIssues(workspaceId, items),
      this.resolveFunnels(workspaceId, items),
    ]);
    // `issue` is null for METRIC alerts (no issueId) and for a watched Issue that
    // has since been deleted — the row must render either way. `funnel` is the
    // watched funnel for FUNNEL_CONVERSION rows (null if it was since deleted).
    return paginated(
      items.map((r) => ({
        ...r,
        issue: r.issueId != null ? (issueById.get(r.issueId) ?? null) : null,
        funnel: r.funnelId != null ? (funnelById.get(r.funnelId) ?? null) : null,
      })),
      nextCursor,
      total !== undefined ? { value: total, capped: false } : undefined,
    );
  }

  /**
   * Resolve the watched Funnel for the FUNNEL_CONVERSION rows on this page.
   *
   * Same shape as resolveIssues: Alert holds a bare `funnelId Int?` (no relation),
   * so this is ONE batched `WHERE id IN (…) AND workspaceId = ?` for the whole
   * page — served by Funnel's PK index with workspaceId as a cheap residual
   * tenancy guard — never a per-alert query. Two queries per page as alerts grow.
   */
  private async resolveFunnels(
    workspaceId: number,
    rows: Array<{ funnelId: number | null }>,
  ): Promise<
    Map<number, Prisma.FunnelGetPayload<{ select: typeof ALERT_FUNNEL_SELECT }>>
  > {
    const ids = [
      ...new Set(
        rows.map((r) => r.funnelId).filter((id): id is number => id != null),
      ),
    ];
    if (ids.length === 0) {
      return new Map();
    }
    const funnels = await this.db.funnel.findMany({
      where: { id: { in: ids }, workspaceId },
      select: ALERT_FUNNEL_SELECT,
    });
    return new Map(funnels.map((f) => [f.id, f]));
  }

  /**
   * Resolve the watched Issue for the ISSUE_RECURRENCE rows on this page.
   *
   * Alert has no Issue relation (a bare `issueId Int?`, no FK), so this cannot be
   * an `include` — it is ONE batched lookup for the whole page, never one query
   * per alert.
   *
   * Access pattern: `WHERE id IN (…) AND workspaceId = ?` over at most `take`
   * (≤ 200) deduped ids — served by Issue's PK index on `id`, with workspaceId as
   * a cheap residual filter on the handful of rows that returns. No new index
   * needed, and it stays two queries per page as alerts grow.
   *
   * The workspaceId guard is tenancy defence-in-depth rather than decoration:
   * because issueId has no FK, nothing at the DB level ties an Alert to an Issue
   * in its own workspace. Every write path validates that today (watchIssue is the
   * only one), so a cross-workspace issueId shouldn't exist — but without this
   * guard a single bad or legacy row would leak another tenant's issue title
   * straight into this response.
   */
  private async resolveIssues(
    workspaceId: number,
    rows: Array<{ issueId: number | null }>,
  ): Promise<
    Map<number, Prisma.IssueGetPayload<{ select: typeof ALERT_ISSUE_SELECT }>>
  > {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.issueId)
          .filter((id): id is number => id != null),
      ),
    ];
    if (ids.length === 0) {
      return new Map();
    }
    const issues = await this.db.issue.findMany({
      where: { id: { in: ids }, workspaceId },
      select: ALERT_ISSUE_SELECT,
    });
    return new Map(issues.map((i) => [i.id, i]));
  }

  /** Pause/resume an alert (human action via REST). Scoped by workspace so a
   *  tenant can only touch its own. */
  async setActive(workspaceId: number, id: number, active: boolean) {
    const r = await this.db.alert.updateMany({
      where: { id, workspaceId },
      data: { active },
    });
    if (r.count === 0) {
      throw new BadRequestException("Alert not found.");
    }
    return { id, active };
  }

  /**
   * Edit an alert's name / threshold / comparator / metric / active. Only the
   * provided fields change; metric+comparator are validated. Workspace-scoped
   * (updateMany with a workspaceId guard, so a tenant can't touch another's).
   */
  async update(
    workspaceId: number,
    id: number,
    body: {
      name?: string;
      threshold?: number;
      comparator?: string;
      metric?: string;
      active?: boolean;
      destinations?: unknown;
      /** FUNNEL_CONVERSION only — the email recipient list (email-only alerts).
       *  Normalised + capped; an empty list clears emailTo → creator-email fallback. */
      recipients?: string[];
      /** FUNNEL_CONVERSION only — the comparison window in days (clamped 1..90). */
      windowDays?: number;
    },
  ) {
    const data: Prisma.AlertUpdateManyMutationInput = {};
    if (body.name !== undefined) data.name = String(body.name).slice(0, 120);
    if (body.threshold !== undefined && Number.isFinite(Number(body.threshold))) {
      data.threshold = Number(body.threshold);
    }
    if (
      body.windowDays !== undefined &&
      Number.isFinite(Number(body.windowDays))
    ) {
      data.windowDays = Math.max(
        1,
        Math.min(90, Math.floor(Number(body.windowDays))),
      );
    }
    // Recipients edit — email-only alerts store the list comma-joined in emailTo;
    // an empty/whitespace list clears it (→ creator-email fallback at send time).
    if (body.recipients !== undefined) {
      data.emailTo = this.normalizeRecipients(body.recipients);
      data.emailEnabled = true;
    }
    if (body.comparator !== undefined) {
      // Comparator vocab depends on the alert KIND: FUNNEL_CONVERSION accepts
      // ABOVE|BELOW|DROP_PCT, every other kind only ABOVE|BELOW. One PK
      // point-read (workspace-scoped), and only when the comparator changes.
      const existing = await this.db.alert.findFirst({
        where: { id, workspaceId },
        select: { kind: true },
      });
      data.comparator =
        existing?.kind === "FUNNEL_CONVERSION"
          ? this.parseFunnelComparator(body.comparator)
          : this.parseComparator(body.comparator);
    }
    if (body.metric !== undefined) {
      data.metric = this.parseMetric(body.metric);
    }
    if (body.active !== undefined) {
      data.active = !!body.active;
    }
    let dests: AlertDestination[] | undefined;
    if (body.destinations !== undefined) {
      dests = this.parseDestinations(body.destinations);
      // Only providers being ADDED have to be connected. Re-validating the whole
      // list stranded any alert whose provider was later disconnected: the save
      // was rejected over a destination the user hadn't touched, so they could
      // not even REMOVE it — and the error named that provider rather than the
      // one they were actually adding. Grandfathering what's already stored
      // keeps "route somewhere that can't receive" impossible while leaving the
      // row editable.
      // Access pattern: one PK point-read, workspace-scoped, and only when
      // destinations actually change.
      const current = await this.db.alert.findFirst({
        where: { id, workspaceId },
        select: { destinations: true },
      });
      const had = new Set(
        this.parseDestinations(current?.destinations).map((d) => d.provider),
      );
      await this.assertDestinationsConnected(
        workspaceId,
        dests.filter((d) => !had.has(d.provider)),
      );
      data.destinations = dests.length ? dests : Prisma.DbNull;
    }
    const r = await this.db.alert.updateMany({ where: { id, workspaceId }, data });
    if (r.count === 0) {
      throw new BadRequestException("Alert not found.");
    }
    // Never echo Prisma.DbNull back — it JSON-serialises to `{}`, which would
    // read as "an empty destination object" to a client. Return the real list.
    return { ...data, id, ...(dests !== undefined ? { destinations: dests } : {}) };
  }

  /** Reject destinations whose provider the workspace hasn't actually connected
   *  — otherwise the alert saves happily and then silently never pages, which
   *  is the worst possible failure for an on-call route. ONE indexed lookup
   *  (unique [workspaceId, provider]), and only when destinations are supplied. */
  private async assertDestinationsConnected(
    workspaceId: number,
    dests: AlertDestination[],
  ): Promise<void> {
    if (dests.length === 0) return;
    const rows = await this.db.workspaceIntegration.findMany({
      where: { workspaceId, provider: { in: dests.map((d) => d.provider) } },
      select: { provider: true },
    });
    const connected = new Set(rows.map((r) => String(r.provider)));
    const missing = dests
      .map((d) => d.provider)
      .filter((p) => !connected.has(p));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Not connected: ${missing.join(", ")}. Connect it in Settings → Integrations before routing alerts there.`,
      );
    }
  }

  /** Delete an alert (human action via REST). Workspace-scoped. */
  async remove(workspaceId: number, id: number) {
    const r = await this.db.alert.deleteMany({ where: { id, workspaceId } });
    if (r.count === 0) {
      throw new BadRequestException("Alert not found.");
    }
    return { id, deleted: true };
  }

  /**
   * Create an issue-recurrence alert — "alert me if this issue comes up again".
   * Fires (minutes-latency) when the watched Issue regresses: the issue-derivation
   * pipeline flips it RESOLVED → REGRESSED on ingest, and evaluateIssueRecurrence
   * catches it on the next tick. Create-only; workspace-scoped.
   */
  async watchIssue(
    workspaceId: number,
    userId: number,
    issueId: number,
    name?: string,
    emailEnabled = false,
  ) {
    const issue = await this.db.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: { id: true, title: true },
    });
    if (!issue) {
      throw new BadRequestException("Issue not found.");
    }
    return this.db.alert.create({
      data: {
        workspaceId,
        createdById: userId,
        kind: "ISSUE_RECURRENCE",
        issueId,
        name: (name?.trim() || `Recurrence: ${issue.title}`).slice(0, 120),
        emailEnabled,
      },
      select: { id: true, name: true, issueId: true, active: true, createdAt: true },
    });
  }

  /**
   * Create an incident-recurrence alert — "alert me about this dashboard signal".
   * A dashboard Signal is backed by an Incident (or an Issue → use watchIssue).
   * Fires (minutes-latency) when the watched Incident is OPEN and freshly seen
   * since the alert last fired. `lastFiredAt` is stamped at creation to the
   * incident's current lastSeenAt, so it never fires on the activity you're
   * looking at right now — only on FUTURE recurrence, past the cooldown.
   * Create-only; workspace-scoped.
   */
  async watchIncident(
    workspaceId: number,
    userId: number,
    incidentId: number,
    name?: string,
    emailEnabled = false,
  ) {
    const incident = await this.db.incident.findFirst({
      where: { id: incidentId, workspaceId },
      select: { id: true, title: true, lastSeenAt: true },
    });
    if (!incident) {
      throw new BadRequestException("Signal not found.");
    }
    return this.db.alert.create({
      data: {
        workspaceId,
        createdById: userId,
        kind: "INCIDENT_RECURRENCE",
        incidentId,
        name: (name?.trim() || `Signal: ${incident.title}`).slice(0, 120),
        emailEnabled,
        // Baseline the cooldown at the incident's current activity so the first
        // notification requires NEW activity after this alert was set.
        lastFiredAt: incident.lastSeenAt,
      },
      select: { id: true, name: true, incidentId: true, active: true, createdAt: true },
    });
  }

  /**
   * Issue-recurrence evaluator (every 5 min, offset from the metric one). Fires
   * any active issue-recurrence alert whose watched Issue is REGRESSED and has
   * been seen since the alert last fired (past cooldown). ONE set-based JOIN of
   * Alert→Issue — never a per-alert query — then a batched fan-out (one admin
   * lookup + one createMany + one lastFiredAt stamp).
   */
  @Cron("50 */5 * * * *")
  async evaluateIssueRecurrence(): Promise<void> {
    try {
      const cooldown = new Date(
        Date.now() - AlertsService.COOLDOWN_HOURS * 3_600_000,
      );
      const due = await this.db.$queryRaw<
        Array<{ id: number; workspaceId: number; name: string; title: string }>
      >`
        SELECT a.id, a."workspaceId", a.name, i.title
        FROM "Alert" a
        JOIN "Issue" i ON i.id = a."issueId"
        WHERE a.active = true AND a.kind = 'ISSUE_RECURRENCE'
          AND i.status = 'REGRESSED'
          AND (a."lastFiredAt" IS NULL OR i."lastSeenAt" > a."lastFiredAt")
          AND (a."lastFiredAt" IS NULL OR a."lastFiredAt" < ${cooldown})`;
      if (due.length === 0) return;

      const wsIds = [...new Set(due.map((d) => d.workspaceId))];
      const admins = await this.db.workspaceMember.findMany({
        where: { workspaceId: { in: wsIds }, role: { in: ["OWNER", "ADMIN"] } },
        select: { workspaceId: true, userId: true },
      });
      const adminsByWs = new Map<number, number[]>();
      for (const a of admins) {
        const arr = adminsByWs.get(a.workspaceId);
        if (arr) arr.push(a.userId);
        else adminsByWs.set(a.workspaceId, [a.userId]);
      }
      const notifications = due.flatMap((d) =>
        (adminsByWs.get(d.workspaceId) ?? []).map((userId) => ({
          workspaceId: d.workspaceId,
          userId,
          kind: NotificationKind.ALERT_TRIGGERED,
          payload: {
            alertName: d.name,
            kind: "issue_recurrence",
            issue: d.title,
          } as Prisma.InputJsonValue,
        })),
      );
      if (notifications.length > 0) {
        await this.db.notification.createMany({ data: notifications });
      }
      await this.db.$executeRaw`
        UPDATE "Alert" SET "lastFiredAt" = now()
        WHERE id IN (${Prisma.join(due.map((d) => d.id))})`;
      await this.sendAlertEmails(
        due.map((d) => ({
          id: d.id,
          workspaceId: d.workspaceId,
          detail: `Issue "${d.title}" has recurred (regressed after being resolved).`,
        })),
      );
      await this.dispatchExternal(
        due.map((d) => ({
          workspaceId: d.workspaceId,
          alertId: d.id,
          title: `${d.name} — issue recurred`,
          detail: `Issue "${d.title}" has recurred (regressed after being resolved).`,
          severity: "error" as const,
        })),
      );
      this.logger.log(`alerts: fired ${due.length} issue-recurrence alert(s)`);
    } catch (e) {
      this.logger.warn(
        `issue-recurrence evaluation failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Incident-recurrence evaluator (every 5 min, offset from the other two). Fires
   * any active incident-recurrence alert whose watched Incident is OPEN and has
   * been seen since the alert last fired (past cooldown). Same set-based
   * Alert→Incident JOIN + batched fan-out as the issue evaluator — never a
   * per-alert query.
   */
  @Cron("40 */5 * * * *")
  async evaluateIncidentRecurrence(): Promise<void> {
    try {
      const cooldown = new Date(
        Date.now() - AlertsService.COOLDOWN_HOURS * 3_600_000,
      );
      const due = await this.db.$queryRaw<
        Array<{ id: number; workspaceId: number; name: string; title: string }>
      >`
        SELECT a.id, a."workspaceId", a.name, i.title
        FROM "Alert" a
        JOIN "Incident" i ON i.id = a."incidentId"
        WHERE a.active = true AND a.kind = 'INCIDENT_RECURRENCE'
          AND i.status = 'OPEN'
          AND (a."lastFiredAt" IS NULL OR i."lastSeenAt" > a."lastFiredAt")
          AND (a."lastFiredAt" IS NULL OR a."lastFiredAt" < ${cooldown})`;
      if (due.length === 0) return;

      const wsIds = [...new Set(due.map((d) => d.workspaceId))];
      const admins = await this.db.workspaceMember.findMany({
        where: { workspaceId: { in: wsIds }, role: { in: ["OWNER", "ADMIN"] } },
        select: { workspaceId: true, userId: true },
      });
      const adminsByWs = new Map<number, number[]>();
      for (const a of admins) {
        const arr = adminsByWs.get(a.workspaceId);
        if (arr) arr.push(a.userId);
        else adminsByWs.set(a.workspaceId, [a.userId]);
      }
      const notifications = due.flatMap((d) =>
        (adminsByWs.get(d.workspaceId) ?? []).map((userId) => ({
          workspaceId: d.workspaceId,
          userId,
          kind: NotificationKind.ALERT_TRIGGERED,
          payload: {
            alertName: d.name,
            kind: "incident_recurrence",
            incident: d.title,
          } as Prisma.InputJsonValue,
        })),
      );
      if (notifications.length > 0) {
        await this.db.notification.createMany({ data: notifications });
      }
      await this.db.$executeRaw`
        UPDATE "Alert" SET "lastFiredAt" = now()
        WHERE id IN (${Prisma.join(due.map((d) => d.id))})`;
      await this.sendAlertEmails(
        due.map((d) => ({
          id: d.id,
          workspaceId: d.workspaceId,
          detail: `Signal "${d.title}" is active again.`,
        })),
      );
      await this.dispatchExternal(
        due.map((d) => ({
          workspaceId: d.workspaceId,
          alertId: d.id,
          title: `${d.name} — signal recurred`,
          detail: `Signal "${d.title}" is active again.`,
          severity: "error" as const,
        })),
      );
      this.logger.log(`alerts: fired ${due.length} incident-recurrence alert(s)`);
    } catch (e) {
      this.logger.warn(
        `incident-recurrence evaluation failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Evaluator — every 5 min, fire any active alert whose metric crossed its
   * threshold in TODAY's WorkspaceSignalDaily row (past its cooldown).
   *
   * Access pattern (scales to millions of alerts/workspaces): keyset-paginate
   * ACTIVE, cooldown-eligible alerts by id, INNER JOIN today's daily row — ONE
   * query per page, served by @@index([active, id]); breaches are decided in
   * memory (no per-alert query). The fan-out (admin lookup + notifications +
   * cooldown stamp) is then fully batched in `fire()` — never an await-in-loop,
   * never N+1. A workspace with no sessions today has no daily row, so the inner
   * join simply skips it (no data → no fire).
   */
  @Cron("30 */5 * * * *")
  async evaluate(): Promise<void> {
    try {
      const cooldown = new Date(
        Date.now() - AlertsService.COOLDOWN_HOURS * 3_600_000,
      );
      let cursor = 0;
      const breached: Breach[] = [];
      for (;;) {
        const rows = await this.db.$queryRaw<DailyRow[]>`
          SELECT a.id, a."workspaceId", a.name, a.metric::text AS metric,
                 a.comparator::text AS comparator, a.threshold,
                 d.crashes, d."backendFail", d."slowApi", d.frustrated,
                 d."formAbandon", d."navLoop", d."convFailure", d."convSuccess",
                 d."healthScore"
          FROM "Alert" a
          JOIN "WorkspaceSignalDaily" d
            ON d."workspaceId" = a."workspaceId" AND d.day = CURRENT_DATE
          WHERE a.active = true
            AND a.kind = 'METRIC'
            AND a.id > ${cursor}
            AND (a."lastFiredAt" IS NULL OR a."lastFiredAt" < ${cooldown})
          ORDER BY a.id ASC
          LIMIT ${AlertsService.PAGE}`;
        if (rows.length === 0) {
          break;
        }
        for (const r of rows) {
          const metric = r.metric as AlertMetric;
          const value = AlertsService.METRIC_VALUE[metric](r);
          const t = Number(r.threshold);
          const breach = r.comparator === "ABOVE" ? value > t : value < t;
          if (breach) {
            breached.push({
              id: Number(r.id),
              workspaceId: Number(r.workspaceId),
              name: r.name,
              metric,
              comparator: r.comparator as AlertComparator,
              threshold: t,
              value,
            });
          }
        }
        cursor = Number(rows[rows.length - 1].id);
        if (rows.length < AlertsService.PAGE) {
          break;
        }
      }
      if (breached.length === 0) {
        return;
      }
      await this.fire(breached);
      this.logger.log(`alerts: fired ${breached.length} threshold breach(es)`);
    } catch (e) {
      this.logger.warn(`alert evaluation failed: ${(e as Error).message}`);
    }
  }

  /**
   * Notify admins of the breached alerts + stamp their cooldown — both batched.
   * ONE admin lookup for every breached workspace, ONE createMany for all
   * notifications, ONE set-based UPDATE for lastFiredAt/lastValue.
   */
  private async fire(breached: Breach[]): Promise<void> {
    const wsIds = [...new Set(breached.map((b) => b.workspaceId))];
    // ONE query for every admin across all breached workspaces.
    const admins = await this.db.workspaceMember.findMany({
      where: { workspaceId: { in: wsIds }, role: { in: ["OWNER", "ADMIN"] } },
      select: { workspaceId: true, userId: true },
    });
    const adminsByWs = new Map<number, number[]>();
    for (const a of admins) {
      const arr = adminsByWs.get(a.workspaceId);
      if (arr) arr.push(a.userId);
      else adminsByWs.set(a.workspaceId, [a.userId]);
    }

    const notifications = breached.flatMap((b) =>
      (adminsByWs.get(b.workspaceId) ?? []).map((userId) => ({
        workspaceId: b.workspaceId,
        userId,
        kind: NotificationKind.ALERT_TRIGGERED,
        payload: {
          alertName: b.name,
          metric: b.metric,
          comparator: b.comparator,
          threshold: b.threshold,
          value: b.value,
        } as Prisma.InputJsonValue,
      })),
    );
    if (notifications.length > 0) {
      await this.db.notification.createMany({ data: notifications });
    }

    // Set-based cooldown stamp for the whole fired batch (one UPDATE…FROM VALUES).
    const tuples = breached.map(
      (b) => Prisma.sql`(${b.id}::int, ${b.value}::double precision)`,
    );
    await this.db.$executeRaw`
      UPDATE "Alert" a SET "lastFiredAt" = now(), "lastValue" = v.val
      FROM (VALUES ${Prisma.join(tuples)}) AS v(id, val)
      WHERE a.id = v.id`;

    await this.sendAlertEmails(
      breached.map((b) => ({
        id: b.id,
        workspaceId: b.workspaceId,
        detail: `${b.metric} is ${b.comparator.toLowerCase()} ${b.threshold} (now ${b.value}).`,
      })),
    );

    await this.dispatchExternal(
      breached.map((b) => ({
        workspaceId: b.workspaceId,
        alertId: b.id,
        title: `${b.name} — ${b.metric} ${b.comparator.toLowerCase()} ${b.threshold}`,
        detail: `${b.metric} is ${b.comparator.toLowerCase()} ${b.threshold} (now ${b.value}).`,
        severity: AlertsService.METRIC_SEVERITY[b.metric] ?? "warning",
      })),
    );
  }

  /**
   * Funnel-conversion evaluator — runs ONCE DAILY at 03:00, right after the 02:00
   * WorkspaceConversionDaily reconcile, so it reads freshly-materialised rollup
   * days. It NEVER runs a live windowFunnel: it keyset-paginates active
   * FUNNEL_CONVERSION alerts and, in ONE set-based JOIN per page, aggregates each
   * alert's current vs prior equal-length window straight off the daily rollup
   * (per-alert window via COALESCE(alert.windowDays, funnel.windowDays, 7); the
   * JOIN is bounded to the last 2×window days). Breaches are decided in memory and
   * delivered through the shared batched fan-out (fireFunnelBreaches → the same
   * sendAlertEmails/dispatchExternal as the metric path). Scales: O(active funnel
   * alerts), served by @@index([active, id]) + WorkspaceConversionDaily's PK — no
   * per-alert query, no windowFunnel, no session scan. Daily cadence matches the
   * rollup's freshness (it only changes nightly) — a 5-min tick would re-scan
   * identical data.
   */
  @Cron("0 3 * * *")
  async evaluateFunnelConversion(): Promise<void> {
    try {
      const cooldown = new Date(
        Date.now() - AlertsService.COOLDOWN_HOURS * 3_600_000,
      );
      let cursor = 0;
      const breached: FunnelBreach[] = [];
      for (;;) {
        // Per-alert window `w = COALESCE(alert.windowDays, funnel.windowDays, 7)`.
        // Anchor both windows at YESTERDAY (CURRENT_DATE - 1) — the newest day the
        // 02:00 reconcile has materialised (today is never in the rollup). current
        // = the w days ending yesterday; prior = the w days before that. Both cover
        // exactly w populated days. The JOIN scans only the last 2w days (indexed PK).
        const rows = await this.db.$queryRaw<FunnelConvRow[]>`
          SELECT a.id, a."workspaceId", a."funnelId", a.name,
                 a.comparator::text AS comparator, a.threshold,
                 f.name AS "funnelName",
                 COALESCE(a."windowDays", f."windowDays", 7) AS win,
                 COALESCE(SUM(d.entered)   FILTER (WHERE d.day > (CURRENT_DATE - 1) - COALESCE(a."windowDays", f."windowDays", 7) AND d.day <= CURRENT_DATE - 1), 0) AS cur_e,
                 COALESCE(SUM(d.converted) FILTER (WHERE d.day > (CURRENT_DATE - 1) - COALESCE(a."windowDays", f."windowDays", 7) AND d.day <= CURRENT_DATE - 1), 0) AS cur_c,
                 COALESCE(SUM(d.entered)   FILTER (WHERE d.day <= (CURRENT_DATE - 1) - COALESCE(a."windowDays", f."windowDays", 7)), 0) AS pri_e,
                 COALESCE(SUM(d.converted) FILTER (WHERE d.day <= (CURRENT_DATE - 1) - COALESCE(a."windowDays", f."windowDays", 7)), 0) AS pri_c
          FROM "Alert" a
          JOIN "Funnel" f
            ON f.id = a."funnelId" AND f."workspaceId" = a."workspaceId"
          JOIN "WorkspaceConversionDaily" d
            ON d."workspaceId" = a."workspaceId" AND d."funnelId" = a."funnelId"
           AND d.day > (CURRENT_DATE - 1) - (2 * COALESCE(a."windowDays", f."windowDays", 7))
          WHERE a.active = true
            AND a.kind = 'FUNNEL_CONVERSION'
            AND a.id > ${cursor}
            AND (a."lastFiredAt" IS NULL OR a."lastFiredAt" < ${cooldown})
          GROUP BY a.id, a."workspaceId", a."funnelId", a.name, a.comparator, a.threshold, f.name,
                   COALESCE(a."windowDays", f."windowDays", 7)
          ORDER BY a.id ASC
          LIMIT ${AlertsService.PAGE}`;
        if (rows.length === 0) break;
        for (const r of rows) {
          const curE = Number(r.cur_e);
          const curC = Number(r.cur_c);
          const priE = Number(r.pri_e);
          const priC = Number(r.pri_c);
          // Noisy denominator guard — mirrors the health MIN_SESSIONS floor.
          if (curE < AlertsService.FUNNEL_MIN_ENTERED) continue;
          const curRate = curE > 0 ? curC / curE : 0;
          const priRate = priE > 0 ? priC / priE : null;
          const comparator = r.comparator as AlertComparator;
          const t = Number(r.threshold);
          let breach = false;
          if (comparator === "DROP_PCT") {
            // Needs a prior window with enough volume; relative drop vs prior.
            if (
              priRate != null &&
              priRate > 0 &&
              priE >= AlertsService.FUNNEL_MIN_ENTERED
            ) {
              const dropPct = ((priRate - curRate) / priRate) * 100;
              breach = dropPct > t;
            }
          } else if (comparator === "ABOVE") {
            breach = curRate * 100 > t;
          } else {
            breach = curRate * 100 < t;
          }
          if (breach) {
            breached.push({
              id: Number(r.id),
              workspaceId: Number(r.workspaceId),
              funnelId: Number(r.funnelId),
              name: r.name,
              funnelName: r.funnelName,
              comparator,
              threshold: t,
              win: Number(r.win),
              curRate,
              priRate,
              value: Number((curRate * 100).toFixed(2)),
            });
          }
        }
        cursor = Number(rows[rows.length - 1].id);
        if (rows.length < AlertsService.PAGE) break;
      }
      if (breached.length === 0) return;
      await this.fireFunnelBreaches(breached);
      this.logger.log(
        `alerts: fired ${breached.length} funnel-conversion breach(es)`,
      );
    } catch (e) {
      this.logger.warn(
        `funnel-conversion alert evaluation failed: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Deliver breached funnel-conversion alerts — same batched fan-out as `fire()`
   * (one admin lookup, one notification.createMany, one set-based cooldown
   * UPDATE) then the SHARED sendAlertEmails/dispatchExternal. Kept separate from
   * `fire()` so the audited metric path is untouched; the message copy is
   * funnel-specific.
   */
  private async fireFunnelBreaches(breached: FunnelBreach[]): Promise<void> {
    // Funnel-conversion alerts are EMAIL-ONLY — no in-app bell, no external
    // channels (PagerDuty/Webhook/Slack). So: stamp the cooldown, then email the
    // recipients (creator + any extras stored on emailTo) with a deep-link back
    // to the funnel.
    const detailOf = (b: FunnelBreach): string => {
      const cur = (b.curRate * 100).toFixed(1);
      if (b.comparator === "DROP_PCT" && b.priRate != null && b.priRate > 0) {
        const prior = (b.priRate * 100).toFixed(1);
        const drop = (((b.priRate - b.curRate) / b.priRate) * 100).toFixed(1);
        return `"${b.funnelName}" conversion is ${cur}% — down ${drop}% from ${prior}% over the last ${b.win} days.`;
      }
      const dir = b.comparator === "ABOVE" ? "above" : "below";
      return `"${b.funnelName}" conversion is ${cur}%, ${dir} your ${b.threshold}% threshold over the last ${b.win} days.`;
    };

    const tuples = breached.map(
      (b) => Prisma.sql`(${b.id}::int, ${b.value}::double precision)`,
    );
    await this.db.$executeRaw`
      UPDATE "Alert" a SET "lastFiredAt" = now(), "lastValue" = v.val
      FROM (VALUES ${Prisma.join(tuples)}) AS v(id, val)
      WHERE a.id = v.id`;

    const base = (process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
    await this.sendAlertEmails(
      breached.map((b) => ({
        id: b.id,
        workspaceId: b.workspaceId,
        detail: detailOf(b),
        ctaUrl: base ? `${base}/funnels/${b.funnelId}` : undefined,
        ctaLabel: "View funnel",
      })),
    );
  }

  /**
   * Fan the fired alerts that configured external channels (PagerDuty/Webhook/
   * Slack) out to those channels — beyond the in-app bell + email. Best-effort
   * and deliberately ADDITIVE: the bell + email above have already been
   * delivered by the time this runs, and every failure here is contained, so
   * this can never degrade the core alerting path.
   *
   * Access pattern: fired alerts past their cooldown are inherently few (that's
   * the point of the 6h cooldown), so everything here is bounded by the breach
   * count, never table size. TWO batched reads total: one for the fired alerts'
   * destination config (keyed on the PK), one for which dispatchable providers
   * those workspaces have connected (indexed unique [workspaceId, provider]) so
   * not-connected destinations are dropped without a per-alert query. The
   * remaining per-(alert, provider) connection lookup happens inside each send*
   * — that's the dispatch itself, and it's bounded by the same small breach set.
   */
  private async dispatchExternal(
    fired: Array<{
      workspaceId: number;
      alertId: number;
      title: string;
      detail: string;
      severity: "critical" | "error" | "warning" | "info";
    }>,
  ): Promise<void> {
    if (fired.length === 0) return;

    // Read the destination config OFF the evaluator's critical path, in its own
    // guard: if this column isn't migrated yet (`prisma db push`) or the read
    // fails, we skip the external fan-out only — the bell + email already went
    // out. Selecting it in the evaluator's own query instead would take the
    // WHOLE alerting path down silently.
    let configRows: Array<{ id: number; destinations: Prisma.JsonValue }>;
    try {
      configRows = await this.db.alert.findMany({
        where: { id: { in: fired.map((f) => f.alertId) } },
        select: { id: true, destinations: true },
      });
    } catch (e) {
      this.logger.warn(
        `alert destinations unavailable, skipped external fan-out: ${(e as Error).message}`,
      );
      return;
    }
    const destsById = new Map(
      configRows.map((r) => [r.id, this.parseDestinations(r.destinations)]),
    );
    const withDest = fired
      .map((f) => ({ ...f, dests: destsById.get(f.alertId) ?? [] }))
      .filter((f) => f.dests.length > 0);
    if (withDest.length === 0) return;

    const wsIds = [...new Set(withDest.map((f) => f.workspaceId))];
    const connectedRows = await this.db.workspaceIntegration.findMany({
      where: {
        workspaceId: { in: wsIds },
        provider: { in: ["PAGERDUTY", "WEBHOOK", "SLACK"] },
      },
      select: { workspaceId: true, provider: true },
    });
    const connected = new Set(
      connectedRows.map((r) => `${r.workspaceId}:${r.provider}`),
    );

    const base = (process.env.DASHBOARD_URL ?? "").replace(/\/$/, "");
    await Promise.allSettled(
      withDest.map((f) => {
        const dests = f.dests.filter((d) =>
          connected.has(`${f.workspaceId}:${d.provider}`),
        );
        if (dests.length === 0) return Promise.resolve();
        return this.integrations.notifyAlert(
          f.workspaceId,
          {
            title: f.title,
            detail: f.detail,
            severity: f.severity,
            // Stable per-alert key so a still-breaching alert folds into one
            // PagerDuty incident instead of paging every tick.
            dedupKey: `alert-${f.alertId}`,
            url: base ? `${base}/alerts` : undefined,
          },
          dests,
        );
      }),
    );
  }

  /** Validate + normalise a stored/inbound `destinations` JSON into the typed
   *  channel list. Silently drops unknown providers, dedupes by provider, caps
   *  at the three we can dispatch. Returns [] for anything malformed.
   *
   *  Accepts a already-parsed array OR a JSON string: the evaluator reads this
   *  column through $queryRaw, and a driver that hands jsonb back as text would
   *  otherwise make every dispatch silently no-op (no pages, no error). */
  private parseDestinations(raw: unknown): AlertDestination[] {
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];
    const allowed = new Set(["PAGERDUTY", "WEBHOOK", "SLACK"]);
    const sev = new Set(["critical", "error", "warning", "info"]);
    const out: AlertDestination[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const provider = String(
        (item as { provider?: unknown }).provider ?? "",
      ).toUpperCase();
      if (!allowed.has(provider) || seen.has(provider)) continue;
      seen.add(provider);
      const rawSev = (item as { severity?: unknown }).severity;
      const severity =
        typeof rawSev === "string" && sev.has(rawSev)
          ? (rawSev as AlertDestination["severity"])
          : undefined;
      out.push({ provider: provider as AlertDestination["provider"], severity });
    }
    return out;
  }

  /**
   * Email the fired alerts that opted into the email channel — batched: one
   * alert-config lookup, one creator-email lookup (for those defaulting to the
   * account email), one workspace-name lookup, then a fan of queued sends. The
   * `to` is the alert's explicit emailTo or the creator's account email; never
   * an address the AI guessed. Best-effort.
   */
  private async sendAlertEmails(
    fired: Array<{
      id: number;
      workspaceId: number;
      detail: string;
      /** Optional deep-link + label → renders a CTA button in the email. */
      ctaUrl?: string;
      ctaLabel?: string;
    }>,
  ): Promise<void> {
    if (fired.length === 0) return;
    try {
      const ids = fired.map((f) => f.id);
      const alerts = await this.db.alert.findMany({
        where: { id: { in: ids }, emailEnabled: true },
        select: {
          id: true,
          name: true,
          emailTo: true,
          createdById: true,
          workspaceId: true,
        },
      });
      if (alerts.length === 0) return;
      const creatorIds = [
        ...new Set(alerts.filter((a) => !a.emailTo).map((a) => a.createdById)),
      ];
      const creators = creatorIds.length
        ? await this.db.user.findMany({
            where: { id: { in: creatorIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailByCreator = new Map(creators.map((c) => [c.id, c.email]));
      const wss = await this.db.workspace.findMany({
        where: { id: { in: [...new Set(alerts.map((a) => a.workspaceId))] } },
        select: { id: true, name: true },
      });
      const wsName = new Map(wss.map((w) => [w.id, w.name]));
      const detailById = new Map(fired.map((f) => [f.id, f.detail]));
      const ctaById = new Map(fired.map((f) => [f.id, f.ctaUrl]));
      const ctaLabelById = new Map(fired.map((f) => [f.id, f.ctaLabel]));
      await Promise.all(
        alerts.map((a) => {
          const to = a.emailTo || emailByCreator.get(a.createdById);
          if (!to) return undefined;
          return this.email
            .sendAlert({
              to,
              alertName: a.name,
              detail: detailById.get(a.id) ?? "An alert you set triggered.",
              workspaceName: wsName.get(a.workspaceId),
              ctaUrl: ctaById.get(a.id),
              ctaLabel: ctaLabelById.get(a.id),
            })
            .catch(() => undefined);
        }),
      );
    } catch (e) {
      this.logger.warn(`alert email send failed: ${(e as Error).message}`);
    }
  }

  /** Validate the metric against the AlertMetric enum (clean error for the API
   *  + the AI capability). */
  private parseMetric(v: unknown): AlertMetric {
    const s = String(v ?? "");
    if ((Object.values(AlertMetric) as string[]).includes(s)) {
      return s as AlertMetric;
    }
    throw new BadRequestException(
      `metric must be one of: ${Object.values(AlertMetric).join(", ")}`,
    );
  }

  /** Validate the comparator (ABOVE | BELOW), case-insensitively. */
  private parseComparator(v: unknown): AlertComparator {
    const s = String(v ?? "").toUpperCase();
    if (s === "ABOVE" || s === "BELOW") {
      return s as AlertComparator;
    }
    throw new BadRequestException("comparator must be ABOVE or BELOW.");
  }
}
