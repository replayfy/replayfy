import { useEffect, useState } from "react";
import { Icon } from "@/components/primitives";
import { DimMark } from "@/components/DimMark";
import type { DistRow } from "../viz/DistBar";

/* ============================================================================
   TrafficSources — where sessions came FROM, as a tabbed list of image-2 style
   filled-bar rows: Referrers (referring host) · Sources (utm_source) · Media
   (utm_medium) · Campaigns (utm_campaign). Each row is a proportional bar with a
   real favicon/glyph (never a colour) via the shared DimMark, the scheme-stripped
   label, and the exact session count.
   ========================================================================== */

const TABS = [
  { key: "referrer", dim: "referrer", label: "Referrers", empty: "No referrers recorded yet." },
  { key: "source", dim: "utmSource", label: "Sources", empty: "No campaign sources tagged yet." },
  { key: "medium", dim: "utmMedium", label: "Media", empty: "No campaign media tagged yet." },
  { key: "campaign", dim: "utmCampaign", label: "Campaigns", empty: "No campaigns tagged yet." },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function TrafficSources({
  referrer,
  source,
  medium,
  campaign,
}: {
  referrer: DistRow[];
  source: DistRow[];
  medium: DistRow[];
  campaign: DistRow[];
}) {
  const data: Record<TabKey, DistRow[]> = { referrer, source, medium, campaign };
  const [tab, setTab] = useState<TabKey>(
    () => TABS.find((t) => data[t.key].length)?.key ?? "referrer",
  );
  // Re-sync to the first populated tab when a refetch empties the selected one
  // (only on data change, so a manual click on an empty tab is respected).
  useEffect(() => {
    if (data[tab].length === 0) {
      const first = TABS.find((t) => data[t.key].length);
      if (first) setTab(first.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referrer, source, medium, campaign]);
  const rows = data[tab];
  const active = TABS.find((t) => t.key === tab)!;
  // Bar is relative to the top NAMED row (excluding the "Other" roll-up, which
  // would otherwise dominate the scale and flatten every real referrer).
  const maxCount = rows.reduce(
    (mx, r) => (r.label === "Other" ? mx : Math.max(mx, r.sessions ?? 0)),
    1,
  );

  return (
    <div className="ox-traffic" aria-label="Traffic sources">
      <div className="ox-traffic-tabs" role="tablist" aria-label="Traffic sources">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === tab}
            className={"ox-traffic-tab" + (t.key === tab ? " on" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {rows.length ? (
        <div className="ox-traffic-list" role="tabpanel">
          {rows.map((r) => {
            const count = r.sessions ?? 0;
            const pct = Math.max(2, Math.min(100, Math.round((count / maxCount) * 100)));
            return (
              <div className="ox-traffic-row" key={r.label}>
                <span className="fill" aria-hidden style={{ width: `${pct}%` }} />
                <DimMark dimension={active.dim} value={r.raw ?? r.label} />
                <span className="n" title={r.label}>
                  {r.label}
                </span>
                <span className="ct">{count.toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="ox-traffic-empty">
          <Icon name="globe" size={14} /> {active.empty}
        </div>
      )}
    </div>
  );
}
