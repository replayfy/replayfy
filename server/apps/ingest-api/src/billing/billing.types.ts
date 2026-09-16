/**
 * Billing queue contract. The auto-upgrade CHARGE moved off the 5-minute cron
 * and onto a queue for one reason: a cron that re-attempts a declined card
 * every 5 minutes never terminates. That is ~288 attempts a day per workspace,
 * which card networks treat as abuse, Stripe rate-limits, and which no amount
 * of logging makes acceptable.
 *
 * The cron is now only a DETECTOR: it notices "over ceiling" and enqueues once
 * (the deterministic jobId dedupes). The queue owns the retry policy —
 * exponential backoff over a bounded window, then it gives up, caps the
 * workspace at the tier it already paid for, and emails once.
 */
export const BILLING_QUEUE = "billing";
export const BILLING_JOB_AUTO_UPGRADE = "auto-upgrade";

/** Retry policy for the upgrade charge: 5 attempts, exponential from 60s —
 *  roughly 1m, 2m, 4m, 8m, 16m, so it stops trying after ~31 minutes. Short on
 *  purpose: a card that declines now will still decline in an hour. Recovery is
 *  event-driven instead (a new payment method re-enqueues), not poll-driven. */
export const AUTO_UPGRADE_ATTEMPTS = 5;
export const AUTO_UPGRADE_BACKOFF_MS = 60_000;

export interface AutoUpgradeJob {
  workspaceId: number;
  /** Target plan key, decided by the detector from usage. */
  target: string;
  /** Plan the workspace was on when queued — the ceiling we cap back to. */
  fromPlan: string;
  /** "YYYY-MM"; scopes the Stripe idempotency key to this cycle. */
  period: string;
  /** Enqueue generation (epoch ms), stamped by the detector. Together with the
   *  attempt number it makes each charge ATTEMPT a distinct Stripe idempotency
   *  key. Stripe caches an idempotent response — including a card decline — for
   *  24h, so a key that is constant across attempts would replay the first
   *  decline forever: the backoff would be decorative and attaching a working
   *  card would not collect. Distinct per attempt = a real retry; stable within
   *  an attempt = a redelivered/stalled job still cannot double-charge. */
  gen: number;
}
