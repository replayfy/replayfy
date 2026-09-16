import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "crypto";
import type {
  ReplayBatchEnvelope,
  ReplayIngestResponse,
} from "@replay/replay-schema";
import { getPostgresClient } from "@replay/db-postgres";
import { ApiKeyCache } from "../api-keys/api-keys.cache";
import { BILLING_SERVICE, type BillingPort } from "../billing/billing.port";
import { QueueService } from "../queue/queue.service";
import { PresenceService } from "../presence/presence.service";
import { isHostAllowed } from "./redactor";

// Throttle lastUsedAt writes to once per minute per key — no UX value in
// bumping the column on every single batch.
const lastUsedCache = new Map<number, number>();

@Injectable()
export class ReplayIngestService {
  private readonly db = getPostgresClient();

  constructor(
    private readonly apiKeyCache: ApiKeyCache,
    private readonly queue: QueueService,
    @Optional() @Inject(BILLING_SERVICE) private readonly billing: BillingPort | undefined,
    private readonly presence: PresenceService,
  ) {}

  async ingestBatch(
    rawApiKey: string | undefined,
    envelope: ReplayBatchEnvelope,
    extras: {
      ip?: string;
      geoCountry?: string;
      identify?: Parameters<QueueService["enqueueBatch"]>[0]["identify"];
      fingerprint?: string;
      origin?: string;
    },
  ): Promise<ReplayIngestResponse> {
    if (!rawApiKey)
      throw new UnauthorizedException("Missing x-replay-api-key header");
    this.assertEnvelope(envelope);
    const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
    const cached = await this.apiKeyCache.lookup(keyHash);
    if (!cached) throw new UnauthorizedException("Invalid or revoked API key");

    // Allowed-host enforcement at the ingest boundary. Reads allowedHosts
    // off the workspace and rejects batches from foreign origins. Bypassed
    // when no Origin header (server-side captures, native SDKs) or when
    // the workspace has an empty allowlist.
    if (extras.origin) {
      const ws = await this.db.workspace.findUnique({
        where: { id: cached.workspaceId },
        select: { allowedHosts: true },
      });
      const hosts = ws?.allowedHosts ?? [];
      if (hosts.length > 0 && !isHostAllowed(extras.origin, hosts)) {
        throw new ForbiddenException("Origin not in workspace allow-list.");
      }
    }

    // Free-tier cap: a workspace that has spent its session allowance stops
    // recording. Drop the batch BEFORE it is enqueued/persisted (never stored,
    // never billed) and tell the SDK to stop sending. Near-real-time — the check
    // is ~60s-cached off the settle-sweep counter. The SDK also learns this from
    // its next remote-config fetch (shouldNotRecord), which stops the upload at
    // the source; this reject is the hard guarantee for whatever is already in
    // flight or running a stale config. Billing is Enterprise Edition — undefined
    // in the open-source build (no BILLING_SERVICE provider) → recording is
    // unlimited.
    if (this.billing && (await this.billing.shouldNotRecord(cached.workspaceId))) {
      return {
        accepted: false,
        acceptedSequence: envelope.sequence,
        sessionId: envelope.sessionId,
        shouldNotRecord: true,
      };
    }

    await this.queue.enqueueBatch({
      workspaceId: cached.workspaceId,
      apiKeyId: cached.keyId,
      envelope,
      ip: extras.ip,
      geoCountry: extras.geoCountry,
      identify: extras.identify,
      fingerprint: extras.fingerprint,
    });

    // Bump lastUsedAt for the Settings → Install + API keys page.
    const now = Date.now();

    // Redis presence — mark this user + session active NOW so the dashboard's
    // "people online" count and the recordings live-dot are real-time and
    // node-local-state-free (correct across many ingest nodes). Written at
    // ACCEPT time, not worker time, so it never lags behind the drain. The
    // distinctId precedence mirrors upsertEndUser so presence and EndUser agree
    // on who this is. Fire-and-forget: presence is a best-effort UI signal and
    // must never fail an already-accepted batch.
    const distinctId =
      extras.identify?.distinctId?.trim() ||
      extras.identify?.email?.trim().toLowerCase() ||
      extras.fingerprint ||
      `anon_${envelope.sessionId.slice(0, 16)}`;
    void this.presence
      .touch(cached.workspaceId, envelope.sessionId, distinctId, now)
      .catch(() => {});
    if (now - (lastUsedCache.get(cached.keyId) ?? 0) > 60_000) {
      lastUsedCache.set(cached.keyId, now);
      this.db.apiKey
        .update({
          where: { id: cached.keyId },
          data: { lastUsedAt: new Date(now) },
        })
        .catch(() => {});
    }

    return {
      accepted: true,
      acceptedSequence: envelope.sequence,
      sessionId: envelope.sessionId,
    };
  }

  /**
   * Resolve an API key to a workspace id, using the same cache the
   * batch ingest path uses. Returns null on invalid/revoked keys so
   * callers can fail soft (the thumbnail endpoint silently ignores
   * bad keys rather than throwing — there's nothing for the dashboard
   * to retry).
   */
  async resolveWorkspaceId(rawApiKey: string | undefined): Promise<number | null> {
    if (!rawApiKey) return null;
    const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
    const cached = await this.apiKeyCache.lookup(keyHash);
    return cached?.workspaceId ?? null;
  }

  private assertEnvelope(envelope: ReplayBatchEnvelope) {
    // A malformed envelope is a CLIENT error → 400, not a 500. (These threw a
    // plain Error before, which the exception filter mapped to 500 and polluted
    // error monitoring for what is just a bad request body.)
    if (!envelope.sessionId)
      throw new BadRequestException("sessionId is required");
    if (!envelope.segmentId)
      throw new BadRequestException("segmentId is required");
    if (!Number.isInteger(envelope.sequence) || envelope.sequence < 1) {
      throw new BadRequestException("sequence must be a positive integer");
    }
    if (!Array.isArray(envelope.events) || envelope.events.length === 0) {
      throw new BadRequestException("events must be a non-empty array");
    }
    // `page` is required by the persistence path (reads envelope.page.userAgent
    // /url/viewport). Without this check a batch missing `page` is ACCEPTED here
    // (201) but throws a TypeError deep in the worker, failing the job 3× into
    // the dead-letter set — a cheap way to spam worker errors. Reject at the
    // door instead. (Found during spike testing.)
    if (!envelope.page || typeof envelope.page !== "object") {
      throw new BadRequestException("page is required");
    }
  }
}
