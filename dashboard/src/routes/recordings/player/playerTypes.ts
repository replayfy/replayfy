/* ===========================================================================
   Shared playback types for the real session player (web rrweb + mobile frames).
   These mirror the backend shapes the reference player consumes:
     - GET /v1/sessions/:id/events  → ReplayBatch[]  (rrweb + native events)
     - GET /v1/sessions/:id/frames  → FramesInfo     (mobile frames archive)
   rrweb's own eventWithTime is re-typed loosely at the wrapper boundary only;
   the extracted rrwebEvent is the real rrweb type.
   ========================================================================== */
import type { eventWithTime } from "rrweb";

export type Rect = { x: number; y: number; w: number; h: number };

/** A node in a native snapshot tree (wireframe fallback / imageRef fallback). */
export type WireNode = {
  id?: string | number;
  type?: string;
  text?: string;
  route?: string | null;
  bounds?: Rect;
  backgroundColor?: string;
  opacity?: number;
  occluded?: boolean;
  imageRef?: string | null;
  children?: WireNode[];
};

/** The `data` payload of one wrapped replay event. For web events it carries
 *  `rrwebEvent`; for native (mobile) events it carries snapshot / tap fields. */
export type ReplayEventData = {
  recorder?: string;
  rrwebEvent?: eventWithTime;
  // navigation — page changes the address bar tracks. `to`/`from` are the full,
  // credential-redacted URLs the SDK emits on load / pushState / popstate.
  from?: string;
  to?: string;
  title?: string;
  // native_snapshot
  width?: number;
  height?: number;
  pixelRatio?: number;
  trigger?: string;
  root?: WireNode | null;
  // tap
  bounds?: Rect;
  point?: { x?: number; y?: number };
  route?: string;
  uiClass?: string;
  uiType?: string;
  uiValue?: string;
  uiId?: string;
};

/** One event inside a replay batch. The SDK wraps every rrweb event as either
 *  'full_snapshot' or 'incremental_snapshot'; native sessions instead emit
 *  'native_snapshot' / 'tap' (and other) event types. */
export type ReplayEvent = {
  id?: string | number;
  ts?: number;
  offsetMs?: number;
  type: string;
  source?: string;
  data?: ReplayEventData;
};

/** GET /v1/sessions/:id/events → array of these keyset-paginated batches. */
export type ReplayBatch = {
  sequence?: number;
  segmentId?: string;
  sentAt?: string;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
  events?: ReplayEvent[];
};

/** GET /v1/sessions/:id/frames → the per-session frames archive descriptor. */
export type FramesInfo = {
  url: string | null;
  count: number;
  startedAt: number;
  fileFormat: string;
};

/** A decoded frame from the archive. `_url` caches the lazily-minted blob URL
 *  so the decode-then-swap look-ahead can pre-warm it. */
export type MobileFrame = {
  time: number;
  getBlobUrl(): string;
  _url?: string | null;
};

/** Parsed native snapshot (dims / route / imageRef fallback for legacy sessions). */
export type NativeSnapshot = {
  id?: string | number;
  ts?: number;
  width?: number;
  height?: number;
  pixelRatio?: number;
  trigger?: string;
  root?: WireNode | null;
  route: string | null;
};

/** Parsed native tap (overlay ripple). */
export type NativeTap = {
  id?: string | number;
  ts: number;
  bounds?: Rect;
  point?: { x?: number; y?: number };
  route?: string;
  uiClass?: string;
  uiType?: string;
  uiValue?: string;
  uiId?: string;
};

/** Imperative handle the frozen HUD bridges to (player clock ↔ scrubber). */
export type RvPlayerHandle = {
  play(): void;
  pause(): void;
  goto(sec: number): void;
  setSpeed(s: number): void;
  /** Current playhead in seconds. */
  getCurrentTime(): number;
};

/** A mark on the scrubber: one real session event, placed at its own seconds.
 *  `tone` drives the marker's visual identity; the rest feed the enterprise
 *  hover tooltip and the marker↔event-row cross-highlight. */
export type RvTick = {
  sec: number;
  tone: "err" | "rage" | "dead" | "nav" | "input" | "click" | "net" | "ai";
  /** Legacy one-line label ("0:03 · Screen /onboarding"); kept as a fallback. */
  label: string;
  /** Source event offsetMs — the shared key that links a marker to its
   *  Events-panel row so hovering one can highlight the other. */
  key?: number;
  /** Type label for the tooltip eyebrow: "Tap" / "Screen" / "Rage click" /
   *  "Error" / "Network" / "AI insight". */
  kind?: string;
  /** Tooltip headline (the event's target / message). */
  primary?: string;
  /** Tooltip secondary line (screen, source, status…). */
  meta?: string;
  /** "M:SS" occurrence time. */
  time?: string;
  /** Attention hierarchy — drives marker height/opacity so a crash or AI
   *  insight naturally outweighs a tap without loud colour. */
  weight?: "low" | "med" | "high";
  /** Extra bullet lines, used by the AI-insight marker. */
  detail?: string[];
};
