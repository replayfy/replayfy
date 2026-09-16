/* ---------- Add-to-playlist picker -------------------------------------------
   Opened from the recording stagebar and the sessions-list context menu. Lists
   the workspace's MANUAL playlists and drops this recording into the one you
   pick (POST /v1/playlists/:id/sessions).

   MANUAL only, and server-side (`filter: "manual"`) rather than a client-side
   pass: an AUTO playlist re-runs its filter on a schedule and rewrites its whole
   member list, so a hand-added session would silently vanish on the next sweep.
   ---------- */
import { useState } from "react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Sk } from "@/components/feedback";
import { Playlists } from "@/api/endpoints";
import { useApi } from "@/api/useApi";

/* Mirrors the fields the API's playlist summary actually serialises — see
   PlaylistsService.toSummary. It also returns `pinned`, `kind`, `filter`,
   `owner` and `createdAt`; the picker has no use for those. */
type ApiPlaylist = {
  id: number;
  title: string;
  description?: string | null;
  itemCount: number;
  updatedAt?: string | null;
};

type Props = {
  open: boolean;
  sessionPublicId?: string;
  onClose: () => void;
};

export function AddToPlaylistModal({ open, sessionPublicId, onClose }: Props) {
  const [busy, setBusy] = useState<number | null>(null);
  const { data, loading, refetch } = useApi<ApiPlaylist[]>(
    () => Playlists.list<ApiPlaylist[]>({ filter: "manual", limit: 100 }),
    [],
    { enabled: open, key: "playlists-manual" },
  );
  const playlists = data ?? [];

  if (!open) return null;

  const addTo = async (p: ApiPlaylist) => {
    if (!sessionPublicId || busy) return;
    setBusy(p.id);
    try {
      // The backend resolves either a numeric id or a `ses_…` publicId; the
      // player only ever holds the publicId (it's what the URL carries).
      await Playlists.addSession(p.id, sessionPublicId);
      // The add is an upsert server-side, so re-adding is a no-op rather than an
      // error — refetch so the count reflects reality either way.
      refetch();
      toast.success(`Added to ${p.title}`);
      onClose();
    } catch (e) {
      toast.error(
        `Couldn't add to ${p.title}: ` +
          (e instanceof Error ? e.message : "error"),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Add to playlist"
      subtitle="Choose a playlist to save this recording to."
      width={520}
      onClose={onClose}
      headerIcon="listplus"
    >
      {loading ? (
        // Skeleton rows mirror the .intg-card layout (logo tile · title +
        // description · count tag) so the body holds its shape while the manual
        // playlists load — previously the list rendered empty (blank) mid-fetch.
        <div className="pick-list" aria-busy="true" aria-label="Loading playlists">
          {[0, 1, 2, 3].map((i) => (
            <div className="intg-card atc-sk" key={i} aria-hidden="true">
              <span className="intg-logo"><Sk w={18} h={18} r={6} /></span>
              <span className="intg-card-b">
                <Sk w={110 + ((i * 31) % 70)} h={12} />
                <Sk w={70 + ((i * 23) % 50)} h={9} style={{ marginTop: "var(--sp-6)" }} />
              </span>
              <Sk w={72} h={20} r={999} />
            </div>
          ))}
        </div>
      ) : playlists.length === 0 ? (
        <p
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--t3)",
            lineHeight: "var(--lh-normal)",
            margin: "var(--sp-2) var(--sp-2) var(--sp-4)",
          }}
        >
          No manual playlists yet. Create one from the sidebar, then add
          recordings to it here. Auto playlists rebuild themselves from a filter,
          so recordings can't be added to them by hand.
        </p>
      ) : (
        <div className="pick-list">
          {playlists.map((p) => {
            const isBusy = busy === p.id;
            const count = `${p.itemCount} recording${p.itemCount === 1 ? "" : "s"}`;
            return (
              <button
                key={p.id}
                className="intg-card"
                disabled={!!busy || !sessionPublicId}
                onClick={() => addTo(p)}
                aria-label={`Add this recording to ${p.title}`}
              >
                <span className="intg-logo">
                  <Icon name="rec" size={17} />
                </span>
                <span className="intg-card-b">
                  <span className="intg-card-t">{p.title}</span>
                  {(isBusy || p.description) && (
                    <span className="intg-card-d">
                      {isBusy ? "Adding…" : p.description}
                    </span>
                  )}
                </span>
                {!isBusy && <span className="tag">{count}</span>}
                <Icon name="chevR" size={14} className="intg-card-go" />
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
