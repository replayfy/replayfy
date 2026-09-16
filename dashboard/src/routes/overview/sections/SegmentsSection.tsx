import { Icon } from "@/components/primitives";
import { DistBar, type DistRow } from "../viz/DistBar";
import type { SegmentsDims } from "../segments.api";
import { SkSegBands } from "./OverviewSkeletons";
import { TrafficSources } from "./TrafficSources";

/** The dimension keys a breakdown can open for. */
export type SegmentDim = "Platform" | "Browser" | "Country";

/* ============================================================================
   SegmentsSection — where sessions come from: platform + country distribution
   bands, plus a tabbed Traffic-sources panel (Referrers / Sources / Media /
   Campaigns) in place of the old Browser band. The full band table lives in the
   breakdown panel. Renders the REAL distribution (`data`) when present; falls
   back to the empty state for a workspace with no session data yet.
   ========================================================================== */

export function SegmentsSection({
  totalSessions,
  data,
  loading,
  onBreakdown,
  onRowOpen,
}: {
  totalSessions: number;
  /** Real platform/browser/country bands. Null → keep the demo fixture. */
  data?: SegmentsDims | null;
  /** /overview hasn't landed. Every row here multiplies its share by
   *  `totalSessions`, so until the session count is real so is nothing in the
   *  "n sessions" column. */
  loading?: boolean;
  /** Open the full breakdown for one dimension — the band itself is the
   *  affordance now (hover hint + click), so there's no header link. */
  onBreakdown: (dim: SegmentDim) => void;
  /** Deep-link a single legend row to the filtered recordings list (e.g. the
   *  "web" row → all web sessions). */
  onRowOpen?: (dim: SegmentDim, row: DistRow) => void;
}) {
  // Real bands only — a workspace with no session data shows the empty state
  // below, never a demo fixture. Browser is gone from the bands; its slot is now
  // the Traffic-sources panel.
  const total = data?.totalSessions ?? totalSessions;
  const dims = (
    data
      ? [
          { title: "Platform", rows: data.platform },
          { title: "Country", rows: data.country },
        ]
      : []
  ).filter((d) => d.rows.length);
  const hasTraffic =
    !!data &&
    (data.referrer.length > 0 ||
      data.source.length > 0 ||
      data.medium.length > 0 ||
      data.campaign.length > 0);

  return (
    <section className="ox-sec" aria-label="Segments">
      <div className="ox-sec-h">
        <span className="t">Segments</span>
        <span className="m">share of sessions · last 30 days</span>
        <span className="sp" />
      </div>
      {/* Ahead of the no-data branch — an unresolved read is not "no platform
          data reported". */}
      {loading ? (
        <SkSegBands titles={["Platform", "Country"]} />
      ) : dims.length || hasTraffic ? (
        // Platform · Country · Traffic-sources — one row, three columns.
        <div className="ox-segs">
          {dims.map((d) => (
            <DistBar
              key={d.title}
              title={d.title}
              rows={d.rows}
              totalSessions={total}
              // Only the real distribution (not the empty-workspace fixture)
              // has a breakdown to open, so the band is inert until data lands.
              onOpen={data ? () => onBreakdown(d.title as SegmentDim) : undefined}
              onRowOpen={
                data && onRowOpen
                  ? (row) => onRowOpen(d.title as SegmentDim, row)
                  : undefined
              }
            />
          ))}
          {data && hasTraffic && (
            <TrafficSources
              referrer={data.referrer}
              source={data.source}
              medium={data.medium}
              campaign={data.campaign}
            />
          )}
        </div>
      ) : (
        <div className="ox-none">
          <Icon name="globe" size={14} /> No platform data reported yet for this
          workspace.
        </div>
      )}
    </section>
  );
}
