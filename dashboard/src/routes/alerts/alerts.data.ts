/* Alerts data — GET /v1/alerts shapes + the row model the list renders.
   No fixtures: every row on this page comes from the API. */
import { relTime } from "@/lib/format";

export type AlertKind =
  | "METRIC"
  | "ISSUE_RECURRENCE"
  | "INCIDENT_RECURRENCE"
  | "FUNNEL_CONVERSION";
export type AlertComparator = "ABOVE" | "BELOW" | "DROP_PCT";
export type IssueStatus = "OPEN" | "RESOLVED" | "IGNORED" | "REGRESSED";

/** The only providers the backend's parseDestinations accepts — anything else is
 *  dropped on save, so the channel picker must never offer one. */
export type DestProvider = "SLACK" | "PAGERDUTY" | "WEBHOOK";
export const DEST_PROVIDERS: DestProvider[] = ["SLACK", "PAGERDUTY", "WEBHOOK"];

/** Routing INTENT only — the URL/secret is resolved from WorkspaceIntegration at
 *  dispatch, so a destination here is a provider name, never a credential. */
export type AlertDestination = { provider: DestProvider; severity?: string };

/** GET /v1/alerts item (backend AlertsService.list + its resolved Issue). */
export type ApiAlert = {
  id: number;
  name: string;
  kind: AlertKind;
  metric: string | null;
  comparator: AlertComparator | null;
  threshold: number | null;
  issueId: number | null;
  issue: { id: number; title: string; status: IssueStatus } | null;
  /** FUNNEL_CONVERSION — the watched funnel + its comparison window (days). */
  funnelId: number | null;
  funnel: { id: number; name: string } | null;
  windowDays: number | null;
  emailEnabled: boolean;
  emailTo: string | null;
  destinations: unknown;
  active: boolean;
  lastValue: number | null;
  lastFiredAt: string | null;
  createdAt: string;
};

export type Alert = {
  id: number;
  name: string;
  kind: AlertKind;
  issue: { id: number; title: string; status: IssueStatus } | null;
  /** An ISSUE_RECURRENCE alert whose Issue no longer resolves (deleted, or in
   *  another workspace and correctly withheld). Rendered as-is, never guessed. */
  orphaned: boolean;
  /** METRIC / FUNNEL_CONVERSION — "Crashes above 10" / "Drops > 20% vs 7d".
   *  Null for issue subscriptions. */
  condition: string | null;
  /** FUNNEL_CONVERSION — the watched funnel, its window, and the raw comparator/
   *  threshold + recipient list, so the manage modal can seed its form. */
  funnel: { id: number; name: string } | null;
  windowDays: number | null;
  comparator: AlertComparator | null;
  threshold: number | null;
  /** Parsed from emailTo — the email recipients (empty = falls back to creator). */
  recipients: string[];
  dests: DestProvider[];
  emailEnabled: boolean;
  emailTo: string | null;
  active: boolean;
  /** relTime of lastFiredAt — "—" when it has never fired. */
  lastFired: string;
};

/** emailTo is stored comma-joined; split back into a clean recipient list. */
export function parseRecipients(emailTo: string | null): string[] {
  if (!emailTo) return [];
  return [
    ...new Set(
      emailTo
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

const METRIC_LABEL: Record<string, string> = {
  crashes: "Crashes",
  backendFail: "Backend failures",
  slowApi: "Slow API calls",
  frustrated: "Frustrated sessions",
  formAbandon: "Form abandonment",
  navLoop: "Navigation loops",
  convFailure: "Conversion failures",
  convSuccess: "Conversion successes",
  healthScore: "Health score",
};

/** Mirrors the server's tolerance: jsonb can arrive parsed OR as a string, and
 *  unknown providers are dropped rather than rendered as a channel that would
 *  never deliver. */
export function parseDestinations(raw: unknown): DestProvider[] {
  let val = raw;
  if (typeof val === "string") {
    try {
      val = JSON.parse(val);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(val)) return [];
  const out: DestProvider[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") continue;
    const p = String(
      (item as { provider?: unknown }).provider ?? "",
    ).toUpperCase() as DestProvider;
    if (DEST_PROVIDERS.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The funnel-conversion condition as a readable one-liner: DROP_PCT compares
 *  against the prior equal-length window; ABOVE/BELOW against a fixed %. */
export function funnelConditionText(
  comparator: AlertComparator | null,
  threshold: number | null,
  windowDays: number | null,
): string | null {
  if (threshold == null) return null;
  const w = windowDays ?? 7;
  if (comparator === "DROP_PCT")
    return `Conversion drops by more than ${threshold}% vs the previous ${w}d`;
  if (comparator === "BELOW")
    return `Conversion falls below ${threshold}% over the last ${w}d`;
  if (comparator === "ABOVE")
    return `Conversion rises above ${threshold}% over the last ${w}d`;
  return null;
}

/** API alert → the row the list renders. */
export function adaptAlert(a: ApiAlert): Alert {
  const metric = a.metric ? (METRIC_LABEL[a.metric] ?? a.metric) : null;
  const condition =
    a.kind === "METRIC" && metric && a.comparator && a.threshold != null
      ? `${metric} ${a.comparator === "ABOVE" ? "above" : "below"} ${a.threshold}`
      : a.kind === "FUNNEL_CONVERSION"
        ? funnelConditionText(a.comparator, a.threshold, a.windowDays)
        : null;
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    issue: a.issue,
    orphaned: a.kind === "ISSUE_RECURRENCE" && a.issue == null,
    condition,
    funnel: a.funnel,
    windowDays: a.windowDays,
    comparator: a.comparator,
    threshold: a.threshold,
    recipients: parseRecipients(a.emailTo),
    dests: parseDestinations(a.destinations),
    emailEnabled: a.emailEnabled,
    emailTo: a.emailTo,
    active: a.active,
    lastFired: relTime(a.lastFiredAt),
  };
}
