import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { gunzipSync } from "zlib";
import { getPostgresClient } from "@replay/db-postgres";
import {
  insertProjectionRows,
  type ProjectionRow,
} from "@replay/db-clickhouse";
import { ApiKeyCache } from "../api-keys/api-keys.cache";
import { mobileDeviceFacts, humanizeDeviceModel } from "../common/device-facts";
import { mergeSessionCustomProps } from "../common/session-props";
import { resolveGeo, deviceGeoFallback } from "../replay/geo";
import { FramesStreamService } from "../frames/frames-stream.service";
import { PresenceService } from "../presence/presence.service";
import { SettingsService } from "../settings/settings.service";
import { BILLING_SERVICE, type BillingPort } from "../billing/billing.port";
import { CohortsService } from "../cohorts/cohorts.service";
import { WorkspaceStatsService } from "../workspace-stats/workspace-stats.service";
import {
  decodeMobileBatch,
  type DecodedMobileMessage,
} from "./mobile-messages";
import { signMobileToken, type MobileTokenPayload } from "./mobile-token";

interface StartParams {
  projectKey?: string;
  platform?: string; // "ios" | "android" (our SDKs send this)
  // Wrapper SDK that drove the native engine, e.g. "react-native" / "flutter".
  // Platform stays ios/android; this only refines sdkName so the dashboard can
  // show "Captured by …".
  framework?: string;
  trackerVersion?: string;
  revID?: string;
  // Host-app marketing version (CFBundleShortVersionString / versionName) —
  // the human release identifier, preferred over the revID build number.
  appVersion?: string;
  userUUID?: string;
  userOSVersion?: string;
  userDevice?: string;
  userDeviceType?: string;
  timestamp?: number;
  deviceMemory?: number;
  timezone?: string;
  // IANA timezone id ("Africa/Lagos") — distinct from `timezone`, which our
  // SDKs send as a UTC offset. Feeds the timezone→country geo fallback.
  timezoneId?: string;
  // The device's own region + locale (Locale.region / Locale.identifier). Used
  // to backfill country when IP geo can't resolve — which is the norm on mobile
  // (carrier NAT, VPNs) and always true in dev (private IPs).
  regionCode?: string;
  language?: string;
  // Network transport the device is on at session start — "wifi" / "cellular"
  // / "ethernet" / "none" (SDK-detected via NWPathMonitor / ConnectivityManager).
  connectionType?: string;
  width?: number;
  height?: number;
  /// Distinct id when the host already called identify() before start —
  /// lets the sampling gate honour alwaysRecordIdentified.
  distinctId?: string;
}

@Injectable()
export class MobileService {
  private readonly db = getPostgresClient();

  constructor(
    @Optional() @Inject(BILLING_SERVICE) private readonly billing: BillingPort | undefined,
    private readonly apiKeys: ApiKeyCache,
    private readonly frames: FramesStreamService,
    private readonly settings: SettingsService,
    private readonly stats: WorkspaceStatsService,
    private readonly cohorts: CohortsService,
    private readonly presence: PresenceService,
  ) {}

  // ── /v1/mobile/start ───────────────────────────────────────────────
  async createSession(
    params: StartParams,
    clientIp?: string,
  ): Promise<{
    record: boolean;
    token: string;
    sessionID: string;
    fps: number;
    quality: string;
    framesSupport: boolean;
    projectID: string;
    userUUID: string;
    captureConsole: boolean;
    captureNetwork: boolean;
    captureNetworkHeaders: boolean;
    captureNetworkBodies: boolean;
  } | null> {
    const workspaceId = await this.resolveWorkspace(params.projectKey);
    if (workspaceId == null) return null;

    // Free-tier cap: allowance spent → do not start a session at all, so the
    // mobile SDK never uploads a single frame (the heavy R2 cost). Same
    // `record:false` shape the sampling-out path returns, so both SDKs decode
    // it cleanly. Takes precedence over the sampling roll below — a capped
    // workspace records nothing regardless of sampling.
    // Billing is Enterprise Edition: absent in the open-source build (no
    // provider bound to BILLING_SERVICE → `billing` is undefined), where
    // recording is unlimited.
    if (this.billing && (await this.billing.shouldNotRecord(workspaceId))) {
      return {
        record: false,
        token: "",
        sessionID: "",
        fps: 0,
        quality: "",
        framesSupport: false,
        projectID: String(workspaceId),
        userUUID: params.userUUID ?? "",
        captureConsole: false,
        captureNetwork: false,
        captureNetworkHeaders: false,
        captureNetworkBodies: false,
      };
    }

    // Sampling gate — mirror the web SDK's session-start roll so the dashboard
    // sampling rate affects mobile too. Decided once here; if sampled out we
    // create no session and tell the SDK not to record (full shape with
    // `record:false` so both SDKs decode it cleanly). alwaysRecordIdentified
    // keeps the session when the host already knows the user (distinctId sent
    // at start). alwaysRecordErrors can't apply at start (no errors yet).
    const sampling = await this.settings.getSampling(workspaceId);
    const isIdentified = !!params.distinctId?.trim();
    const sampledIn =
      (sampling.alwaysRecordIdentified && isIdentified) ||
      Math.random() <= sampling.samplingRate;
    if (!sampledIn) {
      return {
        record: false,
        token: "",
        sessionID: "",
        fps: 0,
        quality: "",
        framesSupport: false,
        projectID: String(workspaceId),
        userUUID: params.userUUID ?? "",
        captureConsole: false,
        captureNetwork: false,
        captureNetworkHeaders: false,
        captureNetworkBodies: false,
      };
    }

    // Dashboard-controlled capture settings (same source the web SDK reads
    // via /v1/sdk/config) so the mobile SDK honours console/network toggles.
    const rec = await this.settings.getRecording(workspaceId);

    const publicId = `ses_${randomBytes(8).toString("hex")}`;
    const startedAt =
      params.timestamp && params.timestamp > 0
        ? new Date(params.timestamp)
        : new Date();
    const platform =
      (params.platform ?? "").toLowerCase() === "android" ? "android" : "ios";

    // Device + geo context the SDK already sends at /start but which the
    // server previously discarded (RAM, timezone, OS) or never derived
    // (country/city, from IP). Stash under a reserved `$device` key so it
    // rides the existing `customProps` Json column (no migration) and the
    // Properties tab — which skips `$`-prefixed keys — never shows it raw.
    // `deviceMemory` arrives in KB (iOS: physicalMemory/1024); normalise to MB.
    let geo = resolveGeo(clientIp);
    if (!geo.country) {
      // IP geo missed — a private/dev IP, or a carrier-NAT / VPN exit that
      // geoip can't place. Fall back to what the device itself reports about
      // where it is (its region/locale), so a mobile session still shows a
      // country. This only fills the null fields; a real IP hit always wins.
      const dev = deviceGeoFallback({
        regionCode: params.regionCode,
        language: params.language,
        timezoneId: params.timezoneId,
        timezone: params.timezone,
      });
      geo = { ...geo, country: dev.country, flag: dev.flag };
    }
    const deviceProps = {
      $device: {
        model: params.userDevice ?? null,
        type: params.userDeviceType ?? null,
        ramMb: params.deviceMemory
          ? Math.round(params.deviceMemory / 1024)
          : null,
        osVersion: params.userOSVersion ?? null,
        timezone: params.timezone ?? null,
        connectionType: params.connectionType ?? null,
        city: geo.city,
        country: geo.country,
        flag: geo.flag,
      },
    };

    // Every native session gets an EndUser — the mobile analog of the web
    // fingerprint "ghost" (see replay-persistence.service.ts). Keyed on the SDK's
    // persistent install id so multiple sessions from one install collapse onto
    // one anonymous user; an identify() later re-keys + claims them (linkEndUser).
    // Without this, anonymous mobile sessions showed "Anonymous" with no Users
    // row — a gap the web path never had.
    const facts = mobileDeviceFacts({
      platform,
      deviceType: params.userDeviceType,
      deviceModel: params.userDevice,
      osVersion: params.userOSVersion,
    });
    const anonDistinctId =
      params.distinctId?.trim() ||
      params.userUUID?.trim() ||
      `anon_${publicId.slice(0, 16)}`;
    const endUser = await this.ensureAnonEndUser(workspaceId, anonDistinctId, {
      os: platform === "ios" ? "iOS" : "Android",
      osVersion: params.userOSVersion ?? null,
      device: facts.device,
    });

    const session = await this.db.session.create({
      data: {
        publicId,
        customProps: deviceProps,
        workspaceId,
        endUserId: endUser.id,
        // Persistent install/device id (the SDK's anonymous id). Stamped on
        // every session so identify() can later claim it if it's still
        // anonymous (see linkEndUser's retroactive reassignment).
        anonymousId: params.userUUID ?? null,
        status: "LIVE",
        startedAt,
        endedAt: startedAt,
        platform,
        // Per-session device facts, promoted out of the $device blob onto real
        // columns so a user's devices are queryable (EndUser's copies are
        // last-write-wins across web + mobile). Normalised through the shared
        // helper so native rows speak the same vocabulary as web ones.
        ...facts,
        // Geo for THIS session, already resolved from its own IP above — so a
        // user who travels doesn't have their whole history re-labelled with
        // wherever they were seen last.
        city: geo.city,
        state: geo.state,
        country: geo.country,
        flag: geo.flag,
        timezone: params.timezone ?? null,
        ip: clientIp ?? null,
        // A wrapper SDK (React Native / Flutter) keeps the ios/android platform
        // but refines sdkName so the dashboard can show "Captured by …".
        sdkName:
          params.framework === "react-native"
            ? "replay-react-native"
            : params.framework === "flutter"
              ? "replay-flutter"
              : platform === "android"
                ? "replay-android"
                : "replay-ios",
        sdkVersion: params.trackerVersion ?? null,
        // Marketing version → appVersion (the preferred release identifier);
        // build number (revID) → appBuild. Release = COALESCE(appVersion, …).
        appVersion: params.appVersion || null,
        appBuild: params.revID ?? null,
        startUrl: params.userDevice
          ? `app://${humanizeDeviceModel(params.userDevice)}`
          : null,
        viewport:
          params.width && params.height
            ? `${params.width}x${params.height}`
            : null,
      },
      select: { id: true, publicId: true, startedAt: true },
    });

    const payload: MobileTokenPayload = {
      sid: session.publicId,
      snum: session.id,
      wid: workspaceId,
      startedAt: session.startedAt.getTime(),
    };

    return {
      record: true,
      token: signMobileToken(payload),
      sessionID: session.publicId,
      // Per-workspace (or MOBILE_FPS/MOBILE_QUALITY env-default) capture
      // settings — same `rec` recording config the console/network toggles
      // above read from.
      fps: rec.mobileFps,
      quality: rec.mobileQuality,
      framesSupport: true,
      projectID: String(workspaceId),
      userUUID: params.userUUID ?? randomBytes(8).toString("hex"),
      captureConsole: rec.captureConsole,
      captureNetwork: rec.captureNetwork,
      captureNetworkHeaders: rec.captureNetworkHeaders,
      captureNetworkBodies: rec.captureNetworkBodies,
    };
  }

  private async resolveWorkspace(projectKey?: string): Promise<number | null> {
    if (!projectKey) return null;
    const keyHash = createHash("sha256").update(projectKey).digest("hex");
    const cached = await this.apiKeys.lookup(keyHash);
    return cached?.workspaceId ?? null;
  }

  // ── /v1/mobile/i + /late (message batch) ───────────────────────────
  /**
   * Decode a (gzipped) binary message batch and persist each message
   * as a ClickHouse projection row, then bump the session aggregates.
   * `gzipped` is false for the /late endpoint.
   */
  async ingestMessages(
    token: MobileTokenPayload,
    body: Buffer,
    gzipped: boolean,
  ): Promise<{ count: number }> {
    const raw = gzipped ? gunzipSync(body) : body;
    const { messages } = decodeMobileBatch(raw);
    if (messages.length === 0) return { count: 0 };

    // Resolve this session's release once (marketing appVersion preferred, then
    // revId, then the appBuild build number). Stamped onto every CH row below so
    // Release Intelligence's per-release latency works for mobile, like web.
    const sessRow = await this.db.session.findUnique({
      where: { id: token.snum },
      select: {
        appVersion: true,
        revId: true,
        appBuild: true,
        durationMs: true,
      },
    });
    const release =
      sessRow?.appVersion || sessRow?.revId || sessRow?.appBuild || "";

    // Session duration = the furthest message offset seen (message ts − session
    // start, BOTH client-clock, so device clock skew cancels — unlike
    // endedAt−startedAt, which mixes the client startedAt with the server-side
    // endedAt). This is the ONLY duration a frameless mobile session gets: with
    // no captured frames the frames finalizer computes 0, which would show 0:00
    // AND look like a sub-threshold throwaway to the billing reaper. Monotonic:
    // GREATEST with the stored value so an out-of-order/retried batch can't
    // shrink it.
    const maxOffsetMs = messages.reduce(
      (mx, m) => Math.max(mx, m.timestamp - token.startedAt),
      0,
    );

    const rows: ProjectionRow[] = [];
    let currentRoute = "";
    const agg = {
      tap: 0,
      console: 0,
      network: 0,
      error: 0,
      screen: 0,
      rage: 0,
    };
    // Identify stream: `userId`(94) carries the distinct id and each
    // `metadata`(92) carries one property. Collected across the batch, then
    // folded into an EndUser once after persisting (see linkEndUser).
    let distinctId: string | null = null;
    const identifyProps: Record<string, string> = {};
    // Tap-rage detector — faithful to the reference heuristics service: 3+ taps
    // on the same label, each >300ms after the previous, is one rage episode.
    // State is batch-local (rage taps cluster in time, so they land in one
    // batch); a streak still open at batch end is finalized below.
    const TAP_TIME_DIFF = 300;
    const MIN_TAPS_IN_A_ROW = 3;
    const rageState = { firstTs: 0, lastTs: 0, lastLabel: "", count: 0 };
    const flushRage = () => {
      if (rageState.count >= MIN_TAPS_IN_A_ROW) {
        agg.rage += 1;
        // Emit a tap_rage marker (a `custom` row tagged level=rage) anchored at
        // the first tap of the streak, so the burst shows on the player
        // timeline + Events panel — the reference's tap_rage issue event.
        const offsetMs = Math.max(0, rageState.firstTs - token.startedAt);
        rows.push({
          ...this.emptyRow(
            token,
            {
              kind: "rage",
              timestamp: rageState.firstTs,
            } as unknown as DecodedMobileMessage,
            offsetMs,
          ),
          kind: "custom",
          level: "rage",
          message: rageState.lastLabel
            ? `Rage tap ×${rageState.count} on ${rageState.lastLabel}`
            : `Rage tap ×${rageState.count}`,
          ui_value: rageState.lastLabel,
          route: currentRoute,
          raw: JSON.stringify({
            count: rageState.count,
            label: rageState.lastLabel,
          }),
        });
      }
      rageState.firstTs = 0;
      rageState.lastTs = 0;
      rageState.lastLabel = "";
      rageState.count = 0;
    };

    for (const m of messages) {
      const offsetMs = Math.max(0, m.timestamp - token.startedAt);
      const base = this.emptyRow(token, m, offsetMs);
      switch (m.kind) {
        case "click":
        case "swipe": {
          // Drop taps whose only label is a framework/system view (keyboard,
          // cursor / input accessory, the Flutter / RN engine hosts). These
          // aren't real app interactions; counting them inflates tap stats and
          // can trigger phantom tap-rage. Same denylist as screen filtering.
          if (this.isSystemUiName(m.label)) break;
          agg.tap += 1;
          // Tap-rage: taps only (the reference detector ignores swipes).
          if (m.kind === "click") {
            if (
              rageState.lastTs + TAP_TIME_DIFF < m.timestamp &&
              rageState.lastLabel === m.label
            ) {
              rageState.lastTs = m.timestamp;
              rageState.count += 1;
            } else {
              flushRage();
              if (m.label !== "") {
                rageState.firstTs = m.timestamp;
                rageState.lastTs = m.timestamp;
                rageState.lastLabel = m.label;
                rageState.count = 1;
              }
            }
          }
          rows.push({
            ...base,
            kind: "tap",
            ui_value: m.label,
            point_x: m.x,
            point_y: m.y,
            gesture:
              m.kind === "swipe"
                ? `swipe_${(m as { direction: string }).direction}`
                : "tap",
            route: currentRoute,
            raw: JSON.stringify(m),
          });
          break;
        }
        case "gesture": {
          // Advanced gestures (long_press / double_tap / pinch). Same tap row
          // shape, but the gesture variant carries through so the dashboard
          // renders a distinct icon (it keys taps off the `gesture` field).
          if (this.isSystemUiName(m.label)) break;
          agg.tap += 1;
          rows.push({
            ...base,
            kind: "tap",
            ui_value: m.label,
            point_x: m.x,
            point_y: m.y,
            gesture: m.gestureKind,
            route: currentRoute,
            raw: JSON.stringify(m),
          });
          break;
        }
        case "input":
          rows.push({
            ...base,
            kind: "custom",
            level: "input",
            message: m.label,
            raw: JSON.stringify({
              value: m.value,
              masked: m.valueMasked,
              label: m.label,
            }),
            route: currentRoute,
          });
          break;
        case "performance":
          rows.push({
            ...base,
            kind: "perf",
            method: m.name,
            duration_ms: m.value,
            message: "",
            raw: JSON.stringify(m),
            route: currentRoute,
          });
          break;
        case "log":
          agg.console += 1;
          rows.push({
            ...base,
            kind: "console",
            level: m.severity || "log",
            message: m.content,
          });
          break;
        case "internalError":
          agg.error += 1;
          rows.push({
            ...base,
            kind: "error",
            error: "internal",
            message: m.content,
          });
          break;
        case "crash":
          agg.error += 1;
          rows.push({
            ...base,
            kind: "error",
            error: "crash",
            message: `${m.name}: ${m.reason}`.slice(0, 400),
            stack: m.stacktrace,
            raw: JSON.stringify(m),
          });
          break;
        case "networkCall": {
          agg.network += 1;
          // The wire packs each side as one JSON blob `{headers, body}`.
          // Split into the dedicated header/body columns the dashboard reads
          // so the Headers tab shows headers and Payload/Response show bodies.
          const req = this.splitNetworkSide(m.request);
          const res = this.splitNetworkSide(m.response);
          rows.push({
            ...base,
            kind: "network",
            method: m.method,
            url: m.url,
            status_code: m.status,
            duration_ms: m.duration,
            request_headers: req.headers,
            response_headers: res.headers,
            request_body: req.body,
            response_body: res.body,
          });
          break;
        }
        case "viewComponent":
          // Native auto-screen-detection fires on every UIViewController /
          // Activity transition, which includes framework containers — the
          // keyboard stack, scroll-tracking windows, react-native-screens
          // hosts. Those aren't app screens; dropping them here keeps both the
          // screen list AND the `pageCount` badge to real screens, for ALL
          // SDKs. Real route names (RN trackScreens / Flutter nav observer)
          // pass straight through.
          if (m.visible && !this.isSystemUiName(m.screenName)) {
            agg.screen += 1;
            currentRoute = m.screenName || currentRoute;
            rows.push({
              ...base,
              kind: "screen",
              level: "screen",
              message: m.screenName,
              route: currentRoute,
            });
          }
          break;
        case "event": {
          // JS/Dart SDKs forward console logs + uncaught errors as reserved
          // track events ($console / $exception) so the wire keeps a single
          // event type. Route them into the dedicated console/error streams the
          // Console + Crashes tabs read, instead of burying them as generic
          // custom events (which is why the Console tab showed 0).
          if (m.name === "$console" || m.name === "$exception") {
            let p: {
              level?: string;
              message?: string;
              stack?: string;
              fatal?: boolean;
            } = {};
            try {
              p = JSON.parse(m.payload || "{}");
            } catch {
              /* malformed payload — fall through with empty fields */
            }
            if (m.name === "$console") {
              agg.console += 1;
              rows.push({
                ...base,
                kind: "console",
                level: p.level || "log",
                message: (p.message ?? "").slice(0, 4000),
                route: currentRoute,
              });
            } else {
              agg.error += 1;
              rows.push({
                ...base,
                kind: "error",
                error: p.fatal ? "crash" : "exception",
                message: (p.message ?? "").slice(0, 400),
                stack: p.stack ?? "",
                route: currentRoute,
              });
            }
          } else {
            rows.push({
              ...base,
              kind: "custom",
              level: "track",
              message: m.name,
              raw: m.payload || JSON.stringify(m),
              route: currentRoute,
            });
          }
          break;
        }
        case "userId":
          if (m.id) distinctId = m.id;
          break;
        case "metadata":
          if (m.key) identifyProps[m.key] = m.value;
          break;
        // userAnonymousId / screenChanges / batchMeta are session-level or
        // framing — not per-event rows.
        default:
          break;
      }
    }

    // Finalize any tap-rage streak still open at the end of the batch.
    flushRage();

    // Stamp the resolved release onto every row (emptyRow defaults it to "").
    if (release) for (const r of rows) r.release = release;
    // CH is best-effort on the inline /i path too (the Mongo/frames copy is the
    // durable backstop, nightly backfill re-derives). Swallow insert failures so
    // one batch's CH error — including a co-batched flush rejection now that
    // inserts are coalesced — can't 500 this request or, worse, an unrelated
    // session's request sharing the same flush window. The session-counter
    // update below still runs.
    if (rows.length > 0) {
      try {
        await insertProjectionRows(rows);
      } catch (e) {
        process.stderr.write(
          `mobile CH insert failed for session ${token.snum}: ${(e as Error).message}\n`,
        );
      }
    }

    await this.db.session.update({
      where: { id: token.snum },
      data: {
        tapCount: { increment: agg.tap },
        consoleCount: { increment: agg.console },
        networkCount: { increment: agg.network },
        errorCount: { increment: agg.error },
        pageCount: { increment: agg.screen },
        rageCount: { increment: agg.rage },
        // Count the message-batch bytes toward storage too (frames are the
        // bulk; this keeps the message stream accounted for as well).
        dataSizeBytes: { increment: BigInt(raw.length) },
        endedAt: new Date(),
        // Grow the duration to the furthest activity offset in this batch; never
        // shrink it (Math.max vs the value read above). Serial per session, so
        // this read-modify-write can't lose ground.
        durationMs: Math.max(Number(sessRow?.durationMs ?? 0), maxOffsetMs),
      },
    });
    this.stats
      .bump(token.wid, { storageBytes: BigInt(raw.length) })
      .catch(() => {});

    // Keep the session "live" in the Redis presence sets (online people + live
    // sessions) — the mobile counterpart of the web accept path
    // (replay-ingest.service.ts:108). Fire-and-forget: presence is best-effort
    // and must never fail an accepted batch. The anon fallback mirrors web's
    // `anon_<sid>` member so anonymous mobile traffic is counted consistently.
    void this.presence
      .touch(
        token.wid,
        token.sid,
        distinctId ?? `anon_${token.sid.slice(0, 16)}`,
        Date.now(),
      )
      .catch(() => {});

    if (distinctId || Object.keys(identifyProps).length > 0) {
      await this.linkEndUser(token, distinctId, identifyProps);
      // Snapshot the non-identity props onto THIS session too (see
      // common/session-props.ts for why session-scoped, not just on EndUser).
      // plan/email/name are promoted to EndUser columns, so they're excluded
      // here to match EndUser.customProps semantics.
      const { plan, email, name, ...rest } = identifyProps;
      void plan;
      void email;
      void name;
      await mergeSessionCustomProps(this.db, token.snum, rest);
    }

    return { count: rows.length };
  }

  /** Ensure an anonymous "ghost" EndUser exists for a native install, keyed on
   *  the SDK's persistent install id — the mobile analog of the web fingerprint
   *  ghost (replay-persistence.service.ts). Called at /start so every mobile
   *  session has a user; harmless on re-start (upsert just bumps
   *  isOnline/lastSeenAt). `usersTotal` bumps only on true first creation. An
   *  identify() later upserts on the REAL distinctId and reassigns this install's
   *  sessions off the ghost — see linkEndUser's retroactive claim. */
  private async ensureAnonEndUser(
    workspaceId: number,
    distinctId: string,
    facts: { os: string | null; osVersion: string | null; device: string | null },
  ): Promise<{ id: number }> {
    const pre = await this.db.endUser.findUnique({
      where: { workspaceId_distinctId: { workspaceId, distinctId } },
      select: { id: true },
    });
    const row = await this.db.endUser.upsert({
      where: { workspaceId_distinctId: { workspaceId, distinctId } },
      create: {
        workspaceId,
        distinctId,
        os: facts.os,
        osVersion: facts.osVersion,
        device: facts.device,
        isOnline: true,
        lastSeenAt: new Date(),
      },
      update: {
        isOnline: true,
        lastSeenAt: new Date(),
        os: facts.os ?? undefined,
        osVersion: facts.osVersion ?? undefined,
        device: facts.device ?? undefined,
      },
      select: { id: true },
    });
    if (!pre) this.stats.bump(workspaceId, { usersTotal: 1 }).catch(() => {});
    return row;
  }

  /**
   * Resolve / create the EndUser for an identified mobile session and link the
   * session to it. Mirrors the web `upsertEndUser` core — upsert on
   * (workspaceId, distinctId) and bump `usersTotal` only on first creation —
   * but sourced from the mobile identify stream: `userId`(94) is the distinct
   * id and each `metadata`(92) is one property. `plan`/`email`/`name` are
   * promoted to their own columns; everything else lands in `customProps`.
   * Device / os come from the session row the SDK opened at `/start`.
   */
  private async linkEndUser(
    token: MobileTokenPayload,
    distinctId: string | null,
    props: Record<string, string>,
  ): Promise<void> {
    const hasProps = Object.keys(props).length > 0;

    // Metadata with no user id in this batch: fold it into the session's
    // already-linked user if there is one; otherwise there's nothing to key on.
    if (!distinctId) {
      if (!hasProps) return;
      const s = await this.db.session.findUnique({
        where: { id: token.snum },
        select: { endUserId: true },
      });
      if (!s?.endUserId) return;
      await this.db.endUser.update({
        where: { id: s.endUserId },
        data: { customProps: props, isOnline: true, lastSeenAt: new Date() },
      });
      return;
    }

    // Promote well-known keys to columns; the rest stay as custom properties.
    const { plan, email, name, ...rest } = props;
    const initials = name
      ? name
          .split(" ")
          .map((p) => p[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      : undefined;
    const hasRest = Object.keys(rest).length > 0;

    const sess = await this.db.session.findUnique({
      where: { id: token.snum },
      select: {
        platform: true,
        device: true,
        anonymousId: true,
        customProps: true,
      },
    });
    const os =
      sess?.platform === "ios"
        ? "iOS"
        : sess?.platform === "android"
          ? "Android"
          : undefined;
    // EndUser.device is the device TYPE ("Mobile"/"Tablet"/"Desktop"), the same
    // vocabulary the web path writes — so a `device = Mobile` cohort/funnel
    // filter matches native users too. (It previously stored the raw hardware
    // model from the `app://<model>` startUrl, e.g. "iPhone18,3", so those
    // filters matched nothing.) The raw model lives on Session.deviceModel.
    const device = sess?.device ?? undefined;
    // OS version rides on the session's $device metadata (stamped at /start
    // from the SDK's userOSVersion) — promote it to a queryable EndUser column.
    const osVersion =
      (
        (sess?.customProps as { $device?: { osVersion?: string } } | null)
          ?.$device?.osVersion ?? undefined
      ) || undefined;

    // Pre-check existence so `usersTotal` bumps only on real first creation,
    // and read the current customProps so new properties MERGE instead of
    // clobbering earlier ones (assigning a Json column replaces the whole blob).
    const preExisting = await this.db.endUser.findUnique({
      where: { workspaceId_distinctId: { workspaceId: token.wid, distinctId } },
      select: { id: true, customProps: true },
    });
    const mergedProps = {
      ...((preExisting?.customProps as Record<string, string> | null) ?? {}),
      ...rest,
    };

    const row = await this.db.endUser.upsert({
      where: { workspaceId_distinctId: { workspaceId: token.wid, distinctId } },
      create: {
        workspaceId: token.wid,
        distinctId,
        email,
        name,
        initials,
        plan,
        os,
        osVersion,
        device,
        customProps: rest,
        isOnline: true,
        lastSeenAt: new Date(),
      },
      update: {
        email: email ?? undefined,
        name: name ?? undefined,
        initials: initials ?? undefined,
        plan: plan ?? undefined,
        os: os ?? undefined,
        osVersion: osVersion ?? undefined,
        device: device ?? undefined,
        customProps: hasRest ? mergedProps : undefined,
        isOnline: true,
        lastSeenAt: new Date(),
      },
      select: { id: true },
    });

    if (!preExisting) {
      this.stats.bump(token.wid, { usersTotal: 1 }).catch(() => {});
    }

    await this.db.session.update({
      where: { id: token.snum },
      data: { endUserId: row.id },
    });

    // identify() set/changed this user's attributes (plan/name/device/os/…), so
    // re-evaluate attribute cohorts. O(1) dirty-mark; the drainer applies the
    // membership deltas. (This is the mobile counterpart of the web hook — it
    // only fires on identify, so it's inherently change-gated.)
    this.cohorts.markUsersDirty(token.wid, [row.id]).catch(() => {});

    // Retroactively claim this user's EARLIER anonymous sessions — same
    // persistent install id, not yet linked to anyone — so identifying surfaces
    // their full pre-identify journey, not just this session. One set-based
    // UPDATE over the indexed (workspaceId, anonymousId) range; never an N+1.
    // Claim BOTH never-linked sessions AND those still pinned to the anonymous
    // ghost (its distinctId == the install id) — now that /start attaches every
    // session to that ghost, the old `endUserId: null` filter alone would match
    // nothing. Sessions already claimed by a DIFFERENT identified user (account
    // switch on the same install) are left untouched.
    if (sess?.anonymousId && sess.anonymousId !== distinctId) {
      await this.db.session.updateMany({
        where: {
          workspaceId: token.wid,
          anonymousId: sess.anonymousId,
          OR: [
            { endUserId: null },
            { endUser: { is: { distinctId: sess.anonymousId } } },
          ],
        },
        data: { endUserId: row.id },
      });
    }
  }

  /**
   * True for framework/system view classes that native auto-detection surfaces
   * but which are NOT app screens OR meaningful tap targets — UIKit keyboard /
   * input / cursor / tracking / container classes (`UI…`, `_UI…`), the
   * react-native-screens host classes (`RNS…`), React Native internals
   * (`RCT…`), and the Flutter engine view hosts (`FlutterView`,
   * `FlutterSurfaceView`, `FlutterViewController`, …). Real app screens and
   * tap targets never use these prefixes (a custom screen is
   * `HomeViewController`, `GameActivity`, or a route like `/home`; a real tap
   * resolves to a button title / label / testID), so a prefix denylist cleanly
   * separates noise from signal across every SDK — for both screens and taps.
   */
  private isSystemUiName(name: string | undefined): boolean {
    if (!name || !name.trim()) return true;
    return (
      /^_?UI[A-Z]/.test(name) ||
      /^RNS/.test(name) ||
      /^RCT/.test(name) ||
      /^Flutter/.test(name)
    );
  }

  /**
   * Mobile network captures arrive as one JSON blob per side —
   * `{headers, body}` — in the wire's `request`/`response` strings. Split
   * into the dedicated header/body columns the dashboard reads. Falls back to
   * treating the whole blob as the body when it isn't the `{headers, body}`
   * shape (opaque payloads / older SDK builds), so nothing is lost.
   */
  private splitNetworkSide(raw: string | undefined): {
    headers: string;
    body: string;
  } {
    const s = (raw ?? "").slice(0, 8000);
    if (!s) return { headers: "", body: "" };
    try {
      const parsed = JSON.parse(s);
      if (
        parsed &&
        typeof parsed === "object" &&
        ("headers" in parsed || "body" in parsed)
      ) {
        const headers =
          parsed.headers && typeof parsed.headers === "object"
            ? JSON.stringify(parsed.headers)
            : "";
        const body =
          parsed.body == null
            ? ""
            : typeof parsed.body === "string"
              ? parsed.body
              : JSON.stringify(parsed.body);
        return { headers, body };
      }
    } catch {
      /* not JSON — treat the whole blob as the body */
    }
    return { headers: "", body: s };
  }

  private emptyRow(
    token: MobileTokenPayload,
    m: DecodedMobileMessage,
    offsetMs: number,
  ): ProjectionRow {
    return {
      workspace_id: token.wid,
      session_id: token.snum,
      session_public_id: token.sid,
      sequence: 0,
      event_id: `${m.kind}-${m.timestamp}-${randomBytes(3).toString("hex")}`,
      event_type: m.kind,
      kind: "custom",
      timestamp: m.timestamp,
      offset_ms: offsetMs,
      level: "",
      message: "",
      method: "",
      url: "",
      status_code: 0,
      duration_ms: 0,
      error: "",
      stack: "",
      raw: "",
      request_headers: "",
      response_headers: "",
      request_body: "",
      response_body: "",
      connection_rtt: 0,
      connection_effective_type: "",
      ui_class: "",
      ui_value: "",
      ui_id: "",
      ui_type: "",
      bounds_x: 0,
      bounds_y: 0,
      bounds_w: 0,
      bounds_h: 0,
      point_x: 0,
      point_y: 0,
      is_sensitive: 0,
      gesture: "",
      pinch_scale_x1000: 0,
      route: "",
      // Default ""; ingestMessages resolves the session's release once and
      // stamps it onto every row before insert (so mobile per-release latency
      // works too).
      release: "",
    };
  }

  // ── /v1/mobile/images (frames batch) ───────────────────────────────
  /**
   * Append a `[ts][size][jpeg]` frames batch to the session's Redis stream —
   * the ingest hot path. Redis-only and non-blocking (XADD + ZADD in one
   * round-trip): NO disk, NO R2, NO Postgres. Count / size / duration
   * accounting is computed by the stream worker as it drains the session and
   * written to Postgres once at finalize, so this path stays <10ms and any
   * ingest node can serve any batch (the request carries no server state).
   */
  async appendFrames(
    token: MobileTokenPayload,
    gzBatch: Buffer,
  ): Promise<{ bytes: number }> {
    // The cap is enforced HERE too, not just at /start. This endpoint carries
    // the frame bytes, and a session token minted before the cap (or replayed by
    // an unofficial client) would otherwise keep uploading archives against
    // an exhausted allowance. Same ~60s-cached read as the other gates, so the
    // hot-path cost matches /start's. Billing is Enterprise Edition — undefined
    // in the open-source build → uploads unlimited.
    if (this.billing && (await this.billing.shouldNotRecord(token.wid))) {
      return { bytes: 0 };
    }
    let batchRaw: Buffer;
    try {
      batchRaw = gunzipSync(gzBatch);
    } catch {
      // Some clients may send the raw frames uncompressed.
      batchRaw = gzBatch;
    }
    if (batchRaw.length < 12) return { bytes: 0 };

    // Stream stores the DECODED raw bytes so the worker reads a self-describing
    // archive (it re-derives count/lastTs via the shared codec).
    await this.frames.append(token.sid, batchRaw, Date.now());

    // A native replay session is frame-driven — it can flush /images for long
    // stretches with no /i message batch, so presence must be touched here too or
    // a quietly-recording session would drop out of "live". This endpoint carries
    // only the token, so the user member uses the install's anon key (identified
    // sessions still get their real distinctId from the /i touch). Fire-and-forget.
    void this.presence
      .touch(token.wid, token.sid, `anon_${token.sid.slice(0, 16)}`, Date.now())
      .catch(() => {});

    return { bytes: batchRaw.length };
  }

  // ── /v1/mobile/late (terminate beacon → session end) ───────────────
  /**
   * The SDK sends /late when the app backgrounds / terminates, AFTER it has
   * flushed the final frames batch — the in-order end-of-session signal. We
   * just mark the session ended NOW (drop its expiry score into the past); the
   * worker/finalizer completes the R2 archive on its next tick (~1s) and HEADs
   * the object so it's available when the dashboard first requests it. No
   * synchronous packing on the request path.
   */
  async endSession(token: MobileTokenPayload): Promise<void> {
    await this.frames.markEnded(token.sid, Date.now());
  }

  /**
   * Discard the current session (POST /v1/mobile/cancel). The mobile engine
   * streams batches live, so — unlike a deferred-upload model where cancel is a
   * pure on-device delete — the SDK asks the server to DROP what already landed.
   * We delete the Redis frames stream (the visual recording, the privacy-
   * sensitive part) so it never packs to R2, and finalize the session to empty.
   *
   * Scope note: the Postgres Session row + already-ingested ClickHouse events
   * remain (the session shows as a short/empty recording). A FULLER purge that
   * also hides the row + deletes its events is a follow-up requiring a
   * `droppedAt` / CANCELLED-status column — deliberately deferred so this path
   * needs no schema migration. Idempotent + best-effort.
   */
  async cancelSession(token: MobileTokenPayload): Promise<void> {
    await this.frames.drop(token.sid, Date.now());
  }
}
