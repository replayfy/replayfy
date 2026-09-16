import { createHash } from "crypto";

/**
 * Error/crash fingerprinting.
 *
 * The goal is a STABLE group key so the same defect collapses to one Issue
 * across thousands of sessions and many releases, while genuinely different
 * defects stay apart. We group primarily on `(platform, isCrash, errorType,
 * top in-app frame)` and fall back to a normalized message when there's no
 * usable stack — the same precedence any mature crash grouper uses.
 *
 * We deliberately do NOT include the screen/URL: a crash is the same defect
 * whether it fired on /cart or /checkout. Including it would shatter one
 * Issue into many and defeat the "142× · 96 users" rollup.
 *
 * Everything here is a pure function of its input — no I/O, no DB — so it's
 * cheap to run per event inside the session processor and trivially testable.
 */

/** One parsed stack frame — the shape the web SDK ships in `frames[]`, and
 *  what we recover from a raw stack string for the mobile/legacy paths. */
export interface ParsedFrame {
  functionName?: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** Raw error/crash event as read out of ClickHouse `session_events`. */
export interface RawErrorEvent {
  /** true = fatal crash (mobile `error='crash'`), false = handled/JS error. */
  isCrash: boolean;
  /** web / ios / android / react_native / flutter / "". */
  platform: string;
  /** Error class from the SDK (`ErrorEventData.name`, Android className,
   *  iOS exception/signal name). May be absent on legacy events. */
  name?: string;
  message?: string;
  /** Raw stack string — web JS stack, Android `stackTraceToString()`, or an
   *  iOS PLCrashReport text dump. Used when structured frames are absent. */
  stack?: string;
  /** JSON array of {functionName,fileName,lineNumber,columnNumber} — the web
   *  SDK's structured `frames`. Preferred over parsing `stack`. */
  framesJson?: string;
}

export interface Fingerprinted {
  fingerprint: string;
  errorType: string;
  /** Single-line, length-capped representative message. */
  message: string;
  /** Top in-app frame rendered for humans, "" when none could be found. */
  culprit: string;
  /** A concise human title: "TypeError: undefined is not a function". */
  title: string;
}

// Frames in these locations are framework/runtime noise, not the app's own
// code — the "system" frames. We skip them when choosing the culprit so the
// fingerprint anchors on the customer's code, which is what stays stable
// across dependency bumps.
const SYSTEM_FRAME_RX =
  /node_modules|(^|[\/.])react-dom|(^|[\/.])zone\.js|webpack-internal|\/dist\/|react-native\/Libraries|Flutter\/|UIKitCore|Foundation|libdispatch|libsystem|java\.|kotlin\.|android\.|androidx\.|dalvik\.|com\.google\.android/i;

function safeJsonFrames(framesJson: string | undefined): ParsedFrame[] {
  if (!framesJson) return [];
  try {
    const arr = JSON.parse(framesJson);
    return Array.isArray(arr) ? (arr as ParsedFrame[]) : [];
  } catch {
    return [];
  }
}

/**
 * Recover frames from a raw stack STRING. Handles the three formats we
 * actually ship:
 *   • web JS  — "    at submitOrder (https://app/checkout.js:12:9)"
 *   • Android — "\tat com.acme.Cart.checkout(Cart.kt:42)"
 *   • iOS     — "3   MyApp   0x1045 $s5MyApp4CartC8checkoutyyF + 120"
 * We only need the top few in-app frames for the culprit, so this is a light
 * line scan, not a full symbolication parser.
 */
function framesFromStack(stack: string | undefined): ParsedFrame[] {
  if (!stack) return [];
  const out: ParsedFrame[] = [];
  const lines = stack.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // web JS: "at fn (file:line:col)" or "at file:line:col"
    let m = /^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/.exec(t);
    if (m) {
      out.push({
        functionName: m[1],
        fileName: m[2],
        lineNumber: Number(m[3]),
        columnNumber: Number(m[4]),
      });
      continue;
    }
    m = /^at\s+(.*?):(\d+):(\d+)$/.exec(t);
    if (m) {
      out.push({
        fileName: m[1],
        lineNumber: Number(m[2]),
        columnNumber: Number(m[3]),
      });
      continue;
    }
    // Android JVM: "at pkg.Class.method(File.kt:42)"
    m = /^at\s+([\w$.]+)\((.*?):(\d+)\)$/.exec(t);
    if (m) {
      out.push({ functionName: m[1], fileName: m[2], lineNumber: Number(m[3]) });
      continue;
    }
    m = /^at\s+([\w$.]+)\(([^)]*)\)$/.exec(t); // Native / no line info
    if (m) {
      out.push({ functionName: m[1], fileName: m[2] });
      continue;
    }
    // iOS crash frame: "<n>   <binary>   0x... <symbol> + <off>"
    m = /^\d+\s+\S+\s+0x[0-9a-f]+\s+(.+?)(\s+\+\s+\d+)?$/i.exec(t);
    if (m) {
      out.push({ functionName: m[1].trim() });
      continue;
    }
  }
  return out;
}

/** The base filename without directory — "checkout.js" from a URL/path. */
function baseName(file: string | undefined): string {
  if (!file) return "";
  const noQuery = file.split(/[?#]/)[0];
  const parts = noQuery.split(/[\/\\]/);
  return parts[parts.length - 1] || noQuery;
}

/** Render a frame as a human culprit: "checkout.js in submitOrder". */
function frameToCulprit(f: ParsedFrame): string {
  const fn = (f.functionName ?? "").trim();
  const file = baseName(f.fileName);
  const loc = file + (f.lineNumber ? `:${f.lineNumber}` : "");
  if (fn && loc) return `${loc} in ${fn}`;
  if (fn) return fn;
  return loc;
}

/** Pick the culprit frame: the first in-app frame, else the first frame. */
function pickCulpritFrame(frames: ParsedFrame[]): ParsedFrame | undefined {
  const inApp = frames.find((f) => {
    const hay = `${f.fileName ?? ""} ${f.functionName ?? ""}`;
    return hay.trim().length > 0 && !SYSTEM_FRAME_RX.test(hay);
  });
  return inApp ?? frames[0];
}

/** For the fingerprint we want the frame's IDENTITY without volatile parts —
 *  function + file base, but NOT the column (shifts with every build). */
function frameSignature(f: ParsedFrame): string {
  return [f.functionName ?? "", baseName(f.fileName), f.lineNumber ?? ""].join(
    "|",
  );
}

/**
 * Collapse the variable parts of a message so "user 123 not found" and
 * "user 456 not found" share a fingerprint. Order matters (broad → narrow).
 */
export function normalizeMessage(message: string | undefined): string {
  let s = (message ?? "").trim();
  if (!s) return "";
  s = s
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0x?") // hex / pointers
    .replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      "<uuid>",
    ) // uuids
    .replace(/\b[0-9a-fA-F]{16,}\b/g, "<hex>") // long hex ids
    .replace(/\bhttps?:\/\/[^\s"')]+/gi, "<url>") // urls
    .replace(/\b\d[\d.,]*\b/g, "<n>") // numbers
    .replace(/['"`][^'"`]*['"`]/g, "<str>") // quoted literals
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 300);
}

/** Derive the error type/class. Prefer the SDK-supplied name; otherwise sniff
 *  a leading "SomethingError:" from the message/stack; else a sensible default. */
function deriveErrorType(ev: RawErrorEvent): string {
  const name = (ev.name ?? "").trim();
  // The SDK also uses "error"/"unhandledrejection"/"crash" as the wire `kind`;
  // those aren't real error classes, so ignore them as a type.
  if (name && !/^(error|unhandledrejection|crash)$/i.test(name)) {
    return name.slice(0, 120);
  }
  const src = (ev.message ?? ev.stack ?? "").trim();
  const m = /^([A-Za-z][\w.$]*(?:Error|Exception))\b\s*:/.exec(src);
  if (m) return m[1].slice(0, 120);
  return ev.isCrash ? "Crash" : "Error";
}

function firstLine(s: string | undefined): string {
  if (!s) return "";
  const line = s.split(/\r?\n/, 1)[0].trim();
  return line.slice(0, 500);
}

/**
 * Compute the fingerprint + display fields for one error/crash event.
 * Grouping precedence:
 *   1. `(platform, isCrash, errorType, top-in-app-frame signature)` when a
 *      usable stack exists — the most stable key.
 *   2. `(platform, isCrash, errorType, normalizedMessage)` otherwise.
 */
export function fingerprintError(ev: RawErrorEvent): Fingerprinted {
  const errorType = deriveErrorType(ev);
  const frames = safeJsonFrames(ev.framesJson);
  const allFrames = frames.length > 0 ? frames : framesFromStack(ev.stack);
  const culpritFrame = pickCulpritFrame(allFrames);
  const culprit = culpritFrame ? frameToCulprit(culpritFrame) : "";
  const normalizedMessage = normalizeMessage(ev.message);

  const platform = (ev.platform || "").toLowerCase();
  const kindKey = ev.isCrash ? "crash" : "error";
  // Anchor on the frame identity when we have one; message otherwise.
  const anchor = culpritFrame
    ? frameSignature(culpritFrame)
    : normalizedMessage;
  const fingerprint = createHash("sha1")
    .update([platform, kindKey, errorType, anchor].join("\n"))
    .digest("hex");

  const message = firstLine(ev.message) || errorType;
  const title = message.startsWith(errorType)
    ? message
    : `${errorType}: ${message}`.slice(0, 500);

  return { fingerprint, errorType, message, culprit, title };
}

/** Raw UI-freeze (ANR) occurrence as read from ClickHouse (`kind='perf'`,
 *  `method='anr_ms'`). A freeze has no exception class, so grouping keys off the
 *  main-thread stack when the watchdog captured one, else the screen. */
export interface RawAnrEvent {
  /** web / ios / android / react_native / flutter / "". */
  platform: string;
  /** Main-thread stack captured at the freeze (Android watchdog). Empty on iOS
   *  today and on any stack-less sample. */
  stack?: string;
  /** Route/screen the freeze fired on — the grouping fallback when there's no
   *  stack. */
  screen?: string;
  /** Freeze duration in ms. Display only — never part of the group key. */
  durationMs: number;
}

/**
 * Fingerprint a UI freeze (ANR / "app not responding"). Unlike a crash there's
 * no exception class to key on, so we anchor on the main-thread stack signature
 * when the watchdog captured one (the same hang reproduces the same top frames)
 * and fall back to the screen/route when it didn't (iOS today, or any stack-less
 * sample). Namespaced "anr" so a freeze can never collide with a crash/error
 * fingerprint, and — for the same reason crashes exclude the URL — the duration
 * never enters the key (it would shatter one freeze into a thousand).
 */
export function fingerprintAnr(ev: RawAnrEvent): Fingerprinted {
  const platform = (ev.platform || "").toLowerCase();
  const frames = framesFromStack(ev.stack);
  const culpritFrame = pickCulpritFrame(frames);
  const culprit = culpritFrame ? frameToCulprit(culpritFrame) : "";
  const screen = (ev.screen ?? "").trim();
  // Stack signature when we have one; the screen otherwise; a constant last
  // resort so a stack-less, screen-less freeze still groups (rather than each
  // becoming its own Issue).
  const anchor = culpritFrame ? frameSignature(culpritFrame) : screen || "app";
  const fingerprint = createHash("sha1")
    .update(["anr", platform, anchor].join("\n"))
    .digest("hex");

  const errorType = "App Not Responding";
  const where = screen ? ` on ${screen}` : "";
  const secs = (ev.durationMs / 1000).toFixed(1);
  const message = `UI froze for ${secs}s${where}`;
  const title = culprit
    ? `App Not Responding in ${culprit}`
    : `App Not Responding${where}`;

  return { fingerprint, errorType, message, culprit, title };
}

/** One rendered stack frame for the investigation drawer. */
export interface DisplayFrame {
  /** Function / symbol name (emphasised in the UI). */
  fn: string;
  /** `file:line[:col]` location. */
  loc: string;
  /** true = the customer's own code (not framework / runtime noise) — these
   *  get the emphasis; the rest render dimmed. */
  inApp: boolean;
}

/**
 * Parse an error event's structured frames (or its raw stack string) into
 * display frames, flagging which are the app's own code. Pure — same parser the
 * fingerprinter uses, exposed for the detail read so the drawer can render a
 * trace without re-implementing the format handling.
 */
export function parseStackFrames(
  ev: { framesJson?: string; stack?: string },
  limit = 25,
): DisplayFrame[] {
  const structured = safeJsonFrames(ev.framesJson);
  const frames = structured.length > 0 ? structured : framesFromStack(ev.stack);
  return frames.slice(0, limit).map((f) => {
    const file = baseName(f.fileName);
    const loc =
      file +
      (f.lineNumber ? `:${f.lineNumber}` : "") +
      (f.lineNumber && f.columnNumber ? `:${f.columnNumber}` : "");
    const hay = `${f.fileName ?? ""} ${f.functionName ?? ""}`;
    return {
      fn: (f.functionName ?? "").trim(),
      loc,
      inApp: hay.trim().length > 0 && !SYSTEM_FRAME_RX.test(hay),
    };
  });
}
