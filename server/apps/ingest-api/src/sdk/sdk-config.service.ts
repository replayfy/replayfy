import { CACHE_MANAGER } from "@nestjs/cache-manager";
import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import type { Cache } from "cache-manager";
import { createHash } from "crypto";
import { getPostgresClient } from "@replay/db-postgres";
import { ApiKeyCache } from "../api-keys/api-keys.cache";
import { BILLING_SERVICE, type BillingPort } from "../billing/billing.port";
import { SettingsService } from "../settings/settings.service";
import { isHostAllowed } from "../replay/redactor";

export interface SdkConfigResponse {
  workspaceId: number;
  /** The workspace has spent its plan's session allowance — the SDK must not
   *  record or upload. Computed FRESH (not from this 1h-cached envelope) and
   *  overlaid per request, so it reflects the cap within ~60s. The ingest reject
   *  is the hard backstop for anything running a stale config. */
  shouldNotRecord: boolean;
  capture: {
    console: boolean;
    network: boolean;
    networkHeaders: boolean;
    networkBodies: boolean;
    errors: boolean;
    headers: boolean;
    canvas: boolean;
    iframe: boolean;
    performance: boolean;
    autoplayNext: boolean;
    minDurationMs: number;
    trigger: "always" | "identified" | "sample";
  };
  privacy: {
    maskAllInputs: boolean;
    maskSelectors: string[];
    /** Input types the SDK should always mask via rrweb's maskInputOptions,
     *  even when maskAllInputs is false. Always includes "password". */
    maskInputTypes: string[];
    blockSelectors: string[];
    redactUrlPatterns: string[];
    blockCreditCardText: boolean;
    stripQueryParams: boolean;
    allowedQueryParams: string[];
    allowedHosts: string[];
  };
  sampling: {
    rate: number;
    alwaysRecordErrors: boolean;
    alwaysRecordIdentified: boolean;
    alwaysRecordOnUrls: string[];
  };
  retentionDays: number;
}

/**
 * SDK config endpoint sits in the request path for *every* page load of every
 * customer site, so it has to be fast. We cache the resolved response per
 * workspace in Redis for an hour. Every settings mutation invalidates the
 * entry so changes propagate within a single SDK refresh cycle.
 *
 * Cache key shape: `sdk-config:${workspaceId}`.
 */
const KEY = (wsId: number) => `sdk-config:${wsId}`;
const TTL_SECONDS = 60 * 60;
const HOSTS_TTL_SECONDS = 60;

@Injectable()
export class SdkConfigService {
  private readonly db = getPostgresClient();

  constructor(
    @Optional() @Inject(BILLING_SERVICE) private readonly billing: BillingPort | undefined,
    private readonly apiKeyCache: ApiKeyCache,
    private readonly settings: SettingsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async resolve(
    rawApiKey: string | undefined,
    originOrReferer?: string,
  ): Promise<SdkConfigResponse> {
    if (!rawApiKey) throw new UnauthorizedException("Missing x-replay-api-key");
    const keyHash = createHash("sha256").update(rawApiKey).digest("hex");
    const cached = await this.apiKeyCache.lookup(keyHash);
    if (!cached) throw new UnauthorizedException("Invalid or revoked API key");

    // Allowed-host enforcement. If the workspace has an allowlist, the
    // request's Origin (or Referer fallback) must match — otherwise an
    // attacker who scraped the API key off a public page can still call
    // the SDK config from their own domain. Empty allowlist = wildcard.
    await this.assertOriginAllowed(cached.workspaceId, originOrReferer);

    // Fast path — Redis hit. Chaining `.catch()` is safe on get/set (both return
    // real Promises) but NOT on del, which returns undefined — see the note on
    // ApiKeyCache. The del at invalidate() below uses await + try/catch for that
    // reason; don't "tidy" it into this shape.
    const hit = await this.cache
      .get<SdkConfigResponse>(KEY(cached.workspaceId))
      .catch(() => undefined);
    // shouldNotRecord is overlaid AFTER the cache, always fresh (its own ~60s
    // cache), so a capped workspace's SDK stops within a minute even though the
    // rest of the config is cached for an hour.
    const block = this.billing ? await this.billing.shouldNotRecord(cached.workspaceId) : false;
    if (hit) return { ...hit, shouldNotRecord: block };

    const payload = await this.build(cached.workspaceId);
    // `{ ttl }`, NOT a bare `set(key, value, seconds)` — cache-manager-ioredis
    // reads `options.ttl` off the third argument, so a raw number is dropped and
    // the store's default applies instead. See ApiKeyCache.set.
    await this.cache
      .set(KEY(cached.workspaceId), payload, { ttl: TTL_SECONDS })
      .catch(() => undefined);
    return { ...payload, shouldNotRecord: block };
  }

  /**
   * Enforce the workspace's allowedHosts list against the request's Origin
   * (or Referer). No allowlist = open to any origin (the install-first
   * default, so customers can drop the snippet and have it just work).
   * Caches the resolved hostlist per workspace for one minute so we don't
   * hammer Postgres on every page load — invalidated on settings PATCH.
   */
  private async assertOriginAllowed(
    workspaceId: number,
    origin?: string,
  ): Promise<void> {
    if (!origin) return; // No Origin header (server-side fetch, native SDK) — bypass.
    const hostsKey = `sdk-allowed-hosts:${workspaceId}`;
    let hosts = await this.cache.get<string[]>(hostsKey).catch(() => undefined);
    if (!hosts) {
      const ws = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { allowedHosts: true },
      });
      hosts = ws?.allowedHosts ?? [];
      // `{ ttl }` — see ApiKeyCache.set. The bare-number form was dropped by the
      // store, so this list actually lived for the default hour rather than the
      // minute documented above; a settings PATCH invalidates the key explicitly,
      // which is why the stale window never surfaced.
      await this.cache
        .set(hostsKey, hosts, { ttl: HOSTS_TTL_SECONDS })
        .catch(() => undefined);
    }
    if (!hosts || hosts.length === 0) return; // wildcard
    if (!isHostAllowed(origin, hosts)) {
      throw new ForbiddenException(
        "Origin not in workspace allow-list. Add this hostname under Settings → Privacy → Allowed hosts.",
      );
    }
  }

  /** Drop the cached config for one workspace. Called from SettingsService
   *  on every mutation so the next /v1/sdk/config request rebuilds fresh. */
  async invalidate(workspaceId: number): Promise<void> {
    try {
      await this.cache.del(KEY(workspaceId));
    } catch {
      /* ignore — stale entry will fall out via TTL */
    }
  }

  private async build(workspaceId: number): Promise<SdkConfigResponse> {
    const [recording, masking, retention, sampling] = await Promise.all([
      this.settings.getRecording(workspaceId),
      this.settings.getMasking(workspaceId),
      this.settings.getRetention(workspaceId),
      this.settings.getSampling(workspaceId),
    ]);

    return {
      workspaceId,
      // Overlaid fresh in resolve(); false here so the cached envelope is valid.
      shouldNotRecord: false,
      capture: {
        console: recording.captureConsole,
        network: recording.captureNetwork,
        networkHeaders: recording.captureNetworkHeaders,
        networkBodies: recording.captureNetworkBodies,
        errors: recording.captureErrors,
        headers: recording.captureHeaders,
        canvas: recording.recordCanvas,
        iframe: recording.recordCrossOriginIframes,
        performance: recording.capturePerformance,
        autoplayNext: recording.autoplayNextRecording,
        minDurationMs: (recording.minDurationSeconds ?? 5) * 1000,
        trigger: recording.recordingTrigger,
      },
      privacy: {
        maskAllInputs: masking.maskAllInputs,
        maskSelectors: masking.maskSelectors,
        // Derive input-type masks from selector strings like
        // `input[type="email"]` so rrweb's maskInputOptions can target
        // specific types even when maskAllInputs is off. Password is
        // ALWAYS forced on — that's not configurable, ever.
        maskInputTypes: SdkConfigService.deriveMaskInputTypes(
          masking.maskSelectors,
        ),
        blockSelectors: masking.blockSelectors,
        redactUrlPatterns: masking.redactUrlPatterns,
        blockCreditCardText: masking.blockCreditCardText,
        stripQueryParams: masking.stripQueryParams,
        allowedQueryParams: masking.allowedQueryParams,
        allowedHosts: masking.allowedHosts,
      },
      sampling: {
        rate: sampling.samplingRate,
        alwaysRecordErrors: sampling.alwaysRecordErrors,
        alwaysRecordIdentified: sampling.alwaysRecordIdentified,
        alwaysRecordOnUrls: sampling.alwaysRecordOnUrls,
      },
      retentionDays: retention.retentionDays,
    };
  }

  /**
   * Look for `input[type="X"]` selectors in the user's mask list and surface
   * the X values so the SDK can flip rrweb's maskInputOptions on for those
   * specific types. Always returns "password" — password fields are masked
   * by default regardless of what the customer configured, no opt-out.
   */
  private static deriveMaskInputTypes(selectors: string[]): string[] {
    const types = new Set<string>(["password"]); // hard floor
    const re = /input\s*\[\s*type\s*=\s*["']?([a-z-]+)["']?\s*\]/gi;
    for (const s of selectors ?? []) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        types.add(m[1].toLowerCase());
      }
    }
    return Array.from(types);
  }
}
