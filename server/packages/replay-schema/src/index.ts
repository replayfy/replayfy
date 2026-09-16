export type ReplayPlatform =
  | "web"
  | "react"
  | "nextjs"
  | "react_native"
  | "android"
  | "ios";

export type ReplayEventType =
  | "session_start"
  | "session_end"
  | "full_snapshot"
  | "incremental_snapshot"
  | "input"
  | "pointer"
  | "scroll"
  | "viewport"
  | "navigation"
  | "console"
  | "network"
  | "error"
  | "performance"
  | "custom"
  // Native (iOS / Android / Flutter / RN) only. Web SDK never emits these.
  | "tap"
  | "native_snapshot";

export interface ReplayBatchEnvelope {
  projectId?: string;
  sessionId: string;
  segmentId: string;
  sequence: number;
  sentAt: number;
  sdk: ReplaySdkDescriptor;
  page: ReplayPageContext;
  events: ReplayEvent[];
}

export interface ReplaySdkDescriptor {
  name: string;
  version: string;
  platform: ReplayPlatform;
  /**
   * Customer's HOST APP version — distinct from `version` (which is
   * the SDK's own version). Used by the backend symbolication
   * service to pick the correct `mapping.txt` (Android R8) or
   * unstripped `.so` debug symbols (NDK) when deobfuscating crash
   * stacks from this batch.
   *
   * `appVersion` is the marketing version (Android `versionName`,
   * iOS `CFBundleShortVersionString`). `appBuild` is the integer
   * build number (Android `versionCode`, iOS `CFBundleVersion`).
   * Both are optional — present on every native batch from SDK
   * 0.0.2+; older SDKs and the web SDK omit them.
   */
  appVersion?: string;
  appBuild?: string;
  /**
   * Web build / revision id from `ReplayConfig.revId` — lets a funnel or
   * session search scope to a specific deployed build. Omitted by native
   * SDKs (they use appVersion/appBuild) and by older web SDKs.
   */
  revId?: string;
}

export interface ReplayPageContext {
  url: string;
  title?: string;
  referrer?: string;
  userAgent: string;
  viewport: ViewportDimensions;
  timezone?: string;
  language?: string;
  screen?: ViewportDimensions;
}

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface ReplayEvent<TData = unknown> {
  id: string;
  ts: number;
  offsetMs: number;
  type: ReplayEventType;
  source: ReplayPlatform;
  data: TData;
}

export interface SessionStartEventData {
  href: string;
  path: string;
  referrer: string;
}

export interface SessionEndEventData {
  reason: "manual" | "unload" | "visibility_hidden";
}

export interface SnapshotEventData {
  recorder: "rrweb";
  rrwebEvent: unknown;
}

export interface ConsoleEventData {
  level: "log" | "info" | "warn" | "error" | "debug";
  message: string;
  args: unknown[];
  stack?: string;
}

export interface NetworkEventData {
  requestId: string;
  transport: "fetch" | "xhr" | "beacon";
  method: string;
  url: string;
  statusCode?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  ok?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  error?: string;
  /** Round-trip time the browser estimates for the active connection. */
  connectionRtt?: number;
  /** Coarse network type — '4g', '3g', etc. — from navigator.connection. */
  connectionEffectiveType?: string;
}

export interface ErrorEventData {
  message: string;
  stack?: string;
  kind: "error" | "unhandledrejection";
  /** True when reported via the web SDK's public captureException (a developer-
   *  CAUGHT error) rather than an uncaught window error/rejection. Classifies the
   *  row as an "exception" vs an uncaught "crash", mirroring mobile's `fatal`. */
  handled?: boolean;
  /** Optional contextual tags from captureException (route, componentStack, …).
   *  Stored in the projected row's `raw` JSON for dashboard display + grouping. */
  metadata?: Record<string, unknown>;
}

export interface NavigationEventData {
  from?: string;
  to: string;
  /** document.title at view time — the human screen name (web SDK). */
  title?: string;
  // On web: history-stack triggers. On native: app-routing triggers.
  trigger:
    | "pushState"
    | "replaceState"
    | "popstate"
    | "hashchange"
    | "load"
    | "screen_appeared"
    | "screen_dismissed"
    | "deep_link";
}

/**
 * One captured tap/gesture on a native (iOS/Android/Flutter/RN) screen.
 * See replay-web-sdk/docs/native-snapshot-format.md for the full design.
 */
export interface TapEventData {
  bounds: { x: number; y: number; w: number; h: number };
  point: { x: number; y: number };
  route: string;
  uiClass: string;
  uiType:
    | "button"
    | "field"
    | "compound"
    | "text"
    | "image"
    | "container"
    | "unknown";
  uiValue: string;
  uiId: string;
  isSensitive: boolean;
  /**
   * Gesture kind. Default "tap" for backwards compatibility with
   * existing payloads. Advanced gestures shipped when the customer
   * calls `Replay.enableAdvancedGestureRecognizer(true)`:
   *
   *   - "long_press" — held longer than the platform's long-press
   *     threshold (~500 ms Android, ~500 ms iOS default).
   *   - "swipe_left" / "swipe_right" / "swipe_up" / "swipe_down" —
   *     fling / pan with detectable direction. Direction encoded in
   *     the variant rather than a separate field so the dashboard
   *     can filter by `gesture === "swipe_up"` without parsing a
   *     compound shape.
   *   - "pinch" — two-finger pinch / zoom. `pinchScale` carries the
   *     final scale factor (1.0 = no change, >1 = zoom in, <1 = out).
   */
  gesture?:
    | "tap"
    | "long_press"
    | "swipe_left"
    | "swipe_right"
    | "swipe_up"
    | "swipe_down"
    | "pinch";
  /** Final scale factor for "pinch" gestures (omitted otherwise). */
  pinchScale?: number;
}

/**
 * View-tree snapshot emitted on screen transition or 500ms idle.
 * NOT every frame — player interpolates from sparse snapshots plus
 * tap events. (Legacy view-tree path; the current SDKs stream a
 * per-session screenshot bundle over the binary /v1/mobile/* protocol
 * instead. Image bytes for this path were uploaded out-of-band by hash.)
 */
export interface NativeSnapshotEventData {
  recorder: "native";
  width: number;
  height: number;
  pixelRatio: number;
  trigger: "screen_appeared" | "idle" | "tap" | "manual";
  root: NativeViewNode;
}

export interface NativeViewNode {
  id: string;
  type:
    | "button"
    | "field"
    | "compound"
    | "text"
    | "image"
    | "container"
    | "unknown";
  className?: string;
  bounds: { x: number; y: number; w: number; h: number };
  text?: string;
  imageRef?: string;
  backgroundColor?: string;
  opacity?: number;
  occluded?: boolean;
  ariaLabel?: string;
  children?: NativeViewNode[];
}

/**
 * Performance metric envelope. Same shape for web and native — only
 * metric names differ. Web: lcp/cls/inp/fcp/ttfb/long_task/memory.
 * Native: cold_start_ms / time_to_first_meaningful_render_ms /
 * tap_response_ms / first_network_ttfb_ms / frame_drop_pct /
 * frozen_frame_count / anr_count / memory_rss_mb / thermal_state /
 * battery_drain_pct_per_min. See mobile-vitals-matrix.md.
 */
/**
 * `type: "custom"` payload — used by mobile SDKs (and the future
 * web one) for `Replay.track()` plus the dashboard-promoted
 * variants (`bug_report`, `session_property`, `session_tag`,
 * `push_token`, `session_favorite`).
 *
 * `kind` discriminates which variant (drives backend
 * promotion + dashboard rendering); `name` is the user-supplied
 * event name (or the variant-specific reserved slot like
 * "favorite" for session_favorite); `properties` is arbitrary
 * structured metadata. The dashboard's EventsPanel maps
 * (`kind`, `name`) → icon + label.
 */
export interface CustomEventData {
  kind: string;
  name: string;
  properties?: Record<string, unknown>;
  /** dead_click variant: CSS selector / element label that was clicked to no
   *  effect. Powers element-level unmet-demand detection. */
  selector?: string;
}

export interface PerformanceEventData {
  metric: string;
  value: number;
  unit: string;
  rating?: "good" | "needs-improvement" | "poor";
  kind?: string;
  /**
   * Optional free-text payload for metrics that need richer context
   * than a single numeric `value`. Currently used by:
   *
   *   - `anr_ms` (Android) / `hang_ms` (iOS) — main-thread stack
   *     trace captured at the moment the ANR / hang fired. Lets the
   *     dashboard group ANRs by stack signature the same way
   *     Crashlytics groups crashes.
   *
   * Capped at ~8 KB by the SDK before send so a single deep stack
   * can't blow batch sizes. Newlines preserved so the dashboard can
   * render the trace as code-formatted lines.
   */
  details?: string;
}

export interface ViewportEventData {
  width: number;
  height: number;
}

export interface ReplayPrivacyConfig {
  maskAllInputs?: boolean;
  maskTextSelector?: string;
  blockSelector?: string;
  redactUrls?: Array<string | RegExp>;
  captureRequestHeaders?: boolean;
  captureResponseHeaders?: boolean;
}

export interface ReplayIngestResponse {
  accepted: boolean;
  acceptedSequence: number;
  sessionId: string;
  /** The workspace has spent its plan's session allowance — the SDK should stop
   *  recording and uploading. The server has already dropped this batch; this
   *  tells the client to stop sending more. */
  shouldNotRecord?: boolean;
}

export interface ReplaySessionSummary {
  sessionId: string;
  projectId?: string;
  platform: ReplayPlatform;
  sdkName: string;
  sdkVersion: string;
  startedAt: number;
  endedAt: number;
  eventCount: number;
  pageUrl: string;
  distinctId?: string;
  status?: "LIVE" | "COMPLETED";
  durationMs?: number;
}

export interface ReplaySessionDetail extends ReplaySessionSummary {
  segments: ReplaySegmentSummary[];
}

export interface ReplayProjectSummary {
  id: string;
  slug: string;
  name: string;
  retentionDays: number;
  samplingRate: number;
  createdAt: string;
  sessionsLast24h: number;
  apiKeys: ReplayApiKeySummary[];
}

export interface ReplayApiKeySummary {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  revokedAt?: string;
  lastUsed?: string;
}

export interface ReplayProjectionLogRow {
  sessionId: string;
  projectId: string;
  sequence: number;
  eventId: string;
  eventType: ReplayEventType;
  timestamp: number;
  offsetMs: number;
  kind: "console" | "network" | "error";
  level?: string;
  message?: string;
  method?: string;
  url?: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  stack?: string;
}

export interface ReplaySegmentSummary {
  sessionId: string;
  segmentId: string;
  sequence: number;
  eventCount: number;
  storageKey: string;
  startedAt: number;
  endedAt: number;
}
