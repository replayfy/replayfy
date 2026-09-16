import { Injectable } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";

const DAY_MS = 86_400_000;

/**
 * Deterministic hybrid Experience-Health score (0b). NO LLM — the AI only writes
 * the hover prose (Phase 3). Each subsystem gets an ABSOLUTE 0–100 score against a
 * target + a relative delta vs the prior window. Stability/Performance use GLOBAL
 * SLO targets (universal); Conversion/Engagement use the workspace's OWN prior
 * window as the target (no universal healthy conversion/stickiness rate exists).
 *
 * Composite weights: Stability 30 / Conversion 30 / Performance 25 / Engagement 15
 * (Performance = apiHealth + webVitals, 12.5 each, matching the dashboard's two
 * "API health" + "Web vitals" bars). Weights renormalize over PRESENT subsystems
 * (a workspace with no funnel drops Conversion's 30% and redistributes). All
 * consts here are the decision-#1 defaults — tune on ws2.
 */
@Injectable()
export class WorkspaceHealthService {
  private readonly db = getPostgresClient();

  // ── Tunable calibration (decision #1 defaults) ─────────────────────────────
  private static readonly WEIGHT = {
    stability: 0.3,
    conversion: 0.3,
    apiHealth: 0.125,
    webVitals: 0.125,
    engagement: 0.15,
  };
  /** κ: how steeply a shortfall below target erodes the score (higher = steeper). */
  private static readonly KAPPA = {
    stability: 5,
    conversion: 2,
    apiHealth: 3,
    webVitals: 3,
    engagement: 2,
  };
  private static readonly SLO_CRASH_FREE = 0.995; // stability target
  private static readonly SLO_API_P95_MS = 800; // apiHealth target
  private static readonly SLO_LCP_MS = 2500; // webVitals target (LCP p75)
  private static readonly SLO_MOBILE_ANR_RATE = 0.005; // mobile "client vitals"
  private static readonly MIN_SESSIONS = 20; // min data for a subsystem to count
  // apiHealth needs a STATISTICALLY meaningful sample before it drives a verdict:
  // a p95 over ~20-40 network calls is essentially the near-max (the 95th of 38
  // is the 37th value), so a couple of slow requests scored the subsystem 0 and
  // the storyline narrated "API health critically weak" off a tiny sample. Gate
  // presence on a real call floor so a thin sample no longer headlines.
  private static readonly MIN_API_CALLS = 200;
  private static readonly MIN_DAYS = 7; // below → scoreAbs only, delta = null

  /**
   * The full health breakdown for a workspace over the trailing `windowDays`
   * (current) vs the equal preceding window (prior → deltas). Reads the 0a daily
   * rollups directly in parallel; no session scan.
   */
  async experienceHealth(workspaceId: number, windowDays = 30) {
    const now = Date.now();
    const curStart = WorkspaceHealthService.toDay(
      new Date(now - windowDays * DAY_MS),
    );
    const priorStart = WorkspaceHealthService.toDay(
      new Date(now - 2 * windowDays * DAY_MS),
    );
    const gte = { gte: priorStart };

    const [signal, latency, perf, mobile, conv, eng] = await Promise.all([
      this.db.workspaceSignalDaily.findMany({
        where: { workspaceId, day: gte },
        select: { day: true, sessions: true, crashes: true, backendFail: true },
      }),
      this.db.workspaceLatencyDaily.findMany({
        where: { workspaceId, day: gte },
        select: { day: true, calls: true, slowCalls: true, samples: true },
      }),
      this.db.workspacePerfDaily.findMany({
        where: { workspaceId, day: gte },
        select: {
          day: true,
          sampleCount: true,
          slowCount: true,
          lcpSamples: true,
        },
      }),
      this.db.workspaceMobilePerfDaily.findMany({
        where: { workspaceId, day: gte },
        select: { day: true, mobileSessions: true, anrSessions: true },
      }),
      this.db.workspaceConversionDaily.findMany({
        where: { workspaceId, day: gte },
        select: { day: true, entered: true, converted: true },
      }),
      this.db.workspaceEngagementDaily.findMany({
        where: { workspaceId, day: gte },
        orderBy: { day: "asc" },
        select: { day: true, dau: true, mau: true },
      }),
    ]);
    const cur = (d: Date) => d >= curStart;

    const subs = [
      this.stability(signal, cur),
      this.conversion(conv, cur),
      this.apiHealth(latency, cur),
      this.webVitals(perf, mobile, cur),
      this.engagement(eng, cur),
    ];

    // Renormalize weights over PRESENT subsystems, then composite.
    const present = subs.filter((s) => s.present);
    const wSum = present.reduce((a, s) => a + s.weight, 0) || 1;
    const composite = Math.round(
      present.reduce((a, s) => a + s.weight * s.scoreAbs, 0) / wSum,
    );

    // subScores in dashboard display order (4 bars); engagement feeds composite.
    return {
      composite,
      windowDays,
      subScores: {
        apiHealth: subs[2],
        webVitals: subs[3],
        stability: subs[0],
        conversion: subs[1],
        engagement: subs[4],
      },
    };
  }

  // ── Subsystems ─────────────────────────────────────────────────────────────

  private stability(
    rows: Array<{
      day: Date;
      sessions: number;
      crashes: number;
      backendFail: number;
    }>,
    cur: (d: Date) => boolean,
  ) {
    const c = rows
      .filter((r) => cur(r.day))
      .reduce((a, r) => ({ s: a.s + r.sessions, x: a.x + r.crashes }), {
        s: 0,
        x: 0,
      });
    const p = rows
      .filter((r) => !cur(r.day))
      .reduce((a, r) => ({ s: a.s + r.sessions, x: a.x + r.crashes }), {
        s: 0,
        x: 0,
      });
    const rate = (o: { s: number; x: number }) =>
      o.s > 0 ? 1 - o.x / o.s : null;
    const cf = rate(c);
    const cfPrior = rate(p);
    const score =
      cf == null
        ? 0
        : WorkspaceHealthService.higherBetter(
            cf,
            WorkspaceHealthService.SLO_CRASH_FREE,
            WorkspaceHealthService.KAPPA.stability,
          );
    return this.mk(
      "stability",
      "Stability",
      score,
      cf,
      cfPrior,
      WorkspaceHealthService.SLO_CRASH_FREE,
      "higher",
      WorkspaceHealthService.KAPPA.stability,
      WorkspaceHealthService.WEIGHT.stability,
      c.s >= WorkspaceHealthService.MIN_SESSIONS,
      cf != null ? `crash-free ${(cf * 100).toFixed(2)}%` : "no data",
    );
  }

  private apiHealth(
    rows: Array<{
      day: Date;
      calls: number;
      slowCalls: number;
      samples: number[];
    }>,
    cur: (d: Date) => boolean,
  ) {
    const p95 = (rs: typeof rows) => {
      const all: number[] = [];
      let calls = 0;
      for (const r of rs) {
        all.push(...r.samples);
        calls += r.calls;
      }
      if (all.length === 0) return { v: null as number | null, calls };
      all.sort((a, b) => a - b);
      return {
        v: all[Math.min(all.length - 1, Math.floor(all.length * 0.95))],
        calls,
      };
    };
    const c = p95(rows.filter((r) => cur(r.day)));
    const pr = p95(rows.filter((r) => !cur(r.day)));
    const score =
      c.v == null
        ? 0
        : WorkspaceHealthService.lowerBetter(
            c.v,
            WorkspaceHealthService.SLO_API_P95_MS,
            WorkspaceHealthService.KAPPA.apiHealth,
          );
    return this.mk(
      "apiHealth",
      "API health",
      score,
      c.v,
      pr.v,
      WorkspaceHealthService.SLO_API_P95_MS,
      "lower",
      WorkspaceHealthService.KAPPA.apiHealth,
      WorkspaceHealthService.WEIGHT.apiHealth,
      c.calls >= WorkspaceHealthService.MIN_API_CALLS,
      c.v != null ? `p95 ${c.v}ms across ${c.calls} calls` : "no data",
    );
  }

  private webVitals(
    perf: Array<{ day: Date; sampleCount: number; lcpSamples: number[] }>,
    mobile: Array<{ day: Date; mobileSessions: number; anrSessions: number }>,
    cur: (d: Date) => boolean,
  ) {
    // Web LCP if present; else mobile ANR rate as the "client vitals" proxy.
    const lcpP75 = (rs: typeof perf) => {
      const all: number[] = [];
      for (const r of rs) all.push(...r.lcpSamples);
      if (all.length === 0) return null;
      all.sort((a, b) => a - b);
      return all[Math.min(all.length - 1, Math.floor(all.length * 0.75))];
    };
    const curLcp = lcpP75(perf.filter((r) => cur(r.day)));
    if (curLcp != null) {
      const priorLcp = lcpP75(perf.filter((r) => !cur(r.day)));
      const samples = perf
        .filter((r) => cur(r.day))
        .reduce((a, r) => a + r.sampleCount, 0);
      const score = WorkspaceHealthService.lowerBetter(
        curLcp,
        WorkspaceHealthService.SLO_LCP_MS,
        WorkspaceHealthService.KAPPA.webVitals,
      );
      return this.mk(
        "webVitals",
        "Web vitals",
        score,
        curLcp,
        priorLcp,
        WorkspaceHealthService.SLO_LCP_MS,
        "lower",
        WorkspaceHealthService.KAPPA.webVitals,
        WorkspaceHealthService.WEIGHT.webVitals,
        samples >= WorkspaceHealthService.MIN_SESSIONS,
        `LCP p75 ${curLcp}ms`,
      );
    }
    const anrRate = (rs: typeof mobile) => {
      const m = rs.reduce(
        (a, r) => ({ s: a.s + r.mobileSessions, a2: a.a2 + r.anrSessions }),
        { s: 0, a2: 0 },
      );
      return m.s > 0
        ? { v: m.a2 / m.s, s: m.s }
        : { v: null as number | null, s: 0 };
    };
    const c = anrRate(mobile.filter((r) => cur(r.day)));
    const pr = anrRate(mobile.filter((r) => !cur(r.day)));
    const score =
      c.v == null
        ? 0
        : WorkspaceHealthService.lowerBetter(
            c.v,
            WorkspaceHealthService.SLO_MOBILE_ANR_RATE,
            WorkspaceHealthService.KAPPA.webVitals,
          );
    return this.mk(
      "webVitals",
      "App vitals",
      score,
      c.v,
      pr.v,
      WorkspaceHealthService.SLO_MOBILE_ANR_RATE,
      "lower",
      WorkspaceHealthService.KAPPA.webVitals,
      WorkspaceHealthService.WEIGHT.webVitals,
      c.s >= WorkspaceHealthService.MIN_SESSIONS,
      c.v != null ? `ANR ${(c.v * 100).toFixed(2)}%` : "no data",
    );
  }

  private conversion(
    rows: Array<{ day: Date; entered: number; converted: number }>,
    cur: (d: Date) => boolean,
  ) {
    const rate = (rs: typeof rows) => {
      const o = rs.reduce(
        (a, r) => ({ e: a.e + r.entered, c: a.c + r.converted }),
        { e: 0, c: 0 },
      );
      return { v: o.e > 0 ? o.c / o.e : null, e: o.e };
    };
    const c = rate(rows.filter((r) => cur(r.day)));
    const pr = rate(rows.filter((r) => !cur(r.day)));
    // Per-workspace target = own prior window. No prior → neutral (score from
    // current vs itself = 100; flagged low-confidence by 0b's present/MIN_DAYS).
    const target = pr.v ?? c.v ?? 0;
    const score =
      c.v == null
        ? 0
        : WorkspaceHealthService.higherBetter(
            c.v,
            target || c.v || 1,
            WorkspaceHealthService.KAPPA.conversion,
          );
    return this.mk(
      "conversion",
      "Conversion",
      score,
      c.v,
      pr.v,
      target,
      "higher",
      WorkspaceHealthService.KAPPA.conversion,
      WorkspaceHealthService.WEIGHT.conversion,
      c.e >= WorkspaceHealthService.MIN_SESSIONS,
      c.v != null ? `completion ${(c.v * 100).toFixed(1)}%` : "no funnel",
    );
  }

  private engagement(
    rows: Array<{ day: Date; dau: number; mau: number }>,
    cur: (d: Date) => boolean,
  ) {
    const stick = (rs: typeof rows) => {
      if (rs.length === 0) return { v: null as number | null, mau: 0 };
      const avgDau = rs.reduce((a, r) => a + r.dau, 0) / rs.length;
      const mau = rs[rs.length - 1].mau;
      return { v: mau > 0 ? avgDau / mau : null, mau };
    };
    const c = stick(rows.filter((r) => cur(r.day)));
    const pr = stick(rows.filter((r) => !cur(r.day)));
    const target = pr.v ?? c.v ?? 0;
    const score =
      c.v == null
        ? 0
        : WorkspaceHealthService.higherBetter(
            c.v,
            target || c.v || 1,
            WorkspaceHealthService.KAPPA.engagement,
          );
    return this.mk(
      "engagement",
      "Engagement",
      score,
      c.v,
      pr.v,
      target,
      "higher",
      WorkspaceHealthService.KAPPA.engagement,
      WorkspaceHealthService.WEIGHT.engagement,
      c.mau >= WorkspaceHealthService.MIN_SESSIONS,
      c.v != null ? `stickiness ${(c.v * 100).toFixed(0)}%` : "no data",
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Build a subscore object. delta = current score − prior-window score (the
   *  bar's ± number); null when prior is absent (< MIN_DAYS / new workspace). */
  private mk(
    key: string,
    label: string,
    scoreAbs: number,
    current: number | null,
    prior: number | null,
    target: number,
    dir: "higher" | "lower",
    kappa: number,
    weight: number,
    present: boolean,
    detail: string,
  ) {
    let delta: number | null = null;
    if (prior != null && current != null) {
      const priorScore =
        dir === "higher"
          ? WorkspaceHealthService.higherBetter(
              prior,
              target || prior || 1,
              kappa,
            )
          : WorkspaceHealthService.lowerBetter(prior, target, kappa);
      delta = scoreAbs - priorScore;
    }
    return {
      key,
      label,
      scoreAbs,
      delta,
      present,
      weight,
      currentRate: current,
      baselineRate: prior,
      detail,
    };
  }

  /** Higher-is-better rate vs target: 100 at/above target, eroding by κ·shortfall. */
  private static higherBetter(
    current: number,
    target: number,
    kappa: number,
  ): number {
    if (target <= 0) return 100;
    const shortfall = Math.max(0, (target - current) / target);
    return Math.max(0, Math.round(100 * (1 - Math.min(1, kappa * shortfall))));
  }
  /** Lower-is-better metric vs target: 100 at/below target, eroding by κ·excess. */
  private static lowerBetter(
    current: number,
    target: number,
    kappa: number,
  ): number {
    if (target <= 0) return current <= 0 ? 100 : 0;
    const excess = Math.max(0, (current - target) / target);
    return Math.max(0, Math.round(100 * (1 - Math.min(1, kappa * excess))));
  }

  private static toDay(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }
}
