/* ============================================================================
   overview.data.tsx — mock-data fixtures for Overview V3 (future API-swap
   points). Some feed rows carry rich (JSX) titles, so this sibling is .tsx.
   ========================================================================== */
import type { ReactNode } from "react";
import { RISE, STEADY, SWELL, LATE, type MetricDef } from "./overview.series";

/** One funnel step as the overview renders it (name, matched event, counts). */
export type FunnelStep = {
  pct: number;
  cnt: number;
  name: string;
  ev: string;
  bad?: boolean;
  drop: number;
};

export const METRIC_DEFS: MetricDef[] = [
  {
    key: "dau",
    label: "DAU",
    sub: "Daily active",
    color: "var(--accent)",
    unit: "",
    display: "12,480",
    delta: "+4.2%",
    dir: "up",
    lo: 9100,
    hi: 12480,
    curve: RISE,
    seed: 11,
  },
  {
    key: "wau",
    label: "WAU",
    sub: "Weekly active",
    color: "var(--blue)",
    unit: "",
    display: "38,210",
    delta: "+2.1%",
    dir: "up",
    lo: 34200,
    hi: 38210,
    curve: STEADY,
    seed: 23,
  },
  {
    key: "mau",
    label: "MAU",
    sub: "Monthly active",
    color: "var(--hue-violet)",
    unit: "",
    display: "91,640",
    delta: "+6.8%",
    dir: "up",
    lo: 80200,
    hi: 91640,
    curve: SWELL,
    seed: 37,
  },
  {
    key: "new",
    label: "New",
    sub: "New users",
    color: "var(--green)",
    unit: "",
    display: "3,240",
    delta: "+11.4%",
    dir: "up",
    lo: 2180,
    hi: 3240,
    curve: LATE,
    seed: 51,
  },
  {
    key: "ret",
    label: "Returning",
    sub: "Returning users",
    color: "var(--hue-magenta)",
    unit: "",
    display: "9,240",
    delta: "+2.8%",
    dir: "up",
    lo: 8300,
    hi: 9240,
    curve: STEADY,
    seed: 67,
  },
  {
    key: "rtn",
    label: "Retention",
    sub: "D7 retention",
    color: "var(--amber)",
    unit: "%",
    display: "44.2%",
    delta: "+3.1pt",
    dir: "up",
    lo: 40.1,
    hi: 44.2,
    curve: RISE,
    seed: 83,
  },
];

/* ---- static content --------------------------------------------------- */
export type Subsys = {
  n: string;
  v: number;
  c: string;
  d: string;
  why: string;
};
export const SUBSYS: Subsys[] = [
  {
    n: "API health",
    v: 94,
    c: "var(--green)",
    d: "+2",
    why: "p95 response 240ms across 1.2M calls. Only /api/checkout breaches SLO — 2.4s p95 on Android since 1.6.2.",
  },
  {
    n: "Web vitals",
    v: 88,
    c: "var(--green)",
    d: "+1",
    why: "LCP 1.9s · INP 184ms · CLS 0.06. Passing on 88% of loads; TTFB up slightly on Web.",
  },
  {
    n: "Stability",
    v: 71,
    c: "var(--amber)",
    d: "−6",
    why: "Crash-free sessions 99.62%, down 0.14pt. Android OOM in CartView + iOS NSInvalidArgument after 1.6.2.",
  },
  {
    n: "Conversion",
    v: 64,
    c: "var(--red)",
    d: "−9",
    why: "Checkout completion 8.5%, down from 11.2%. 51% abandon at payment on Android since 1.6.2.",
  },
];
export const HEALTH_TREND = [79, 80, 80, 81, 82, 81, 80, 79, 82, 82];

export type Evidence = {
  key: string;
  ic: string;
  label: string;
  chip: string;
  big: string;
  d: string;
  sp: number[];
  col: string;
};
export const EVIDENCE: Evidence[] = [
  {
    key: "sessions",
    ic: "rec",
    label: "Replay",
    chip: "Replay · 3,180",
    big: "3,180 sessions",
    d: "92% abandoned right after the payment step · Android only",
    sp: [40, 60, 90, 140, 200, 260, 318],
    col: "#e79aa8",
  },
  {
    key: "funnel",
    ic: "funnel",
    label: "Funnel",
    chip: "Funnel · −51%",
    big: "−51% step drop",
    d: "Checkout Started → Purchase abandon rose from 44% to 51% post-1.6.2",
    sp: [44, 45, 46, 47, 49, 50, 51],
    col: "#e79aa8",
  },
  {
    key: "crash",
    ic: "warn",
    label: "Crash",
    chip: "Crash · +31%",
    big: "+31% OOM",
    d: "OutOfMemoryError in CartView · Android 14 · concentrated on <2GB RAM",
    sp: [30, 36, 40, 48, 60, 80, 98],
    col: "#e79aa8",
  },
  {
    key: "network",
    ic: "console",
    label: "Network",
    chip: "Network trace",
    big: "180ms → 2.4s",
    d: "/api/checkout p95 latency · request timeouts up 18% on Android",
    sp: [180, 300, 600, 1100, 1700, 2200, 2400],
    col: "#e79aa8",
  },
];

export type ConfFactor = {
  ic: string;
  n: string;
  d: string;
  w: "Strong" | "Moderate";
};
export const CONF_FACTORS: ConfFactor[] = [
  {
    ic: "rec",
    n: "Replay correlation",
    d: "3,180 sessions abandon at the same payment step",
    w: "Strong",
  },
  {
    ic: "console",
    n: "Deployment correlation",
    d: "Regression starts within 2h of the 1.6.2 rollout",
    w: "Strong",
  },
  {
    ic: "funnel",
    n: "Funnel correlation",
    d: "Checkout→Purchase drop aligns with the latency spike",
    w: "Strong",
  },
  {
    ic: "warn",
    n: "Crash correlation",
    d: "Android OOM rises on the same build, same screen",
    w: "Moderate",
  },
  {
    ic: "globe",
    n: "Network analysis",
    d: "/api/checkout p95 180ms→2.4s, timeouts +18%",
    w: "Strong",
  },
];

/* Inline signals feed (top 4) + the full paginated set for the drawer */
export type Signal = {
  sev: "bad" | "warn" | "good" | "info";
  ic: string;
  t: ReactNode;
  d: string;
  conf: number;
  tags: string[];
  time: string;
  act: string;
  // The AI-chosen action for this insight, carried from the backend so the button
  // does what the model decided (not a fixed "Investigate"). `titleText` is the
  // plain-string title (t is a ReactNode) for building an Investigate prompt.
  actionKind?: string;
  actionHref?: string;
  titleText?: string;
  /** Live resurfacing activity: how much this signal's source fired in the last
   *  `windowMins`. Present only when it fired recently. */
  recent?: { count: number; users: number; windowMins: number } | null;
  /** Stable row identity + the source rows the investigation panel reads from. */
  id?: number | string;
  incidentId?: number | null;
  issueId?: number | null;
  /** Impact, surfaced on the row rather than buried in the description. */
  sessions?: number;
  users?: number;
  /** Whole-number signed percent change vs the prior period. */
  deltaPct?: number;
};
export const FEED: Signal[] = [
  {
    sev: "bad",
    ic: "warn",
    t: (
      <>
        Checkout conversion down <b style={{ color: "var(--red)" }}>8.4%</b>{" "}
        since deploy <span className="mono">1.6.2</span>
      </>
    ),
    d: "p95 on /api/checkout rose 180ms → 2.4s on Android. 3,180 sessions abandoned at payment. Deploy 1.6.2 is the most likely cause.",
    conf: 92,
    tags: ["deploy 1.6.2", "/api/checkout"],
    time: "12m ago",
    act: "Investigate",
  },
  {
    sev: "bad",
    ic: "phone",
    t: (
      <>
        Android <b style={{ color: "var(--red)" }}>OOM crashes +31%</b> in{" "}
        <span className="mono">CartView</span>
      </>
    ),
    d: "OutOfMemoryError on Android 14 devices after 1.6.2. 98 crashes in 24h, concentrated on <2GB RAM devices during checkout.",
    conf: 90,
    tags: ["android", "oom", "1.6.2"],
    time: "38m ago",
    act: "Open crash",
  },
  {
    sev: "warn",
    ic: "cursor",
    t: (
      <>
        Safari rage clicks <b style={{ color: "var(--amber)" }}>+22%</b> on{" "}
        <span className="mono">Reset Password</span>
      </>
    ),
    d: "Concentrated on the new inline validation field. 410 users affected in the last 24h — no equivalent rise on Chrome.",
    conf: 74,
    tags: ["safari", "rage_click"],
    time: "1h ago",
    act: "View sessions",
  },
  {
    sev: "good",
    ic: "globe",
    t: (
      <>
        Android sessions <b style={{ color: "var(--green)" }}>+14%</b>{" "}
        week-over-week
      </>
    ),
    d: "Growth from the 1.6.1 rollout. No increase in crash rate on this path — healthy expansion.",
    conf: 88,
    tags: ["android", "growth"],
    time: "3h ago",
    act: "View cohort",
  },
];
export const MORE_INSIGHTS: Signal[] = [
  {
    sev: "good",
    ic: "users",
    t: (
      <>
        D7 retention improving —{" "}
        <b style={{ color: "var(--green)" }}>41% → 44%</b> for the March cohort
      </>
    ),
    d: "Users who reach a second session within 48h retain 2.3× better. Onboarding change on 1.6.0 correlates.",
    conf: 81,
    tags: ["retention", "onboarding"],
    time: "6h ago",
    act: "Open funnel",
  },
  {
    sev: "good",
    ic: "phone",
    t: (
      <>
        iOS cold start <b style={{ color: "var(--green)" }}>−12%</b> after 1.6.1
      </>
    ),
    d: "App Launch p95 dropped 1.9s → 1.6s on iOS. Startup trace shows the deferred-analytics change landed as expected.",
    conf: 79,
    tags: ["ios", "cold_start"],
    time: "9h ago",
    act: "View trace",
  },
  {
    sev: "info",
    ic: "globe",
    t: (
      <>
        Fastest-growing market: <b>India +31%</b> sessions
      </>
    ),
    d: "Driven by Android. Session length is 18% below the global median — worth a localized onboarding review.",
    conf: 85,
    tags: ["india", "growth"],
    time: "12h ago",
    act: "View cohort",
  },
  {
    sev: "warn",
    ic: "mega",
    t: (
      <>
        Push-open rate <b style={{ color: "var(--amber)" }}>−6%</b> on Android
        14
      </>
    ),
    d: "Notification Opened events down since the OS update changed channel defaults. iOS unaffected.",
    conf: 68,
    tags: ["android", "push"],
    time: "1d ago",
    act: "View events",
  },
  {
    sev: "good",
    ic: "cursor",
    t: (
      <>
        Deep-link opens <b style={{ color: "var(--green)" }}>+19%</b>{" "}
        week-over-week
      </>
    ),
    d: "Deep Link Opened → activation conversion holding at 41%. Campaign traffic is converting on par with organic.",
    conf: 77,
    tags: ["deep_link", "growth"],
    time: "1d ago",
    act: "View funnel",
  },
];
export const ALL_INSIGHTS: Signal[] = FEED.concat(MORE_INSIGHTS);
const _TW = [
  "just now",
  "8m ago",
  "15m ago",
  "32m ago",
  "1h ago",
  "2h ago",
  "4h ago",
  "6h ago",
  "9h ago",
  "14h ago",
  "18h ago",
  "22h ago",
  "1d ago",
  "1d ago",
  "2d ago",
  "2d ago",
];
export const INSIGHT_POOL: Signal[] = Array.from({ length: 24 }, (_, i) => ({
  ...ALL_INSIGHTS[i % ALL_INSIGHTS.length],
  time: _TW[i] || Math.ceil(i / 3) + "d ago",
}));

/* Deterministic signal rows (AI mode OFF) — measured facts only, no causal or
   confidence language. Same Signal shape so the drawer/list components render
   either set; `conf` is unused when the AI layer is hidden. */
export const DFEED: Signal[] = [
  {
    sev: "bad",
    ic: "warn",
    t: (
      <>
        Checkout conversion <b style={{ color: "var(--red)" }}>−2.7pt</b> vs
        previous period
      </>
    ),
    d: "8.5% end-to-end, down from 11.2%. 3,180 sessions ended at the payment step on Android.",
    conf: 0,
    tags: ["funnel", "android"],
    time: "12m ago",
    act: "Open funnel",
  },
  {
    sev: "bad",
    ic: "phone",
    t: (
      <>
        Android OOM crashes <b style={{ color: "var(--red)" }}>+31%</b> in{" "}
        <span className="mono">CartView</span>
      </>
    ),
    d: "98 crashes in 24h on Android 14, concentrated on <2GB RAM devices during checkout.",
    conf: 0,
    tags: ["android", "oom"],
    time: "38m ago",
    act: "Open crash",
  },
  {
    sev: "warn",
    ic: "cursor",
    t: (
      <>
        Safari rage clicks <b style={{ color: "var(--amber)" }}>+22%</b> on{" "}
        <span className="mono">Reset Password</span>
      </>
    ),
    d: "410 users affected in the last 24h. No equivalent rise on Chrome.",
    conf: 0,
    tags: ["safari", "rage_click"],
    time: "1h ago",
    act: "View sessions",
  },
  {
    sev: "good",
    ic: "globe",
    t: (
      <>
        Android sessions <b style={{ color: "var(--green)" }}>+14%</b>{" "}
        week-over-week
      </>
    ),
    d: "Crash rate on this path is flat while volume grows.",
    conf: 0,
    tags: ["android", "growth"],
    time: "3h ago",
    act: "View cohort",
  },
  {
    sev: "good",
    ic: "users",
    t: (
      <>
        D7 retention <b style={{ color: "var(--green)" }}>41% → 44%</b> for the
        March cohort
      </>
    ),
    d: "Users reaching a second session within 48h retain 2.3× better.",
    conf: 0,
    tags: ["retention"],
    time: "6h ago",
    act: "Open funnel",
  },
];

/* Releases rail — deploy markers already shown on the charts, listed with the
   measured movement after each rollout. `corr` is the AI-mode correlation tag. */
export type Release = {
  v: string;
  date: string;
  ago: string;
  note: string;
  bad?: boolean;
  corr?: string;
};
export const RELEASES: Release[] = [
  {
    v: "1.6.2",
    date: "Jun 19",
    ago: "6d ago",
    note: "Crashes +18% · checkout conversion −2.7pt since rollout",
    bad: true,
    corr: "Correlated with the checkout regression",
  },
  {
    v: "1.6.1",
    date: "Jun 11",
    ago: "14d ago",
    note: "iOS cold start −12% · crash-free steady at 99.7%",
  },
  {
    v: "1.6.0",
    date: "Jun 3",
    ago: "22d ago",
    note: "No metric moved beyond noise after rollout",
  },
];

export const FUNNEL: FunnelStep[] = [
  {
    name: "App Launch",
    ev: "App Launch",
    cnt: 48932,
    pct: 100,
    drop: 0,
    bad: false,
  },
  {
    name: "Product Viewed",
    ev: "Screen Viewed",
    cnt: 31204,
    pct: 63.8,
    drop: 36.2,
    bad: false,
  },
  {
    name: "Add to Cart",
    ev: "Button Tapped",
    cnt: 18760,
    pct: 38.3,
    drop: 39.9,
    bad: false,
  },
  {
    name: "Checkout Started",
    ev: "Checkout Started",
    cnt: 9140,
    pct: 18.7,
    drop: 51.3,
    bad: true,
  },
  {
    name: "Purchase",
    ev: "Checkout Completed",
    cnt: 4180,
    pct: 8.5,
    drop: 54.3,
    bad: false,
  },
];
export const FUNNEL_PREV = [100, 65.1, 40.4, 22.6, 11.2];

/* Crashlytics */
export const CRASH_STATS: [string, string, string, string][] = [
  ["Crash-free sessions", "99.62%", "−0.14pt", "down"],
  ["Crash-free users", "99.10%", "−0.21pt", "down"],
  ["ANR rate", "0.08%", "+0.02pt", "down"],
  ["Total crashes", "312", "+18%", "down"],
];
export type Crash = {
  n: string;
  s: string;
  p: string;
  /** Category (crash / exception / freeze / error) — drives the row's colour dot
   *  and the Stability category filter. Optional so demo fixtures can omit it. */
  cat?: import("./drawers/drawers.data").CrashCat;
  c: number;
  d: string;
  down?: boolean;
  note: string;
  sp: number[];
};
export const CRASHES: Crash[] = [
  {
    n: "NSInvalidArgumentException",
    s: "-[NSNull length] · CheckoutVC",
    p: "iOS 17 · 1.6.2",
    c: 142,
    d: "+64",
    note: "Started spiking right after Release 1.6.2",
    sp: [10, 14, 20, 28, 40, 80, 142],
  },
  {
    n: "OutOfMemoryError",
    s: "CartView.render allocation",
    p: "Android 14 · 1.6.2",
    c: 98,
    d: "+31",
    note: "Concentrated on <2GB RAM Android devices",
    sp: [30, 36, 40, 48, 60, 80, 98],
  },
  {
    n: "ANR · main thread",
    s: "blocked 5.2s · Checkout",
    p: "Android · 1.6.2",
    c: 41,
    d: "+12",
    note: "Main thread blocked during checkout call",
    sp: [18, 20, 22, 26, 30, 36, 41],
  },
  {
    n: "RangeError",
    s: "invalid array length",
    p: "Web · Safari 17",
    c: 18,
    d: "−4",
    down: true,
    note: "Declining — fix shipped in 1.6.1",
    sp: [26, 24, 22, 21, 20, 19, 18],
  },
  {
    n: "TypeError",
    s: "cannot read 'token'",
    p: "React Native · 1.6.2",
    c: 13,
    d: "+2",
    note: "Low volume, holding steady",
    sp: [8, 9, 10, 11, 12, 12, 13],
  },
];

/* Platform — real platforms only (no SDK granularity). Data-driven so a
   dimension with no report simply isn't rendered. */
export type PlatV3 = {
  browser: [string, number, string][];
  platform: [string, number, string][];
  country: [string, string, number, string][];
};
export const PLAT_V3: PlatV3 = {
  browser: [
    ["Chrome", 58, "+1.2"],
    ["Safari", 24, "+3.4"],
    ["Firefox", 9, "−0.8"],
    ["Edge", 6, "+0.3"],
    ["Other", 3, "—"],
  ],
  platform: [
    ["iOS", 46, "+2.1"],
    ["Android", 39, "+3.4"],
    ["Web", 15, "−1.2"],
  ],
  country: [
    ["🇺🇸", "United States", 44, "+0.9"],
    ["🇮🇳", "India", 17, "+31"],
    ["🇬🇧", "United Kingdom", 11, "+1.2"],
    ["🇩🇪", "Germany", 8, "−0.4"],
    ["🇧🇷", "Brazil", 6, "+8.7"],
  ],
};
export type PlatDetail = {
  name: string;
  share: number;
  sess: string;
  crashFree: string;
  ver: string;
  d: string;
};
export const PLAT_DETAIL: PlatDetail[] = [
  {
    name: "iOS",
    share: 46,
    sess: "22,510",
    crashFree: "99.4%",
    ver: "1.6.2 · 1.6.1",
    d: "+2.1",
  },
  {
    name: "Android",
    share: 39,
    sess: "19,080",
    crashFree: "98.7%",
    ver: "1.6.2 · 1.6.0",
    d: "+3.4",
  },
  {
    name: "Web",
    share: 15,
    sess: "7,342",
    crashFree: "99.9%",
    ver: "evergreen",
    d: "−1.2",
  },
];

export type Worst = {
  s: number;
  t: string;
  n: string;
  p: string;
  tags: [string, string][];
};
export const WORST: Worst[] = [
  {
    s: 18,
    t: "var(--red)",
    n: "Anonymous",
    p: "Android · 1.6.2",
    tags: [
      ["3 rage", "err"],
      ["2 err", "warn"],
    ],
  },
  {
    s: 24,
    t: "var(--red)",
    n: "maria@acme.io",
    p: "iOS · 1.6.2",
    tags: [["1 crash", "err"]],
  },
  {
    s: 29,
    t: "var(--red)",
    n: "Anonymous",
    p: "Web · Safari",
    tags: [["4 rage", "err"]],
  },
  {
    s: 41,
    t: "var(--amber)",
    n: "priya@northwind.co",
    p: "Android · 1.6.1",
    tags: [["dead click", "warn"]],
  },
];
export const ASK_CHIPS = [
  "Why did checkout conversion drop?",
  "What changed after release 1.6.2?",
  "Worst crashes on Android this week",
  "Which cohort is retaining best?",
];

export const ASK_ROTATE = [
  "Why did checkout conversion drop?",
  "What changed in release 1.6.2?",
  "Compare iOS vs Android retention",
  "Show rage taps on Android",
  "Which cohort recovered fastest?",
];

/* Radial bar chart palette (concentric rings) */
export const RCOLS = [
  "#4546d9",
  "#5b5ceb",
  "#7b7cf0",
  "#9e9ff5",
  "#c4c5fa",
  "#dddefa",
];
