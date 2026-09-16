import { useRef, useState } from "react";
import { Icon, Popover, Seg, ConfirmDialog } from "@/components/primitives";
import { EmptyState, EMPTY_ART, useToast } from "@/components/feedback";
import { Funnels, Dashboard } from "@/api/endpoints";
import { useApi, useApiInfinite } from "@/api/useApi";
import { useDebounced } from "@/routes/recordings/search/suggest";
import { useInfiniteScroll } from "@/hooks";
import {
  FN_SORTS,
  adaptFunnel,
  type ApiFunnel,
  type FnListItem,
} from "../funnels.data";
import { funnelToTemplate, saveUserFunnelTemplate } from "../funnel-templates.data";
import { FunnelRow } from "./FunnelRow";
import { FunnelsIndexSkeleton } from "./FunnelsIndexSkeleton";

type FunnelsIndexProps = {
  onOpen: (f: FnListItem) => void;
  onNew: () => void;
  empty?: boolean;
};

// The 0-vs-nonzero gate reads only `funnels` off the shared counts aggregate
// (backend counts() → funnels: funnelsTotal).
type DashCounts = { funnels: number };

export function FunnelsIndex({ onOpen, onNew, empty }: FunnelsIndexProps) {
  const [q, setQ] = useState("");
  // Debounced so the server-side search re-queries once typing settles, not per
  // keystroke. The list matches across ALL funnels, not just loaded pages.
  const dq = useDebounced(q);
  const [tab, setTab] = useState("all");
  const [sort, setSort] = useState("updated");
  // The funnel pending a delete-confirmation (null = dialog closed). Replaces
  // window.confirm so the confirmation matches the app's ConfirmDialog.
  const [confirmDel, setConfirmDel] = useState<FnListItem | null>(null);
  const tabs = [
    { value: "all", label: "All" },
    { value: "mine", label: "Mine" },
    { value: "shared", label: "Shared" },
    { value: "archived", label: "Archived" },
  ];
  // Workspace-wide funnel count, already fetched on dashboard load (shared
  // "dashboard-counts" key → cache, no refetch). The list below fetches NOTHING
  // until this says the workspace has ≥1 funnel, so an empty workspace renders
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
  const hasCount = !!counts && counts.funnels > 0;
  // GET /v1/funnels — cursor-paginated, one page at a time (infinite scroll).
  // Real name/description/step-count/updated per row. Conversion + sessions are
  // NOT on the list summary; deriving them per row would be a per-funnel compute
  // loop (N+1, forbidden), so adaptFunnel keeps them neutral. Gated on `hasCount`
  // so it never fires for an empty workspace.
  const { items, loading, stale, loadingMore, hasMore, fetchMore, refetch } =
    useApiInfinite<ApiFunnel>(
      (cursor) =>
        Funnels.list<ApiFunnel[]>({
          cursor: cursor ?? undefined,
          search: dq || undefined,
        }),
      [dq],
      { enabled: hasCount },
    );
  // State-backed scroll root (a plain ref stays null past the observer's first
  // run). Funnels scrolls with the PAGE, not a nested rail, so the observer
  // roots on the app-shell scroll container (.main) reached from the list el.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, () => fetchMore(), {
    root: listEl?.closest(".main") ?? null,
  });
  const toast = useToast();
  /* Cold load — no funnel list on screen for THIS workspace yet, so the rows
     get the skeleton. `loading` is TanStack's isPending (genuinely empty
     cache); `stale` means `data` is still the PREVIOUS workspace's list, held
     by the keepPreviousData placeholder because the new workspace's key hasn't
     resolved — either way we have nothing true to show. `syncing` is
     deliberately NOT here: a background refetch of the same key means the list
     is already on screen and still correct, and blanking it to redraw the same
     rows throws away what the analyst is reading. `empty` is the router's own
     hint, so it goes straight to the empty state with no skeleton flash. */
  const cold = !empty && (loading || stale);
  /* No fixture fallback. This was `data ? … : FN_LIST`, which rendered five
     invented funnels — "Checkout Funnel" at 62.8%, and so on — whenever `data`
     was undefined. That is not only the first paint: TanStack PAUSES queries
     while the browser is offline, so `loading` stays true forever and the table
     sat there showing fabricated conversion rates as if they were the
     workspace's real numbers. A loading list renders the skeleton; a
     loaded-empty one gets the empty state below. */
  const source: FnListItem[] = items.map(adaptFunnel);
  // The list already carries each funnel's full steps, so duplicate/save-as-
  // template read from it (one on-demand GET as a fallback) — never a per-row loop.
  // Built from the LOADED pages; the on-demand GET covers a funnel not yet paged in.
  const byId = new Map<number, ApiFunnel>(items.map((f) => [f.id, f]));
  const rawFunnel = async (id: number): Promise<ApiFunnel> =>
    byId.get(id) ?? (await Funnels.get<ApiFunnel>(String(id))).data;
  const duplicate = async (f: FnListItem) => {
    try {
      const src = await rawFunnel(f.id);
      await Funnels.create<ApiFunnel>({
        name: `${src.name} (copy)`,
        steps: src.steps,
        windowDays: src.windowDays,
      });
      toast(`Duplicated “${src.name}”`, { kind: "ok" });
      refetch();
    } catch {
      toast("Couldn't duplicate funnel", { kind: "err" });
    }
  };
  const saveTemplate = async (f: FnListItem) => {
    try {
      const src = await rawFunnel(f.id);
      saveUserFunnelTemplate(funnelToTemplate(src));
      toast(`Saved “${src.name}” as a template`, { kind: "ok" });
    } catch {
      toast("Couldn't save template", { kind: "err" });
    }
  };
  const remove = async (f: FnListItem) => {
    setConfirmDel(null);
    try {
      await Funnels.remove(String(f.id));
      toast(`Deleted “${f.name}”`, { kind: "ok" });
      refetch();
    } catch {
      toast("Couldn't delete funnel", { kind: "err" });
    }
  };

  // Genuinely empty workspace (list loaded, zero funnels) → the illustrated
  // empty state. `empty` is the router hint; the data check is the real signal
  // (mirrors Cohorts/Users). Search-with-no-matches keeps the inline .fnx-none.
  // `cold` wins over this: on a workspace switch away from an empty workspace,
  // `items` is still the previous `[]` while `loading` has already gone false, so
  // this check would call the NEW workspace empty before its list ever landed.
  // Only the ONBOARDING empty state — never when a search is active (a no-match
  // search must fall through to the inline `.fnx-none` "No funnels match …" below).
  if ((countsReady && !hasCount) || (!cold && !dq && (empty || (!loading && items.length === 0))))
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.funnels}
          title="Funnels"
          desc="Funnels track how users move through a sequence of steps — a signup, a checkout, an onboarding — and reveal exactly where they drop off. Start from a template or build your own."
          actions={[
            {
              label: "Create funnel",
              primary: true,
              icon: "plus",
              kbd: ["N", "F"],
              onClick: onNew,
            },
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/funnels",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
      </div>
    );
  // Tab-filter, search and sort run client-side over the LOADED pages only (the
  // accumulating `items`), not the server — they refine what infinite scroll has
  // pulled in so far, widening as more pages load.
  let rows = source.filter((f) => {
    if (tab === "archived" ? !f.archived : f.archived) return false;
    if (tab === "mine" && !f.mine) return false;
    if (tab === "shared" && !f.shared) return false;
    if (tab === "recent" && !f.recent) return false;
    // Name/description search is server-side now (?search=) so it matches ALL
    // funnels, not just the pages loaded — no client-side text filter here.
    return true;
  });
  rows = [...rows].sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "sessions"
        ? b.sessions - a.sessions
        : sort === "conv"
          ? b.conv - a.conv
          : 0,
  );

  return (
    <div className="wrap fnx">
      <div className="head" style={{ alignItems: "flex-start" }}>
        <div className="head-l">
          <div className="title-row">
            <h1>Funnels</h1>
          </div>
          <div className="sub">
            Analyze where users enter, progress and drop off.
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={onNew}>
            <Icon name="plus" size={13} /> New funnel
            <span className="empty-kbd">
              <kbd>N</kbd>
              <span className="then">then</span>
              <kbd>F</kbd>
            </span>
          </button>
        </div>
      </div>

      <div className="fbar fnx-bar">
        <div className="fnx-search av-tall-search">
          <Icon name="search" size={13} />
          <input
            placeholder="Search funnels..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            spellCheck={false}
          />
        </div>
        {/* <Seg value={tab} options={tabs} onChange={setTab} /> */}
        <span className="sp" />
        <Popover
          align="right"
          trigger={
            <button className="av-fbtn">
              <Icon name="sliders" size={14} />{" "}
              {FN_SORTS.find((x) => x[0] === sort)![1]}{" "}
              <Icon name="chev" size={12} style={{ color: "var(--t4)" }} />
            </button>
          }
        >
          {({ close }) => (
            <div className="fnx-menu">
              {FN_SORTS.map(([v, l]) => (
                <button
                  key={v}
                  className={sort === v ? "on" : ""}
                  onClick={() => {
                    setSort(v);
                    close();
                  }}
                >
                  {l}
                  {sort === v && (
                    <Icon
                      name="chev"
                      size={11}
                      style={{ marginLeft: "auto", transform: "rotate(-90deg)" }}
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>

      {/* Skeleton first: while the list is cold `rows` is empty for want of a
          response, not for want of a match, and the .fnx-none branch below would
          claim "No funnels match" before anything had been fetched. */}
      {cold ? (
        <FunnelsIndexSkeleton />
      ) : rows.length > 0 ? (
        <div className="fnx-list" ref={setListEl}>
          <div className="fnx-colhead">
            <span className="h-main">Funnel</span>
            <span className="h-conv">Conversion</span>
            <span className="h-sess">Sessions</span>
            <span className="h-steps">Steps</span>
            <span className="h-upd">Updated</span>
            <span className="h-a" />
          </div>
          {rows.map((f, i) => (
            <FunnelRow
              key={i}
              f={f}
              onOpen={() => onOpen(f)}
              onDuplicate={() => duplicate(f)}
              onSaveTemplate={() => saveTemplate(f)}
              onDelete={() => setConfirmDel(f)}
            />
          ))}
          {/* Infinite-scroll sentinel — ALWAYS mounted (so the observer never
              has to re-attach); fetchMore no-ops unless a page remains. The
              end-of-list skeleton shows while the next page is in flight. */}
          <div ref={sentinelRef} className="fnx-sentinel" aria-hidden={!hasMore}>
            {loadingMore && <FunnelsIndexSkeleton rows={2} head={false} />}
          </div>
        </div>
      ) : (
        <div className="fnx-none">
          <Icon name="search" size={18} />
          <p>No funnels match “{q}”.</p>
        </div>
      )}
      {confirmDel && (
        <ConfirmDialog
          title="Delete funnel?"
          confirmLabel="Delete funnel"
          onConfirm={() => remove(confirmDel)}
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
              {confirmDel.name}
            </b>{" "}
            will be permanently deleted. This can't be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
