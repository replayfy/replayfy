import { Injectable, Logger } from "@nestjs/common";
import { getPostgresClient, Prisma } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { getClickHouseClient } from "@replay/db-clickhouse";
import { StorageService } from "../storage/storage.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import { WorkspaceSignalDailyService } from "../workspace-signal-daily/workspace-signal-daily.service";
import { framesGzKey } from "../frames/frames.constants";

/** Everything the reaper needs to erase a session, gathered at the call site
 *  (the Session row is about to be gone, so its facts are passed in, not
 *  re-fetched). */
export interface ReapTarget {
  workspaceId: number;
  /** Session.id — the numeric key ClickHouse replay.sessions / session_cards
   *  order by. */
  id: number;
  /** Session.publicId — the key Mongo, R2 and session_events use. */
  publicId: string;
  status: string;
  dataSizeBytes: bigint;
  /** Session.endedAt — only `eraseMany()` needs it, to reconcile the rollup day
   *  the erased session used to count in. Optional so the single-session
   *  `deleteEverywhere()` (the throwaway sweep, whose recent victims the nightly
   *  RECONCILE_DAYS window already covers) can omit it. */
  endedAt?: Date;
}

/**
 * COMPLETE, one-place erase of a session from EVERY store — the opposite of the
 * decoupled retention *prune* (which keeps the Session + all ClickHouse
 * analytics and only drops the watchable replay). This is for EXPLICIT deletes:
 * the short-session throwaway sweep, a user's "delete recording", workspace
 * delete, and GDPR forget.
 *
 * Before this existed, deletion was scattered and every site leaked (none
 * deleted the R2 frames archive, none deleted replay.sessions / session_cards —
 * only session_events), so a "deleted" session kept paying for its screenshots
 * and columnar rows forever. GDPR forget still leaked that way until this change
 * (it was a Postgres-only deleteMany). Every store is best-effort and
 * independent: a ClickHouse hiccup must not leave the Postgres row behind (which
 * would resurrect the session in the UI), so failures are logged, not thrown,
 * and Postgres goes LAST — once its rows are gone the sessions are invisible and
 * any store that failed is orphaned data cleaned up by the next sweep.
 */
@Injectable()
export class SessionReaperService {
  private readonly logger = new Logger(SessionReaperService.name);
  private readonly pg = getPostgresClient();
  private readonly mongo = getMongoClient();

  constructor(
    private readonly storage: StorageService,
    private readonly stats: WorkspaceStatsService,
    private readonly signalDaily: WorkspaceSignalDailyService,
  ) {}

  /**
   * Single-session complete erase — the short-session throwaway sweep's entry
   * point. Its victims are value-less and reaped within a minute of ending, so
   * they fall inside the nightly RECONCILE_DAYS window and need no explicit
   * rollup reconcile here. Delegates to the shared batch core.
   */
  async deleteEverywhere(t: ReapTarget): Promise<void> {
    await this.eraseBatch(t.workspaceId, [t]);
  }

  /**
   * EXPLICIT hard-delete of a batch of sessions (user "delete recording", GDPR
   * forget). Complete erase across every store PLUS a rollup reconcile of the
   * affected days — because these can target OLD sessions (older than the
   * nightly trailing window) whose WorkspaceSignalDaily day would otherwise stay
   * inflated (the exact drift that let the Overview "Sessions" total exceed the
   * live count). Batched (IN-list deletes, chunked R2) so a user with thousands
   * of sessions erases without per-row round-trips.
   */
  async eraseMany(workspaceId: number, targets: ReapTarget[]): Promise<void> {
    if (targets.length === 0) return;
    await this.eraseBatch(workspaceId, targets);

    // Recompute the rollup for exactly the UTC days this batch touched, so any
    // day whose COMPLETED-session count just dropped (or hit zero) is corrected
    // even when it predates the nightly 3-day window. BOUNDED to [oldest, newest]
    // so a single delete never recomputes the whole history forward, and a
    // page-by-page GDPR forget stays O(total days), not O(pages x history).
    // Idempotent; best-effort (a miss only costs Pulse freshness until nightly).
    let oldest: Date | null = null;
    let newest: Date | null = null;
    for (const t of targets) {
      if (!t.endedAt) continue;
      if (oldest === null || t.endedAt < oldest) oldest = t.endedAt;
      if (newest === null || t.endedAt > newest) newest = t.endedAt;
    }
    if (oldest && newest) {
      const from = new Date(oldest);
      from.setUTCHours(0, 0, 0, 0);
      const toExcl = new Date(newest);
      toExcl.setUTCHours(0, 0, 0, 0);
      toExcl.setUTCDate(toExcl.getUTCDate() + 1);
      await this.signalDaily
        .reconcileRange(workspaceId, from, toExcl)
        .catch(() => {});
      // Surface the corrected rollup on the Overview PROMPTLY. The windowed
      // "Sessions" tile / Pulse are served from the WorkspacePrecompute snapshot,
      // which the rollup write does NOT invalidate — so without this the Overview
      // shows the stale count until the ~1h stale-clause fires. Bumping
      // lastActivityAt past snapshotAt marks the workspace dirty, so the 5-min
      // tickPrecompute recomputes it. Best-effort; the rollup is already correct.
      await this.pg
        .$executeRaw`UPDATE "WorkspaceSnapshot" SET "lastActivityAt" = now() WHERE "workspaceId" = ${workspaceId}`
        .catch(() => {});
    }
  }

  /**
   * The shared store-by-store erase. See the class header for the best-effort /
   * Postgres-last ordering rationale.
   */
  private async eraseBatch(
    workspaceId: number,
    targets: ReapTarget[],
  ): Promise<void> {
    if (targets.length === 0) return;
    const publicIds = targets.map((t) => t.publicId);
    const ids = targets.map((t) => t.id);

    // R2 frames archive (mobile screenshots): one object per session,
    // frames/<pid>.gz. Chunked so we don't fan out the whole batch at once.
    const CHUNK = 20;
    for (let i = 0; i < publicIds.length; i += CHUNK) {
      await Promise.all(
        publicIds
          .slice(i, i + CHUNK)
          .map((pid) => this.storage.remove(framesGzKey(pid))),
      );
    }

    // MongoDB rrweb batches (web replay). Scope by projectId (= workspaceId) so
    // erasing this workspace's sessions can't touch another workspace's batches
    // that share a client-generated, cross-workspace-collidable sessionId.
    try {
      await this.mongo.replayBatch.deleteMany({
        where: { sessionId: { in: publicIds }, projectId: String(workspaceId) },
      });
    } catch (e) {
      this.logger.warn(
        `mongo erase failed ws=${workspaceId}: ${(e as Error).message}`,
      );
    }

    // ClickHouse — all THREE per-session tables. session_events + session_cards
    // key on public_id; replay.sessions on the numeric session_id.
    const inPub = publicIds.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    const inIds = ids.join(",");
    const ch = getClickHouseClient();
    for (const stmt of [
      `ALTER TABLE replay.session_events DELETE WHERE workspace_id = ${workspaceId} AND session_public_id IN (${inPub})`,
      `ALTER TABLE replay.session_cards  DELETE WHERE workspace_id = ${workspaceId} AND session_public_id IN (${inPub})`,
      `ALTER TABLE replay.sessions       DELETE WHERE workspace_id = ${workspaceId} AND session_id IN (${inIds})`,
    ]) {
      try {
        await ch.command({ query: stmt });
      } catch (e) {
        this.logger.warn(
          `clickhouse erase failed ws=${workspaceId}: ${(e as Error).message}`,
        );
      }
    }

    // Postgres LAST — DELETE ... RETURNING so EVERY counter delta comes from the
    // rows ACTUALLY removed, not the input list. Under a partial double-reap
    // (another path deleted some of these between our SELECT and here) this keeps
    // sessionsTotal, liveSessions AND storageBytes consistent — the old single
    // delete() threw when the row was already gone, which skipped the bump; we
    // preserve that by keying every delta on the returned rows. The DB-level ON
    // DELETE CASCADE (foreignKeys relationMode) takes every child relation, so a
    // raw DELETE erases them exactly as the Prisma delete did.
    let removed: Array<{ status: string; dataSizeBytes: bigint }> = [];
    try {
      removed = await this.pg.$queryRaw<
        Array<{ status: string; dataSizeBytes: bigint }>
      >(
        Prisma.sql`DELETE FROM "Session" WHERE "id" IN (${Prisma.join(
          ids,
        )}) RETURNING "status", "dataSizeBytes"`,
      );
    } catch (e) {
      this.logger.warn(
        `postgres erase failed ws=${workspaceId}: ${(e as Error).message}`,
      );
      return;
    }
    // Nothing actually removed (e.g. a double-reap race where the rows were
    // already gone) — bail before touching the counters.
    if (removed.length === 0) return;

    // Return the counters the removed rows were holding: fewer sessions, freed
    // storage, and a live decrement for any that died still LIVE.
    let liveGone = 0;
    let freedBytes = 0n;
    for (const r of removed) {
      if (r.status === "LIVE") liveGone += 1;
      freedBytes += r.dataSizeBytes ?? 0n;
    }
    this.stats
      .bump(workspaceId, {
        sessionsTotal: -removed.length,
        liveSessions: -liveGone,
        storageBytes: -freedBytes,
      })
      .catch(() => {});
  }
}
