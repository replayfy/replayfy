import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient } from "@replay/db-postgres";
import { insertSessionCards, type SessionCardRow } from "@replay/db-clickhouse";
import { SESSION_ROW_SELECT, toSessionRow } from "../common/ch-session-row";

/**
 * The Session Processor's card stage — emits one compact `replay.session_cards`
 * row per finalized session: the "figurative" summary the Replayfy AI reads
 * instead of raw events.
 *
 * It composes the card entirely from data ALREADY computed upstream at the
 * finalize chokepoint — Session counters/attributes, Signals, IssueOccurrences,
 * and SessionPath — so it adds no new event scans. Reads are set-based
 * (`sessionId IN (…)`), never a per-session loop. Every field is deterministic;
 * no LLM runs here (the AI only ever narrates these precomputed facts).
 *
 * Runs AFTER Issues (chained off IssuesService in the signals chokepoint) so
 * the issue fingerprints it references are already committed. Idempotent:
 * ReplacingMergeTree collapses re-writes for the same (workspace, session) to
 * the latest `_version`.
 */
@Injectable()
export class SessionCardsService {
  private readonly db = getPostgresClient();
  private readonly logger = new Logger(SessionCardsService.name);

  async deriveForSessions(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    try {
      await this.deriveInner(ids);
    } catch (e) {
      this.logger.warn(
        `session card derive failed (${ids.length} sessions): ${(e as Error).message}`,
      );
    }
  }

  private async deriveInner(ids: number[]): Promise<void> {
    // Session attributes — reuse the shared replay.sessions projection so the
    // card's denormalised fields never drift from the funnel table's; add the
    // two card-only columns (publicId for citing a recording, sessionScore).
    const sessions = await this.db.session.findMany({
      where: { id: { in: ids } },
      select: { ...SESSION_ROW_SELECT, publicId: true, sessionScore: true },
    });
    if (sessions.length === 0) {
      return;
    }

    // Three set-based reads of the upstream derived facts for the whole batch.
    const [signals, occurrences, paths] = await Promise.all([
      this.db.signal.findMany({
        where: { sessionId: { in: ids } },
        select: { sessionId: true, type: true, weight: true },
      }),
      this.db.issueOccurrence.findMany({
        where: { sessionId: { in: ids } },
        select: { sessionId: true, fingerprint: true, isCrash: true, count: true },
      }),
      this.db.sessionPath.findMany({
        where: { sessionId: { in: ids } },
        orderBy: { sequence: "asc" },
        select: { sessionId: true, url: true },
      }),
    ]);

    const sigBy = this.groupBy(signals, (x) => x.sessionId);
    const occBy = this.groupBy(occurrences, (x) => x.sessionId);
    const pathBy = this.groupBy(paths, (x) => x.sessionId);

    const version = Date.now();
    const rows: SessionCardRow[] = sessions.map((s) => {
      const base = toSessionRow(s, version);
      const sig = sigBy.get(s.id) ?? [];
      const occ = occBy.get(s.id) ?? [];
      const pth = pathBy.get(s.id) ?? [];

      const signalTypes = [...new Set(sig.map((x) => x.type))];
      const fingerprints = [...new Set(occ.map((x) => x.fingerprint))];
      const crashCount = occ
        .filter((x) => x.isCrash)
        .reduce((a, x) => a + x.count, 0);
      const networkFail = sig
        .filter((x) => x.type === "backend_failure")
        .reduce((a, x) => a + x.weight, 0);
      const slowApi = sig
        .filter((x) => x.type === "slow_api")
        .reduce((a, x) => a + x.weight, 0);

      const journey = this.compactJourney(pth.map((p) => p.url));
      const outcome = this.classifyOutcome(
        signalTypes,
        base.errors_count,
        crashCount,
      );
      const summary = this.buildSummary(
        base.platform,
        base.release,
        outcome,
        journey,
        crashCount,
        base.errors_count,
        base.rage_count,
      );

      return {
        workspace_id: base.workspace_id,
        session_id: base.session_id,
        session_public_id: s.publicId,
        user_id: base.user_id,
        anonymous_id: base.anonymous_id,
        datetime: base.datetime,
        duration_ms: base.duration_ms,
        platform: base.platform,
        release: base.release,
        device: base.device,
        os: base.os,
        browser: base.browser,
        country: base.country,
        outcome,
        journey,
        signals: signalTypes,
        issue_fingerprints: fingerprints,
        pages_count: base.pages_count,
        error_count: base.errors_count,
        crash_count: crashCount,
        rage_count: base.rage_count,
        dead_count: base.dead_count,
        network_fail_count: networkFail,
        slow_api_count: slowApi,
        session_score: s.sessionScore ?? 100,
        summary,
        _version: version,
      };
    });

    await insertSessionCards(rows);
  }

  private groupBy<T>(arr: T[], key: (x: T) => number): Map<number, T[]> {
    const m = new Map<number, T[]>();
    for (const x of arr) {
      const k = key(x);
      const list = m.get(k);
      if (list) {
        list.push(x);
      } else {
        m.set(k, [x]);
      }
    }
    return m;
  }

  /** Compact the ordered URLs into "/a → /b → /c" — pathname only, consecutive
   *  duplicates collapsed, and elided in the middle so a long session stays a
   *  short, readable spine. */
  private compactJourney(urls: string[]): string {
    const steps: string[] = [];
    for (const u of urls) {
      let p: string;
      try {
        p = new URL(u).pathname || "/";
      } catch {
        p = u.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0] || u;
      }
      if (p && p !== steps[steps.length - 1]) {
        steps.push(p);
      }
    }
    const shown =
      steps.length > 8
        ? [...steps.slice(0, 4), "…", ...steps.slice(-3)]
        : steps;
    return shown.join(" → ").slice(0, 400);
  }

  /** Deterministic outcome label. Conversion is the headline; a crash outranks
   *  a plain error; abandonment is an explicit failure/abandon signal. */
  private classifyOutcome(
    signalTypes: string[],
    errorCount: number,
    crashCount: number,
  ): string {
    const has = (t: string) => signalTypes.includes(t);
    if (has("conversion_success")) {
      return "converted";
    }
    if (crashCount > 0 || has("crash_detected")) {
      return "crashed";
    }
    if (has("conversion_failure") || has("form_abandonment")) {
      return "abandoned";
    }
    if (errorCount > 0 || has("backend_failure")) {
      return "errored";
    }
    return "normal";
  }

  /** One-line, fact-only summary — the human-readable spine of the card. */
  private buildSummary(
    platform: string,
    release: string,
    outcome: string,
    journey: string,
    crashCount: number,
    errorCount: number,
    rageCount: number,
  ): string {
    const head = [platform || "web", release].filter(Boolean).join(" · ");
    const bits: string[] = [`${head} — ${outcome}`];
    if (journey) {
      bits.push(journey);
    }
    if (crashCount > 0) {
      bits.push(`${crashCount} crash${crashCount > 1 ? "es" : ""}`);
    } else if (errorCount > 0) {
      bits.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
    }
    if (rageCount > 0) {
      bits.push(`rage×${rageCount}`);
    }
    return bits.join(" · ").slice(0, 400);
  }
}
