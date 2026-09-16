import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { WorkspaceHealthService } from "../workspace-health/workspace-health.service";
import { IssuesService } from "../issues/issues.service";

/** A single verified fact, keyed by a stable fact-id (F_inc_5, H_stability, …). */
type Fact = Record<string, unknown>;
/** Server-side source row for an insight, used by the resolver (never sent to the model). */
export interface Source {
  kind: "incident" | "issue";
  sourceId: number;
  title: string;
  screen: string | null;
  sessionCount: number;
  userCount: number;
  deltaPctX100: number;
  rank: number;
  polarity: string;
  linkedIssueId: number | null;
  linkedIssueRecording: string | null;
}
interface FunnelFact {
  id: number;
  name: string;
  goalKey: string | null;
}
export interface FactBundle {
  facts: Record<string, Fact>;
  sources: Record<string, Source>; // keyed by the same fact-id (F_inc_/F_iss_)
  funnels: FunnelFact[];
}
export interface ResolvedAction {
  actionKind: string;
  actionRef: string;
  actionHref: string;
}

const STR_CAP = 120;

/**
 * Assembles the bounded, id-addressed FactBundle the intel pass hands the model,
 * and owns the deterministic grounding helpers: the deep-link resolver (real
 * entity id → provisional URL) and the template-slot filler (server fills
 * {{fact.field}} verbatim, so the model can never emit a raw number — R3).
 *
 * Reads only ALREADY-materialized facts (the cached snapshot overview/metrics,
 * the 0b health, the ranked issues, pinned funnels) — never rrweb/video, never a
 * per-session scan. Every list is capped by deterministic rank.
 */
@Injectable()
export class IntelFactsService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly health: WorkspaceHealthService,
    private readonly issues: IssuesService,
  ) {}

  async assemble(workspaceId: number): Promise<FactBundle> {
    const [snap, health, issues, funnels] = await Promise.all([
      this.db.workspaceSnapshot.findUnique({
        where: { workspaceId },
        select: { overview: true, metrics: true },
      }),
      this.health.experienceHealth(workspaceId, 30),
      // list() now returns a paginated envelope; this caller wants the rows.
      this.issues.list(workspaceId, { status: "OPEN", limit: 8 }).then((r) => r.items),
      this.db.funnel.findMany({
        where: { workspaceId, pinned: true },
        take: 20,
        select: { id: true, name: true, steps: true },
      }),
    ]);
    const overview = (snap?.overview ?? {}) as Record<string, unknown>;
    const metrics = snap?.metrics ?? {};
    const facts: Record<string, Fact> = {};
    const sources: Record<string, Source> = {};

    // Incidents (top 12, problems + opportunities) — the AI's primary material.
    const lanes = (overview.incidents ?? {}) as Record<string, unknown>;
    const incs = [
      ...(Array.isArray(lanes.problems) ? lanes.problems : []),
      ...(Array.isArray(lanes.opportunities) ? lanes.opportunities : []),
    ].slice(0, 12) as Array<Record<string, unknown>>;
    for (const i of incs) {
      const fid = `F_inc_${i.id}`;
      const li = (i.linkedIssue ?? null) as Record<string, unknown> | null;
      facts[fid] = {
        kind: "incident",
        title: IntelFactsService.cap(i.title),
        signalType: i.signalType,
        screen: i.screen ?? null,
        sessionCount: i.sessionCount ?? 0,
        userCount: i.userCount ?? 0,
        // Clean percentage for the model to cite (deltaPctX100 is ×100-scaled, so
        // slot-filling it raw would read "10000" instead of "100%").
        deltaPct: Math.round((Number(i.deltaPctX100) || 0) / 100),
        polarity: i.polarity,
        severity: i.severity,
        release: i.release ?? null,
      };
      sources[fid] = {
        kind: "incident",
        sourceId: Number(i.id),
        title: String(i.title ?? ""),
        screen: (i.screen as string) ?? null,
        sessionCount: Number(i.sessionCount ?? 0),
        userCount: Number(i.userCount ?? 0),
        deltaPctX100: Number(i.deltaPctX100 ?? 0),
        rank: Number(i.rank ?? 0),
        polarity: String(i.polarity ?? "NEGATIVE"),
        linkedIssueId: li?.id != null ? Number(li.id) : null,
        linkedIssueRecording: (li?.recording as string) ?? null,
      };
    }
    // Issues (top 8, ranked crashes/errors).
    for (const s of issues as Array<Record<string, unknown>>) {
      const fid = `F_iss_${s.id}`;
      facts[fid] = {
        kind: "issue",
        title: IntelFactsService.cap(s.title),
        isCrash: s.isCrash,
        errorType: s.errorType,
        occurrenceCount: s.occurrenceCount ?? 0,
        sessionCount: s.sessionCount ?? 0,
        userCount: s.userCount ?? 0,
        lastRelease: s.lastRelease ?? null,
      };
      sources[fid] = {
        kind: "issue",
        sourceId: Number(s.id),
        title: String(s.title ?? ""),
        screen: null,
        sessionCount: Number(s.sessionCount ?? 0),
        userCount: Number(s.userCount ?? 0),
        deltaPctX100: 0,
        rank: 0,
        polarity: "NEGATIVE",
        linkedIssueId: Number(s.id),
        linkedIssueRecording: (s.lastPublicId as string) ?? null,
      };
    }
    // Health sub-scores (the ONLY facts the health-explanation half may cite).
    const subs = health.subScores as Record<string, Record<string, unknown>>;
    for (const [k, sub] of Object.entries(subs)) {
      facts[`H_${k}`] = {
        kind: "health",
        score: sub.scoreAbs,
        // `detail` is ALREADY human-formatted ("crash-free 100.00%", "p95 4600ms
        // across 35 calls"); currentRate is a raw 0–1 ratio, so we omit it — the
        // model can only cite the clean `detail`, never a raw "0.3076923…".
        detail: sub.detail,
        present: sub.present,
      };
    }
    facts["H_composite"] = { kind: "health", score: health.composite };
    // Metric strip (conversion/dau/etc.) — key + value + delta.
    const metArr = (
      Array.isArray(metrics) ? metrics : Object.values(metrics as object)
    ) as Array<Record<string, unknown>>;
    for (const m of metArr.filter((x) => x && typeof x === "object").slice(0, 8)) {
      if (m.key) facts[`F_met_${m.key}`] = { kind: "metric", value: m.value, deltaPct: m.deltaPct };
    }
    // Pinned funnels — id + name + derived goalKey (terminal step) for open_funnel.
    const funnelFacts: FunnelFact[] = funnels.map((f) => ({
      id: f.id,
      name: IntelFactsService.cap(f.name, 80),
      goalKey: IntelFactsService.terminalKey(f.steps),
    }));

    return { facts, sources, funnels: funnelFacts };
  }

  /**
   * Resolve an insight action to a REAL entity id + a provisional URL. Emits an
   * href ONLY when the target id genuinely exists; otherwise DOWNGRADES to
   * `investigate` (always resolvable). URL strings are provisional — to be
   * reconciled with the frontend router later (one place). view_cohort is not in
   * the vocabulary (no signal→cohort mapping).
   */
  resolveAction(
    actionKind: string,
    source: Source,
    funnels: FunnelFact[],
  ): ResolvedAction {
    const investigate: ResolvedAction = {
      actionKind: "investigate",
      actionRef: String(source.sourceId),
      actionHref: `/ai?${source.kind}=${source.sourceId}`,
    };
    switch (actionKind) {
      case "open_crash": {
        const issueId = source.kind === "issue" ? source.sourceId : source.linkedIssueId;
        return issueId
          ? { actionKind: "open_crash", actionRef: String(issueId), actionHref: `/crashes/${issueId}` }
          : investigate;
      }
      case "view_sessions":
        return {
          actionKind: "view_sessions",
          actionRef: String(source.sourceId),
          actionHref: `/sessions?${source.kind}=${source.sourceId}`,
        };
      case "open_funnel": {
        const key = source.screen ? IntelFactsService.normKey(source.screen) : null;
        const match = key
          ? funnels.filter((f) => f.goalKey && (f.goalKey === key || f.goalKey.includes(key) || key.includes(f.goalKey)))
          : [];
        return match.length === 1
          ? { actionKind: "open_funnel", actionRef: String(match[0].id), actionHref: `/funnels/${match[0].id}` }
          : investigate; // no unique confident match → downgrade
      }
      case "create_funnel":
        return {
          actionKind: "create_funnel",
          actionRef: source.screen ?? "",
          actionHref: `/funnels/new${source.screen ? `?screen=${encodeURIComponent(source.screen)}` : ""}`,
        };
      case "investigate":
      default:
        return investigate;
    }
  }

  /**
   * Fill template slots {{F_inc_5.sessionCount}} in model prose with the VERBATIM
   * value from the FactBundle (R3 grounding). Any slot whose fact-id/field isn't
   * in the bundle is dropped (never left raw / never invented). Returns the filled
   * text + whether every slot resolved (callers can reject prose with a dangling slot).
   */
  fillSlots(text: string, facts: Record<string, Fact>): { text: string; ok: boolean } {
    let ok = true;
    const filled = String(text ?? "").replace(/\{\{([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\}\}/g, (_m, fid, field) => {
      const v = facts[fid]?.[field];
      if (v === undefined || v === null) {
        ok = false;
        return "";
      }
      return String(v);
    });
    return { text: filled.replace(/\s{2,}/g, " ").trim(), ok };
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private static cap(s: unknown, n = STR_CAP): string {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }
  /** Derive a funnel's goal key from its TERMINAL step (lowercased matchType:value). */
  private static terminalKey(steps: unknown): string | null {
    const arr = Array.isArray(steps) ? (steps as Array<Record<string, unknown>>) : [];
    if (arr.length === 0) return null;
    const last = arr[arr.length - 1];
    const v = String(last?.value ?? "").trim().toLowerCase();
    return v ? `${String(last?.matchType ?? "equals").toLowerCase()}:${v}` : null;
  }
  /** Normalise an incident screen/URL to compare against a funnel goal key. */
  private static normKey(screen: string): string {
    return String(screen).trim().toLowerCase().replace(/^https?:\/\/[^/]+/, "");
  }
}
