import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Interval } from "@nestjs/schedule";
import type { Queue } from "bull";
import { getPostgresClient } from "@replay/db-postgres";
import { getMongoClient } from "@replay/db-mongo";
import { REPLAY_QUEUE } from "./queue.constants";
import { isInfraError } from "./infra-error";
import { hasRole } from "../common/app-roles";

/**
 * Circuit breaker for the replay-batch queue.
 *
 * THE PROBLEM (the Atlas-full incident): when the backing store rejects writes,
 * the worker keeps pulling jobs and failing them. Each burns its retry budget in
 * seconds and drops into the `failed` set, which needs a MANUAL requeue. 524
 * jobs were stranded that way.
 *
 * THE FIX: on an infra-classified failure, PAUSE the queue. bull's `wait` state
 * lives in Redis (AOF-persisted, noeviction) with no retention window, and a
 * locally-paused worker runs neither waiting NOR delayed→wait (retry) jobs — so
 * paused jobs sit there durably, indefinitely, without consuming attempts. A 10s
 * probe RESUMES only once the stores accept WRITES again, and everything drains.
 *
 * The recovery probe verifies *writeability*, not just reachability: the
 * incident (Atlas over-quota / a stepped-down primary / a read-only replica) is
 * precisely "reachable, answers reads, refuses writes" — a `ping` would clear it
 * and resume into the same wall every 10s, burning attempts. So we probe
 * write-capability against BOTH stores (a real upsert on Mongo; a transaction-id
 * assignment on Postgres, which a read-only/standby node refuses) and resume
 * only when both succeed.
 *
 * Only the node holding the `worker` role manages the queue — the api node
 * already local-pauses it (worker gate) and must never resume it — so every
 * action here is gated on hasRole("worker").
 */

const PROBE_TIMEOUT_MS = 4_000;
const TICK_MS = 10_000;
// Minimum time the breaker stays OPEN before it will try to resume, so a
// mis-probe can't produce tight flapping that still drains the attempt budget.
const MIN_OPEN_MS = 5_000;
const FAILED_ALERT_THRESHOLD = Number(
  process.env.QUEUE_FAILED_ALERT_THRESHOLD ?? 25,
);
const ALERT_THROTTLE_MS = 15 * 60_000;

@Injectable()
export class QueueBreakerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueBreakerService.name);
  private open = false; // true = queue paused because a store rejects writes
  private openedAt = 0;
  private tripping = false; // guards concurrent trip() from parallel job failures
  private ticking = false; // re-entrancy guard: @Interval doesn't await tick()
  private lastAlertAt = 0;

  constructor(
    @InjectQueue(REPLAY_QUEUE) private readonly replayQueue: Queue,
  ) {}

  /**
   * Belt-and-suspenders for a worker that restarts DURING an outage (the
   * in-process pause is gone): if the stores don't accept writes at boot, open.
   * Note: @nestjs/bull registers processors in onModuleInit (an earlier phase),
   * so bull may pull a few jobs before this runs — those trip the breaker via
   * reportFailure(), which is the primary gate; this just shrinks the window.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!hasRole("worker")) return;
    try {
      if (!(await this.storesWritable())) {
        await this.pause("boot: stores not accepting writes");
      }
    } catch {
      /* probe error at boot → leave running; the first job failure trips it */
    }
  }

  /**
   * Called from the processor's catch on EVERY failure. If the error means a
   * backing store is unavailable, trip the breaker (pause) so this and every
   * following job WAITS instead of failing. Fire-and-forget: never adds latency
   * to, or throws into, the failing job's path.
   */
  reportFailure(err: unknown): void {
    if (!hasRole("worker")) return; // only the consuming node manages the queue
    if (this.open || this.tripping) return; // already open / a trip is in flight
    if (!isInfraError(err)) return; // data/logic error → let it fail normally
    this.tripping = true;
    void this.pause(`infra error: ${(err as Error)?.message ?? String(err)}`)
      .finally(() => {
        this.tripping = false;
      });
  }

  private async pause(reason: string): Promise<void> {
    try {
      // Local pause: THIS worker stops consuming; producers (the api node) keep
      // enqueuing, so incoming batches buffer in Redis rather than being lost.
      await this.replayQueue.pause(true);
      this.open = true;
      this.openedAt = Date.now();
      this.logger.error(
        `CIRCUIT OPEN — replay-batch paused so jobs wait in Redis instead of ` +
          `exhausting retries. ${reason}`,
      );
    } catch (e) {
      // Couldn't pause — leave open=false so the next infra failure retries the
      // trip. Worst case we fall back to bull's normal retry/failed behavior.
      this.logger.error(`queue-breaker: pause failed: ${(e as Error).message}`);
    }
  }

  /**
   * Runs on every node but no-ops unless this is the worker. While OPEN, probes
   * writeability and resumes on recovery. While CLOSED, watches the failed-set
   * size as a tripwire. @Interval (not @Cron) so it runs on a worker node even
   * if that node does not also hold the `cron` role.
   */
  @Interval("queue-breaker-tick", TICK_MS)
  async tick(): Promise<void> {
    if (!hasRole("worker")) return;
    // A slow tick (two sequential probe timeouts) can outlast the 10s interval;
    // @Interval fires on a fixed timer and does not await, so skip if the prior
    // tick is still running rather than let two overlap.
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.open) {
        if (Date.now() - this.openedAt < MIN_OPEN_MS) return; // dwell
        if (await this.storesWritable()) {
          await this.replayQueue.resume(true);
          this.open = false;
          this.logger.log(
            "CIRCUIT CLOSED — stores accept writes again; replay-batch resumed, buffered jobs draining.",
          );
        }
        return; // while open, the pause IS the alert — don't also page
      }
      await this.alertOnBacklog();
    } catch (e) {
      this.logger.error(`queue-breaker: tick error: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * True only when BOTH authoritative stores accept a trivial WRITE — not just a
   * ping. This is the crux: an over-quota Atlas / stepped-down primary /
   * read-only replica answers reads but refuses writes, so a read probe would
   * resume straight back into the outage. Each probe is one idempotent
   * single-row write (no growth), time-boxed so a hung store can't stall the tick.
   */
  private async storesWritable(): Promise<boolean> {
    const withTimeout = <T>(p: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        p.finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("probe timeout")),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
    };
    try {
      await withTimeout(this.probePostgresWrite());
      await withTimeout(this.probeMongoWrite());
      return true;
    } catch {
      return false;
    }
  }

  /** Prove Postgres accepts writes with no data touched, no table, and no DDL:
   *  txid_current() forces a real transaction-id assignment, which a read-only
   *  primary or a hot standby refuses ("cannot ... in a read-only transaction" /
   *  "... during recovery"), and an unreachable server errors outright. Covers
   *  the realistic write-blocked-but-reachable PG cases; a reachable-primary-
   *  disk-full edge could still slip past, but Mongo — the write-block-prone
   *  store — keeps a real-write probe below. Needs only privileges the app has. */
  private async probePostgresWrite(): Promise<void> {
    await getPostgresClient().$queryRawUnsafe("SELECT txid_current()");
  }

  /** Upsert one sentinel doc via a raw write command. An over-quota / not-
   *  writable-primary Mongo rejects it (throws, or returns ok≠1 / writeErrors). */
  private async probeMongoWrite(): Promise<void> {
    const res = (await getMongoClient().$runCommandRaw({
      update: "_breakerProbe",
      updates: [
        { q: { _id: "heartbeat" }, u: { $set: { ts: Date.now() } }, upsert: true },
      ],
    })) as { ok?: number; writeErrors?: unknown[] };
    if (res?.ok !== 1 || (res.writeErrors && res.writeErrors.length > 0)) {
      throw new Error("mongo write probe rejected");
    }
  }

  /** Tripwire on the failed set. With the breaker in place this stays ~0 during
   *  an outage; a real backlog means jobs failed for a NON-infra reason, or the
   *  breaker never tripped — either way, look now. getFailedCount is a Redis
   *  ZCARD (O(1)). Throttled so it can't spam the logs. */
  private async alertOnBacklog(): Promise<void> {
    const failed = await this.replayQueue.getFailedCount();
    if (failed < FAILED_ALERT_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_THROTTLE_MS) return;
    this.lastAlertAt = now;
    this.logger.error(
      `QUEUE ALERT — replay-batch failed set = ${failed} (>= ${FAILED_ALERT_THRESHOLD}). ` +
        `Requeue with: node deploy/requeue-failed.js replay-batch`,
    );
    // TODO(owner): wire EmailService.sendOpsAlert(...) here once an ops recipient
    // + template exist, so this pages instead of only logging.
  }
}
