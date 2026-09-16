import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Cache } from "cache-manager";
import {
  getPostgresClient,
  type Prisma,
  type DataRegion,
} from "@replay/db-postgres";
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
  // Off by default so a new workspace sees what users actually typed. Passwords
  // are still masked regardless: the SDK always sets rrweb's
  // maskInputOptions.password (initReplay.ts), which applies even when this is
  // false. maskSelectors/blockSelectors below still cover the opt-in cases.
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
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
    });
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
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
    });
    return {
      ...DEFAULT_MASKING,
      ...((ws?.maskingConfig as Partial<MaskingConfig>) ?? {}),
    };
  }

  async setMasking(workspaceId: number, body: Partial<MaskingConfig>) {
    const next = { ...(await this.getMasking(workspaceId)), ...body };
    // Persist the JSON blob *and* mirror allowedHosts to the column so the
    // ingest persistence service can filter without a JSON parse hot-path.
    await this.db.workspace.update({
      where: { id: workspaceId },
      data: {
        maskingConfig: next as Prisma.InputJsonValue,
        allowedHosts: next.allowedHosts,
      },
    });
    await this.invalidateSdkConfig(workspaceId);
    return next;
  }

  async getRetention(
    workspaceId: number,
  ): Promise<
    RetentionConfig & {
      storageUsedBytes: number;
      storageQuotaBytes: number;
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
      storageQuotaBytes: quotas[ws?.plan ?? "FREE"] ?? quotas.FREE,
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
    const ws = await this.db.workspace.findUnique({
      where: { id: workspaceId },
    });
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
