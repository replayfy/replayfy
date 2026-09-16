import { Icon } from "@/components/primitives";
import type { ApiFunnelCompute } from "../funnels.data";

type FnInsightsProps = {
  insights: ApiFunnelCompute["insights"] | null;
  /** Omitted for viewers, who can't use the assistant. */
  onAsk?: () => void;
};

/** "What's hurting conversion" (F6) — real issue→drop correlations carried on
 *  the funnel compute/preview response (insights.significant). Ports the legacy
 *  FunnelInsights card list. Renders only rows with affected sessions; when
 *  there's no signal it shows a neutral note + the "Ask AI why" affordance
 *  (never a fabricated reason). */
export function FnInsights({ insights, onAsk }: FnInsightsProps) {
  const sig = (insights?.significant ?? []).filter(
    (i) => i.affectedSessions > 0,
  );

  if (sig.length === 0) {
    return (
      <div className="fn-ins-empty">
        <span className="fn-ins-empty-t">
          No issue is significantly correlated with drop-off in this window yet.
        </span>
        {onAsk && (
          <button className="fn-rsn-l" style={{ opacity: 1 }} onClick={onAsk}>
            Ask AI why <Icon name="arrowR" size={11} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fn-ins">
      {/* The section header ("What's hurting conversion") lives in the funnel
          page's .fn-det-sub row (with the Ask-AI action), so it isn't repeated here. */}
      <div className="fn-ins-sub">
        Issues that correlate with sessions dropping out of the funnel.
        {insights && insights.totalDropDueToIssues > 0 && (
          <>
            {" "}
            ~<b>{insights.totalDropDueToIssues.toLocaleString()}</b> drop-offs
            are associated with issues.
          </>
        )}
      </div>
      <div className="fn-ins-list">
        {sig.map((i) => (
          <div className="fn-ins-card" key={i.type}>
            <div className="fn-ins-main">
              <div className="fn-ins-title">
                {i.title}
                {i.significant && (
                  <span className="fn-ins-sig">significant</span>
                )}
              </div>
              <div className="fn-ins-meta">
                {i.affectedSessions.toLocaleString()} affected session
                {i.affectedSessions === 1 ? "" : "s"}
                {i.lostConversions > 0 && (
                  <>
                    {" "}
                    &middot; ~{i.lostConversions.toLocaleString()} lost
                    conversion{i.lostConversions === 1 ? "" : "s"}
                  </>
                )}
              </div>
            </div>
            <div className="fn-ins-impact">
              <div
                className={`fn-ins-pct ${i.conversionImpactPct >= 40 ? "hi" : ""}`}
              >
                {i.conversionImpactPct}%
              </div>
              <div className="fn-ins-impact-l">impact</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
