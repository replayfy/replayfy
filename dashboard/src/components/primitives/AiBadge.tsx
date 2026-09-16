import { Icon } from "./Icon";

type AiBadgeProps = {
  label?: string;
};

/* "Created with Replayfy AI" provenance pill. Shown beside a funnel/cohort title
   (the funnels + cohorts list rows, the funnel builder breadcrumb, and the cohort
   scope banner) when the assistant created it (createdByAi). Deliberately static —
   it renders in list rows many times over, so no entrance animation (see the
   animation frequency rule); the sparkle already carries the "AI" read. */
export function AiBadge({ label = "Created with Replayfy AI" }: AiBadgeProps) {
  return (
    <span className="ai-badge" title={label}>
      <Icon name="spark" size={11} fill />
      <span>{label}</span>
    </span>
  );
}
