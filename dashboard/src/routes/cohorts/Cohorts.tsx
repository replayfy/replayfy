import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AiBadge, Icon, Popover, Search, Seg, ConfirmDialog } from "@/components/primitives";
import { EmptyState, EMPTY_ART, useToast } from "@/components/feedback";
import { Cohorts as CohortsApi, Dashboard } from "@/api/endpoints";
import { useApi, useApiInfinite } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import { CohortBuilder } from "./builder/CohortBuilder";
import { CoRowsSkeleton, CoStatSkeleton } from "./CohortsSkeleton";
import { CohortTemplateGallery } from "./CohortTemplateGallery";
import { coTemplate, type CohortTemplate } from "./cohort-templates.data";
import { adaptCohort, type ApiCohort, type Cohort } from "./cohorts.data";

type CohortsProps = {
  empty?: boolean;
};

// The 0-vs-nonzero gate reads only `cohorts` off the shared counts aggregate.
type DashCounts = { cohorts: number };

export function Cohorts({ empty }: CohortsProps) {
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const [build, setBuild] = useState(false);
  // The template chooser gallery (scratch or a ready-made audience) shown before
  // the builder opens — mirrors the funnel "Create a funnel" gallery.
  const [choosing, setChoosing] = useState(false);
  const [seed, setSeed] = useState<CohortTemplate | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The "N then C" shortcut lands here with ?new=1 → open the template chooser,
  // then strip the param so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get("new")) {
      setChoosing(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  // Gallery → builder handoff. Scratch opens a blank builder; a template seeds it.
  const openChooser = () => setChoosing(true);
  const startScratch = () => {
    setSeed(null);
    setChoosing(false);
    setBuild(true);
  };
  const startTemplate = (id: string) => {
    setSeed(coTemplate(id) ?? null);
    setChoosing(false);
    setBuild(true);
  };
  // Debounce the search box before it hits the API — the list is server-side
  // searchable (the BE list endpoint honours `search`/`kind`), so the query
  // key carries them and the whole workspace is searched, not just the pages
  // already scrolled into memory. Without this the box only narrowed loaded rows.
  const [dsearch, setDsearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDsearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  // Workspace-wide cohort count, already fetched on dashboard load (shared
  // "dashboard-counts" key → cache, no refetch). The list below fetches NOTHING
  // until this says the workspace has ≥1 cohort, so an empty workspace renders
  // the illustration directly — no fetch → skeleton → illo flash. `countsReady`
  // folds in loading/stale so a workspace SWITCH (counts still the previous
  // workspace's cached row) can't flash the wrong empty state.
  const {
    data: counts,
    loading: countsLoading,
    stale: countsStale,
  } = useApi<DashCounts>(() => Dashboard.counts<DashCounts>(), [], {
    key: "dashboard-counts",
  });
  const countsReady = !countsLoading && !countsStale && counts !== undefined;
  const hasCount = !!counts && counts.cohorts > 0;
  const { items, page, loading, loadingMore, stale, hasMore, fetchMore, refetch } =
    useApiInfinite<ApiCohort>(
      (cursor) =>
        CohortsApi.list<ApiCohort[]>({
          cursor: cursor ?? undefined,
          search: dsearch || undefined,
          kind: kind || undefined,
        }),
      [dsearch, kind],
      { enabled: hasCount },
    );
  // Infinite scroll: the page's scroller is the shell's <main.main> (this route
  // renders no scroll container of its own), resolved off the mounted wrapper and
  // held in state so the observer's root is set on first paint — a plain ref
  // reads null past the observer's first run. Mirrors RvRail's state-backed root,
  // adapted to a table whose scroller is the app shell.
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  const toast = useToast();
  // Cohort pending a delete-confirmation (null = closed) — replaces
  // window.confirm with the app's ConfirmDialog.
  const [confirmDel, setConfirmDel] = useState<Cohort | null>(null);
  const sentinelRef = useRef<HTMLTableRowElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), { root: rootEl });
  const all: Cohort[] = items.map(adaptCohort);
  /* Cold load: nothing truthful to show yet, so the figures and rows are
     skeletons. `stale` is in here because the query key carries the workspace
     id — on a switch, `data` is still the PREVIOUS workspace's cohorts, which
     must not render under the new one. `syncing` is deliberately NOT: a
     recompute/delete refetch reuses the same key, and blanking rows the analyst
     is reading to re-fetch what is already correct is worse than a stale beat. */
  const cold = loading || stale;

  const recompute = async (c: Cohort) => {
    setBusy(c.id);
    try {
      await CohortsApi.refresh(String(c.id));
      refetch();
    } catch (e) {
      toast("Recompute failed: " + (e instanceof Error ? e.message : "error"), {
        kind: "err",
      });
    } finally {
      setBusy(null);
    }
  };
  const del = async (c: Cohort) => {
    setConfirmDel(null);
    setBusy(c.id);
    try {
      await CohortsApi.remove(String(c.id));
      toast(`Deleted cohort “${c.n}”`, { kind: "ok" });
      refetch();
    } catch (e) {
      toast("Delete failed: " + (e instanceof Error ? e.message : "error"), {
        kind: "err",
      });
    } finally {
      setBusy(null);
    }
  };
  const viewMembers = (c: Cohort) => navigate(`/users?cohort=${c.id}`);

  // The "Create a cohort" gallery takes precedence over both the empty state and
  // the table — same pattern as /funnels/new.
  if (choosing)
    return (
      <CohortTemplateGallery
        onScratch={startScratch}
        onPick={startTemplate}
        onBack={() => setChoosing(false)}
      />
    );

  /* `!cold`, not `!loading`: an unresolved list also has zero rows, and a real
     empty workspace must get the install-onboarding rather than a skeleton that
     never resolves. While cold this falls through to the page below, which
     renders the skeleton in place of the figures and rows. */
  // Onboarding empty state ONLY when the workspace has no cohorts AND no
  // search/scope filter is active — a filtered-empty result (e.g. scope=Manual
  // with no manual cohorts, or a no-match search) falls through to the in-table
  // no-results row below instead of the generic "create your first cohort".
  if (empty || (countsReady && !hasCount) || (!cold && all.length === 0 && !dsearch && !kind))
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.cohorts}
          title="Cohorts"
          desc="Cohorts are saved groups of users defined by behavior or properties — 'power users', 'churn risk', 'signed up this week'. Build one and every screen can filter to that segment."
          actions={[
            {
              label: "Create cohort",
              primary: true,
              icon: "plus",
              kbd: ["N", "C"],
              onClick: openChooser,
            },
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/cohorts",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
        <CohortBuilder
          open={build}
          template={seed}
          onClose={() => setBuild(false)}
          onCreated={refetch}
        />
      </div>
    );

  /* Nothing to list while cold, so the skeleton in the tbody is the only thing
     in it: under `stale`, `all` is still the PREVIOUS workspace's cohorts, and
     rendering those alongside the skeleton would both stack the two and show
     one workspace's cohorts under another's id. */
  const rows = cold
    ? []
    : all.filter(
        (c) =>
          (!kind || c.kind === kind) &&
          (!search || c.n.toLowerCase().includes(search.toLowerCase())),
      );
  /* Infinite scroll: `all` is only the pages loaded so far. The list envelope
     carries the true cohort count, so "Active cohorts" uses that; the member sum
     and the Auto/Manual tiles have no server total and therefore now reflect the
     LOADED rows, not the whole workspace. */
  const activeCount = page?.total ?? all.length;
  const total = all.reduce((a, c) => a + c.m, 0);
  return (
    <div
      className={`wrap rd-page ${build ? "co-frost" : ""}`}
      ref={(el) => setRootEl(el?.closest<HTMLElement>(".main") ?? null)}
    >
      <div className="head">
        <div className="head-l">
          <h1>Cohorts</h1>
          <div className="sub">
            Saved groups of users defined by behavior or properties.
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={openChooser}>
            <Icon name="plus" size={13} /> New cohort
            <span className="empty-kbd">
              <kbd>N</kbd>
              <span className="then">then</span>
              <kbd>C</kbd>
            </span>
          </button>
        </div>
      </div>
      <div
        className="stats"
        style={{
          marginTop: "var(--sp-20)",
          paddingBottom: "var(--sp-20)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="stat">
          <div className="stat-l">Active cohorts</div>
          <div className="stat-v">
            {cold ? <CoStatSkeleton w={26} /> : activeCount}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Total members</div>
          <div className="stat-v">
            {cold ? <CoStatSkeleton w={62} /> : total.toLocaleString()}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Auto-updated</div>
          <div className="stat-v">
            {cold ? (
              <CoStatSkeleton w={26} />
            ) : (
              all.filter((c) => c.kind === "AUTO").length
            )}
          </div>
        </div>
        <div className="stat">
          <div className="stat-l">Manual</div>
          <div className="stat-v">
            {cold ? (
              <CoStatSkeleton w={26} />
            ) : (
              all.filter((c) => c.kind === "MANUAL").length
            )}
          </div>
        </div>
      </div>
      <div className="fbar" style={{ margin: "var(--sp-16) 0" }}>
        <Seg
          value={kind}
          options={[
            { value: "", label: "All" },
            { value: "AUTO", label: "Auto-updated" },
            { value: "MANUAL", label: "Manual" },
          ]}
          onChange={setKind}
        />
        <span className="sp" />
        {/* Same width + `av-tall` (34px) as the Users search — it was the only
            search left on the base `.search` padding, so it sat shorter than
            every other one. */}
        <Search
          value={search}
          onChange={setSearch}
          placeholder="Search cohorts…"
          width={260}
          className="av-tall"
        />
      </div>
      <table className="co-tbl">
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num" style={{ width: 120 }}>Members</th>
            <th style={{ width: 120 }}>Type</th>
            <th style={{ width: 160 }}>Last computed</th>
            <th style={{ width: 40 }}></th>
          </tr>
        </thead>
        <tbody>
          {cold && <CoRowsSkeleton />}
          {!cold && rows.length === 0 && (
            <tr>
              <td colSpan={6}>
                <div className="fnx-none">
                  <Icon name="search" size={18} />
                  <p>
                    No{" "}
                    {kind === "MANUAL"
                      ? "manual "
                      : kind === "AUTO"
                        ? "auto-updated "
                        : ""}
                    cohorts{dsearch ? ` match “${dsearch}”` : ""}.
                  </p>
                </div>
              </td>
            </tr>
          )}
          {rows.map((c) => (
            <tr
              className="clickable"
              key={c.id}
              onClick={() => viewMembers(c)}
              style={{ opacity: busy === c.id ? 0.5 : 1 }}
            >
              <td>
                <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-10)" }}>
                  <div className="co-ic">
                    <Icon name="funnel" size={13} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--sp-8)",
                        fontWeight: "var(--fw-semibold)",
                        fontSize: "var(--text-base)",
                      }}
                    >
                      {c.n}
                      {c.createdByAi && <AiBadge />}
                    </div>
                    <div
                      style={{ fontSize: "var(--text-xs)", color: "var(--t3)", marginTop: "var(--sp-2)" }}
                    >
                      {c.d}
                    </div>
                    {c.cond.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "var(--sp-6)",
                          marginTop: "var(--sp-6)",
                        }}
                      >
                        {c.cond.slice(0, 3).map((x, i) => (
                          <span key={i} className="cond">
                            <b>{x[0]}</b>
                            <span className="op">{x[1]}</span>
                            <span className="mono">{x[2]}</span>
                          </span>
                        ))}
                        {c.cond.length > 3 && (
                          <span style={{ fontSize: "var(--text-2xs)", color: "var(--t3)" }}>
                            +{c.cond.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </td>
              <td className="num" style={{ fontWeight: "var(--fw-semibold)" }}>
                {c.m.toLocaleString()}
              </td>
              <td>
                <span className={`tag ${c.kind === "AUTO" ? "auto" : ""}`}>
                  {c.kind === "AUTO" ? "Auto-updated" : "Manual"}
                </span>
              </td>
              <td
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--t3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {c.lc}
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <Popover
                  align="right"
                  trigger={
                    <button className="ibtn">
                      <Icon name="more" size={14} />
                    </button>
                  }
                >
                  {({ close }) => (
                    <>
                      <button
                        onClick={() => {
                          close();
                          viewMembers(c);
                        }}
                      >
                        <Icon name="users" size={14} /> View members
                      </button>
                      <button
                        onClick={() => {
                          close();
                          recompute(c);
                        }}
                      >
                        <Icon name="refresh" size={14} /> Recompute
                      </button>
                      <div className="sep" />
                      <button
                        className="danger"
                        onClick={() => {
                          close();
                          setConfirmDel(c);
                        }}
                      >
                        <Icon name="trash" size={14} /> Delete cohort
                      </button>
                    </>
                  )}
                </Popover>
              </td>
            </tr>
          ))}
          {/* End-of-list skeleton while the next page is in flight — bare `<tr>`s
              that wear the row geometry, same as the cold-load skeleton. */}
          {loadingMore && <CoRowsSkeleton rows={2} />}
          {/* Infinite-scroll sentinel — ALWAYS mounted (so the observer never has
              to re-attach); fetchMore no-ops unless a page remains. An invisible
              1px row (see `.co-tbl tr.co-more` in pages.css) so it adds no band. */}
          <tr ref={sentinelRef} className="co-more" aria-hidden={!hasMore}>
            <td colSpan={5} />
          </tr>
        </tbody>
      </table>
      <CohortBuilder
        open={build}
        template={seed}
        onClose={() => setBuild(false)}
        onCreated={refetch}
      />
      {confirmDel && (
        <ConfirmDialog
          title="Delete cohort?"
          confirmLabel="Delete cohort"
          onConfirm={() => del(confirmDel)}
          onClose={() => setConfirmDel(null)}
        >
          <p
            style={{
              fontSize: "var(--text-base)",
              color: "var(--t2)",
              lineHeight: "var(--lh-body)",
              margin: "0 0 var(--sp-18)",
            }}
          >
            <b style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)" }}>
              {confirmDel.n}
            </b>{" "}
            and its membership will be permanently deleted. This can't be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
