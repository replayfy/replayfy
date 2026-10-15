/* Settings fixtures + avatar-hue helper + per-panel descriptions —
   future API-swap points. Extracted verbatim from the approved prototype. */
import { API_URL } from "@/api/client";
import { relTime } from "@/lib/format";

/* avatar hue (Team panel) */
const HUES = ["#5b5ceb", "#c08a3e", "#3f9468", "#c2599f", "#3b76b0", "#8b72d6"];
export function uhue(n: string): string {
  let h = 0;
  for (const c of n || "?") h = (h * 31 + c.charCodeAt(0)) % HUES.length;
  return HUES[h];
}

/* ---------- Privacy & masking ---------- */
export type MaskTemplate = {
  id: string;
  label: string;
  selector?: string;
  mode?: string;
  kind?: "url";
  pattern?: string;
};
export const MASK_TEMPLATES: MaskTemplate[] = [
  {
    id: "password",
    label: "Password fields",
    selector: 'input[type="password"]',
    mode: "block",
  },
  {
    id: "card",
    label: "Credit card inputs",
    selector: 'input[autocomplete="cc-number"], input[name*="card"]',
    mode: "block",
  },
  {
    id: "cvc",
    label: "CVC / CVV",
    selector: 'input[autocomplete="cc-csc"], input[name*="cvc"]',
    mode: "block",
  },
  {
    id: "ssn",
    label: "SSN / National id",
    selector: 'input[name*="ssn"]',
    mode: "block",
  },
  {
    id: "private",
    label: "Anything tagged [data-private]",
    selector: "[data-private]",
    mode: "block",
  },
  {
    id: "email",
    label: "Email cells",
    selector: ".user-email, [data-email]",
    mode: "mask",
  },
  {
    id: "no-replay",
    label: "Class .no-replay",
    selector: ".no-replay",
    mode: "block",
  },
  {
    id: "token-url",
    label: "URLs with token=",
    kind: "url",
    pattern: "token=",
  },
  {
    id: "apikey-url",
    label: "URLs with api_key=",
    kind: "url",
    pattern: "api_key=",
  },
];

/* ---------- Team ---------- */
export type Member = [string, string, string];
export type Invite = [string, string, string];
export const MEMBERS: Member[] = [
  ["Nas", "admin@local", "Owner"],
  ["Devon Carter", "devon@loop.io", "Admin"],
  ["Maria Alvarez", "maria@acme.io", "Member"],
  ["Priya Nair", "priya@northwind.co", "Member"],
  ["Sam Okafor", "sam@globex.com", "Viewer"],
];
export const INVITES: Invite[] = [
  ["theo@northwind.co", "Member", "2 hours ago"],
  ["priya.r@globex.com", "Viewer", "1 day ago"],
];

/* ---------- Integrations ---------- */
export type Integration = [string, string, string, boolean];
export const INTG: Integration[] = [
  ["Slack", "#4A154B", "Post new playlists and comments to a channel", true],
  ["Linear", "#5E6AD2", "Create issues directly from a session", true],
  ["Jira", "#0052CC", "Sync session links to Jira tickets", false],
  ["GitHub", "#1f2023", "Open issues for errors captured in sessions", false],
  ["Sentry", "#362D59", "Link errors to replays", true],
  ["Webhook", "#6b7280", "POST events anywhere", false],
];

/* ---------- Install ---------- */
export type Platform = { id: string; label: string; group: string };
export const PLATFORMS: Platform[] = [
  { id: "web", label: "Web", group: "Web" },
  { id: "react", label: "React", group: "Web" },
  { id: "next", label: "Next.js", group: "Web" },
  { id: "vue", label: "Vue / Nuxt", group: "Web" },
  { id: "rn", label: "React Native", group: "Mobile" },
  { id: "swift", label: "iOS · Swift", group: "Mobile" },
  { id: "android", label: "Android", group: "Mobile" },
  { id: "flutter", label: "Flutter", group: "Mobile" },
];
export type Snippet = { lang: string; title: string; code: string };
/* The placeholders baked into every SNIP snippet below. At render they are
   swapped (see fillSnippet) for the live values: the workspace's real public
   key, the SDK ingest host, and the web-SDK loader URL. Keep these in sync with
   the literals used inside SNIP. */
export const SNIP_PROJECT_KEY = "rpl_pk_8a91b3c2d4e5";
export const SNIP_API_HOST = "https://us.replayfy.app";
export const SNIP_CDN_URL = "https://cdn.replayfy.app/v1/replay.global.js";

/** The SDK `apiHost` shown in copy-paste install snippets. Defaults to the API
 *  origin the dashboard itself talks to (`API_URL`, which prefers the runtime
 *  `/runtime-config.js` value over the build-time VITE_API_URL), so a pre-built
 *  self-hosted image hands out snippets that point at the self-hoster's own
 *  server; override with VITE_INGEST_HOST. */
export function installIngestHost(): string {
  return import.meta.env.VITE_INGEST_HOST || API_URL || SNIP_API_HOST;
}
/** URL of the web-SDK loader script. Override with VITE_SDK_URL; the published
 *  SDK on the default CDN works against any host, so self-hosters can keep it. */
export function installSdkUrl(): string {
  return import.meta.env.VITE_SDK_URL || SNIP_CDN_URL;
}
/** Fill a SNIP snippet's placeholders with the live project key + host + SDK URL. */
export function fillSnippet(code: string, publicKey: string): string {
  return code
    .replaceAll(SNIP_PROJECT_KEY, publicKey)
    .replaceAll(SNIP_API_HOST, installIngestHost())
    .replaceAll(SNIP_CDN_URL, installSdkUrl());
}
export const SNIP: Record<string, Snippet> = {
  web: {
    lang: "HTML",
    title: "index.html",
    code: `<!-- Loads asynchronously (never blocks page render) and queues calls\n     until the SDK is ready. crossorigin = full error stack traces. -->\n<script>\n  !(function () {\n    var r = (window.Replayfy = window.Replayfy || []);\n    ['init', 'identify', 'track', 'captureException', 'flush', 'stop'].forEach(function (m) {\n      r[m] = function () { r.push([m].concat([].slice.call(arguments))); };\n    });\n    var s = document.createElement('script');\n    s.async = true;\n    s.crossOrigin = 'anonymous';\n    s.src = 'https://cdn.replayfy.app/v1/replay.global.js';\n    var f = document.getElementsByTagName('script')[0];\n    f.parentNode.insertBefore(s, f);\n  })();\n  Replayfy.init({\n    apiKey: 'rpl_pk_8a91b3c2d4e5',\n    apiHost: 'https://us.replayfy.app',\n  });\n</script>`,
  },
  react: {
    lang: "TSX",
    title: "App.tsx",
    code: `import { useEffect } from 'react';\nimport { initReplay } from '@replayfyapp/browser';\n\nexport default function App() {\n  useEffect(() => {\n    initReplay({\n      apiKey: 'rpl_pk_8a91b3c2d4e5',\n      apiHost: 'https://us.replayfy.app',\n    });\n  }, []);\n\n  return <YourApp />;\n}`,
  },
  next: {
    lang: "TSX",
    title: "app/replayfy.tsx",
    code: `'use client';\nimport { useEffect } from 'react';\nimport { initReplay } from '@replayfyapp/browser';\n\nexport function Replayfy() {\n  useEffect(() => {\n    initReplay({\n      apiKey: 'rpl_pk_8a91b3c2d4e5',\n      apiHost: 'https://us.replayfy.app',\n    });\n  }, []);\n  return null;\n}\n// Render <Replayfy /> once in app/layout.tsx`,
  },
  vue: {
    lang: "TS",
    title: "main.ts",
    code: `import { createApp } from 'vue';\nimport { initReplay } from '@replayfyapp/browser';\nimport App from './App.vue';\n\ninitReplay({\n  apiKey: 'rpl_pk_8a91b3c2d4e5',\n  apiHost: 'https://us.replayfy.app',\n});\n\ncreateApp(App).mount('#app');`,
  },
  rn: {
    lang: "TSX",
    title: "App.tsx",
    code: `// npm i @replayfyapp/react-native && cd ios && pod install\nimport Replay from '@replayfyapp/react-native';\n\nReplay.start({\n  apiKey: 'rpl_pk_8a91b3c2d4e5',\n  apiHost: 'https://us.replayfy.app',\n});\n\nexport default function App() {\n  return <RootStack />;\n}`,
  },
  swift: {
    lang: "Swift",
    title: "App.swift",
    code: `import Replay\n\nReplay.start(with: ReplayConfig(\n  apiKey: "rpl_pk_8a91b3c2d4e5",\n  apiHost: "https://us.replayfy.app"\n))\n// Replay.identify("user_123", traits: ["email": "ada@example.com"])`,
  },
  android: {
    lang: "Kotlin",
    title: "MainApplication.kt",
    code: `import com.replayfy.android.Replay\nimport com.replayfy.android.ReplayConfig\n\nReplay.init(\n  this,\n  ReplayConfig(\n    apiKey = "rpl_pk_8a91b3c2d4e5",\n    apiHost = "https://us.replayfy.app",\n  ),\n)`,
  },
  flutter: {
    lang: "Dart",
    title: "main.dart",
    code: `import 'package:replayfy_flutter/replayfy_flutter.dart';\n\nawait Replay.start(const ReplayConfig(\n  apiKey: 'rpl_pk_8a91b3c2d4e5',\n  apiHost: 'https://us.replayfy.app',\n));`,
  },
};
/* ---------- Billing ---------- */

/* ---------- Panel descriptions ---------- */
export const PANEL_DESC: Record<string, string> = {
  general: "Workspace name, slug, plan and danger zone.",
  recording: "Configure what gets captured. Changes reach the SDK within 60s.",
  masking:
    "Control what's captured from the DOM. Block replaces an element with an empty box of the same size; mask replaces its text with * of the same length.",
  retention: "How long recordings are kept before being deleted.",
  sampling: "Record a representative subset to control volume.",
  ai: "Powers the Overview likely-cause and Ask Replayfy. Optional.",
  team: "Manage who has access to this workspace.",
  integrations: "Connect Replayfy to the rest of your stack.",
  install:
    "Add Replayfy to your site or app, manage API keys and allowed hosts.",
  billing: "Plan, usage, and billing details.",
};

/* ============================================================================
   API adapters + typed fallbacks (real-data wiring). The fixtures above stay as
   typed fallbacks; the types + adaptX()/mappers below translate each backend
   response into the shape the frozen markup already renders, so no JSX changes.
   ========================================================================== */

/* ---------- Recording (GET/PATCH /v1/settings/recording) ---------- */
export type ApiRecording = {
  recordCanvas: boolean;
  recordCrossOriginIframes: boolean;
  autoplayNextRecording: boolean;
  captureNetwork: boolean;
  captureNetworkHeaders: boolean;
  captureNetworkBodies: boolean;
  captureConsole: boolean;
  capturePerformance: boolean;
  captureErrors: boolean;
  mobileFps: number;
  mobileQuality: string;
  recordingTrigger: string;
  minDurationSeconds: number;
};
export const RECORDING_FALLBACK: ApiRecording = {
  recordCanvas: false,
  recordCrossOriginIframes: false,
  autoplayNextRecording: true,
  captureNetwork: true,
  captureNetworkHeaders: false,
  captureNetworkBodies: false,
  captureConsole: true,
  capturePerformance: true,
  captureErrors: true,
  mobileFps: 3,
  mobileQuality: "standard",
  recordingTrigger: "always",
  minDurationSeconds: 5,
};

/* ---------- Masking (GET/PATCH /v1/settings/masking) ---------- */
export type ApiMasking = {
  maskAllInputs: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  redactUrlPatterns: string[];
  blockCreditCardText: boolean;
  stripQueryParams: boolean;
  allowedQueryParams: string[];
  allowedHosts: string[];
};
/* Mirrors the server's DEFAULT_MASKING (injest-api settings.service.ts), i.e.
   what a workspace that never touched this panel really has. The panel only
   shows it while the real config loads and locks every control meanwhile, so
   these values are never sent back. maskAllInputs false = "don't force"; it
   does not unmask anything on current SDKs. */
export const MASKING_FALLBACK: ApiMasking = {
  maskAllInputs: false,
  maskSelectors: ["[data-private]", ".sensitive"],
  blockSelectors: [".no-replay"],
  redactUrlPatterns: ["token=", "api_key="],
  blockCreditCardText: true,
  stripQueryParams: false,
  allowedQueryParams: ["utm_source", "utm_medium", "utm_campaign"],
  allowedHosts: [],
};
/* Panel copy that makes privacy promises. Each claim names the SDK versions it
   holds for (settings.data.test.ts pins the risky ones): web SDK 0.1.20 masks
   inputs by default and the switch can only force masking on, while 0.1.19
   and older follow the switch as-is; Android/iOS honour it from 0.0.7 and
   React Native from 0.0.8 (the first release that bundles those engines); and
   Flutter / Jetpack Compose text fields are never masked automatically. The
   force only arrives with the SDK config fetch, and mobile reads it at
   session start, hence the "once ... loaded" qualifier. */
export const MASKING_COPY = {
  maskInputsLabel: "Always mask input values",
  maskInputsHelp: [
    "On: once an SDK has loaded this workspace's settings, web SDKs mask every input value even where an app's code opts out (maskAllInputs: false), and mobile SDKs hide native text fields in screen recordings: Android EditText from Android SDK 0.0.7, iOS UITextField and UITextView from iOS SDK 0.0.7, React Native TextInput from React Native SDK 0.0.8. Mobile apps pick up a change at their next session start.",
    "Off leaves masking to each SDK: web SDK 0.1.20+ masks every input unless the code opts out, while web SDK 0.1.19 and older record what users type. Passwords stay masked on web, in Android password EditTexts and in iOS secure text fields.",
    "Flutter and Jetpack Compose text fields, password fields included, are not masked automatically. Wrap them in ReplayMask or Modifier.replayOcclude.",
  ],
  // blockCreditCardText only reaches the web SDK's network capture, which
  // Luhn-checks 13–19 digit runs in each request URL; page text, page URLs
  // and request/response bodies are untouched.
  cardTextHelp:
    "Web: replaces card numbers (13–19 digits that pass the Luhn check) in captured network request URLs.",
  // Same reach as blockCreditCardText: network request URLs only.
  stripQueryHelp:
    "Web: removes query strings from captured network request URLs, except the allowed params below. Page URLs keep theirs.",
  // The allowlist is only read while stripQueryParams is on.
  allowedParamsHelp:
    "Comma-separated. While stripping is on, these params are kept and every other one is removed.",
  // Only the web SDK applies these, to network request and resource URLs, as
  // case-insensitive RegExps. From 0.1.20 every match is replaced and a match
  // ending in "=" takes its value too; older SDKs replace only the first match
  // and keep the value, hence coverParamValue on add.
  urlPatternsHelp:
    "Web: each pattern is a case-insensitive regular expression. Every match in each captured network request and resource URL is replaced with [REDACTED] (web SDK 0.1.19 and older replace only the first). A pattern that ends in = also covers the value after it, so email= is saved as email=[^&#]*.",
  loadError:
    "Couldn't load this workspace's privacy settings. Editing is off until they load.",
  invalidDraft: "Not a valid CSS selector, so it wasn't added.",
  newSelectorDraft:
    "Uses :has(), & nesting or :nth-child(… of …), which older browsers can't read, so it wasn't added.",
  invalidRule: (mode: string) =>
    `Not a valid CSS selector. Remove it: it can stop the other ${mode} rules from applying.`,
  newSelectorRule: (mode: string) =>
    `Older browsers can't read :has(), & nesting or :nth-child(… of …). Remove it: in those browsers it can stop the other ${mode} rules from applying.`,
  invalidRulesBlock: "Remove the flagged rules before adding more.",
  invalidDraftPattern: "Not a valid regular expression, so it wasn't added.",
  newPatternDraft:
    "Uses lookbehind or inline flags, which older browsers can't compile, so it wasn't added.",
  // The web SDK compiles every pattern while applying the dashboard config; a
  // throw there aborts the apply, and on a fast config fetch that is before
  // the recorder starts, so the page records no replay at all.
  invalidPattern:
    "Not a valid regular expression. Remove it: while it is listed, web SDKs can record no replay or ignore this workspace's dashboard settings.",
  newPattern:
    "Older browsers can't compile lookbehind or inline flags. Remove it: while it is listed, web SDKs in those browsers can record no replay or ignore this workspace's dashboard settings.",
  invalidPatternsBlock: "Remove the flagged patterns before adding more.",
};
export type MaskRule = { s: string; m: string };
/** Why a rule can't be saved: "invalid" fails to parse here, "newSyntax"
 *  parses here but not in browsers some end users still run. The admin's
 *  browser is the only one checked, while every end user's browser applies
 *  the rule, so syntax newer engines added is refused as well. */
export type RuleIssue = "invalid" | "newSyntax";
/* Selector syntax that is a SyntaxError in engines still in use: :has()
   before Firefox 121 (ESR 115 included), & nesting before Chrome 112 /
   Firefox 117, :nth-child(… of S) before Chrome 111 / Firefox 113. */
const NEW_SELECTOR_SYNTAX = [
  /:has\(/i,
  /&/,
  /:nth-(?:last-)?child\([^)]*\bof\b/i,
];
/** Whether the recorders can use `sel` as one rule. It must parse as a CSS
 *  selector list in this browser (checked on a detached fragment, so nothing
 *  in the page is touched) AND stand on its own: the web SDK joins every rule
 *  of a mode with ", ", and browsers auto-close an unterminated string,
 *  bracket or paren — or a trailing comment / escape — at the end of a
 *  selector, so `[name="x` would swallow every rule joined after it while
 *  still parsing fine alone. One that only newer browsers parse does the
 *  same to the others in older ones. */
export function selectorIssue(sel: string): RuleIssue | null {
  const s = sel.trim();
  const bare = s ? selectorSkeleton(s) : null;
  if (bare == null) return "invalid";
  try {
    document.createDocumentFragment().querySelector(s);
  } catch {
    return "invalid";
  }
  return NEW_SELECTOR_SYNTAX.some((rx) => rx.test(bare)) ? "newSyntax" : null;
}
export const isValidSelector = (sel: string): boolean =>
  selectorIssue(sel) === null;
/** `s` with escapes and the insides of quoted strings blanked out, so syntax
 *  checks only see selector syntax; null unless every quote, [ and ( is
 *  closed and no comment or escape runs off the end. */
function selectorSkeleton(s: string): string | null {
  const open: string[] = [];
  let quote = "";
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      if (++i >= s.length) return null;
      if (!quote) out += "_";
      continue;
    }
    if (quote) {
      if (c === quote) {
        quote = "";
        out += c;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "/" && s[i + 1] === "*") return null;
    else if (c === "[") open.push("]");
    else if (c === "(") open.push(")");
    else if ((c === "]" || c === ")") && open.pop() !== c) return null;
    out += c;
  }
  return !quote && open.length === 0 ? out : null;
}
/** Whether the web SDK can compile `p` — it builds `new RegExp(p, "i")` from
 *  every redact URL pattern, and one that throws stops the whole dashboard
 *  config from applying. Lookbehind (Safari before 16.4) and inline flags
 *  such as (?i:…) (2024+ engines) compile here but throw in older browsers. */
export function urlPatternIssue(p: string): RuleIssue | null {
  if (!p.trim()) return "invalid";
  try {
    new RegExp(p, "i");
  } catch {
    return "invalid";
  }
  return usesNewRegexSyntax(p) ? "newSyntax" : null;
}
export const isValidUrlPattern = (p: string): boolean =>
  urlPatternIssue(p) === null;
/** A `(?<=` / `(?<!` lookbehind or `(?i:` / `(?-i:` group outside a class. */
function usesNewRegexSyntax(p: string): boolean {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (
      c === "(" &&
      p[i + 1] === "?" &&
      /^(?:<[=!]|[ims-]+:)/.test(p.slice(i + 2))
    )
      return true;
  }
  return false;
}
/** The web SDK replaces only the text a pattern matches, so a `key=` pattern
 *  on its own would store `?email=jane@acme.com` as `?[REDACTED]jane@acme.com`.
 *  A pattern that ends in "=" is extended through the value (up to the next
 *  & or #) before it is saved. */
export function coverParamValue(p: string): string {
  const s = p.trim();
  return s.endsWith("=") ? `${s}[^&#]*` : s;
}
/** block+mask selector arrays → the panel's flat [{selector, mode}] rows. */
export function maskingToRules(m: ApiMasking): MaskRule[] {
  return [
    ...(m.blockSelectors ?? []).map((s) => ({ s, m: "block" })),
    ...(m.maskSelectors ?? []).map((s) => ({ s, m: "mask" })),
  ];
}
/** panel rows → the two selector arrays the backend stores. */
export function rulesToSelectors(rules: MaskRule[]): {
  blockSelectors: string[];
  maskSelectors: string[];
} {
  return {
    blockSelectors: rules.filter((r) => r.m === "block").map((r) => r.s),
    maskSelectors: rules.filter((r) => r.m !== "block").map((r) => r.s),
  };
}
export const csvToList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
export const listToCsv = (a: string[] | undefined): string =>
  (a ?? []).join(", ");

/* ---------- Retention (GET/PATCH /v1/settings/retention) ---------- */
export type ApiRetention = {
  retentionDays: number;
  extendBookmarked: string;
  keepErrorsLonger: boolean;
  storageUsedBytes: number;
  /** Storage quota in bytes; null = unlimited (self-host / no billing). */
  storageQuotaBytes: number | null;
  /** The plan's retention ceiling in days; null = unlimited (Enterprise). Both
   *  the default period and the bookmark extension are capped by it. */
  maxRetentionDays: number | null;
};
export const RETENTION_DAY_TO_LABEL: Record<number, string> = {
  7: "7 days",
  14: "14 days",
  30: "30 days",
  90: "90 days",
  180: "180 days",
  365: "1 year",
};
export const RETENTION_LABEL_TO_DAY: Record<string, number> = {
  "7 days": 7,
  "14 days": 14,
  "30 days": 30,
  "90 days": 90,
  "180 days": 180,
  "1 year": 365,
};
export const EXTEND_CODE_TO_LABEL: Record<string, string> = {
  never: "Never expire",
  "30d": "+30 days",
  "90d": "+90 days",
  "365d": "+1 year",
};
export const EXTEND_LABEL_TO_CODE: Record<string, string> = {
  "Never expire": "never",
  "+30 days": "30d",
  "+90 days": "90d",
  "+1 year": "365d",
};
/** bytes → "638 GB" / "1 TB" / "194 KB" / "512 B" (base-1024), matching the
 *  storage meter copy. Mirrors the legacy formatBytes: sub-GB values must not
 *  all floor to "0 MB" — carry the MB/KB/B branches too. */
export function fmtBytes(n: number): string {
  const TB = 1024 ** 4,
    GB = 1024 ** 3,
    MB = 1024 ** 2,
    KB = 1024;
  if (n >= TB)
    return `${(Math.round((n / TB) * 10) / 10).toString().replace(/\.0$/, "")} TB`;
  if (n >= GB) {
    const v = n / GB;
    return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} GB`;
  }
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${Math.max(0, Math.round(n))} B`;
}

/* ---------- Sampling (GET/PATCH /v1/settings/sampling) ---------- */
export type ApiSampling = {
  samplingRate: number;
  alwaysRecordErrors: boolean;
  alwaysRecordIdentified: boolean;
  alwaysRecordOnUrls: string[];
};

/* ---------- LLM / AI (GET/PATCH /v1/settings/llm) ---------- */
export type ApiLlm = {
  mode: "DISABLED" | "PLATFORM" | "BYOK";
  provider: string;
  apiKeyLast4: string | null;
  guardModel: string | null;
  causeModel: string | null;
  askModel: string | null;
  dailyTokenBudget: number;
  tokensUsedToday: number;
  /** Whether AI can actually run right now (a provider key + model are resolved). */
  aiReady: boolean;
  /** Whether this build meters AI (cloud). false in the self-hosted build. */
  metered: boolean;
};

/* ---------- Team members + invites ---------- */
export type ApiMember = {
  id: number;
  userId: number;
  email: string;
  name: string | null;
  initials: string | null;
  role: string;
  lastActiveAt: string | null;
  createdAt: string;
};
export type MemberRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  lastActiveAt: string | null;
};
export type ApiInvite = {
  id: number;
  email: string;
  role: string;
  sentAt: string;
};
export type InviteRow = {
  id: number;
  email: string;
  role: string;
  sent: string;
};
export const roleTitle = (r: string): string =>
  r ? r[0].toUpperCase() + r.slice(1).toLowerCase() : r;
export function adaptMember(m: ApiMember): MemberRow {
  // Keep lastActiveAt so the Team panel can show a "Last active" column; the
  // panel formats it with relTime (null → "—").
  return {
    id: m.id,
    name: m.name || m.email,
    email: m.email,
    role: roleTitle(m.role),
    lastActiveAt: m.lastActiveAt,
  };
}
export function adaptInvite(i: ApiInvite): InviteRow {
  return {
    id: i.id,
    email: i.email,
    role: roleTitle(i.role),
    sent: relTime(i.sentAt),
  };
}

/* ---------- API keys (GET/POST/DELETE /v1/api-keys) ---------- */
export type ApiApiKey = {
  id: number;
  name: string;
  scope: "PUBLIC" | "SERVER" | "WEBHOOK";
  prefix: string;
  envs: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
};
export type ApiKeyRow = {
  id: number;
  name: string;
  keyDisplay: string;
  scope: string;
  created: string;
  lastUsed: string;
  lastRotated: string;
};
export function adaptApiKey(k: ApiApiKey): ApiKeyRow {
  return {
    id: k.id,
    name: k.name,
    keyDisplay: k.prefix,
    scope: k.scope.toLowerCase(),
    created: relTime(k.createdAt),
    lastUsed: k.lastUsedAt ? relTime(k.lastUsedAt) : "never",
    // relTime already renders a null/undefined timestamp as an em dash.
    lastRotated: relTime(k.rotatedAt),
  };
}

/* ---------- Integrations (GET /v1/settings/integrations) ---------- */
export type ApiIntegration = { id: string; label: string; connected: boolean };
/** Keep the design's colour + copy (visual identity, not backend data); drive
 *  only `connected` from the real endpoint, matched by name. Integrations the
 *  backend doesn't report fall back to not-connected rather than fabricating. */
export function adaptIntegrations(
  list: ApiIntegration[] | undefined,
): Integration[] {
  const map = new Map(
    (list ?? []).map((i) => [i.id.toLowerCase(), i.connected] as const),
  );
  return INTG.map(
    ([name, color, desc]) =>
      [name, color, desc, map.get(name.toLowerCase()) ?? false] as Integration,
  );
}
