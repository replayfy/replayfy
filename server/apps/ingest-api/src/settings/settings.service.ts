import { isDeepStrictEqual } from "node:util";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Cache } from "cache-manager";
import {
  getPostgresClient,
  Prisma,
  type DataRegion,
  type Workspace,
} from "@replay/db-postgres";
import { makeWellFormedInPlace } from "../common/well-formed";
import { isUsableSelector, isUsableUrlPattern } from "./masking-rules";
import {
  bookmarkExtensionDays,
  capMobileFps,
  capMobileQuality,
  mobileQualityRank,
  planAiCadenceFloorHours,
  planMobileMaxFps,
  planMobileMaxQuality,
  planRetentionDays,
  resolvePlan,
  BILLING_ENABLED,
} from "../billing/plan-catalog";

export interface RecordingConfig {
  // Capture toggles
  captureConsole: boolean;
  captureNetwork: boolean;
  captureNetworkHeaders: boolean;
  captureNetworkBodies: boolean;
  captureErrors: boolean;
  captureHeaders: boolean; // legacy alias kept for backwards compat
  capturePerformance: boolean;
  // Recording behavior
  recordCanvas: boolean;
  recordCrossOriginIframes: boolean;
  autoplayNextRecording: boolean;
  // Trigger
  recordingTrigger: "always" | "identified" | "sample";
  minDurationSeconds: number;
  // Mobile screenshot capture, returned to the native SDK at /v1/mobile/start.
  // Per-workspace override of the MOBILE_FPS / MOBILE_QUALITY env defaults.
  mobileFps: number;
  mobileQuality: "low" | "standard" | "high";
}

export interface SamplingConfig {
  /** 0..1 — fraction of sessions to record. */
  samplingRate: number;
  /** Override the sample rate and always record when an error fires. */
  alwaysRecordErrors: boolean;
  /** Override once `replay.identify()` has been called for the session. */
  alwaysRecordIdentified: boolean;
  /** Glob patterns ("/checkout/**") that force recording regardless of rate. */
  alwaysRecordOnUrls: string[];
}

export interface RetentionConfig {
  /** Default lifetime in days. */
  retentionDays: number;
  /** "never" | "30d" | "90d" | "365d" — bookmarks extend the lifetime by this much. */
  extendBookmarked: string;
  /** Keep sessions with ≥1 captured error 2× the default lifetime. */
  keepErrorsLonger: boolean;
}

export interface MaskingConfig {
  maskAllInputs: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  redactUrlPatterns: string[];
  // New: design-spec additions
  blockCreditCardText: boolean;
  stripQueryParams: boolean;
  allowedQueryParams: string[];
  allowedHosts: string[];
}

/** Everything /v1/mobile/start needs, read in one query. */
export interface MobileStartSettings {
  sampling: SamplingConfig;
  recording: RecordingConfig;
  masking: MaskingConfig;
}

const DEFAULT_RECORDING: RecordingConfig = {
  captureConsole: true,
  captureNetwork: true,
  captureNetworkHeaders: false,
  captureNetworkBodies: false,
  captureErrors: true,
  captureHeaders: false,
  capturePerformance: true,
  recordCanvas: true,
  recordCrossOriginIframes: true,
  autoplayNextRecording: false,
  recordingTrigger: "always",
  minDurationSeconds: 5,
  // Env-tunable defaults (mirrors the reference's MOBILE_FPS / MOBILE_QUALITY).
  // Workspaces inherit these until overridden via setRecording; merged on read
  // so existing stored configs without these keys pick them up automatically.
  // Default 1 fps / low quality for EVERY workspace — matching the reference and
  // keeping archives small (a long session is a fraction of the size at 1 fps vs
  // 3). This is the plan FLOOR: a workspace RAISES fps/quality up to its plan
  // ceiling via setRecording (see PLAN_TIERS.mobileMax*), enforced in
  // getRecording (clamp on read) + setRecording (reject on set). No env override
  // — capture rate is a plan feature now, so a stale env can't lift the floor for
  // a paid tier.
  mobileFps: 1,
  mobileQuality: "low",
};

const DEFAULT_MASKING: MaskingConfig = {
  // Dashboard enforcement flag. false (default) defers to the SDKs: web SDKs
  // from 0.1.20 mask every input unless the app opts out in code (0.1.19 and
  // older apply this flag as-is, so false records input values there); native
  // mobile SDKs always mask password / secure-entry fields, and from 0.0.7
  // card-number and one-time-code fields too. true forces input masking on
  // every SDK (web maskAllInputs, native occludeAllTextFields) even where app
  // code opts out. It never unmasks.
  maskAllInputs: false,
  maskSelectors: ["[data-private]", ".sensitive"],
  blockSelectors: [".no-replay"],
  redactUrlPatterns: ["token=", "api_key="],
  blockCreditCardText: true,
  stripQueryParams: false,
  allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
  allowedHosts: [],
};

/**
 * Marks a maskingConfig blob stored as a delta: only the keys an admin set.
 * A blob without it was saved by the old setMasking, which stored the whole
 * merged config, so its values equal to PRE_DELTA_MASKING are defaults that
 * were merged in, not choices. They read as unset (a later DEFAULT_MASKING
 * change reaches them too) and are dropped when the blob is next saved.
 */
const MASKING_DELTA_MARK = { v: 2 } as const;

/**
 * The defaults the old setMasking merged into every blob it saved. FROZEN:
 * never edit it, not even when DEFAULT_MASKING changes, or old choices would
 * start reading as defaults. maskAllInputs defaulted to true before
 * 2026-07-16; a stored true can't be told apart from an admin's force, so it
 * stays a choice (the stricter reading).
 */
const PRE_DELTA_MASKING: MaskingConfig = {
  maskAllInputs: false,
  maskSelectors: ["[data-private]", ".sensitive"],
  blockSelectors: [".no-replay"],
  redactUrlPatterns: ["token=", "api_key="],
  blockCreditCardText: true,
  stripQueryParams: false,
  allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
  allowedHosts: [],
};

@Injectable()
export class SettingsService {
  private readonly db = getPostgresClient();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /** Drop the cached SDK config (and the allowed-hosts shortcut) for this
   *  workspace. Called after every recording / masking / sampling /
   *  retention update so the next /v1/sdk/config and /v1/replay/batch
   *  enforce the new state. */
  private async invalidateSdkConfig(workspaceId: number) {
    try {
      await this.cache.del(`sdk-config:${workspaceId}`);
    } catch {
      /* ignore */
    }
    try {
      await this.cache.del(`sdk-allowed-hosts:${workspaceId}`);
    } catch {
      /* ignore */
    }
  }

  async getRecording(workspaceId: number): Promise<RecordingConfig> {
    // Access pattern: one Workspace primary-key lookup, narrow select (the plan
    // for the mobile clamp + the stored JSON) — O(1) at any workspace count.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, recordingConfig: true },
    });
    return this.mergeRecording(ws);
  }

  /**
   * Everything /v1/mobile/start needs: the sampling gate, the capture settings
   * handed to the native SDK and the dashboard's input-masking force, merged
   * exactly as getSampling / getRecording / getMasking merge them.
   *
   * Access pattern: single Workspace primary-key lookup, narrow select; replaces
   * the separate getSampling + getRecording reads on /v1/mobile/start (2 reads
   * → 1) and brings masking along without a third.
   */
  async getMobileStartSettings(
    workspaceId: number,
  ): Promise<MobileStartSettings> {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        plan: true,
        samplingRate: true,
        samplingConfig: true,
        recordingConfig: true,
        maskingConfig: true,
      },
    });
    return {
      sampling: this.mergeSampling(ws),
      recording: this.mergeRecording(ws),
      masking: this.mergeMasking(ws?.maskingConfig),
    };
  }

  private mergeRecording(
    ws: Pick<Workspace, "plan" | "recordingConfig"> | null,
  ): RecordingConfig {
    const merged: RecordingConfig = {
      ...DEFAULT_RECORDING,
      ...((ws?.recordingConfig as Partial<RecordingConfig>) ?? {}),
    };
    // Cap mobile capture to the plan ceiling on READ — this is the value /start
    // hands the SDK, so a workspace that raised fps/quality on a larger plan and
    // then downgraded stops capturing above its new plan automatically, without
    // a migration to rewrite the stored config.
    merged.mobileFps = capMobileFps(ws?.plan, merged.mobileFps);
    merged.mobileQuality = capMobileQuality(ws?.plan, merged.mobileQuality);
    return merged;
  }

  async setRecording(workspaceId: number, body: Partial<RecordingConfig>) {
    // Mobile fps/quality are plan features: reject a request above the plan's
    // ceiling (rather than silently clamp) so the UI can toast an upgrade prompt.
    // getRecording still clamps on read, so a later downgrade shrinks capture
    // even if the stored value was set while on a higher plan.
    if (body.mobileFps != null || body.mobileQuality != null) {
      const ws = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      });
      const label = resolvePlan(ws?.plan).label;
      const maxFps = planMobileMaxFps(ws?.plan);
      const maxQuality = planMobileMaxQuality(ws?.plan);
      if (body.mobileFps != null && body.mobileFps > maxFps) {
        throw new BadRequestException(
          `Your ${label} plan records mobile at up to ${maxFps} fps. Upgrade your plan for a higher frame rate.`,
        );
      }
      if (
        body.mobileQuality != null &&
        mobileQualityRank(body.mobileQuality) > mobileQualityRank(maxQuality)
      ) {
        throw new BadRequestException(
          `Your ${label} plan records mobile at up to "${maxQuality}" quality. Upgrade your plan for higher quality.`,
        );
      }
    }
    const next = { ...(await this.getRecording(workspaceId)), ...body };
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { recordingConfig: next as Prisma.InputJsonValue },
    });
    await this.invalidateSdkConfig(workspaceId);
    return next;
  }

  async getMasking(workspaceId: number): Promise<MaskingConfig> {
    // Access pattern: one Workspace primary-key lookup, narrow select (only the
    // masking JSON) — O(1) at any workspace count.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { maskingConfig: true },
    });
    return this.mergeMasking(ws?.maskingConfig);
  }

  async setMasking(workspaceId: number, body: Partial<MaskingConfig>) {
    // Store only the keys an admin actually set, never the merged defaults: a
    // key nobody touched keeps following DEFAULT_MASKING, so a later change to a
    // default reaches every workspace that never overrode it.
    const patch = this.presentMaskingKeys(body);
    // Postgres jsonb rejects a lone surrogate or NUL in any string.
    makeWellFormedInPlace(patch);
    await this.assertUsableRules(workspaceId, patch);
    // allowedHosts is mirrored to its column (the ingest hot path filters on it
    // without parsing JSON). Only this method writes either, so a save that
    // doesn't set the list leaves the column as it is.
    const hosts =
      patch.allowedHosts !== undefined
        ? Prisma.sql`${patch.allowedHosts}::text[]`
        : Prisma.sql`"allowedHosts"`;
    // Access pattern: ONE Workspace primary-key UPDATE ... RETURNING — O(1) per
    // save. The patch is merged onto the stored delta with jsonb `||` inside the
    // statement (right-hand keys win), so two admins saving different keys at
    // once both land: no read-modify-write window. A blob from before delta
    // storage (no MASKING_DELTA_MARK) first drops its merged-in defaults, its
    // nulls and any non-MaskingConfig keys, as maskingOverrides reads it.
    const rows = await this.db.$queryRaw<
      Array<{ maskingConfig: Prisma.JsonValue }>
    >`
      UPDATE "Workspace"
      SET "maskingConfig" = CASE
            WHEN "maskingConfig" @> ${JSON.stringify(MASKING_DELTA_MARK)}::jsonb
              THEN "maskingConfig"
            WHEN jsonb_typeof("maskingConfig") = 'object' THEN (
              SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
              FROM jsonb_each("maskingConfig") AS e
              WHERE ${JSON.stringify(PRE_DELTA_MASKING)}::jsonb ? e.key
                AND jsonb_typeof(e.value) <> 'null'
                AND e.value <> (${JSON.stringify(PRE_DELTA_MASKING)}::jsonb -> e.key)
            )
            ELSE '{}'::jsonb
          END
          || ${JSON.stringify(patch)}::jsonb
          || ${JSON.stringify(MASKING_DELTA_MARK)}::jsonb,
        "allowedHosts" = ${hosts}
      WHERE "id" = ${workspaceId}
      RETURNING "maskingConfig"`;
    if (rows.length === 0) throw new NotFoundException("Workspace not found");
    await this.invalidateSdkConfig(workspaceId);
    return this.mergeMasking(rows[0].maskingConfig);
  }

  /**
   * Rejects a save that adds a mask / block selector or a redact URL pattern
   * web SDKs can't use: one such rule can switch the others off (see
   * masking-rules.ts). Rules the workspace already has are let through, so a
   * list still holding an older invalid rule can be edited and the rule removed.
   *
   * Access pattern: one Workspace primary-key read (narrow select), only for
   * saves that carry a rule list. The read only decides which rules count as
   * already there; the merge stays in setMasking's single UPDATE, so it opens
   * no lost-update window.
   */
  private async assertUsableRules(
    workspaceId: number,
    patch: Partial<MaskingConfig>,
  ): Promise<void> {
    const lists = [
      { key: "maskSelectors", usable: isUsableSelector },
      { key: "blockSelectors", usable: isUsableSelector },
      { key: "redactUrlPatterns", usable: isUsableUrlPattern },
    ] as const;
    if (!lists.some(({ key }) => patch[key] !== undefined)) return;
    const current = await this.getMasking(workspaceId);
    for (const { key, usable } of lists) {
      const bad = (patch[key] ?? []).filter(
        (rule) => !usable(rule) && !current[key].includes(rule),
      );
      if (bad.length === 0) continue;
      const shown = bad.map((rule) => JSON.stringify(rule)).join(", ");
      throw new BadRequestException(
        key === "redactUrlPatterns"
          ? `Not a valid regular expression in ${key}: ${shown}. Web SDKs compile every pattern, so it would stop this workspace's dashboard settings from applying.`
          : `Not a valid CSS selector in ${key}: ${shown}. Web SDKs join every rule into one selector, so it would stop the other rules from applying.`,
      );
    }
  }

  private mergeMasking(stored: Prisma.JsonValue | undefined): MaskingConfig {
    return { ...DEFAULT_MASKING, ...this.maskingOverrides(stored) };
  }

  /**
   * The keys a stored blob overrides. A delta blob (MASKING_DELTA_MARK)
   * overrides every key it holds. A blob from before delta storage holds every
   * key, so only its values that differ from PRE_DELTA_MASKING are choices.
   */
  private maskingOverrides(
    stored: Prisma.JsonValue | undefined,
  ): Partial<MaskingConfig> {
    const present = this.presentMaskingKeys(stored);
    const isDelta =
      !!stored &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      stored.v === MASKING_DELTA_MARK.v;
    if (isDelta) return present;
    return Object.fromEntries(
      Object.entries(present).filter(
        ([k, v]) =>
          !isDeepStrictEqual(v, PRE_DELTA_MASKING[k as keyof MaskingConfig]),
      ),
    ) as Partial<MaskingConfig>;
  }

  /**
   * The MaskingConfig keys that carry a value. undefined and null mean "not
   * set": the DTO lets both through (@IsOptional accepts null), and neither may
   * erase a stored key or override a default. Unknown keys are dropped too, so
   * only MaskingConfig fields are ever stored.
   */
  private presentMaskingKeys(
    src: Prisma.JsonValue | Partial<MaskingConfig> | undefined,
  ): Partial<MaskingConfig> {
    if (!src || typeof src !== "object" || Array.isArray(src)) return {};
    return Object.fromEntries(
      Object.entries(src).filter(
        ([k, v]) =>
          Object.prototype.hasOwnProperty.call(DEFAULT_MASKING, k) &&
          v !== undefined &&
          v !== null,
      ),
    ) as Partial<MaskingConfig>;
  }

  async getRetention(
    workspaceId: number,
  ): Promise<
    RetentionConfig & {
      storageUsedBytes: number;
      storageQuotaBytes: number | null; // null = unlimited (self-host / no billing)
      maxRetentionDays: number | null;
    }
  > {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
    });
    const extras =
      (ws?.retentionConfig as Partial<RetentionConfig> | null) ?? {};
    // Storage used = sum of session.dataSizeBytes for the workspace.
    const sizeAgg = await this.db.session.aggregate({
      where: { workspaceId },
      _sum: { dataSizeBytes: true },
    });
    const used = Number(sizeAgg._sum.dataSizeBytes ?? 0);
    // Plan-based quota — FREE: 1 GB, PRO: 100 GB, TEAM: 500 GB, ENT: 5 TB.
    // FREE has been re-confirmed: 1 GB is the entry tier; anyone exceeding
    // is nudged to upgrade.
    const quotas: Record<string, number> = {
      FREE: 1 * 1024 ** 3, // 1 GB
      PRO: 100 * 1024 ** 3, // 100 GB
      TEAM: 500 * 1024 ** 3, // 500 GB
      ENTERPRISE: 5 * 1024 ** 4, // 5 TB
    };
    return {
      retentionDays: ws?.retentionDays ?? 30,
      extendBookmarked: extras.extendBookmarked ?? "never",
      keepErrorsLonger: extras.keepErrorsLonger ?? true,
      storageUsedBytes: used,
      // Self-host / no billing: storage is uncapped. `null` = unlimited, the
      // same short-circuit every other plan cap uses via resolvePlan()/
      // BILLING_ENABLED (unlike them, this quota was a hardcoded map that
      // bypassed it — hence a stray "/100 GB" leaked into the self-host UI).
      // Cloud path (billing on) is unchanged.
      storageQuotaBytes: BILLING_ENABLED
        ? (quotas[ws?.plan ?? "FREE"] ?? quotas.FREE)
        : null,
      // The plan's retention ceiling (null = unlimited), surfaced so the panel
      // can state the limit up front instead of only discovering it when a save
      // is rejected. Both the default period AND the bookmark extension are
      // enforced against this same number.
      maxRetentionDays: planRetentionDays(ws?.plan),
    };
  }

  async setRetention(workspaceId: number, body: Partial<RetentionConfig>) {
    const current = await this.getRetention(workspaceId);
    // Retention is a plan feature: you can't keep recordings longer than your
    // plan allows. Reject (rather than silently clamp) so the UI can toast an
    // upgrade prompt instead of quietly ignoring the choice.
    //
    // The bookmark extension is checked against the SAME ceiling, because it is
    // the same storage. Previously only `retentionDays` was validated, so
    // "Extend bookmarked recordings → Never expire" was an unlimited-retention
    // bypass on any plan — pick a 30-day default, star everything, keep it
    // forever. The total a bookmark buys (default + extension) is what must fit
    // under the plan cap.
    if (body.retentionDays != null || body.extendBookmarked != null) {
      const ws = await this.db.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      });
      const max = planRetentionDays(ws?.plan);
      if (max != null) {
        const label = resolvePlan(ws?.plan).label;
        if (body.retentionDays != null && body.retentionDays > max) {
          throw new BadRequestException(
            `Your ${label} plan keeps recordings for up to ${max} days. Upgrade your plan to retain them longer.`,
          );
        }
        if (body.extendBookmarked != null) {
          const base = body.retentionDays ?? current.retentionDays;
          const extra = bookmarkExtensionDays(body.extendBookmarked);
          if (extra == null) {
            throw new BadRequestException(
              `Your ${label} plan keeps recordings for up to ${max} days, so bookmarked recordings can't be kept forever. Upgrade your plan to retain them longer.`,
            );
          }
          if (base + extra > max) {
            throw new BadRequestException(
              `Your ${label} plan keeps recordings for up to ${max} days, and a ${base}-day default plus ${extra} days would exceed that. Upgrade your plan to retain them longer.`,
            );
          }
        }
      }
    }
    const next: RetentionConfig = {
      retentionDays: body.retentionDays ?? current.retentionDays,
      extendBookmarked: body.extendBookmarked ?? current.extendBookmarked,
      keepErrorsLonger: body.keepErrorsLonger ?? current.keepErrorsLonger,
    };
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        retentionDays: next.retentionDays,
        retentionConfig: {
          extendBookmarked: next.extendBookmarked,
          keepErrorsLonger: next.keepErrorsLonger,
        } as Prisma.InputJsonValue,
      },
    });
    await this.invalidateSdkConfig(workspaceId);
    return this.getRetention(workspaceId);
  }

  /** Deployment region (data residency). Single-scalar read keyed by the
   *  workspace PK (already indexed) — O(1), scales to any workspace count. */
  async getRegion(
    workspaceId: number,
  ): Promise<{ dataRegion: DataRegion | null }> {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { dataRegion: true },
    });
    return { dataRegion: ws?.dataRegion ?? null };
  }

  /** Persist the deployment region. WRITE-ONCE: permanent after the first
   *  choice — a later attempt to change it is rejected. */
  async setRegion(
    workspaceId: number,
    dataRegion: DataRegion,
  ): Promise<{ dataRegion: DataRegion }> {
    if (dataRegion !== "US" && dataRegion !== "EU") {
      throw new BadRequestException("dataRegion must be US or EU");
    }
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { dataRegion: true },
    });
    if (ws?.dataRegion && ws.dataRegion !== dataRegion) {
      throw new BadRequestException(
        "Deployment region is permanent and cannot be changed once set.",
      );
    }
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { dataRegion },
    });
    return { dataRegion };
  }

  async getSampling(workspaceId: number): Promise<SamplingConfig> {
    // Access pattern: one Workspace primary-key lookup, narrow select (the rate
    // column + the stored JSON) — O(1) at any workspace count.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { samplingRate: true, samplingConfig: true },
    });
    return this.mergeSampling(ws);
  }

  private mergeSampling(
    ws: Pick<Workspace, "samplingRate" | "samplingConfig"> | null,
  ): SamplingConfig {
    const extras = (ws?.samplingConfig as Partial<SamplingConfig> | null) ?? {};
    return {
      samplingRate: ws?.samplingRate ?? 1,
      alwaysRecordErrors: extras.alwaysRecordErrors ?? true,
      alwaysRecordIdentified: extras.alwaysRecordIdentified ?? false,
      alwaysRecordOnUrls: extras.alwaysRecordOnUrls ?? [],
    };
  }

  async setSampling(workspaceId: number, body: Partial<SamplingConfig>) {
    const current = await this.getSampling(workspaceId);
    const next: SamplingConfig = {
      samplingRate: body.samplingRate ?? current.samplingRate,
      alwaysRecordErrors: body.alwaysRecordErrors ?? current.alwaysRecordErrors,
      alwaysRecordIdentified:
        body.alwaysRecordIdentified ?? current.alwaysRecordIdentified,
      alwaysRecordOnUrls: body.alwaysRecordOnUrls ?? current.alwaysRecordOnUrls,
    };
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        samplingRate: Math.max(0, Math.min(1, next.samplingRate)),
        samplingConfig: {
          alwaysRecordErrors: next.alwaysRecordErrors,
          alwaysRecordIdentified: next.alwaysRecordIdentified,
          alwaysRecordOnUrls: next.alwaysRecordOnUrls,
        } as Prisma.InputJsonValue,
      },
    });
    await this.invalidateSdkConfig(workspaceId);
    return next;
  }

  /**
   * Business settings — the average order value (cents) that powers the
   * Overview incident impact estimate (doc 09 §7). Null means "unset": the
   * dashboard then shows affected-user reach instead of a dollar figure.
   */
  /** AI intelligence layer on/off for the whole workspace (owner/admin). When
   *  false, the Overview serves only classic/deterministic analytics — the
   *  Experience-Health score, Storyline and Signals(insights) are withheld. */
  async getAiMode(workspaceId: number): Promise<{ aiEnabled: boolean }> {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiEnabled: true },
    });
    return { aiEnabled: ws?.aiEnabled ?? true };
  }

  async setAiMode(
    workspaceId: number,
    body: { enabled: boolean },
  ): Promise<{ aiEnabled: boolean }> {
    const aiEnabled = body.enabled !== false;
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { aiEnabled },
    });
    return { aiEnabled };
  }

  /** How often the AI intelligence pass may regenerate the storyline + insights,
   *  in hours (0 = off). The deterministic numbers still refresh ~5-min. */
  async getIntelInterval(
    workspaceId: number,
  ): Promise<{ intelIntervalHours: number; minIntervalHours: number }> {
    // Access pattern: one workspace by PRIMARY KEY, with its 1:1 snapshot
    // pulled through the relation — the plan lives on Workspace and the
    // interval on the snapshot, so this is one statement instead of two reads,
    // and it cannot scan (both sides are PK lookups) however many workspaces
    // exist.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true, snapshot: { select: { intelIntervalHours: true } } },
    });
    // The plan's cadence FLOOR is surfaced next to the stored value for the same
    // reason getRetention surfaces maxRetentionDays: the sweep actually runs at
    // max(stored, floor) (see AI_CADENCE_FLOOR_HOURS), so a panel shown only the
    // stored number would state a refresh rate we do not honour — a Free
    // workspace storing 6 is really refreshed every 24. 0 = off, and a floor
    // never resurrects it, so the panel should read the two independently.
    return {
      intelIntervalHours: ws?.snapshot?.intelIntervalHours ?? 6,
      minIntervalHours: planAiCadenceFloorHours(ws?.plan),
    };
  }

  async setIntelInterval(
    workspaceId: number,
    body: { hours: number },
  ): Promise<{ intelIntervalHours: number; minIntervalHours: number }> {
    const intelIntervalHours = Math.min(
      168,
      Math.max(0, Math.floor(Number(body.hours) || 0)),
    );
    // Access pattern: one row by PRIMARY KEY on a user-triggered save — not a
    // loop, not a scan.
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    });
    const floor = planAiCadenceFloorHours(ws?.plan);
    // The background AI cadence is a plan feature, like retention above: the
    // sweep runs at max(stored, floor), so storing a faster value would persist
    // and echo back a number we never honour — the user sets 6, is told 6, gets
    // 24. Reject rather than clamp, the same contract setRetention uses, so the
    // UI can toast an upgrade prompt instead of the save quietly meaning
    // something else. 0 (= turn it off) is always allowed: a floor may only slow
    // the pass down, never switch it back on.
    if (floor > 0 && intelIntervalHours > 0 && intelIntervalHours < floor)
      throw new BadRequestException(
        `Your ${resolvePlan(ws?.plan).label} plan refreshes AI insights every ${floor} hours. Upgrade your plan for a faster refresh.`,
      );
    await this.db.workspaceSnapshot.upsert({
      where: { workspaceId },
      create: { workspaceId, intelIntervalHours },
      update: { intelIntervalHours },
    });
    return { intelIntervalHours, minIntervalHours: floor };
  }

  async getBusiness(
    workspaceId: number,
  ): Promise<{ avgOrderValueCents: number | null }> {
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { avgOrderValueCents: true },
    });
    return { avgOrderValueCents: ws?.avgOrderValueCents ?? null };
  }

  async setBusiness(
    workspaceId: number,
    body: { avgOrderValueCents: number | null },
  ): Promise<{ avgOrderValueCents: number | null }> {
    // Clamp to a sane non-negative integer; null clears it (back to reach-only).
    const raw = body.avgOrderValueCents;
    const value =
      raw == null || Number.isNaN(raw) ? null : Math.max(0, Math.round(raw));
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: { avgOrderValueCents: value },
    });
    return { avgOrderValueCents: value };
  }

  /**
   * Returns each integration with `connected` reflecting ACTUAL per-workspace
   * state. The dashboard renders an "available" list; only items with
   * `connected: true` show a green indicator.
   *
   * Access pattern: one indexed lookup on WorkspaceIntegration keyed by
   * workspaceId (the prefix of @@unique([workspaceId, provider])), returning at
   * most one row per provider — O(#providers), so it scales to any workspace
   * count. Every wired provider (Slack/Linear/GitHub/Jira/Lark/Sentry OAuth +
   * PagerDuty/Webhook config-form) reflects the per-workspace connection table;
   * transactional email (AWS SES) is server-wide env config (not per-workspace).
   */
  async getIntegrations(workspaceId: number) {
    const rows = await this.db.workspaceIntegration.findMany({
      where: { workspaceId },
      select: { provider: true },
    });
    const connected = new Set(rows.map((r) => r.provider));
    const integrations = [
      { id: "slack", label: "Slack", connected: connected.has("SLACK") },
      { id: "linear", label: "Linear", connected: connected.has("LINEAR") },
      { id: "jira", label: "Jira", connected: connected.has("JIRA") },
      { id: "github", label: "GitHub", connected: connected.has("GITHUB") },
      { id: "lark", label: "Lark", connected: connected.has("LARK") },
      { id: "sentry", label: "Sentry", connected: connected.has("SENTRY") },
      {
        id: "pagerduty",
        label: "PagerDuty",
        connected: connected.has("PAGERDUTY"),
      },
      { id: "webhook", label: "Webhook", connected: connected.has("WEBHOOK") },
    ];
    return { integrations };
  }
}
