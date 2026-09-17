/* ============================================================================
   Enterprise Edition surface — the contract the OPEN CORE depends on.

   The dashboard is open-core: only the billing / subscription / AI-credit UI is
   proprietary and lives under `src/ee/` (see src/ee/LICENSE), which is ABSENT
   from the open-source build. Core code never imports those files directly; it
   imports the `ee` object from the "@ee" alias, whose shape is fixed by the
   interface below. (The agentic Ask assistant is open-core — bring-your-own-key
   — and lives in src/routes/overview.)

   Two implementations satisfy this contract:
     • src/ee/index.tsx  — the real surface (proprietary, cloud build only).
     • src/ee.stub.tsx   — everything off (ships in the open-source build).
   vite.config.ts points "@ee" at the real barrel when src/ee/index.tsx exists
   and at the stub otherwise, mirroring the backend's optional-ee `require()`.

   So every ee touchpoint in core degrades to a safe default when ee is absent:
   no billing tab, unlimited everything. This type lives in core (not ee/)
   precisely so the open build can reference it without the ee code. */
import type { ComponentType, LazyExoticComponent } from "react";

/** A component the core renders through the ee surface — may be an eager
 *  component or a React.lazy() chunk (billing stays lazily code-split). */
type Renderable<P = Record<never, never>> =
  | ComponentType<P>
  | LazyExoticComponent<ComponentType<P>>;

export interface EeSurface {
  /** True only in the cloud build (real ee present). Handy for coarse gates. */
  enabled: boolean;

  /* ---- Billing / subscriptions / credits — mirrors backend ee/billing --- */
  /** Whether the hosted billing surface exists (Settings tab + /billing/plans). */
  hasBilling: boolean;
  /** The Settings "Billing" panel (lazy chunk). null when ee is absent. */
  BillingPanel: Renderable<{ openId?: string }> | null;
  /** The full-screen /billing/plans route element (lazy). null when ee absent. */
  ChangePlanRoute: Renderable | null;
}
