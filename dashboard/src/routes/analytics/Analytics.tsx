import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, DatePicker } from "@/components/primitives";
import { EmptyState, EMPTY_ART } from "@/components/feedback";
import { useApi } from "@/api/useApi";
import { Dashboard } from "@/api/endpoints";
import { RANGE_PRESETS } from "./analytics.data";
import { Trends } from "./sections/Trends";
import { Retention } from "./sections/Retention";
import { WebVitals } from "./sections/WebVitals";
import { Breakdowns } from "./sections/Breakdowns";
import { EventsExplorer } from "./sections/EventsExplorer";

/* ============================================================================
   Analytics — the product-analytics hub. Sub-tabs: Trends, Retention,
   Web Vitals, Breakdowns, Events.

   The date range is SECTION-LEVEL: one picker in the header, shared across every
   tab (set once, applies everywhere). Compare-to-previous is Trends-only, so its
   toggle rides inside that same picker only on the Trends tab.

   Every screen runs on LIVE data from /v1/analytics/* (see endpoints.ts →
   `Analytics`); each section's *.data.ts holds only its shapes + formatters.
   ========================================================================== */

type Tab = { id: string; label: string; icon: string };

const TABS: Tab[] = [
  { id: "trends", label: "Trends", icon: "chartLine" },
  { id: "retention", label: "Retention", icon: "grid" },
  { id: "webvitals", label: "Web Vitals", icon: "gauge" },
  { id: "breakdowns", label: "Breakdowns", icon: "chartBar" },
  { id: "events", label: "Events", icon: "table" },
];

type DashCounts = { recordings: number; live: number; lastEventAt: string | null; lastEventDomain: string | null };

export function Analytics() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("trends");
  const [range, setRange] = useState("Last 30 days");
  const [compare, setCompare] = useState(false);

  // Truly-empty workspace (never captured a session) → the illustrated install
  // empty state, matching Crashlytics/Funnels. GET /v1/dashboard/counts is one
  // cached, indexed per-workspace aggregate (no scan), so this is cheap and
  // range-independent — a brand-new workspace, not merely "no data in this
  // window". `cold` (loading || stale) guards the workspace switch: on a switch
  // `counts` is still the PREVIOUS workspace's cached row with loading:false.
  const { data: counts, loading, stale } = useApi<DashCounts>(
    () => Dashboard.counts<DashCounts>(),
    [],
    { key: "dashboard-counts" },
  );
  const cold = loading || stale;
  if (!cold && counts && counts.recordings === 0)
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.analytics}
          title="Analytics"
          desc="Trends, retention, web vitals and breakdowns across everything your SDK captures — every event, session and property, sliceable the moment your first session lands."
          actions={[
            {
              label: "Install the SDK",
              primary: true,
              icon: "doc",
              onClick: () => navigate("/settings/install"),
            },
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/product-analytics",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
      </div>
    );

  return (
    <div className="wrap anl-page rd-page">
      <div className="head">
        <div className="head-l">
          <div className="title-row"><h1>Analytics</h1></div>
          <div className="sub">Explore trends, retention and breakdowns across everything your SDK captures.</div>
        </div>
        <div className="actions">
          <DatePicker
            value={range}
            onChange={setRange}
            align="right"
            presets={RANGE_PRESETS}
            compare={tab === "trends" ? compare : undefined}
            onCompareChange={tab === "trends" ? setCompare : undefined}
          />
        </div>
      </div>

      <div className="anl-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={"anl-tab" + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "trends" ? <Trends range={range} compare={compare} />
        : tab === "retention" ? <Retention range={range} />
        : tab === "webvitals" ? <WebVitals range={range} />
        : tab === "breakdowns" ? <Breakdowns range={range} />
        : <EventsExplorer range={range} />}
    </div>
  );
}
