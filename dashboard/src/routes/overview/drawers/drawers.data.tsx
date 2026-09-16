/* ============================================================================
   drawers.data.tsx — fixtures for the Overview V3 drawers: full crash groups
   (infinite scroll) + the Ask investigation threads.
   ========================================================================== */
import type { ReactNode } from "react";

export type CrashSev = "Critical" | "High" | "Medium" | "Low";

/** Fine-grained kind of a crash-group, mirroring the backend `Issue.errorClass`.
 *  Lets the Crashlytics surfaces separate a fatal crash from a handled exception
 *  or a UI freeze (ANR) instead of lumping them all as "crashes". */
export type CrashCat = "crash" | "exception" | "freeze" | "error";

/** Display metadata per category — label + the one colour it's allowed to use.
 *  Matches the recordings "Crashes" tab convention (crash=red, exception=amber,
 *  freeze=violet) so the two surfaces read as one system. */
export const CAT_META: Record<
  CrashCat,
  { label: string; plural: string; color: string }
> = {
  crash: { label: "Crash", plural: "Crashes", color: "var(--red)" },
  exception: { label: "Exception", plural: "Exceptions", color: "var(--amber)" },
  freeze: { label: "Freeze", plural: "Freezes", color: "var(--hue-violet)" },
  error: { label: "Error", plural: "Errors", color: "var(--t3)" },
};

/** Per-category glyph (from the shared Icon set). A DISTINCT icon per kind so a
 *  crash / exception / freeze / error is scannable at a glance — each rendered
 *  in its category colour (see CAT_META). */
export const CAT_ICON: Record<CrashCat, string> = {
  crash: "crash",     // ShieldWarning — a fatal crash
  exception: "bolt",  // Lightning — a handled / thrown exception
  freeze: "clock",    // Clock — a UI freeze / ANR (hang)
  error: "issue",     // Bug — a non-fatal error
};

/** Map a backend `errorClass` to a display category. `anr` is the wire value for
 *  a UI freeze; anything unrecognised falls back to a plain non-fatal error. */
export function crashCatOf(errorClass: string | undefined): CrashCat {
  if (errorClass === "anr") return "freeze";
  if (errorClass === "crash") return "crash";
  if (errorClass === "exception") return "exception";
  return "error";
}

export type CrashSeed = {
  n: string;
  s: string;
  p: string;
  sev: CrashSev;
  /** Category (crash / exception / freeze / error). Optional so the demo
   *  fixtures don't each need one — real rows always carry it. */
  cat?: CrashCat;
  c: number;
  d: string;
  down?: boolean;
  rec: number;
  users: number;
  sp: number[];
};
export type PooledCrash = CrashSeed & { _id: number };

/* ---- Crashlytics: full crash groups (infinite scroll) ------------------ */
const _CRASH_SEED: CrashSeed[] = [
  {
    n: "NSInvalidArgumentException",
    s: "-[NSNull length] · CheckoutVC",
    p: "iOS 17 · 1.6.2",
    sev: "Critical",
    c: 142,
    d: "+64",
    rec: 138,
    users: 96,
    sp: [10, 14, 20, 28, 40, 80, 142],
  },
  {
    n: "OutOfMemoryError",
    s: "CartView.render allocation",
    p: "Android 14 · 1.6.2",
    sev: "Critical",
    c: 98,
    d: "+31",
    rec: 91,
    users: 74,
    sp: [30, 36, 40, 48, 60, 80, 98],
  },
  {
    n: "ANR · main thread",
    s: "blocked 5.2s · Checkout",
    p: "Android · 1.6.2",
    sev: "High",
    c: 41,
    d: "+12",
    rec: 39,
    users: 33,
    sp: [18, 20, 22, 26, 30, 36, 41],
  },
  {
    n: "RangeError",
    s: "invalid array length",
    p: "Web · Safari 17",
    sev: "Low",
    c: 18,
    d: "−4",
    down: true,
    rec: 12,
    users: 15,
    sp: [26, 24, 22, 21, 20, 19, 18],
  },
  {
    n: "TypeError",
    s: "cannot read 'token'",
    p: "React Native · 1.6.2",
    sev: "Medium",
    c: 13,
    d: "+2",
    rec: 11,
    users: 9,
    sp: [8, 9, 10, 11, 12, 12, 13],
  },
  {
    n: "IllegalStateException",
    s: "Fragment not attached",
    p: "Android 13 · 1.6.1",
    sev: "Medium",
    c: 11,
    d: "+1",
    rec: 9,
    users: 8,
    sp: [7, 8, 9, 10, 10, 11, 11],
  },
  {
    n: "EXC_BAD_ACCESS",
    s: "SIGSEGV · ImageCache",
    p: "iOS 16 · 1.6.0",
    sev: "Medium",
    c: 9,
    d: "−1",
    down: true,
    rec: 6,
    users: 7,
    sp: [12, 11, 10, 10, 9, 9, 9],
  },
  {
    n: "FlutterError",
    s: "setState after dispose",
    p: "Flutter · 1.6.2",
    sev: "Low",
    c: 7,
    d: "+3",
    rec: 5,
    users: 5,
    sp: [3, 4, 4, 5, 6, 6, 7],
  },
  {
    n: "NetworkOnMainThread",
    s: "StrictMode violation",
    p: "Android · 1.6.2",
    sev: "Low",
    c: 6,
    d: "0",
    rec: 4,
    users: 4,
    sp: [6, 6, 5, 6, 6, 6, 6],
  },
  {
    n: "UnhandledPromiseRejection",
    s: "checkout() timeout",
    p: "Web · Chrome 138",
    sev: "Medium",
    c: 6,
    d: "+2",
    rec: 5,
    users: 5,
    sp: [3, 3, 4, 4, 5, 5, 6],
  },
];
export const CRASH_POOL: PooledCrash[] = Array.from({ length: 22 }, (_, i) => {
  const b = _CRASH_SEED[i % _CRASH_SEED.length];
  const scale =
    i < _CRASH_SEED.length ? 1 : 0.7 - (i - _CRASH_SEED.length) * 0.02;
  return {
    ...b,
    c: Math.max(1, Math.round(b.c * scale)),
    rec: Math.max(1, Math.round(b.rec * scale)),
    _id: i,
  };
});
export const SEV_COLOR: Record<CrashSev, string> = {
  Critical: "var(--red)",
  High: "var(--amber)",
  Medium: "var(--t3)",
  Low: "var(--t4)",
};

/* ---- Ask Replayfy: investigation threads ------------------------------ */
export type AskThread = {
  q: string;
  steps: string[];
  answer: ReactNode;
  ev: [string, string][];
};
export const ASK_THREADS: Record<string, AskThread> = {
  "Why did conversion drop?": {
    q: "Why did checkout conversion drop?",
    steps: [
      "Scanned 48,932 sessions across all platforms",
      "Correlated the drop with the v1.6.2 deploy window",
      "Isolated the Checkout Started → Purchase step",
      "Traced /api/checkout latency on Android",
    ],
    answer: (
      <>
        Conversion fell <b style={{ color: "var(--red)" }}>8.4%</b> because{" "}
        <b>Android</b> checkout latency rose{" "}
        <span className="mono">180ms → 2.4s</span> after{" "}
        <span className="mono">v1.6.2</span>. 3,180 sessions abandoned at the
        payment step — <b>51%</b> of everyone who reached it. iOS and Web held
        steady.
      </>
    ),
    ev: [
      ["rec", "3,180 replays"],
      ["funnel", "Funnel −51%"],
      ["console", "/api/checkout trace"],
    ],
  },
};
export const DEFAULT_ASK = ASK_THREADS["Why did conversion drop?"];
