/**
 * The billing surface the OPEN CORE depends on — the only two things any core
 * (non-`ee/`) module calls on the billing service.
 *
 * In the cloud build the proprietary ee BillingService implements this interface
 * and is bound to the BILLING_SERVICE token. In the open-source build no
 * provider is bound, so the (@Optional) injection resolves to `undefined` and
 * every caller falls back to the unlimited default: record everything, meter
 * nothing.
 *
 * This lives in core (not ee/) precisely so the open build can reference the
 * token/type without the ee code being present.
 */
export const BILLING_SERVICE = Symbol("BILLING_SERVICE");

/**
 * Presence flag — bound (to `true`) only when the Enterprise billing module is
 * in the build. Core reads it with @Optional: `undefined` means the open-source
 * / self-hosted build, where AI is UNMETERED and UNLIMITED (no plan credits, no
 * daily token budget, no fail-closed metering breaker).
 *
 * Why a separate dependency-free token instead of reusing BILLING_SERVICE:
 * BillingService depends on LlmService, so if LlmService injected BILLING_SERVICE
 * it would form a DI cycle in the cloud build. This token is provided `useValue:
 * true` (no dependencies), so a consumer can detect "is billing present" without
 * pulling BillingService into its own construction.
 */
export const AI_METERING_ENABLED = Symbol("AI_METERING_ENABLED");

export interface BillingPort {
  /**
   * True → the workspace is over its plan and this session must NOT be recorded.
   * Open-source default (no billing bound): always false — nothing is capped.
   */
  shouldNotRecord(workspaceId: number): Promise<boolean>;

  /** Settle metered usage for the period (cron). Open-source default: no-op. */
  settleSweep(): Promise<void>;
}
