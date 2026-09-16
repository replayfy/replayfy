import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, type BlockerFunction } from "react-router-dom";
import { toast } from "sonner";
import { AiBadge, ConfirmDialog, DatePicker, Icon, NumberFlow, Popover, Select } from "@/components/primitives";
import { EmptyState, EMPTY_ART } from "@/components/feedback";
import { Funnels } from "@/api/endpoints";
import { ee } from "@ee";
import { useAuth } from "@/lib/auth";
import { deserializeFilters, fmtDur, fmtN, fnKind, fnMatch, fnOpsFor, serializeFilters } from "../funnels.helpers";
import { FN_SEED, FN_BDIMS, FN_FLABEL, FN_FKIND, FN_OPS, FN_FVALUES, toBackendSteps, type ApiFunnel, type ApiFunnelCompute, type ApiFunnelBreakdown, type ApiFunnelBreakdownBucket, type ApiFunnelTimeline, type ApiFunnelTimelinePoint, type FnStep, type FnFilter, type FnSettings } from "../funnels.data";
import { FnBars, FnBreakdown, FnTime, FnInsights } from "../charts";
import { FN_DATE_PRESETS, resolveDateRange, rangeDayCount } from "@/lib/date-ranges";
import { FnStepEditor, type EdPos } from "./FnStepEditor";
import { DropoffCohortModal } from "./DropoffCohortModal";
import { FunnelAlertModal } from "./FunnelAlertModal";
import { FnFilterButton } from "./FnFilterButton";
import { FnMenuBtn } from "./FnMenuBtn";

/* The per-step "View sessions" drill-down resolves at most the NEWEST
   INCIDENT_SCOPE_CAP (= 5,000) reached-session ids server-side
   (common/incident-scope.ts) — the recordings list can't be handed a 96k-id
   `IN (...)`. So the step reach-count (which is uncapped, e.g. 96,141) must NOT
   be printed as the button's promise: past the ceiling we say "newest 5,000",
   matching what actually opens. Keep this in sync with INCIDENT_SCOPE_CAP. */
const STEP_VIEW_CAP = 5000;

type PageFunnelsProps = {
  empty?: boolean;
  onBack?: () => void;
  funnelName?: string;
  /** Saved funnel id — present in "view" mode so Save persists via PATCH. */
  funnelId?: number;
  /** Real steps (compute counts) for a saved funnel, or a zeroed template for "new". */
  initialSteps?: FnStep[];
  /** A saved funnel's stored segment — rebuilt into filter chips on mount so
   *  the bar shows the filter the funnel actually computes with. */
  initialFilter?: Record<string, unknown> | null;
  /** Saved funnel's window (days) — seeds the builder so the metric/compare
   *  re-compute matches the single GET /compute that produced initialSteps. */
  initialWindow?: number;
  /** "new" persists via POST /v1/funnels and live-previews unsaved steps. */
  mode?: "view" | "new";
  /** Saved funnel's pinned flag (from the list summary / GET — compute omits it),
   *  so the "Pin to dashboard" button reflects real state on load. */
  initialPinned?: boolean;
  /** Template-seeded date-range preset (e.g. "Last 14 days"); defaults to the
   *  classic "Last 30 days" when a template doesn't pre-select one. */
  initialDateRange?: string;
  /** Template-seeded breakdown dimension key (FN_BDIMS). When set, the builder
   *  opens on the Breakdown tab pre-split by this dimension. */
  initialBreakdown?: string;
  /** Real insights + reached-session id samples from the saved funnel's GET
   *  /compute — so a loaded funnel shows them immediately WITHOUT a mount-time
   *  preview. */
  initialInsights?: ApiFunnelCompute["insights"] | null;
  initialSampleIds?: number[][];
  /** Saved funnel was created by the assistant — shows the "Created with
   *  Replayfy AI" badge beside the title. */
  initialCreatedByAi?: boolean;
  onCreated?: (id: number) => void;
};

export function PageFunnels({ empty, onBack, funnelName, funnelId, initialSteps, initialFilter, initialWindow, mode = "view", initialPinned, initialDateRange, initialBreakdown, initialInsights, initialSampleIds, initialCreatedByAi, onCreated }: PageFunnelsProps) {
  const navigate = useNavigate();
  const [steps, setSteps] = useState<FnStep[]>(initialSteps ?? FN_SEED);
  const isNew = mode === "new";
  const [sel, setSel] = useState(0);
  // A template that carries a breakdown dimension opens directly on the Breakdown
  // tab (pre-split), so the funnel shows exactly what its name promises.
  const [view, setView] = useState(initialBreakdown ? 'breakdown' : 'steps');
  const [metric, setMetric] = useState('sessions');
  const [compare, setCompare] = useState(false);
  // Previous-period series for the compare toggle: per-step counts + aggregates
  // from a second preview over the immediately-preceding equal-length window.
  // null when compare is off or the fetch hasn't landed (so deltas never fabricate).
  const [cmp, setCmp] = useState<{ counts: number[]; entered: number; overallConv: number } | null>(null);
  // Overall entry→last-step time for converters (ms) — real, from compute.
  const [convTime, setConvTime] = useState<{ p50: number | null; p95: number | null; n: number } | null>(null);
  // Which step's "create cohort from drop-off" modal is open (0-based; null = closed).
  const [dropoffStep, setDropoffStep] = useState<number | null>(null);
  // "Alert on this funnel" modal (open when true).
  const [alertOpen, setAlertOpen] = useState(false);
  // Compare isn't meaningful on the Breakdown tab (it's a single-period split by
  // dimension), so it's force-disabled there — greyed/blurred in the UI AND
  // treated as OFF by the compute effect + comparison chrome below. Everything
  // downstream reads `compareActive`; raw `compare` stays the toggle's own memory
  // so returning to Steps/Metric/Conversion restores the user's prior choice.
  const compareDisabled = view === 'breakdown';
  const compareActive = compare && !compareDisabled;
  // Real issue→drop correlations off the preview response (#6). null until a
  // compute lands (so we never fabricate a "what's hurting conversion" reason).
  const [insights, setInsights] = useState<ApiFunnelCompute["insights"] | null>(initialInsights ?? null);
  // Per-step sample of session ids that reached each step (from the compute) —
  // powers the "View sessions" drill-down into a scoped recordings list.
  const [sampleIds, setSampleIds] = useState<number[][]>(initialSampleIds ?? []);
  // Selected date range (#7, F7) — the DatePicker preset/custom label. Drives the
  // equal-length current + prior windows the Compare toggle previews over.
  const [dateRange, setDateRange] = useState(initialDateRange || 'Last 30 days');
  const [bdim, setBdim] = useState(initialBreakdown || 'platform');
  // Start with NO default filters (owner: a fresh funnel should not pre-apply
  // Platform/Country) — the user adds them via the redesigned filter palette.
  const [filters, setFilters] = useState<FnFilter[]>(() => deserializeFilters(initialFilter));
  const [settings, setSettings] = useState<FnSettings>({ window: String(initialWindow ?? 7), order: 'sequential', scope: 'session', repeat: 'any', firstOcc: false, unique: true });
  const [edit, setEdit] = useState<number | null>(null);
  const [edPos, setEdPos] = useState<EdPos | null>(null);
  const pipeRef = useRef<HTMLDivElement>(null);
  // Click-to-edit funnel title (#3) — seeded from the saved name (or a blank
  // "Untitled funnel" placeholder for a brand-new funnel).
  // New funnels start with an EMPTY title (the placeholder invites a name); the
  // owner requires a real title before save (see persist()/requireTitle).
  const [name, setName] = useState(funnelName || '');
  const nameInputRef = useRef<HTMLInputElement>(null);
  // A title counts as "unset" when blank or left as the default placeholder text.
  const requireTitle = () => {
    if (name.trim() && name.trim().toLowerCase() !== 'untitled funnel') return true;
    toast.warning('Give your funnel a title before saving.');
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
    return false;
  };
  // ── AI "Why did conversion drop?" (#6) — the per-step reason links fire a
  // grounded query at the real agent (POST /v1/agent/stream via useAskStream)
  // and stream the answer into a right-side drawer. No fixture: the streamed
  // narration + evidence come straight off the agent.
  // The ONE global assistant (the floating "Ask Replayfy AI" panel mounted at
  // app-shell level), not a second page-local transcript. Overview already
  // drives it the same way; the funnel page had grown its own parallel drawer
  // that opened an independent conversation, so a question here and a question
  // on Overview lived in two different threads.
  const { openAsk } = ee.useAsk();
  // The global panel only renders for contributors (viewers get a 403 from the
  // agent routes anyway), so the button must match — otherwise a viewer clicks
  // "Ask AI why" and nothing opens.
  const { can } = useAuth();
  // ── Dirty / draft state (#16) ──────────────────────────────────────────
  // A brand-new funnel is dirty from the start ("Save"); a loaded/saved funnel
  // opens clean ("Saved"). Every real mutation flips it dirty via the effect
  // below (step def / filters / settings) or directly (name edit). `saving`
  // is the in-flight flag for the explicit Save/create write.
  const [saved, setSaved] = useState(mode !== 'new');
  const [saving, setSaving] = useState(false);
  // Real pinned state — seeded from the loaded funnel; togglePin persists it.
  const [pinned, setPinned] = useState(!!initialPinned);
  const baselineRef = useRef<string | null>(null);
  // Definition signature — kind/matchType/value + filters + settings (NOT counts),
  // so merging real `cur` back into a step never re-triggers a compute or the
  // dirty flag.
  const stepSig = steps.map((st) => `${st.kind}|${st.matchType}|${st.value}`).join('~');
  const defSig = `${stepSig}¦${JSON.stringify(filters)}¦${JSON.stringify(settings)}`;
  // Mark the funnel dirty when its definition diverges from the loaded/last-saved
  // baseline. We compare to a captured baseline rather than skipping "the first
  // render" with a boolean — StrictMode double-invokes mount effects, which
  // consumed the old first-render flag and wrongly dirtied a freshly-loaded
  // funnel. This only ever marks dirty (never falsely clean), so a brand-new
  // funnel stays dirty via `saved`'s init until its first real Save.
  useEffect(() => {
    if (baselineRef.current === null) { baselineRef.current = defSig; return; }
    if (defSig !== baselineRef.current) setSaved(false);
  }, [defSig]);
  const fname = name;

  // Resolve the DatePicker label → an explicit [from, to] window (F7). Named
  // presets come from the shared resolver (so a fixed period like "Q1" or
  // "Yesterday" queries THAT window, not "last N days ending now"); a custom
  // "Mon D → Mon D" range is parsed to its inclusive span. `days` is the window
  // length the Compare toggle mirrors and the timeline endpoint keys off.
  const range = useMemo(() => {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // Custom span from the DatePicker. It carries an EXPLICIT year only when the
    // pick isn't the current year ("Nov 3, 2025 → Nov 20, 2025"); the year-less
    // form ("Jul 10 → Jul 15") is, by the picker's contract, the current year —
    // so a prior-year or New-Year-crossing pick no longer collapses to this year.
    const my = dateRange.match(/^(\w{3}) (\d+), (\d{4}) → (\w{3}) (\d+), (\d{4})$/);
    if (my) {
      const s = new Date(Number(my[3]), MON.indexOf(my[1]), Number(my[2])); s.setHours(0, 0, 0, 0);
      const e = new Date(Number(my[6]), MON.indexOf(my[4]), Number(my[5])); e.setHours(23, 59, 59, 999);
      const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
      return { from: s.getTime(), to: e.getTime(), days };
    }
    const m = dateRange.match(/^(\w{3}) (\d+) → (\w{3}) (\d+)$/);
    if (m) {
      const y = new Date().getFullYear();
      const s = new Date(y, MON.indexOf(m[1]), Number(m[2])); s.setHours(0, 0, 0, 0);
      const e = new Date(y, MON.indexOf(m[3]), Number(m[4])); e.setHours(23, 59, 59, 999);
      const days = Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
      return { from: s.getTime(), to: e.getTime(), days };
    }
    const r = resolveDateRange(dateRange);
    if (r) {
      const days = rangeDayCount(r);
      // "Last N …" presets are ROLLING windows ending NOW — exactly what the
      // funnel compute (GET /:id/compute, and the pinned dashboard widget) uses:
      // [now − windowDays, now]. resolveDateRange calendar-aligns them (start-of-
      // day N days ago → end-of-day today), which shifts the window ~1 day and
      // made the SAME funnel read different numbers here vs the dashboard. Fixed
      // periods (Today, Yesterday, Q1, a custom span) stay exactly as resolved.
      if (/^Last\s/i.test(dateRange)) {
        const now = Date.now();
        return { from: now - days * 86_400_000, to: now, days };
      }
      return { from: r.start.getTime(), to: r.end.getTime(), days };
    }
    // Fallback: last 30 days ending now.
    const now = Date.now();
    return { from: now - 30 * 86_400_000, to: now, days: 30 };
  }, [dateRange]);

  // A saved funnel opens with real counts + insights ALREADY painted from GET
  // /:id/compute (initialSteps/initialInsights). The live preview must NOT fire
  // on mount: it re-computes and would clobber those correct numbers (a visible
  // flash to 0 whenever the mount window disagreed) and is a redundant call —
  // compute already answered. This holds the loaded signature; the effect below
  // skips the preview while it's unchanged, and only goes live once the user
  // actually edits the definition / range / metric / compare. A `new` funnel has
  // no seeded compute, so it starts null and previews immediately.
  const seededPrevRef = useRef<string | null>(mode === "view" ? "" : null);
  const prevSig = `${defSig}¦${metric}¦${compareActive}¦${dateRange}`;

  // Live compute — a single POST /v1/funnels/preview over the VALID steps (empty
  // scaffold rows are ignored), for BOTH new and saved funnels. Re-runs whenever
  // the step definition, window, metric (sessions|users) or compare toggle change.
  // Merges the real per-step counts back onto the matching rows. When `compare`
  // is on, a second preview over the immediately-preceding equal-length window
  // supplies the previous-period series (▲/▼ deltas + FnBars ghost). Two calls
  // total per change — never a per-row loop.
  useEffect(() => {
    const valid = steps.filter((st) => st.value.trim());
    if (valid.length < 2) { setCmp(null); return; }
    // Skip the preview while the funnel still matches what GET /compute loaded —
    // capture the seeded signature on the first run, then bail on every run whose
    // signature equals it (covers React's StrictMode double-invoke too). The
    // moment anything diverges we clear the ref and preview live from then on.
    if (seededPrevRef.current !== null) {
      if (seededPrevRef.current === "") { seededPrevRef.current = prevSig; return; }
      if (seededPrevRef.current === prevSig) return;
      seededPrevRef.current = null;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const metricParam: "session" | "user" = metric === 'users' ? 'user' : 'session';
      const windowDays = Number(settings.window) || 7;
      const backendSteps = toBackendSteps(valid);
      // Serialize the filter chips into the shared FunnelFilter body so the
      // preview (and the compare series) narrow to the same segment the charts do.
      const filter = serializeFilters(filters);
      try {
        // Compare (F7): both the current and prior series are previewed over
        // explicit, equal-length windows derived from the selected date range —
        // current = [range.from, range.to], prior = the same-length span
        // immediately before it — so the ghost bars + Δ badges reflect the real
        // range (including fixed periods like Q1), not settings.window.
        // Compare OFF: the current series stays the relative windowDays preview.
        const curStart = range.from, curEnd = range.to, span = curEnd - curStart;
        // Both paths now analyse the SELECTED date range (fromTs/toTs from the
        // DatePicker) so changing the range actually refreshes the funnel data
        // (F8). windowDays stays the conversion window (time to complete).
        const cur = compareActive
          ? await Funnels.preview<ApiFunnelCompute>({ steps: backendSteps, metric: metricParam, filter, fromTs: curStart, toTs: curEnd })
          : await Funnels.preview<ApiFunnelCompute>({ steps: backendSteps, windowDays, metric: metricParam, filter, fromTs: curStart, toTs: curEnd });
        if (cancelled) return;
        const cs = cur.data.steps;
        // Write real counts + per-step time-to-reach back onto the non-empty
        // rows, in order; empty rows → 0/null.
        setSteps((prev) => { let vi = 0; return prev.map((st) => {
          if (!st.value.trim()) return { ...st, cur: 0, p50Reach: null, p95Reach: null, reachN: 0 };
          const c = cs[vi++];
          return { ...st, cur: c?.count ?? 0, p50Reach: c?.medianTimeToReachMs ?? null, p95Reach: c?.p95TimeToReachMs ?? null, reachN: c?.timeSampleSize ?? 0 };
        }); });
        setConvTime({ p50: cur.data.medianTimeToConvertMs ?? null, p95: cur.data.p95TimeToConvertMs ?? null, n: cur.data.convertTimeSampleSize ?? 0 });
        // Real "what's hurting conversion" signal for this segment (#6).
        setInsights(cur.data.insights ?? null);
        // Per-step reached-session id samples → the "View sessions" drill-down.
        setSampleIds(Array.isArray(cur.data.dropOffSessionIds) ? cur.data.dropOffSessionIds : []);
        if (compareActive) {
          const prevRes = await Funnels.preview<ApiFunnelCompute>({ steps: backendSteps, metric: metricParam, filter, fromTs: curStart - span, toTs: curStart });
          if (cancelled) return;
          const pc = prevRes.data.steps.map((x) => x.count);
          setCmp({ counts: pc, entered: prevRes.data.startedFunnel, overallConv: prevRes.data.overallConversionPct });
        } else {
          setCmp(null);
        }
      } catch { /* keep the last good numbers on a transient failure */ }
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepSig, settings.window, metric, compareActive, filters, range]);

  // ── Breakdown (#7) — split conversion by a dimension (device/country/…) ──
  // Only fetched when the Breakdown tab is active AND the funnel is ready
  // (≥2 valid steps). Debounced; a single POST /v1/funnels/breakdown per change
  // (never per-bucket). Real buckets replace the fixtures in FnBreakdown.
  const [bd, setBd] = useState<ApiFunnelBreakdownBucket[] | null>(null);
  useEffect(() => {
    if (view !== 'breakdown') return;
    const valid = steps.filter((st) => st.value.trim());
    if (valid.length < 2) { setBd(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await Funnels.breakdown<ApiFunnelBreakdown>({
          steps: toBackendSteps(valid),
          windowDays: Number(settings.window) || 7,
          // Analysed period from the DatePicker — the breakdown was ignoring the
          // date filter entirely (no fromTs/toTs sent, and `range` wasn't even in
          // this effect's deps), so it always showed the relative-window result.
          fromTs: range.from,
          toTs: range.to,
          filter: serializeFilters(filters),
          dimension: bdim,
          metric: metric === 'users' ? 'user' : 'session',
          topN: 20,
        });
        if (!cancelled) setBd(res.data.buckets ?? []);
      } catch { if (!cancelled) toast.error("Couldn't compute breakdown"); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, bdim, stepSig, settings.window, metric, filters, range]);

  // ── Conversion over time (#8) — daily-bucketed conversion timeline ──
  // Only fetched when the "Conversion over time" tab is active AND ready.
  // Debounced; a single POST /v1/funnels/timeline per change. `range` carries
  // the window (the timeline endpoint keys off range, not windowDays).
  const [tl, setTl] = useState<ApiFunnelTimelinePoint[] | null>(null);
  useEffect(() => {
    if (view !== 'time') return;
    const valid = steps.filter((st) => st.value.trim());
    if (valid.length < 2) { setTl(null); return; }
    let cancelled = false;
    const windowDays = Number(settings.window) || 7;
    const t = setTimeout(async () => {
      try {
        const res = await Funnels.timeline<ApiFunnelTimeline>({
          steps: toBackendSteps(valid),
          // windowDays = the conversion window; the absolute [fromTs,toTs] from
          // the DatePicker = the analysed period. Previously only `range.days`
          // (a relative day-count) was sent, so a custom/fixed range was ignored
          // and the chart always showed the last-N-days window.
          windowDays,
          range: `${range.days}d`,
          fromTs: range.from,
          toTs: range.to,
          // Honour the Sessions/Users toggle here too — it drove the steps and
          // breakdown queries but the over-time chart ignored it entirely.
          metric: metric === "users" ? "user" : "session",
          filter: serializeFilters(filters),
        });
        if (!cancelled) setTl(res.data.points ?? []);
      } catch { if (!cancelled) toast.error("Couldn't compute conversion over time"); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stepSig, settings.window, metric, filters, range]);

  // Save = create (new) or update (existing). Step names are synthesized from
  // each step's value in toBackendSteps (the design has no per-step name field).
  const persist = async () => {
    // Empty scaffold rows are dropped on save — the backend requires ≥2 steps,
    // each with a value, so we only persist the valid ones.
    const valid = steps.filter((st) => st.value.trim());
    if (valid.length < 2) { toast.warning('A funnel needs at least 2 steps, each with a value.'); return; }
    if (!requireTitle()) return;
    const nm = name.trim();
    setSaving(true);
    try {
      if (isNew) {
        // Name comes from the inline-editable title (#3), pinned from the toggle (#10).
        const res = await Funnels.create<ApiFunnel>({ name: nm, steps: toBackendSteps(valid), windowDays: Number(settings.window), pinned, filter: serializeFilters(filters) });
        setSaved(true); setSaving(false); baselineRef.current = defSig; dirtyRef.current = false;
        toast.success('Funnel saved');
        onCreated?.(res.data.id);
      } else if (funnelId != null) {
        // TODO(api): counts shown are from the initial compute; after an edit+save
        // they refresh on next navigation/reload (no re-compute wired here).
        await Funnels.update<ApiFunnel>(String(funnelId), { name: nm, steps: toBackendSteps(valid), windowDays: Number(settings.window), pinned, filter: serializeFilters(filters) });
        setSaved(true); setSaving(false); baselineRef.current = defSig; dirtyRef.current = false;
        toast.success('Funnel saved');
      }
    } catch (e) {
      setSaving(false);
      toast.error('Save failed: ' + (e instanceof Error ? e.message : 'error'));
    }
  };

  // Pin/unpin to the dashboard (#10). For a saved funnel it PATCHes pinned
  // immediately (optimistic, reverts on failure). For a brand-new funnel with
  // ≥2 valid steps it creates-then-pins in one call; otherwise it stashes the
  // choice locally so the pin rides along on the next explicit Save.
  const togglePin = async () => {
    const next = !pinned;
    if (funnelId != null) {
      setPinned(next);
      try {
        await Funnels.update<ApiFunnel>(String(funnelId), { pinned: next });
        toast.success(next ? 'Pinned to dashboard' : 'Unpinned from dashboard');
      } catch (e) {
        setPinned(!next);
        toast.error('Could not update pin: ' + (e instanceof Error ? e.message : 'error'));
      }
      return;
    }
    const valid = steps.filter((st) => st.value.trim());
    if (isNew && valid.length >= 2 && requireTitle()) {
      setPinned(next); setSaving(true);
      try {
        const res = await Funnels.create<ApiFunnel>({ name: name.trim(), steps: toBackendSteps(valid), windowDays: Number(settings.window), pinned: next });
        setSaved(true); setSaving(false); baselineRef.current = defSig; dirtyRef.current = false;
        toast.success(next ? 'Pinned to dashboard' : 'Saved');
        onCreated?.(res.data.id);
      } catch (e) {
        setPinned(!next); setSaving(false);
        toast.error('Could not pin: ' + (e instanceof Error ? e.message : 'error'));
      }
    } else {
      // Not yet persistable — keep the choice; it's included on Save. Dirty.
      setPinned(next); setSaved(false);
    }
  };

  // Only filled rows drive the viz — empty scaffold rows are ignored. The charts
  // + stats gate on ≥2 valid steps (below that we show a prompt, not fixtures).
  const vsteps = steps.filter((st) => st.value.trim());
  const ready = vsteps.length >= 2;
  // #3/F3 — a funnel is only saveable/pinnable once it has a real title (not
  // blank, not the "Untitled funnel" placeholder) AND ≥2 valid steps.
  const titleOk = name.trim() !== "" && name.trim().toLowerCase() !== "untitled funnel";
  const canSave = ready && titleOk;
  const saveHint = !titleOk ? "Name your funnel first" : !ready ? "Add at least 2 steps with a value" : "";

  // ── Unsaved-changes guard ─────────────────────────────────────────────────
  // Warn before leaving the builder with pending edits. "Dirty" = not saved and
  // there's real content to lose (a titled funnel OR ≥1 valued step) — a blank,
  // untouched new builder never prompts. Guards BOTH exits: in-app navigation
  // (useBlocker — the app is a data router) and a browser tab close / hard reload
  // (beforeunload). A ref mirrors the flag so persist() can clear it right before
  // the post-save navigation (onCreated → navigate) and not block its own success.
  const isDirty =
    !saved && !saving && (titleOk || steps.some((st) => st.value.trim()));
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;
  // Location-AWARE on purpose: only block a real route change AWAY from the
  // builder. A bare always-block predicate also traps react-router's own
  // same-path navigations (search-param replaces, revalidations). The router
  // keeps a SINGLE global blocker slot, so one left wedged there silently
  // swallows every later navigation app-wide until a hard reload.
  const blocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
      [],
    ),
  );
  // Release the blocker the moment the page goes clean while a prompt is open
  // (e.g. a save cleared the dirty flag mid-navigation) so it can't linger in
  // "blocked".
  useEffect(() => {
    if (blocker.state === "blocked" && !isDirty) blocker.reset();
  }, [blocker, isDirty]);
  // Hard safety net: if this page ever unmounts while its blocker is still
  // "blocked", release it — a non-idle blocker on the shared router is exactly
  // what dead-locks all future links. A ref mirrors the live blocker so the
  // unmount-only cleanup reads the current one.
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(
    () => () => {
      if (blockerRef.current.state === "blocked") blockerRef.current.reset?.();
    },
    [],
  );
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  const clampSel = Math.min(sel, Math.max(0, vsteps.length - 1));
  const s = vsteps[clampSel]; // defined whenever `ready` (guards the detail block)
  // "View sessions" drill-down → recordings scoped to the (sampled) sessions
  // that reached step i, with a label for the scope banner.
  const viewStepSessions = (i: number) => {
    const st = vsteps[i];
    const label = st ? st.value || fnKind(st.kind).label : "";
    const p = new URLSearchParams();
    if (funnelId != null) {
      // Saved funnel → a server-resolved, keyset-PAGED scope (up to 5,000
      // reached sessions, a page at a time) instead of a fixed 200-id URL
      // sample that could never scroll past 200. Carries the analysed date
      // range so the drill-down matches exactly what the funnel view shows.
      p.set("funnel", String(funnelId));
      p.set("fstep", String(i));
      p.set("ffrom", String(range.from));
      p.set("fto", String(range.to));
    } else {
      // Unsaved builder preview — no id to resolve server-side, so fall back to
      // the per-step 200-id sample from the live preview.
      const ids = sampleIds[i] ?? [];
      if (ids.length) p.set("sessionIds", ids.join(","));
    }
    if (label) p.set("fnstep", label);
    const qsStr = p.toString();
    navigate("/recordings" + (qsStr ? `?${qsStr}` : ""));
  };
  // Grounded "why did conversion drop?" query for the selected step (#6). Names
  // the funnel, the adjacent steps and their values so the agent investigates
  // the real transition; opens the AI drawer and streams the answer.
  const askWhyDrop = () => {
    const desc = (st: FnStep) => `${fnKind(st.kind).label}${st.value ? ` "${st.value}"` : ''}`;
    const i = clampSel, cur = vsteps[i];
    let q: string;
    if (i === vsteps.length - 1) {
      q = `In the "${name}" funnel, what drives users to successfully reach the final step (${desc(cur)})? Summarize the winning paths and any late friction, grounded in real sessions.`;
    } else if (i > 0) {
      q = `Why did conversion drop between step ${i} (${desc(vsteps[i - 1])}) and step ${i + 1} (${desc(cur)}) in the "${name}" funnel? Ground the answer in real sessions and name the top causes.`;
    } else {
      q = `In the "${name}" funnel, why do users drop off between step 1 (${desc(cur)}) and step 2 (${desc(vsteps[1])})? Ground the answer in real sessions and name the top causes.`;
    }
    openAsk(q);
  };
  const vc0 = vsteps[0]?.cur ?? 0;
  const vLast = vsteps[vsteps.length - 1]?.cur ?? 0;
  const stepConv = clampSel > 0 && s ? (s.cur / (vsteps[clampSel - 1].cur || 1) * 100) : 100;
  const dropC = clampSel > 0 && s ? vsteps[clampSel - 1].cur - s.cur : 0;
  const dropP = clampSel > 0 && s ? (dropC / (vsteps[clampSel - 1].cur || 1) * 100) : 0;
  const overallConv = vc0 > 0 ? (vLast / vc0 * 100) : 0;
  // Biggest adjacent drop-off — derived from the real counts (was hardcoded).
  let bigDropPct = 0, bigDropFrom = 1;
  for (let k = 1; k < vsteps.length; k++) { const prev = vsteps[k - 1].cur; const d = prev > 0 ? ((prev - vsteps[k].cur) / prev) * 100 : 0; if (d > bigDropPct) { bigDropPct = d; bigDropFrom = k; } }
  // ── Compare deltas (real previous-period numbers, or null when off) ──
  const prevC0 = cmp?.counts[0] ?? 0;
  const prevLast = cmp ? (cmp.counts[cmp.counts.length - 1] ?? 0) : 0;
  let prevBigDrop = 0;
  if (cmp) for (let k = 1; k < cmp.counts.length; k++) { const p = cmp.counts[k - 1]; const d = p > 0 ? ((p - cmp.counts[k]) / p) * 100 : 0; if (d > prevBigDrop) prevBigDrop = d; }
  const dEntered = prevC0 > 0 ? ((vc0 - prevC0) / prevC0) * 100 : 0;
  const dConv = overallConv - (cmp?.overallConv ?? 0);
  const dConverted = prevLast > 0 ? ((vLast - prevLast) / prevLast) * 100 : 0;
  const dBigDrop = bigDropPct - prevBigDrop;
  // ▲/▼ badge — only when compare has a loaded previous period (never fabricated).
  const deltaBadge = (delta: number, unit: string) => {
    if (cmp == null || !isFinite(delta) || delta === 0) return null;
    const up = delta > 0;
    return <span className={`fn-cmp ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}{unit}</span>;
  };
  // step mutators
  const patchStep = (i: number, patch: Partial<FnStep>) => setSteps((a) => a.map((x, j) => j === i ? { ...x, ...patch } : x));
  const dupStep = (i: number) => setSteps((a) => { const n = [...a]; n.splice(i + 1, 0, { ...a[i] }); return n; });
  const delStep = (i: number) => setSteps((a) => a.length > 1 ? a.filter((_, j) => j !== i) : a);
  // anchored editor — fixed-position, clamped to viewport, flips upward near the bottom
  const repositionEd = useCallback((i: number) => {
    const el = pipeRef.current && pipeRef.current.querySelector(`[data-step-idx="${i}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 32);
    const left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left + r.width / 2 - w / 2));
    const up = r.bottom + 380 > window.innerHeight && r.top > 400;
    setEdPos({ left, w, up, top: up ? null : r.bottom + 10, bottom: up ? window.innerHeight - r.top + 10 : null, ax: r.left + r.width / 2 });
  }, []);
  const openEdit = (i: number) => { setSel(i); setEdit(i); requestAnimationFrame(() => repositionEd(i)); };
  useEffect(() => {
    if (edit == null) return;
    const h = () => repositionEd(edit);
    window.addEventListener('resize', h);
    window.addEventListener('scroll', h, true);
    return () => { window.removeEventListener('resize', h); window.removeEventListener('scroll', h, true); };
  }, [edit, repositionEd]);
  // #3 — on a brand-new funnel, open step 1's editor by default so users see it's
  // editable straight away (the step card must be laid out first, hence the tick).
  useEffect(() => {
    if (!isNew) return undefined;
    const t = setTimeout(() => openEdit(0), 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const addStepAt = (i: number) => { const ns: FnStep = { kind: 'page', matchType: 'contains', value: '', cur: 0 }; setSteps((a) => { const n = [...a]; n.splice(i, 0, ns); return n; }); setSel(i); setTimeout(() => openEdit(i), 40); };
  const moveStep = (from: number, to: number) => setSteps((a) => { if (to < 0 || to >= a.length) return a; const n = [...a]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n; });
  const dragRef = useRef<number | null>(null);
  // Drag-reorder visuals: `dragIdx` is the step being dragged (its slot becomes
  // a dashed drop-zone placeholder), `overIdx` is the slot the pointer is over
  // (gets a quiet accent cue). The native drag image is the floating card.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const endDrag = () => { dragRef.current = null; setDragIdx(null); setOverIdx(null); };


  // Early return kept below all hooks (Rules of Hooks) — same empty-state markup.
  if (empty) return <div className="wrap"><EmptyState art={EMPTY_ART.funnels}
    title="No funnels yet" desc="Define an ordered set of steps and Replayfy will show where users drop off and why. Create your first funnel to begin."
    actions={[{ label: 'New funnel', primary: true, icon: 'plus', kbd: ['N', 'F'], onClick: () => navigate('/funnels/new') }, { label: 'View docs' }]} /></div>;

  return (
    <div className="wrap rd-page fn">
      <div className="crumbs"><a onClick={onBack} style={{ cursor: onBack ? 'pointer' : 'default' }}>Funnels</a><span className="sep">/</span><span>{fname || 'Untitled funnel'}</span>{initialCreatedByAi && <AiBadge />}</div>
      {/* Unsaved-changes guard — fires on ANY in-app navigation away while the
          funnel is dirty (top-level so it renders regardless of step count). */}
      {blocker.state === "blocked" && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Leave without saving"
          cancelLabel="Keep editing"
          icon="logout"
          onConfirm={() => blocker.proceed?.()}
          onClose={() => blocker.reset?.()}
        >
          <p style={{ fontSize: "var(--text-base)", color: 'var(--t2)', lineHeight: "var(--lh-body)", margin: '0 0 var(--sp-18)' }}>
            You have unsaved edits to this funnel. If you leave now, they&rsquo;ll be lost.
          </p>
        </ConfirmDialog>
      )}
      <div className="head" style={{ alignItems: 'center' }}>
        <div className="head-l"><div className="title-row">
          {/* Inline-editable title (#3) — always an input; transparent until hover/focus. */}
          <input ref={nameInputRef} className="fn-title" value={name} placeholder="Untitled funnel" aria-label="Funnel name"
            onChange={(e) => { setName(e.target.value); setSaved(false); }} />
          <span className={`fn-saved ${saving ? 'saving' : saved ? '' : 'dirty'}`}><span className="dot" />{saving ? 'Saving…' : saved ? 'Saved' : 'Unsaved changes'}</span>
        </div></div>
        <div className="actions"><button className="btn" onClick={() => setAlertOpen(true)} disabled={funnelId == null || !saved} title={funnelId != null && saved ? 'Get notified when this funnel’s conversion changes' : 'Save the funnel to set up an alert'}><Icon name="bell" size={14} /> Alert</button><button className={`btn ${pinned ? 'on' : ''}`} onClick={togglePin} disabled={!canSave || saving} title={canSave ? (pinned ? 'Unpin from dashboard' : 'Pin to dashboard') : saveHint}><Icon name={pinned ? 'check' : 'funnel'} size={14} /> {pinned ? 'Pinned to dashboard' : 'Pin to dashboard'}</button><button className="btn primary" onClick={persist} disabled={saving || !canSave} title={canSave ? '' : saveHint}><Icon name={saved ? 'check' : 'plus'} size={14} /> {saving ? 'Saving…' : saved ? 'Saved' : isNew ? 'Save' : 'Save changes'}</button></div>
      </div>

      {/* definition — steps drive everything */}
      <section className="fn-def">
        <div className="fn-def-bar"><span className="fn-eyebrow">Funnel steps</span>
          <span className="sp" /><span className="mono" style={{ fontSize: "var(--text-xs)", color: 'var(--t3)' }}>{steps.length} steps</span></div>
        <div className="fn-rail fn2-rail" ref={pipeRef}>
          {steps.map((st, i) => {
            const k = fnKind(st.kind);
            const filled = k.ic === 'cursor' || k.ic === 'spark';
            return (
              <Fragment key={i}>
                {i > 0 && (
                  <div className="fn2-conn">
                    <svg className="fn2-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 3l5 5-5 5" /></svg>
                    <button className="fn2-ins" title="Insert step here" onClick={() => addStepAt(i)}><Icon name="plus" size={12} /></button>
                  </div>
                )}
                <div className={`fn2-step ${i === clampSel ? 'sel' : ''}${dragIdx === i ? ' fn2-dragging' : ''}${overIdx === i && dragIdx !== i ? ' fn2-drop' : ''}`} draggable data-step-idx={i}
                  onClick={(e) => { if ((e.target as HTMLElement).closest('.fn2-del') || (e.target as HTMLElement).closest('.fn2-grip')) return; openEdit(i); }}
                  onDragStart={(e) => { dragRef.current = i; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => setDragIdx(i), 0); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnter={() => { if (dragRef.current != null && dragRef.current !== i) setOverIdx(i); }}
                  onDragEnd={endDrag}
                  onDrop={(e) => { e.preventDefault(); if (dragRef.current != null && dragRef.current !== i) moveStep(dragRef.current, i); endDrag(); }}>
                  <div className="fn2-top">
                    <span className="fn2-badge">{i + 1}</span>
                    <span className="fn2-grip" title="Drag to reorder"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="3.5" cy="2.5" r="1"/><circle cx="8.5" cy="2.5" r="1"/><circle cx="3.5" cy="6" r="1"/><circle cx="8.5" cy="6" r="1"/><circle cx="3.5" cy="9.5" r="1"/><circle cx="8.5" cy="9.5" r="1"/></svg></span>
                    <span className="sp" style={{ flex: 1 }} />
                    {steps.length > 1 && <button className="fn2-del" title="Remove step" onClick={(e) => { e.stopPropagation(); if (edit === i) setEdit(null); delStep(i); }}><Icon name="trash" size={13} /></button>}
                  </div>
                  <div className="fn2-ev"><span className="fn2-ic"><Icon name={k.ic} size={14} fill={filled} /></span><span className="fn2-evt">{k.label}</span></div>
                  <div className="fn2-cond"><span className="op">{fnMatch(st.matchType)}</span> <span className="val">{st.value || <span className="any">any value</span>}</span></div>
                </div>
              </Fragment>
            );
          })}
          <button className="fn2-add" title="Add step" onClick={() => addStepAt(steps.length)}><span className="ring"><Icon name="plus" size={16} /></span><span className="txt">Add step</span></button>
          {edit != null && steps[edit] && edPos && <>
            <div className="fn-editback" onClick={() => setEdit(null)} />
            <FnStepEditor st={steps[edit]} idx={edit} pos={edPos}
              onChange={(p) => patchStep(edit, p)}
              onDup={() => { dupStep(edit); setEdit(null); }}
              onRemove={() => { delStep(edit); setEdit(null); }}
              canRemove={steps.length > 1}
              onClose={() => setEdit(null)} />
          </>}
        </div>
        <div className="fn-filters"><span style={{ fontSize: "var(--text-sm)", color: 'var(--t3)' }}>Filtered by</span>
          {filters.map((f, i) => (
            <Popover key={i} trigger={
              <span className="cond editable"><b>{FN_FLABEL[f.key] || f.key}</b><span className="op">{FN_OPS[f.op] || f.op}</span><span className="mono">{f.val || '…'}</span><span className="rm" onClick={(e) => { e.stopPropagation(); setFilters((a) => a.filter((_, j) => j !== i)); }}>×</span></span>
            }>
              <div className="fn-fedit">
                <div className="fn-fedit-h">{FN_FLABEL[f.key] || f.key}</div>
                {FN_FKIND[f.key] === "bool"
                  ? /* Boolean signal — one row of is-true / is-false (no operator step). */
                    <div className="fn-fedit-vals">{[["true", "is true"], ["false", "is false"]].map(([v, l]) => <button key={v} className={f.val === v ? 'on' : ''} onClick={() => setFilters((a) => a.map((x, j) => j === i ? { ...x, op: "is", val: v } : x))}>{l}</button>)}</div>
                  : <>
                    <div className="fn-fedit-ops">{fnOpsFor(f.key).map((o) => <button key={o} className={f.op === o ? 'on' : ''} onClick={() => setFilters((a) => a.map((x, j) => j === i ? { ...x, op: o } : x))}>{FN_OPS[o]}</button>)}</div>
                    {FN_FVALUES[f.key]
                      ? <div className="fn-fedit-vals">{FN_FVALUES[f.key].map((v) => <button key={v} className={f.val === v ? 'on' : ''} onClick={() => setFilters((a) => a.map((x, j) => j === i ? { ...x, val: v } : x))}>{v}</button>)}</div>
                      : <input className="fn-fedit-in" defaultValue={f.val} placeholder="Value…" onChange={(e) => setFilters((a) => a.map((x, j) => j === i ? { ...x, val: e.target.value } : x))} />}
                  </>}
                <button className="fn-fedit-rm" onClick={() => setFilters((a) => a.filter((_, j) => j !== i))}>Remove filter</button>
              </div>
            </Popover>
          ))}
          <FnFilterButton onCommit={(f) => setFilters((a) => [...a, f])} />
        </div>
      </section>

      {/* Analytics gate — the charts + stats only render once the funnel has ≥2
          valid steps (matching legacy). Below that, a prompt instead of fixtures. */}
      {!ready ? (
        <div className="fn-viz-empty" style={{ marginTop: "var(--sp-40)", padding: 'var(--sp-52) var(--sp-24)', textAlign: 'center', border: '1px dashed var(--line)', borderRadius: "var(--r-lg)" }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: "var(--r-lg)", background: 'var(--line-2)', color: 'var(--t3)' }}><Icon name="funnel" size={22} /></div>
          <div style={{ fontSize: "var(--text-md)", fontWeight: "var(--fw-medium)", color: 'var(--t2)', marginTop: "var(--sp-14)" }}>Add at least 2 steps</div>
          <div style={{ fontSize: "var(--text-sm)", color: 'var(--t3)', marginTop: "var(--sp-6)", maxWidth: 380, margin: 'var(--sp-6) auto 0' }}>Define two or more steps with a value to see conversion, drop-off and where users fall out of the flow.</div>
        </div>
      ) : (
        <>
      {/* metrics */}
      {/* Median time-to-convert + per-step time-to-reach are REAL now
          (funnelStages p50/p95); ▲/▼ compare deltas come from a 2nd preview series. */}
      <div className="stats fn-sum" style={{ marginTop: "var(--sp-20)" }}>
        <div className="stat"><div className="stat-l">Entered</div><div className="stat-v"><NumberFlow value={vc0} />{deltaBadge(dEntered, '%')}</div><div className="stat-s">{metric}</div></div>
        <div className="stat"><div className="stat-l">Conversion</div><div className="stat-v" style={{ color: 'var(--accent)' }}><NumberFlow value={overallConv} decimals={1} suffix="%" />{deltaBadge(dConv, '')}</div><div className="stat-s">{compareActive ? 'vs previous period' : `all ${vsteps.length} steps`}</div></div>
        <div className="stat"><div className="stat-l">Converted</div><div className="stat-v"><NumberFlow value={vLast} />{deltaBadge(dConverted, '%')}</div><div className="stat-s">reached {vsteps[vsteps.length - 1].value || 'final'}</div></div>
        <div className="stat"><div className="stat-l">Median time</div><div className="stat-v">{fmtDur(convTime?.p50)}</div><div className="stat-s">{convTime?.p95 != null ? `p95 ${fmtDur(convTime.p95)} · to convert` : 'to convert'}</div></div>
        <div className="stat"><div className="stat-l">Biggest drop</div><div className="stat-v" style={{ color: 'var(--red)' }}>−{bigDropPct.toFixed(1)}%{deltaBadge(dBigDrop, '%')}</div><div className="stat-s">step {bigDropFrom} → {bigDropFrom + 1}</div></div>
      </div>

      {/* controls */}
      <div className="fn-tabs-row">
        <button className={`fn-tab ${view === 'steps' ? 'on' : ''}`} onClick={() => setView('steps')}>Steps</button>
        <button className={`fn-tab ${view === 'breakdown' ? 'on' : ''}`} onClick={() => setView('breakdown')}>Breakdown</button>
        <button className={`fn-tab ${view === 'time' ? 'on' : ''}`} onClick={() => setView('time')}>Conversion over time</button>
        <button className={`fn-tab ${view === 'metric' ? 'on' : ''}`} onClick={() => setView('metric')}>Metric</button>
        <span className="sp" style={{ flex: 1 }} />
        {view === 'breakdown' && <FnMenuBtn label={<><Icon name="funnel" size={11} /> by {(FN_BDIMS.find((d) => d[0] === bdim) || [])[1]}</>} align="right" cls="ctl">
          {({ close }) => <div className="fn-menu"><div className="fn-menu-h">Break down by</div>{FN_BDIMS.map(([id, l]) => <button key={id} className={bdim === id ? 'on' : ''} onClick={() => { setBdim(id); close(); }}>{l}</button>)}</div>}
        </FnMenuBtn>}
        <span className="fn-metric-sel">
          <Select value={metric} width={134} onChange={setMetric} options={[
            { value: 'sessions', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--sp-8)" }}><Icon name="rec" size={13} />Sessions</span> },
            { value: 'users', label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--sp-8)" }}><Icon name="users" size={13} />Users</span> },
          ]} />
        </span>
        {/* Compare lives INSIDE the date picker (a "Compare to previous period"
            toggle in its dropdown) — the period and the thing you compare it
            against belong together. Disabled on Breakdown, where a single-period
            split has no prior to compare. */}
        <DatePicker
          value={dateRange}
          onChange={setDateRange}
          align="right"
          presets={FN_DATE_PRESETS}
          compare={compare}
          onCompareChange={setCompare}
          compareDisabled={compareDisabled}
          compareDisabledHint="Comparison isn't available in the Breakdown view"
        />
      </div>

      {/* hero */}
      <section style={{ marginTop: "var(--sp-8)" }}>
        <div className="fn-flow-meta"><b>{fmtN(vc0)}</b> entered · {metric} · {compareActive ? 'compared to previous period' : dateRange.toLowerCase()}</div>
        {/* Breakdown is scoped to the SELECTED range (unlike the filter-value menu,
            which spans a fixed recent window), so a narrower range shows fewer
            values. Say so explicitly, or the split reads as "missing" data. */}
        {view === 'breakdown' && !compareActive && (
          <div className="fn-flow-meta" style={{ marginTop: 'var(--sp-4)' }}>
            Showing only sessions that entered in {dateRange.toLowerCase()} — widen the range to include more.
          </div>
        )}
        {/* Key on the query INPUTS (metric · compare · date range · filter ·
            step identity), NOT the resulting counts. The grow-in fires on mount
            only, and this remounts FnBars — replaying it — whenever the user
            changes what's being asked, which is what they want.
            It deliberately does NOT include s.cur. The detail page seeds the
            bars from GET /compute and then the live preview overwrites the same
            counts; keying on cur made that refresh a remount, so the bars grew
            in a SECOND time whenever the two differed by even one session. With
            an input key the refresh updates widths in place (no re-animation),
            and only a real query change re-plays it. */}
        {view === 'steps' && <FnBars key={`${compareActive ? 'c' : 's'}:${metric}:${dateRange}:${serializeFilters(filters)}:${vsteps.map((st) => `${st.kind}:${st.value}`).join('|')}`} steps={vsteps} sel={clampSel} onSel={setSel} compare={compareActive} prev={cmp?.counts} onViewSessions={viewStepSessions} />}
        {view === 'breakdown' && <FnBreakdown dim={bdim} steps={vsteps} buckets={bd} metric={metric} />}
        {view === 'time' && <FnTime points={tl} />}
        {/* Metric-only view — the headline conversion number for this funnel,
            no step bars or chart. Reads the same real preview stats as the
            summary row (never fabricated). */}
        {view === 'metric' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 'var(--sp-52) var(--sp-24) var(--sp-44)', gap: "var(--sp-12)", minHeight: 240 }}>
            <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-semibold)", letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--t4)' }}>Overall conversion · all {vsteps.length} steps</div>
            <div style={{ fontSize: 84, fontWeight: "var(--fw-semibold)", lineHeight: "var(--lh-none)", letterSpacing: '-2.5px', color: 'var(--accent)', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: "var(--sp-12)" }}>
              <NumberFlow value={overallConv} decimals={1} suffix="%" />
              {compareActive && cmp && deltaBadge(dConv, '')}
            </div>
            <div style={{ fontSize: "var(--text-md)", color: 'var(--t2)', maxWidth: 480, lineHeight: "var(--lh-body)" }}>
              <b style={{ color: 'var(--text)' }}>{fmtN(vLast)}</b> of <b style={{ color: 'var(--text)' }}>{fmtN(vc0)}</b> {metric} that entered {name.trim() ? <b style={{ color: 'var(--text)' }}>{name.trim()}</b> : 'the funnel'} completed every step · {compareActive ? 'vs previous period' : dateRange.toLowerCase()}
            </div>
          </div>
        )}
      </section>

      {/* Step-scoped modals — kept OUTSIDE the Steps-only card below so the
          "Alert" button (present on EVERY tab) still opens its modal, and an
          open "Create cohort" survives a tab switch. */}
      {dropoffStep != null && funnelId != null && vsteps[dropoffStep] && (
        <DropoffCohortModal
          funnelId={funnelId}
          funnelName={funnelName ?? 'Funnel'}
          stepIndex={dropoffStep}
          stepName={vsteps[dropoffStep].value || fnKind(vsteps[dropoffStep].kind ?? 'page').label}
          fromTs={range.from}
          toTs={range.to}
          onClose={() => setDropoffStep(null)}
        />
      )}
      {alertOpen && funnelId != null && (
        <FunnelAlertModal
          funnelId={funnelId}
          funnelName={funnelName ?? 'Funnel'}
          windowDays={Number(settings.window) || 7}
          onClose={() => setAlertOpen(false)}
        />
      )}

      {/* per-step detail — ONLY on the Steps tab. Breakdown / Conversion over
          time / Metric are whole-funnel views and don't show a single-step card. */}
      {view === 'steps' && (
      <section className="fn-detail">
        <div className="fn-det-h"><span className="fn-det-step">Step {clampSel + 1}</span><span className="fn-det-title">{fnKind(s.kind).label} <span className="mono">{s.value}</span></span><span className="sp" /><button className="btn sm" onClick={() => openEdit(clampSel)}>Edit step</button><button className="btn sm" onClick={() => viewStepSessions(clampSel)} title={s.cur > STEP_VIEW_CAP ? `${fmtN(s.cur)} sessions reached this step — the recordings list opens the newest ${fmtN(STEP_VIEW_CAP)}` : undefined}>{s.cur > STEP_VIEW_CAP ? `View newest ${fmtN(STEP_VIEW_CAP)} sessions` : `View ${fmtN(s.cur)} sessions`}</button>{clampSel >= 1 && (<button className="btn sm" onClick={() => setDropoffStep(clampSel)} disabled={funnelId == null || !saved} title={funnelId != null && saved ? 'Create a cohort of the users who dropped off here' : 'Save the funnel first — drop-off cohorts use the saved definition'}>Create cohort</button>)}</div>
        <div className="fn-det-m">
          <div className="fn-dm"><div className="fn-dm-l">Reached</div><div className="fn-dm-v">{fmtN(s.cur)}</div></div>
          <div className="fn-dm"><div className="fn-dm-l">Step conversion</div><div className="fn-dm-v" style={{ color: clampSel > 0 ? 'var(--green)' : 'inherit' }}>{clampSel === 0 ? '—' : stepConv.toFixed(1) + '%'}</div></div>
          <div className="fn-dm"><div className="fn-dm-l">Dropped here</div><div className="fn-dm-v" style={{ color: 'var(--red)' }}>{clampSel === 0 ? '—' : fmtN(dropC) + ' · ' + dropP.toFixed(0) + '%'}</div></div>
          <div className="fn-dm"><div className="fn-dm-l">Time to reach</div><div className="fn-dm-v">{s && s.reachN ? `${fmtDur(s.p50Reach)} · p95 ${fmtDur(s.p95Reach)}` : '—'}</div></div>
        </div>
        <div className="fn-det-sub" style={{ display: 'flex', alignItems: 'center', gap: "var(--sp-10)" }}>
          <span>What&rsquo;s hurting conversion</span>
          <span className="sp" style={{ flex: 1 }} />
          {/* #6 — grounded agent investigation of THIS transition (real stream).
              Enterprise Edition: the assistant is absent in the open-source
              build (ee.hasAsk false), so this control is omitted rather than
              left dead — mirrors the command-palette Ask gate. */}
          {ee.hasAsk && can.contribute && (
            <button className="fn-ai-ask" onClick={askWhyDrop}><Icon name="spark" size={12} fill /> Ask AI why</button>
          )}
        </div>
        {/* Real issue→drop correlations off the compute (#6/F6) — never a
            fabricated reason. Empty state surfaces "Ask AI why" only when the
            assistant exists (ee present); passing undefined omits it. */}
        <FnInsights insights={insights} onAsk={ee.hasAsk && can.contribute ? askWhyDrop : undefined} />
      </section>
      )}
        </>
      )}

    </div>
  );
}
