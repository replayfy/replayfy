import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, Select, ConfirmDialog } from "@/components/primitives";
import { EmptyState, EMPTY_ART, Sk, useToast } from "@/components/feedback";
import { Comments as CommentsApi, Dashboard } from "@/api/endpoints";
import { useApi, useApiInfinite } from "@/api/useApi";
import { useInfiniteScroll } from "@/hooks";
import { CommentsSkeleton } from "./CommentsSkeleton";
import {
  chue,
  fmtAt,
  adaptComment,
  type ApiComment,
  type Comment,
} from "./comments.data";

type CommentsProps = {
  empty?: boolean;
};

// The 0-vs-nonzero gate reads only `comments` off the shared counts aggregate.
type DashCounts = { comments: number };

export function Comments({ empty }: CommentsProps) {
  const navigate = useNavigate();
  const [author, setAuthor] = useState("All authors");
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<Comment | null>(null);
  const toast = useToast();
  // The workspace-wide comment count, already fetched on dashboard load (shared
  // "dashboard-counts" key → served from cache, no refetch). We fetch NOTHING on
  // this page until it says the workspace has ≥1 comment, so an empty workspace
  // renders the illustration directly — no fetch → skeleton → illustration flash.
  // `countsReady` folds in loading/stale so a workspace SWITCH (counts still the
  // previous workspace's cached row) can't flash the wrong empty state.
  const {
    data: counts,
    loading: countsLoading,
    stale: countsStale,
  } = useApi<DashCounts>(() => Dashboard.counts<DashCounts>(), [], {
    key: "dashboard-counts",
  });
  const countsReady = !countsLoading && !countsStale && counts !== undefined;
  const hasCount = !!counts && counts.comments > 0;
  // Cursor-paginated: each page threads the previous page's next_cursor through
  // CommentsApi.list's query params (the backend already returns it); rows
  // accumulate across pages into `items`. Gated on `hasCount` so it never fires
  // for an empty workspace (the empty state is served straight from counts).
  const { items, loading, loadingMore, hasMore, fetchMore, refetch } =
    useApiInfinite<ApiComment>(
      (cursor) => CommentsApi.list<ApiComment[]>({ cursor: cursor ?? undefined }),
      [],
      { enabled: hasCount },
    );
  // Stable, always-mounted sentinel. The scroll container is the shell's shared
  // `.main` (this page has no scroll box of its own), so the observer watches
  // the viewport — no state-backed root ref like RvRail's `.rv-list` is needed.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useInfiniteScroll(sentinelRef, fetchMore);
  const rowsData: Comment[] = items.map(adaptComment);

  /* Onboarding empty — decided from the shared dashboard counts BEFORE any
     comments fetch, so an empty workspace renders the illustration with no
     fetch → skeleton → illo flash. `empty` is the caller's explicit override;
     the trailing `!loading && rowsData.length === 0` is the post-fetch fallback
     for the rare case where counts and the list disagree (e.g. counts briefly
     stale right after a bulk delete).

     Ordered BEFORE the skeleton on purpose: when counts === 0 the list query is
     gated off (`enabled:false`), so its `isPending` stays true forever — falling
     to the skeleton first would hang there. A cold load (counts still resolving)
     matches no clause here and correctly falls through to the skeleton below. */
  if (empty || (countsReady && !hasCount) || (!loading && rowsData.length === 0))
    return (
      <div className="wrap">
        <EmptyState
          art={EMPTY_ART.comments}
          title="Comments"
          desc="Comments are how your team discusses what happened in a session. Open any recording, click a moment on the timeline, and leave a note to flag a bug or share a finding — it stays pinned to that exact timestamp."
          actions={[
            {
              label: "Watch a session",
              primary: true,
              icon: "play",
              onClick: () => navigate("/recordings"),
            },
            {
              label: "Documentation",
              onClick: () =>
                window.open(
                  "https://docs.replayfy.app/products/session-replay",
                  "_blank",
                  "noopener",
                ),
            },
          ]}
        />
      </div>
    );

  /* Cold load: counts still resolving, or the (now enabled) comments fetch is
     in flight. Skeleton rather than a flash of "0 comments across 0 sessions".
     `items.length === 0` keeps this to a COLD load — a delete's refetch resolves
     through keepPreviousData and leaves the list on screen. */
  if (loading && items.length === 0) return <CommentsSkeleton />;

  // Author list, session count, header counts, and the text filter all run over
  // the pages LOADED SO FAR (infinite scroll), not the whole table — an accepted
  // tradeoff; these stay client-side rather than moving server-side.
  const authors = ["All authors", ...new Set(rowsData.map((c) => c.n))];
  const sessions = new Set(rowsData.map((c) => c.sid)).size;
  const rows = rowsData.filter(
    (c) =>
      (author === "All authors" || c.n === author) &&
      (!search ||
        c.tx
          .map((t) => t[1])
          .join("")
          .toLowerCase()
          .includes(search.toLowerCase())),
  );
  const del = async (c: Comment) => {
    setConfirm(null);
    if (c.id == null) return;
    try {
      await CommentsApi.remove(String(c.id));
      toast(`Deleted ${c.n}’s comment`, { kind: "ok" });
      refetch();
    } catch {
      toast("Couldn’t delete comment", { kind: "err" });
    }
  };
  const openAt = (c: Comment) => {
    if (c.sid) navigate(`/recordings/${c.sid}?t=${c.at}`);
  };
  return (
    <div className="wrap rd-page cmt-page">
      {/* Nudged right by the comment row's 6px padding so the title and subtitle
          share a left edge with the row avatars. */}
      <div className="head" style={{ paddingLeft: "var(--sp-6)" }}>
        <div className="head-l">
          <h1>Comments</h1>
          <div className="sub">
            {rowsData.length} comments across {sessions} sessions
          </div>
        </div>
        <div className="actions">
          <Select
            value={author}
            options={authors}
            onChange={setAuthor}
            icon="users"
            width={140}
          />
        </div>
      </div>
      <div style={{ marginTop: "var(--sp-18)" }}>
        {rows.map((c, i) => (
          <div className="crow" key={c.id ?? i}>
            <span className="c-av" style={{ background: chue(c.n) }}>
              {c.n[0]}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="c-h">
                <span className="c-name">{c.n}</span>
                <span className="c-time">{c.time}</span>
                <span className="sp" />
                <div className="c-actions">
                  <button
                    className="c-open"
                    onClick={() => openAt(c)}
                    disabled={!c.sid}
                    title={
                      c.sid
                        ? `Open the session and jump to ${fmtAt(c.at)}`
                        : undefined
                    }
                  >
                    <Icon name="play" size={10} fill /> Open at {fmtAt(c.at)}
                  </button>
                  <button
                    className="c-act danger"
                    title="Delete"
                    onClick={() => setConfirm(c)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
              <div className="c-body">
                {c.tx.map((t, j) =>
                  t[0] === "t" ? (
                    <span key={j} className="men">
                      {t[1]}
                    </span>
                  ) : (
                    <span key={j}>{t[1]}</span>
                  ),
                )}
              </div>
              <div className="c-meta">
                on{" "}
                <button
                  className="c-sid"
                  onClick={() => openAt(c)}
                  disabled={!c.sid}
                >
                  {c.sid}
                </button>
                {c.url && <span className="c-url"> · {c.url}</span>}
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="fnx-none" role="status">
            <Icon name="search" size={18} />
            <p>
              No comments
              {search
                ? ` match “${search}”`
                : author !== "All authors"
                  ? ` from ${author}`
                  : ""}
              .
            </p>
          </div>
        )}
        {/* Infinite-scroll sentinel — ALWAYS mounted so the observer never has
            to re-attach; fetchMore no-ops once the last page is in. A trimmed
            two-row `.crow` shimmer marks the end only while the next page loads. */}
        <div ref={sentinelRef} className="cmt-more" aria-hidden={!hasMore}>
          {loadingMore &&
            Array.from({ length: 2 }, (_, i) => (
              <div className="crow" key={i}>
                <Sk w={30} h={30} r={99} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="c-h">
                    <Sk w={96} h={11} />
                    <Sk w={44} h={9} />
                  </div>
                  <div className="c-body" style={{ marginTop: "var(--sp-6)" }}>
                    <Sk w={`${64 + i * 12}%`} h={10} />
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Remove comment?"
          confirmLabel="Remove comment"
          onConfirm={() => del(confirm)}
          onClose={() => setConfirm(null)}
        >
          <p
            style={{
              fontSize: "var(--text-base)",
              color: "var(--t2)",
              lineHeight: "var(--lh-body)",
              margin: "0 0 var(--sp-18)",
            }}
          >
            <b style={{ color: "var(--text)", fontWeight: "var(--fw-semibold)" }}>{confirm.n}</b>
            's comment will be permanently removed from this session. This can't
            be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
