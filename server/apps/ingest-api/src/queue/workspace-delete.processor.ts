import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import Stripe from "stripe";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { getClickHouseClient } from "@replay/db-clickhouse";
import {
  WORKSPACE_DELETE_QUEUE,
  WORKSPACE_DELETE_JOB,
} from "./queue.constants";
import type { WorkspaceDeleteJob } from "./queue.types";
import { StorageService } from "../storage/storage.service";
import { framesGzKey } from "../frames/frames.constants";

/**
 * Workspace deletion is a sprawling operation — millions of sessions, all
 * their projected logs in ClickHouse, raw rrweb batches in Mongo, plus
 * dozens of cascade-related rows in Postgres. Doing it inline holds an HTTP
 * connection open for minutes and can fail half-way through, leaving
 * orphaned data. We queue it instead: the HTTP endpoint returns instantly
 * with "deletion in progress", and a Bull worker processes the cleanup in
 * cancellable batches.
 *
 * Job is idempotent: re-running it after a partial failure picks up where
 * it left off (each batch deletes-and-returns-count).
 */
@Processor(WORKSPACE_DELETE_QUEUE)
export class WorkspaceDeleteProcessor {
  private readonly logger = new Logger(WorkspaceDeleteProcessor.name);
  private readonly pg = getPostgresClient();
  private readonly mongo = getMongoClient();

  constructor(private readonly storage: StorageService) {}

  @Process(WORKSPACE_DELETE_JOB)
  async run(job: Job<WorkspaceDeleteJob>) {
    const { workspaceId } = job.data;
    this.logger.log(`Deleting workspace ${workspaceId}…`);

    // 1. Verify the workspace is still soft-deleted. If an admin restored
    //    it, abort — better to surface a "still scheduled" message than to
    //    blow away live data.
    const ws = await this.pg.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, deletedAt: true, stripeSubscriptionId: true },
    });
    if (!ws || !ws.deletedAt) {
      this.logger.warn(
        `Workspace ${workspaceId} no longer marked for deletion — skipping`,
      );
      return;
    }

    // 1b. Stop the money BEFORE touching data. Deleting the workspace row used
    //     to leave the Stripe subscription live, so a customer who deleted their
    //     workspace kept being charged every month with no workspace left to
    //     cancel from — and once the row is gone we no longer even know the
    //     subscription id, so it can never be reconciled.
    //
    //     Deliberately not fatal: if Stripe is unreachable we log and press on.
    //     A half-deleted workspace (data gone, row alive, job retrying forever)
    //     is worse than an orphaned subscription, and the orphan is recoverable
    //     from the log line below while a wedged deletion is not.
    await this.cancelStripeSubscription(workspaceId, ws.stripeSubscriptionId);

    // 2. Tear down session data in batches of 1000 so we don't block PG.
    let pendingSessions = true;
    let totalSessions = 0;
    while (pendingSessions) {
      const batch = await this.pg.session.findMany({
        where: { workspaceId },
        select: { id: true, publicId: true },
        take: 1000,
      });
      if (batch.length === 0) {
        pendingSessions = false;
        break;
      }
      const ids = batch.map((s) => s.id);
      const publicIds = batch.map((s) => s.publicId);

      await this.pg.session.deleteMany({ where: { id: { in: ids } } });
      await this.mongo.replayBatch.deleteMany({
        where: { sessionId: { in: publicIds } },
      });
      // R2 frames archive — one object per session (frames/<pid>.gz). This site
      // never deleted them, so a hard-deleted workspace left its mobile frames
      // billing us forever. Per-session because the keys aren't workspace-prefixed.
      await Promise.all(publicIds.map((pid) => this.storage.remove(framesGzKey(pid))));
      totalSessions += batch.length;
      await job.progress(
        Math.min(
          99,
          Math.round(
            (totalSessions / Math.max(totalSessions + batch.length, 1)) * 100,
          ),
        ),
      );
    }

    // 3. Bulk-drop ClickHouse rows for this workspace.
    // All THREE per-session tables, bulk by workspace_id (efficient for a whole
    // workspace). session_cards + sessions were never deleted here — the same
    // leak the reaper fixed on the single-session path.
    for (const table of ["session_events", "session_cards", "sessions"]) {
      try {
        await getClickHouseClient().command({
          query: `ALTER TABLE replay.${table} DELETE WHERE workspace_id = ${workspaceId}`,
        });
      } catch (e) {
        this.logger.warn(
          `ClickHouse ${table} delete failed for ws ${workspaceId}: ${(e as Error).message}`,
        );
      }
    }

    // 3.5. Delete the workspace's crash-symbol uploads (mapping.txt + NDK debug
    // binaries under replay-symbols/<workspaceId>/…). The per-session frames loop
    // above only removes the frames archives; symbol objects are keyed by
    // workspace, not session, so nothing else deletes them — they'd otherwise sit
    // orphaned in R2 forever. Prefix is tenant-scoped by workspaceId.
    const symbolsDeleted = await this.storage.removePrefix(
      `replay-symbols/${workspaceId}/`,
    );
    if (symbolsDeleted)
      this.logger.log(
        `Workspace ${workspaceId}: removed ${symbolsDeleted} symbol object(s)`,
      );

    // 4. Hard-delete the workspace itself (Prisma cascades the rest).
    await this.pg.workspace.delete({ where: { id: workspaceId } });
    await job.progress(100);
    this.logger.log(
      `Workspace ${workspaceId} deleted (${totalSessions} sessions purged)`,
    );
  }

  /**
   * Cancel the workspace's subscription immediately, best-effort.
   *
   * Immediate (not cancel_at_period_end): the workspace and all its data are
   * about to cease to exist, so there is nothing left to serve for the rest of
   * the period. No proration is requested — Stripe's default is no credit, and
   * choosing to refund the unused remainder is the owner's REFUND POLICY, not a
   * decision to bury in a delete worker.
   *
   * The Stripe client is constructed here rather than injected because
   * StripeService lives in BillingModule and this worker is in QueueModule,
   * which BillingModule already depends on — injecting it would close a cycle.
   * The right home is a `StripeService.cancelSubscription()` called from here
   * once that module edge exists; until then this is a single, contained call.
   */
  private async cancelStripeSubscription(
    workspaceId: number,
    subscriptionId: string | null,
  ): Promise<void> {
    if (!subscriptionId) return;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      this.logger.warn(
        `Workspace ${workspaceId} has subscription ${subscriptionId} but STRIPE_SECRET_KEY is unset — it will keep billing. Cancel it in the Stripe dashboard.`,
      );
      return;
    }
    try {
      // Same timeout/retry posture as StripeService: fail fast rather than let a
      // Stripe outage hold a Bull worker slot, and cap retries so an outage
      // can't stall the delete queue.
      const stripe = new Stripe(key, { timeout: 20_000, maxNetworkRetries: 2 });
      await stripe.subscriptions.cancel(subscriptionId);
      this.logger.log(
        `Canceled Stripe subscription ${subscriptionId} for deleted workspace ${workspaceId}`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      // resource_missing = already canceled (or a redelivered job). Not an error.
      if ((e as Stripe.errors.StripeError)?.code === "resource_missing") return;
      // Loud and greppable: this is the one line that lets the owner reconcile
      // an orphaned subscription by hand, so it names the id explicitly.
      this.logger.error(
        `FAILED to cancel Stripe subscription ${subscriptionId} for deleted workspace ${workspaceId} — it may STILL BE BILLING. Cancel it manually. Cause: ${msg}`,
      );
    }
  }
}
