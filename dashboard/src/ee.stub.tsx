/* ============================================================================
   Open-source stub of the Enterprise Edition surface (see ee-contract.ts).

   This ships in the OPEN-SOURCE build, where the proprietary `src/ee/`
   directory is absent. Everything is off: the Ask assistant is a no-op, the
   billing tab and /billing/plans route disappear, and the app runs as a fully
   self-hostable product with unlimited usage and no metering.

   The cloud build replaces this at bundle time — vite.config.ts aliases "@ee"
   to src/ee/index.tsx when that file exists. Keep this in exact shape-sync with
   the EeSurface contract; the type annotation enforces it. */
import type { ReactNode } from "react";
import type { EeSurface } from "./ee-contract";

function AskPassthrough({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export const ee: EeSurface = {
  enabled: false,

  // Assistant — absent: provider is transparent, useAsk is inert, no Ask bar.
  hasAsk: false,
  AskProvider: AskPassthrough,
  useAsk: () => ({ openAsk: () => {}, close: () => {} }),
  AskBar: null,

  // Billing — absent: no panel, no route. Unlimited, unmetered.
  hasBilling: false,
  BillingPanel: null,
  ChangePlanRoute: null,
};
