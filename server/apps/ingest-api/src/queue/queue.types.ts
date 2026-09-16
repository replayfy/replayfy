import type { ReplayBatchEnvelope } from "@replay/replay-schema";

export const REPLAY_QUEUE_NAME = "replay-batch";
export const WORKSPACE_DELETE_QUEUE_NAME = "workspace-delete";

export interface WorkspaceDeleteJob {
  workspaceId: number;
  /** Initiator — surfaces in audit logs. */
  triggeredBy: number;
  /** When the user clicked Delete; we use it to no-op late jobs if the
   *  workspace was restored. */
  requestedAt: number;
}

/** Generic retention job — discriminated by `kind`. One job per workspace
 *  per kind so the cron tick fans out into the queue instead of running
 *  the entire sweep in-process. */
export interface RetentionJob {
  kind: "purge" | "refreshPlaylists" | "refreshCohorts";
  workspaceId: number;
  enqueuedAt: number;
}

/** One derive-signals job = one keyset page of session ids (the derive is
 *  set-based over the whole batch). Enqueued by the intelligence scheduler's
 *  bulk paths — the nightly backfill and the mobile end-of-session sweep. */
export interface DeriveSignalsJob {
  sessionIds: number[];
  /** Bump the intraday daily rollup (finalize freshness). Off for re-derives
   *  (backfill / mobile-quiet) so a replay can't double-count. */
  bumpDaily?: boolean;
  /** Stamp Session.processedAt after a SUCCESSFUL derive — the mobile-quiet
   *  watermark, so a session isn't reprocessed until it resumes + re-finalizes.
   *  Left unset on failure so the next sweep retries it. */
  markProcessedAt?: boolean;
  /** Which scheduler tick produced it — used only for the idempotent jobId. */
  source: "backfill" | "mobile-quiet";
  enqueuedAt: number;
}

/** One precompute-workspace job = rebuild one dirty/stale workspace's cached L1
 *  snapshot + storyline. Enqueued by the dirty-gated precompute sweep. */
export interface PrecomputeWorkspaceJob {
  workspaceId: number;
  enqueuedAt: number;
}

export interface ReplayBatchJob {
  workspaceId: number;
  apiKeyId: number;
  envelope: ReplayBatchEnvelope;
  /** Network info captured at the edge for SDK enrichment. */
  ip?: string;
  /** Authoritative country ISO-2 from the edge (Cloudflare `cf-ipcountry`).
   *  Overrides geoip-lite's country/flag, which can disagree with its own city
   *  on VPN/datacenter IPs. */
  geoCountry?: string;
  /** Stable per-browser fingerprint from the SDK. */
  fingerprint?: string;
  /** Identify payload (optional; SDK may send distinctId+email+props). */
  identify?: {
    distinctId?: string;
    email?: string;
    name?: string;
    plan?: string;
    /** Reserved avatar-URL trait. `picture` is our documented key; `avatar` is
     *  accepted as an alias for parity with the reference user model. Either may
     *  also arrive nested in `customProps`; persistence resolves + URL-validates
     *  whichever is present into the discrete EndUser.picture column. */
    picture?: string;
    avatar?: string;
    customProps?: Record<string, unknown>;
  };
}
