/* ============================================================================
   Enterprise Edition surface — the contract the OPEN CORE depends on.

   The dashboard is open-core: the agentic assistant (Ask) and the billing /
   subscription / AI-credit UI are proprietary and live under `src/ee/` (see
   src/ee/LICENSE), which is ABSENT from the open-source build. Core code never
   imports those files directly; it imports the `ee` object from the "@ee"
   alias, whose shape is fixed by the interface below.

   Two implementations satisfy this contract:
     • src/ee/index.tsx  — the real surface (proprietary, cloud build only).
     • src/ee.stub.tsx   — everything off (ships in the open-source build).
   vite.config.ts points "@ee" at the real barrel when src/ee/index.tsx exists
   and at the stub otherwise, mirroring the backend's optional-ee `require()`.

   So every ee touchpoint in core degrades to a safe default when ee is absent:
   no Ask panel, no billing tab, unlimited everything. This type lives in core
   (not ee/) precisely so the open build can reference it without the ee code. */
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";

/** A component the core renders through the ee surface — may be an eager
 *  component or a React.lazy() chunk (billing stays lazily code-split). */
type Renderable<P = Record<never, never>> =
  | ComponentType<P>
  | LazyExoticComponent<ComponentType<P>>;

/** Imperative handle the global Ask AI panel exposes to any page. */
export type AskController = { openAsk: (q?: string) => void; close: () => void };

export interface EeSurface {
  /** True only in the cloud build (real ee present). Handy for coarse gates. */
  enabled: boolean;

  /* ---- Agentic assistant — mirrors the backend ee/agent module ---------- */
  /** Whether the interactive Ask assistant exists in this build. */
  hasAsk: boolean;
  /** App-shell provider that owns the Ask chat stream + renders the floating
   *  panel. Stub is a transparent passthrough (renders children only). */
  AskProvider: ComponentType<{ children: ReactNode }>;
  /** Hook any page calls to open Ask. Stub returns no-ops, so callers need no
   *  guard. Bound once per build, so calling it unconditionally is hook-safe. */
  useAsk: () => AskController;
  /** Inline "ask a question" bar (Overview signals). null when ee is absent. */
  AskBar: ComponentType<{ onSubmit: (q: string) => void }> | null;

  /* ---- Billing / subscriptions / credits — mirrors backend ee/billing --- */
  /** Whether the hosted billing surface exists (Settings tab + /billing/plans). */
  hasBilling: boolean;
  /** The Settings "Billing" panel (lazy chunk). null when ee is absent. */
  BillingPanel: Renderable<{ openId?: string }> | null;
  /** The full-screen /billing/plans route element (lazy). null when ee absent. */
  ChangePlanRoute: Renderable | null;
}
