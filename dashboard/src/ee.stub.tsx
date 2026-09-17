/* ============================================================================
   Open-source stub of the Enterprise Edition surface (see ee-contract.ts).

   This ships in the OPEN-SOURCE build, where the proprietary `src/ee/`
   directory is absent. Billing is off: the billing tab and /billing/plans route
   disappear, and the app runs as a fully self-hostable product with unlimited
   usage and no metering. (The AI assistant is open-core and ships regardless.)

   The cloud build replaces this at bundle time — vite.config.ts aliases "@ee"
   to src/ee/index.tsx when that file exists. Keep this in exact shape-sync with
   the EeSurface contract; the type annotation enforces it. */
import type { EeSurface } from "./ee-contract";

export const ee: EeSurface = {
  enabled: false,

  // Billing — absent: no panel, no route. Unlimited, unmetered.
  hasBilling: false,
  BillingPanel: null,
  ChangePlanRoute: null,
};
