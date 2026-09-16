/**
 * Semantic signal vocabulary for the Overview dashboard spine.
 *
 * Stored on `Signal.type` as a plain string so the vocabulary can grow without
 * a schema migration. Shared between the derivation job (Slice 0) and the
 * nightly clusterer (Slice 1), so it lives in its own module rather than as a
 * private member of either service.
 */
export const SignalType = {
  USER_FRUSTRATED: "user_frustrated",
  BACKEND_FAILURE: "backend_failure",
  SLOW_API: "slow_api",
  CRASH_DETECTED: "crash_detected",
  FORM_ABANDONMENT: "form_abandonment",
  NAVIGATION_LOOP: "navigation_loop",
  CONVERSION_SUCCESS: "conversion_success",
  CONVERSION_FAILURE: "conversion_failure",
  /// Positive/opportunity: users repeatedly visited a high-intent route
  /// (pricing, upgrade, export…) without converting — demand worth chasing.
  UNMET_DEMAND: "unmet_demand",
} as const;

export type SignalTypeValue = (typeof SignalType)[keyof typeof SignalType];

/** A contextual action the dashboard renders as a button on a signal/incident
 *  card. The USER drives it (nothing is auto-created); the set is tailored to
 *  the signal type so, e.g., "Create funnel" only appears where a funnel is
 *  actually meaningful. */
export interface SuggestedAction {
  kind:
    | "open_crash"
    | "create_funnel"
    | "view_sessions"
    | "view_cohort"
    | "investigate";
  label: string;
}

/**
 * Deterministic action affordances for a signal/incident type — no LLM, so this
 * costs nothing and never suggests a funnel the workspace won't need (the
 * owner's conservative call). Crash/error types point at the crash + sessions;
 * drop-off/journey types (abandonment, nav loop, conversion failure, unmet
 * demand) offer a funnel; everything else offers sessions + investigate.
 */
export function suggestedActionsForSignal(signalType: string): SuggestedAction[] {
  const openCrash: SuggestedAction = { kind: "open_crash", label: "Open crash" };
  const createFunnel: SuggestedAction = {
    kind: "create_funnel",
    label: "Create funnel",
  };
  const viewSessions: SuggestedAction = {
    kind: "view_sessions",
    label: "View sessions",
  };
  const viewCohort: SuggestedAction = { kind: "view_cohort", label: "View cohort" };
  const investigate: SuggestedAction = {
    kind: "investigate",
    label: "Investigate",
  };
  switch (signalType) {
    case SignalType.CRASH_DETECTED:
      return [openCrash, viewSessions];
    case SignalType.BACKEND_FAILURE:
    case SignalType.SLOW_API:
      return [investigate, viewSessions];
    case SignalType.FORM_ABANDONMENT:
    case SignalType.NAVIGATION_LOOP:
    case SignalType.CONVERSION_FAILURE:
      return [createFunnel, viewSessions];
    case SignalType.UNMET_DEMAND:
      return [createFunnel, viewCohort];
    case SignalType.CONVERSION_SUCCESS:
      return [viewCohort, viewSessions];
    case SignalType.USER_FRUSTRATED:
      return [viewSessions, investigate];
    default:
      return [viewSessions, investigate];
  }
}
