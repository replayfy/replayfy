/* ============================================================================
   fn-influence.data.ts — the model behind "What's influencing conversion".

   The events and person-properties most correlated with COMPLETING a funnel
   (drivers) and with DROPPING OUT (blockers). Built from LIVE data via
   `/v1/funnels/:id/influence` (see endpoints.ts → `Funnels.influence`); the real
   issue-blockers still come from the funnel compute (insights.significant). This
   module only declares the shapes the response is cast to plus a formatter.
   ========================================================================== */

export type InflDir = "driver" | "blocker";
export type InflKind = "event" | "property" | "issue";

export type InflFactor = {
  id: string;
  label: string;
  kind: InflKind;
  icon: string;
  dir: InflDir;
  /** conversion of sessions WITH this signal vs WITHOUT it. */
  withPct: number;
  withoutPct: number;
  /** 0–100 correlation strength (|lift| normalised). */
  strength: number;
  confidence: "High" | "Medium" | "Low";
};

export type InflModel = {
  drivers: InflFactor[];
  blockers: InflFactor[];
  baselinePct: number;
  sessions: number;
};

export const inflPct = (v: number): string => Math.round(v * 100) + "%";
