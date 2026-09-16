import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Icon,
  Popover,
  Search,
  NumberFlow,
  AiBadge,
} from "@/components/primitives";
import { UsersFilter } from "./UsersFilter";
import { EmptyState, EMPTY_ART, Sk, useToast } from "@/components/feedback";
import { UsersSkeleton } from "./UsersSkeleton";
import { AddToCohortModal } from "./AddToCohortModal";
import { EndUsers, Cohorts, Dashboard } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import {
  adaptUser,
  uhue,
  type ApiEndUser,
  type ApiEndUserDetail,
  type User,
} from "./users.data";
import { useDebounced } from "@/routes/recordings/search/suggest";
import { readTotal } from "@/routes/recordings/recordings.data";
import { ANON_LABEL } from "@/lib/identity";
import { UserDetail } from "./UserDetail";

type UsersProps = { empty?: boolean };

// The 0-vs-nonzero gate reads only `users` off the shared counts aggregate.
type DashCounts = { users: number };

/** "Last seen" dropdown label → the lastSeenDays param the API expects
 *  (undefined = "Any time", no window). */
const LAST_SEEN_DAYS: Record<string, string | undefined> = {
  "Any time": undefined,
  "Last 24 hours": "1",
  "Last 7 days": "7",
  "Last 30 days": "30",
};

/* Page: Users — wired to GET /v1/end-users; country/platform/user-type/online/
   last-seen filters are applied SERVER-side (they used to narrow only the loaded
   page). Custom identify() properties are deliberately NOT columns here — they
   live on the single-user page, which has room to show all of them. */
export function Users({ empty }: UsersProps) {
  const [country, setCountry] = useState("All countries");
  const [search, setSearch] = useState("");
  const dSearch = useDebounced(search);
  // Cursor-stack pagination: `cursor` starts the current page; `cursorStack`
  // holds the cursors that led to prior pages so "Prev" can walk back.
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const pageNum = cursorStack.length + 1;
  const { userId } = useParams();
  const navigate = useNavigate();
  const [lastSeen, setLastSeen] = useState("Any time");
  const [platform, setPlatform] = useState("All");
  const [userType, setUserType] = useState("All");
  const [online, setOnline] = useState("All");
  const [exporting, setExporting] = useState(false);
  const toast = useToast();
  // Which row's ⋯ → "Add to cohort" is open. One modal for the whole table,
  // driven by the picked user (null = closed).
  const [cohortUser, setCohortUser] = useState<User | null>(null);
  // The list rows don't carry cohort membership, so fetch the picked user's
  // detail when the modal opens — that gives the modal the `cohortIds` it needs
  // to pre-check the cohorts they're already in (and to toggle-remove). Disabled
  // until a row is picked; re-runs per user; `onChanged` refetches it after a
  // write so the checks can't drift.
  const { data: cohortUserDetail, refetch: refetchCohortUser } =
    useApi<ApiEndUserDetail>(
      () => EndUsers.get<ApiEndUserDetail>(String(cohortUser?.id)),
      [cohortUser?.id],
      { enabled: !!cohortUser },
    );

  const [params] = useSearchParams();
  const cohortId = params.get("cohort") || undefined;
  // Cohort name (+ AI provenance) for the scope banner — only fetched while a
  // cohort scopes the list.
  const { data: scopeCohort } = useApi<{ name: string; createdByAi?: boolean }>(
    () => Cohorts.get<{ name: string; createdByAi?: boolean }>(cohortId!),
    [cohortId],
    { enabled: !!cohortId },
  );
  // Workspace-wide identified-user count, already fetched on dashboard load
  // (shared "dashboard-counts" key → cache, no refetch). Gates ONLY the
  // top-level all-users view: a brand-new workspace that never called identify()
  // renders the illustration straight from counts — no fetch → skeleton → illo
  // flash. A cohort scope is a DIFFERENT empty (its own "no users match this
  // cohort" state), so it never depends on this count and always fetches.
  // `countsReady` folds in loading/stale so a workspace SWITCH can't flash the
  // wrong empty state.
  const {
    data: counts,
    loading: countsLoading,
    stale: countsStale,
  } = useApi<DashCounts>(() => Dashboard.counts<DashCounts>(), [], {
    key: "dashboard-counts",
  });
  const countsReady = !countsLoading && !countsStale && counts !== undefined;
  const hasCount = !!counts && counts.users > 0;
  const {
    data,
    loading,
    stale,
    page: pageMeta,
  } = useApi<ApiEndUser[]>(
    () =>
      EndUsers.list<ApiEndUser[]>({
        limit: 25,
        cohortId,
        search: dSearch || undefined,
        cursor,
        // Filters are applied SERVER-side now — they used to narrow only the 25
        // rows already loaded, so a filter never reached users on other pages.
        country: country === "All countries" ? undefined : country,
        platform: platform === "All" ? undefined : platform,
        userType: userType === "All" ? undefined : userType,
        online:
          online === "All"
            ? undefined
            : online === "Online now"
              ? "true"
              : "false",
        lastSeenDays: LAST_SEEN_DAYS[lastSeen],
      }),
    [cohortId, dSearch, cursor, country, platform, userType, online, lastSeen],
    // Fetch the all-users list only when the workspace has identified users
    // (counts.users > 0); a cohort scope always fetches (its own empty state).
    { enabled: !!cohortId || hasCount },
  );
  // A new cohort scope, search term, or filter restarts pagination at page one.
  useEffect(() => {
    setCursor(undefined);
    setCursorStack([]);
  }, [cohortId, dSearch, country, platform, userType, online, lastSeen]);

  /* Export the WHOLE filtered set, not the 25 loaded rows: hand the SAME filter
     query the list uses (minus cursor/limit) to the streaming CSV endpoint,
     which pages it server-side so a 50k-member cohort never lands in memory here
     or there. Kept inline (not a shared util) so it can't drift from the exact
     filters the table is showing. `download` carries the Bearer auth a plain
     link can't, so we surface a real error rather than a silent no-op. */
  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const slug = scopeCohort?.name
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const filename =
        cohortId && slug ? `cohort-${slug}-${stamp}.csv` : `users-${stamp}.csv`;
      await EndUsers.exportCsv(
        {
          cohortId,
          search: dSearch || undefined,
          country: country === "All countries" ? undefined : country,
          platform: platform === "All" ? undefined : platform,
          userType: userType === "All" ? undefined : userType,
          online:
            online === "All"
              ? undefined
              : online === "Online now"
                ? "true"
                : "false",
          lastSeenDays: LAST_SEEN_DAYS[lastSeen],
        },
        filename,
      );
      toast("Export started — check your downloads", { kind: "ok" });
    } catch (e) {
      toast(`Couldn't export CSV: ${e instanceof Error ? e.message : "error"}`, {
        kind: "err",
      });
    } finally {
      setExporting(false);
    }
  };

  const all: User[] = (data ?? []).map(adaptUser);
  // Header total comes from the server's precomputed count (page.total →
  // WorkspaceStats.usersTotal), not the page size — the page size was why this
  // read "100 identified users" no matter the workspace.
  // The real total, or undefined when the server can't cheaply count the
  // filtered set. Deliberately NOT falling back to pageMeta.count — that is the
  // PAGE SIZE (25), which is exactly what made a 3,491-member cohort read
  // "25 of 25". A missing total renders as "N+" (at least this many), never a
  // wrong exact number.
  const total = readTotal(pageMeta)?.value;

  /* The list has nothing trustworthy to show yet → the table's rows are a
     skeleton. Two cases, both true of the ROWS and not of the page around them:

     `loading` is the cold load — an empty cache, no users on screen at all.

     `stale` is a cohort switch: keepPreviousData is still serving the PREVIOUS
     cohort's users under the new cohort's scope banner, so those rows are rows
     the banner doesn't describe. Swapping them for the skeleton is the same
     call the rail makes when re-filtering (see RvRail's `listBusy`).

     `syncing` is deliberately NOT here. It is also true for a background
     refetch of the SAME key, where the users on screen are already correct —
     blanking them would throw away what the reader is reading. */
  const busy = loading || stale;

  // /users/:userId → single-user detail. Rendered ABOVE the empty-state guard so
  // a deep-linked user still shows even when the current list fetch is empty.
  if (userId) {
    const row = all.find((u) => String(u.id) === userId);
    // Placeholder until UserDetail's own fetch resolves — it states nothing it
    // doesn't know: no invented email, no "anon" in a field labelled email.
    const u: User = row ?? {
      id: Number(userId),
      n: ANON_LABEL,
      e: "",
      identified: false,
      initials: null,
      picture: null,
      hueSeed: userId,
      plan: "",
      pt: "",
      flag: "",
      loc: "",
      dev: "",
      seen: "",
    };
    return <UserDetail u={u} onBack={() => navigate("/users")} />;
  }

  // Cohort scope banner — hoisted so it renders in BOTH the populated list and
  // the scoped-but-empty state (mirrors recordings → playlist scope).
  const scopeBanner = cohortId ? (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-8)",
        padding: "var(--sp-8) var(--sp-14)",
        marginBottom: "var(--sp-16)",
        fontSize: "var(--text-sm)",
        color: "var(--t2)",
        background: "var(--accent-tint)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
      }}
    >
      <Icon name="cohorts" size={13} style={{ color: "var(--accent)" }} />
      <span>
        Segmented to cohort{" "}
        <b style={{ color: "var(--text)" }}>{scopeCohort?.name ?? "…"}</b>
      </span>
      {scopeCohort?.createdByAi && <AiBadge />}
      <span style={{ flex: 1 }} />
      <button
        className="btn q sm"
        onClick={() => navigate("/users")}
        title="Clear cohort filter"
      >
        Clear
        <Icon name="x" size={12} />
      </button>
    </div>
  ) : null;

  // Empty: a brand-new workspace (no users at all) gets the install-onboarding;
  // a cohort that simply has no matching users keeps its scope banner and says so.
  //
  // Gated on `busy`, not `loading`: this guard yields to the skeleton before it
  // can fire. It used to read `!loading && !all.length`, which is FALSE while
  // loading — so a cold load fell straight past it into the table below and
  // flashed bare column headers over zero rows. "No users" is a claim only a
  // resolved list gets to make. `empty` still short-circuits first: it is the
  // demo prop that renders this state on purpose, not a statement about a fetch.
  // A search or any attribute filter is active — so a zero-result list means
  // "nothing matched", not "no users in this workspace" (→ no-results, not the
  // install onboarding).
  const filtersActive =
    !!dSearch ||
    country !== "All countries" ||
    platform !== "All" ||
    userType !== "All" ||
    online !== "All" ||
    lastSeen !== "Any time";
  if (empty || (countsReady && !hasCount && !cohortId) || (!busy && all.length === 0))
    return cohortId && !empty ? (
      <div className="wrap">
        {scopeBanner}
        <EmptyState
          art={EMPTY_ART.users}
          title="No users match this cohort"
          desc="No users fall into this cohort yet. People who match its rules will appear here as they’re identified."
          actions={[
            {
              label: "View all users",
              primary: true,
              icon: "users",
              onClick: () => navigate("/users"),
            },
          ]}
        />
      </div>
    ) : filtersActive && !empty ? (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.users}
          title="No users match your filters"
          desc="No identified users match the current search and filters. Try broadening or clearing them."
          actions={[
            {
              label: "Clear filters",
              primary: true,
              icon: "x",
              onClick: () => {
                setSearch("");
                setCountry("All countries");
                setPlatform("All");
                setUserType("All");
                setOnline("All");
                setLastSeen("Any time");
              },
            },
          ]}
        />
      </div>
    ) : (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.users}
          title="Users"
          desc="Users are the real people behind your sessions. Anonymous visitors are tracked automatically; call identify() after sign-in and their name, email, plan, and full session history show up here — searchable and linkable from anywhere."
          actions={[
            {
              label: "View install guide",
              primary: true,
              icon: "console",
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


  // Every filter (country/platform/userType/online/lastSeen + search) is now
  // applied server-side, so the fetched page IS the filtered set — no client-
  // side narrowing, which previously only filtered the 25 rows on screen.
  const rows = all;

  const hasMore = !!pageMeta?.has_more; // cursor pagination is a follow-up
  // Display string for the count: the exact total when we have it, else "N+"
  // (there are at least the rows shown, and more pages exist) — honest under a
  // filter the server can't cheaply total.
  const totalLabel =
    total != null
      ? total.toLocaleString()
      : hasMore
        ? `${rows.length}+`
        : rows.length.toLocaleString();

  return (
    <div className="wrap rd-page">
      {scopeBanner}
      <div className="head">
        <div className="head-l">
          {/* The title doesn't depend on the fetch, so it never leaves. The
              count does: while busy `total` is 0 (cold) or the previous
              cohort's figure (stale), and both would state a number this list
              hasn't earned. Inline-block keeps `.sub`'s 12.5px line box, so
              swapping the bar in doesn't move the header. */}
          <h1>Users</h1>
          <div className="sub">
            {busy ? (
              <Sk
                w={116}
                h={9}
                style={{ display: "inline-block", verticalAlign: "middle" }}
              />
            ) : (
              <>
                {/* The count rolls in on mount (local NumberFlow). Under a
                    filter the server can't cheaply total, the value is the
                    loaded-rows count with a "+" — still a real number to roll. */}
                {total != null ? (
                  <NumberFlow value={total} />
                ) : hasMore ? (
                  <NumberFlow value={rows.length} suffix="+" />
                ) : (
                  <NumberFlow value={rows.length} />
                )}
                {" identified users"}
              </>
            )}
          </div>
        </div>
        <div className="actions">
          <button
            className="btn"
            onClick={onExport}
            disabled={exporting}
            aria-busy={exporting}
          >
            {exporting ? (
              <>
                <span className="rd-spinner" /> Exporting…
              </>
            ) : (
              <>
                <Icon name="download" size={13} /> Export CSV
              </>
            )}
          </button>
        </div>
      </div>
      <div
        className="fbar"
        style={{
          margin: "var(--sp-20) 0 0",
          paddingBottom: "var(--sp-14)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <Search
          value={search}
          onChange={setSearch}
          placeholder="Search by name, email, id…"
          width={260}
          className="av-tall"
        />
        <span className="sp" />
        <UsersFilter
          value={{ country, lastSeen, platform, userType, online }}
          onChange={(v) => {
            setCountry(v.country);
            setLastSeen(v.lastSeen);
            setPlatform(v.platform);
            setUserType(v.userType);
            setOnline(v.online);
          }}
        />
      </div>
      <table className="uatt">
        <thead>
          <tr>
            <th><span className="uatt-h"><Icon name="users" size={13} />User</span></th>
            <th style={{ width: 180 }}><span className="uatt-h"><Icon name="globe" size={13} />Location</span></th>
            <th style={{ width: 184 }}><span className="uatt-h"><Icon name="monitor" size={13} />Device</span></th>
            <th style={{ width: 132 }}><span className="uatt-h"><Icon name="clock" size={13} />Last seen</span></th>
            <th style={{ width: 34 }}></th>
          </tr>
        </thead>
        <tbody>
          {busy && <UsersSkeleton />}
          {!busy &&
            rows.map((u, i) => (
              <tr className="clickable" key={i} onClick={() => navigate("/users/" + u.id)}>
                <td>
                  <div className="cell-user">
                    <span className="u-av" style={{ background: uhue(u.hueSeed) }}>
                      {u.initials ?? "∅"}
                      {u.on && <span className="on-d" />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="u-name">{u.n}</div>
                      <div className="u-email">{u.e}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--t2)",
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--sp-6)",
                    }}
                  >
                    <span style={{ fontSize: "var(--text-base)" }}>{u.flag}</span>
                    {u.loc}
                  </span>
                </td>
                <td>
                  {/* The device from their most recent session (see EndUsers list). */}
                  <span
                    className="mono"
                    style={{ fontSize: "var(--text-xs)", color: "var(--t2)" }}
                  >
                    {u.dev}
                  </span>
                </td>
                <td>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      color: u.seen === "online" ? "var(--green)" : "var(--t2)",
                      fontFamily:
                        u.seen === "online" ? "var(--font)" : "var(--mono)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--sp-6)",
                    }}
                  >
                    {u.seen === "online" && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: "var(--green)",
                        }}
                      />
                    )}
                    {u.seen}
                  </span>
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
                            // Deep-link the recordings list to this user by the
                            // indexed endUserId (the `#id` the search resolves to
                            // params.endUserId), so it lands on their sessions —
                            // not a substring match on the name.
                            const label = (u.e || u.n).replace(/"/g, "");
                            navigate(
                              `/recordings?q=${encodeURIComponent(
                                `user:"${label}"#${u.id}`,
                              )}`,
                            );
                          }}
                        >
                          <Icon name="rec" size={14} /> View sessions
                        </button>
                        <button
                          onClick={() => {
                            close();
                            setCohortUser(u);
                          }}
                        >
                          <Icon name="cohorts" size={14} /> Add to cohort
                        </button>
                        <div className="sep" />
                        <button
                          onClick={async () => {
                            close();
                            try {
                              await navigator.clipboard.writeText(String(u.id));
                              toast(`User ID ${u.id} copied`, { kind: "ok" });
                            } catch {
                              toast("Couldn't copy user ID", { kind: "err" });
                            }
                          }}
                        >
                          Copy user ID
                        </button>
                      </>
                    )}
                  </Popover>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="tfoot">
        {/* Same rule as the header count: while busy this would read
            "Page 1 · 0 of 0" over a table of skeleton rows. The bar stays
            inside the span so the footer keeps its line box and height. */}
        <span>
          {busy ? (
            <Sk
              w={132}
              h={9}
              style={{ display: "inline-block", verticalAlign: "middle" }}
            />
          ) : (
            <>
              Page {pageNum} · {rows.length} of {totalLabel}
            </>
          )}
        </span>
        <div className="r">
          <button
            className="btn sm ghost"
            disabled={pageNum === 1}
            style={{ opacity: pageNum === 1 ? 0.4 : 1 }}
            onClick={() => {
              setCursor(undefined);
              setCursorStack([]);
            }}
          >
            First
          </button>
          <button
            className="btn sm ghost"
            disabled={pageNum === 1}
            style={{ opacity: pageNum === 1 ? 0.4 : 1 }}
            onClick={() => {
              setCursor(cursorStack[cursorStack.length - 1] || undefined);
              setCursorStack((s) => s.slice(0, -1));
            }}
          >
            <Icon
              name="chev"
              size={12}
              style={{ transform: "rotate(90deg)" }}
            />
          </button>
          <button
            className="btn sm ghost"
            disabled={!hasMore}
            style={{ opacity: hasMore ? 1 : 0.4 }}
            onClick={() => {
              setCursorStack((s) => [...s, cursor ?? ""]);
              setCursor(pageMeta?.next_cursor ?? undefined);
            }}
          >
            <Icon
              name="chev"
              size={12}
              style={{ transform: "rotate(-90deg)" }}
            />
          </button>
        </div>
      </div>
      {/* One shared modal for the table's ⋯ → "Add to cohort". Opened with the
          picked row's user; `cohortIds` come from the on-demand detail fetch
          above, so existing memberships show pre-checked and can be toggled off. */}
      <AddToCohortModal
        open={!!cohortUser}
        userId={cohortUser?.id ?? 0}
        userName={cohortUser?.n ?? ""}
        cohortIds={cohortUserDetail?.cohortIds ?? []}
        onChanged={refetchCohortUser}
        onClose={() => setCohortUser(null)}
      />
    </div>
  );
}
