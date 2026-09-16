import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EmptyState, EMPTY_ART } from "@/components/feedback";
import { Funnels } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import { PageFunnels } from "./builder/PageFunnels";
import { FnDetailSkeleton } from "./FnDetailSkeleton";
import { FunnelTemplateGallery } from "./FunnelTemplateGallery";
import { fnTemplate } from "./funnel-templates.data";
import {
  FN_NEW_SEED,
  adaptComputeSteps,
  type ApiFunnel,
  type ApiFunnelCompute,
} from "./funnels.data";

/** /funnels/:funnelId — the funnel builder/analysis detail.
 *  - "new" → an empty builder that persists via POST /v1/funnels on save.
 *  - <id>  → the saved funnel: its name, steps, conversion and per-step counts
 *            all come from a SINGLE GET /v1/funnels/:id/compute for the one
 *            opened funnel (never a per-funnel loop — see CLAUDE.md). */
/** The date-range preset that matches a saved funnel's conversion window, so
 *  the detail page opens over the same span the pinned dashboard widget
 *  computes. Only the presets the picker offers; an unusual window falls
 *  through to the builder's own default. */
function windowToPreset(windowDays: number): string | undefined {
  return { 7: "Last 7 days", 14: "Last 14 days", 30: "Last 30 days" }[windowDays];
}

export function FunnelDetail() {
  const { funnelId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isNew = funnelId === "new";
  const id = funnelId ?? "";

  // Single compute for the one opened funnel — carries name + resolved steps +
  // real counts in one call. Disabled for the "new" builder.
  const { data, loading, stale, error } = useApi<ApiFunnelCompute>(
    () => Funnels.compute<ApiFunnelCompute>(id),
    [id],
    { enabled: !isNew && !!id },
  );
  // The `pinned` flag is on the funnel SUMMARY (not the compute payload), so we
  // read it with one GET /v1/funnels/:id for the one opened funnel (single call,
  // never a per-funnel loop) to seed the "Pin to dashboard" button correctly.
  const {
    data: summary,
    loading: summaryLoading,
    stale: summaryStale,
  } = useApi<ApiFunnel>(
    () => Funnels.get<ApiFunnel>(id),
    [id],
    { enabled: !isNew && !!id },
  );

  if (isNew) {
    const startScratch = searchParams.get("start") === "scratch";
    const tpl = fnTemplate(searchParams.get("template") ?? "");
    // /funnels/new with no choice yet → the template gallery (scratch or a
    // ready-made funnel). A ?start=scratch or ?template=<id> param opens the
    // builder, pre-filled from the template when one was picked.
    if (!startScratch && !tpl)
      return (
        <FunnelTemplateGallery
          onScratch={() => navigate("/funnels/new?start=scratch")}
          onPick={(tid) => navigate("/funnels/new?template=" + tid)}
          onBack={() => navigate("/funnels")}
        />
      );
    return (
      <PageFunnels
        mode="new"
        funnelName={tpl?.name ?? ""}
        // A template seeds real step rows (counts fill in via the live preview);
        // scratch opens the single empty row. No fabricated numbers either way.
        initialSteps={(tpl?.steps ?? FN_NEW_SEED).map((s) => ({ ...s }))}
        initialWindow={tpl?.windowDays ?? 7}
        // A template can pre-select the analysed date range (e.g. "Referring
        // domain (last 14 days)") and a breakdown dimension (e.g. by browser),
        // so it opens showing exactly what its name promises.
        initialDateRange={tpl?.dateRange}
        initialBreakdown={tpl?.breakdown}
        onCreated={(newId) => navigate("/funnels/" + newId, { replace: true })}
        onBack={() => navigate("/funnels")}
      />
    );
  }

  // COLD load only — stand in for the page instead of the blank `.wrap` it used
  // to hold for the whole compute. `loading` is a genuinely empty cache;
  // `stale` means `data` is still the PREVIOUS :funnelId's compute, held by
  // keepPreviousData while this one resolves — that has to be skeletoned too,
  // because PageFunnels seeds its state from initialSteps at mount and `key` is
  // already the new id, so funnel B would keep funnel A's name and steps for
  // good. A background refetch of the SAME funnel reports via `syncing`, which
  // is deliberately absent here: a populated page stays populated.

  // A bad or deleted funnel id — the compute 404s (or otherwise settles with no
  // data). Render a real not-found page with a way back, not the blank div it
  // used to hold. Checked BEFORE the skeleton so an errored id resolves to this
  // rather than an endless skeleton; the `!data` case below catches a settled
  // empty compute that carried no error.
  const notFound = (
    <div className="wrap rd-page fn">
      <EmptyState
        art={EMPTY_ART.funnels}
        title="Funnel not found"
        desc="This funnel doesn’t exist or was deleted. It may have been removed by someone on your team."
        actions={[
          {
            label: "Back to funnels",
            primary: true,
            onClick: () => navigate("/funnels"),
          },
        ]}
      />
    </div>
  );
  if (error) return notFound;
  // Also wait for the SUMMARY (GET /funnels/:id) — it carries the saved `filter`
  // (+ pinned/createdByAi). PageFunnels seeds those from props ONCE at mount via
  // lazy useState, so mounting before summary resolves left the "Filtered by" bar
  // empty even though the funnel was saved WITH a filter. `compute` is the warm
  // precomputed path and often lands first; gate on summary too so initialFilter
  // is present at first mount. `summaryStale` (keepPreviousData placeholder) is
  // required alongside `summaryLoading`: on funnel→funnel nav the summary query
  // isn't pending — it serves the PREVIOUS funnel's data — so without the stale
  // gate the builder could mount seeded with the previous funnel's filter.
  if (loading || stale || summaryLoading || summaryStale)
    return <FnDetailSkeleton onBack={() => navigate("/funnels")} />;
  // Mount the builder only once real steps/counts are in hand, so no fixture
  // data ever flashes. `key` remounts it when navigating between funnels.
  if (!data) return notFound;

  return (
    <PageFunnels
      key={id}
      funnelId={Number(id)}
      funnelName={data.name || "Funnel"}
      initialSteps={adaptComputeSteps(data)}
      // Seed the builder's window from the saved funnel so the metric/compare
      // re-compute (a preview over the resolved steps) matches the counts the
      // single GET /compute already returned.
      initialWindow={data.windowDays}
      // AND seed the DATE RANGE from the same saved window, so the detail page
      // opens over the exact period the pinned dashboard widget shows. Without
      // this the page fell back to a hardcoded "Last 30 days" (PageFunnels) while
      // the pinned widget's GET /compute uses the saved N-day window — so the
      // same funnel read two different numbers whenever sessions existed outside
      // the last 30/N days. Maps the common windows to their preset; anything
      // else keeps the builder's default rather than inventing a custom range.
      initialDateRange={windowToPreset(data.windowDays)}
      initialPinned={summary?.pinned ?? false}
      // The saved segment, from GET /funnels/:id (same fetch as pinned). Rebuilds
      // the filter chips so the bar shows what the funnel actually computes with,
      // instead of an empty bar over a filtered result.
      initialFilter={summary?.filter ?? null}
      // Real per-step insights + reached-session samples from the SAME GET
      // /compute that seeded the steps — so the builder opens fully populated
      // and does NOT need to fire a live preview on load just to fill them in.
      initialInsights={data.insights ?? null}
      initialSampleIds={Array.isArray(data.dropOffSessionIds) ? data.dropOffSessionIds : []}
      // Provenance from GET /funnels/:id (same fetch as pinned/filter) — badges
      // the title "Created with Replayfy AI" when the assistant built the funnel.
      initialCreatedByAi={summary?.createdByAi ?? false}
      onBack={() => navigate("/funnels")}
    />
  );
}
