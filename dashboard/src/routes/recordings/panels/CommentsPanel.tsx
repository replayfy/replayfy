import { useState } from "react";
import { rvHue } from "../helpers";
import { Sessions } from "@/api/endpoints";
import { useApi, useInvalidateApi } from "@/api/useApi";
import { SkComments } from "./RvSkeletons";
import {
  adaptComments,
  rvClock,
  type ApiComment,
  type RvCmt,
} from "../recordings.data";

type CommentsPanelProps = {
  publicId: string;
  /* Playhead as % of the session + the session's real duration in seconds.
     Together they are the moment a new note gets pinned to — the panel used to
     hardcode "0:42" (the fixture's rage click) because it was handed neither. */
  pos: number;
  durSec: number;
  /* Refresh the session detail so the tab's comment badge counts the new note. */
  onPosted?: () => void;
};

/* Comments tab — GET /v1/sessions/:id/comments lists, POST …/comments composes.
   A note is pinned to the playhead at the moment Post is pressed (atMs), which
   is what makes it seekable from the Comments page later (?t=<seconds>). The
   compose box used to be dead markup: uncontrolled input, no onClick, and
   Sessions.addComment was never called anywhere in the app. */
export function CommentsPanel({
  publicId,
  pos,
  durSec,
  onPosted,
}: CommentsPanelProps) {
  const { data, loading, stale, refetch } = useApi<ApiComment[]>(
    () => Sessions.comments<ApiComment[]>(publicId),
    [publicId],
  );
  // The list fetch's own busy signal — `loading` (cold) OR `stale` (a session
  // switch where useApi still holds the PREVIOUS recording's comments under the
  // new id). Named `listBusy` so it doesn't collide with the post-in-flight
  // `busy` state below.
  const listBusy = loading || stale;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // The sidenav's Comments badge reads Dashboard.counts under this shared key;
  // posting has to invalidate it or the badge stays stale until a refocus.
  const invalidate = useInvalidateApi();

  // No fixture fallback: a real session with zero comments must read empty,
  // not show two invented notes from people who never commented. Gated on
  // `!listBusy` so a session switch never renders the previous recording's
  // comments under the new id (mirrors the other inspector panels).
  const comments: RvCmt[] = data && !listBusy ? adaptComments(data) : [];
  // Clamp before converting: pos can read a hair out of range mid-scrub, and a
  // negative atMs would pin the note before the recording starts.
  const atMs = Math.round(
    (Math.min(100, Math.max(0, pos)) / 100) * Math.max(0, durSec) * 1000,
  );
  const at = rvClock(atMs);
  const canPost = draft.trim().length > 0 && !busy;

  const post = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await Sessions.addComment(publicId, { body, atMs });
      // Only clear on success — a failed POST keeps the draft so the note the
      // user typed isn't lost.
      setDraft("");
      refetch();
      invalidate("dashboard-counts");
      onPosted?.();
    } catch {
      /* leave the draft in place; the user can press Post again */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rv-panel rv-cmts">
      {listBusy && <SkComments n={4} />}
      {comments.map((c, i) => (
        <div key={i} className="rv-cmt">
          <span className="rv-cmt-av" style={{ background: rvHue(c[0]) }}>
            {c[0][0]}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rv-cmt-h">
              <span className="nm">{c[0]}</span>
              <span className="at">@ {c[1]}</span>
            </div>
            <div className="rv-cmt-b">{c[2]}</div>
          </div>
        </div>
      ))}
      {!listBusy && comments.length === 0 && (
        <div className="rv-cmts-empty">
          No comments on this recording yet. Pause on a moment and leave a note —
          it stays pinned to that exact timestamp.
        </div>
      )}
      <div className="rv-compose">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canPost) void post();
          }}
          placeholder={`Comment at ${at}…`}
        />
        <span className="at">@{at}</span>
        <button
          className="rv-post"
          disabled={!canPost}
          onClick={() => void post()}
        >
          {busy ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}
