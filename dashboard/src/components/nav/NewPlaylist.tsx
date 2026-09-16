import { useState } from "react";
import { toast } from "sonner";
import { Icon, Modal } from "@/components/primitives";
import { Playlists } from "@/api/endpoints";
import { PlaylistFilterEditor } from "./PlaylistFilterEditor";
import { plEmptyCond, type Playlist, type PlFilter } from "./nav.data";

type NewPlaylistProps = {
  existing: Playlist[];
  onClose: () => void;
  onCreate: (pl: Playlist) => void;
};

export function NewPlaylist({ existing, onClose, onCreate }: NewPlaylistProps) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState('MANUAL');
  const [filter, setFilter] = useState<PlFilter>({ conditions: [plEmptyCond()] });
  const dupe = existing.some((p) => p.title.toLowerCase() === name.trim().toLowerCase());
  const valid = name.trim().length >= 1 && !dupe;
  // Create → POST /v1/playlists. AUTO playlists carry a filter (re-run server-side
  // every 5 min); MANUAL ones don't. onCreate hands the created row back so the
  // sidebar refetches its live list.
  const submit = async () => {
    if (!valid) return;
    const body = { title: name.trim(), description: desc.trim() || undefined, kind, ...(kind === 'AUTO' ? { filter } : {}) };
    try {
      const { data } = await toast.promise(Playlists.create<Playlist>(body), {
        loading: 'Creating playlist…',
        success: (r) => `Created playlist "${r.data.title}"`,
        error: (e) => (e instanceof Error ? e.message : 'Could not create playlist'),
      }).unwrap();
      onCreate(data);
      onClose();
    } catch {
      /* toast.promise surfaces the error; keep the modal open to retry */
    }
  };
  return (
    <Modal title="New playlist" onClose={onClose} width={560} headerIcon="listplus"
      subtitle="Manual playlists are static lists of recordings. Auto-updated playlists re-run a filter every 5 minutes so the list stays current."
      footer={<><span className="sp" style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" style={{ opacity: valid ? 1 : 0.5, pointerEvents: valid ? 'auto' : 'none' }} onClick={submit}><Icon name="plus" size={13} /> Create playlist</button></>}>
      <div className="field-row"><label>Name</label>
        <input className={`text-input ${dupe ? 'in-err' : ''}`} style={{ width: '100%' }} autoFocus value={name} placeholder="e.g. Checkout failures this week"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {dupe && <div className="fld-hint"><span className="err">A playlist with this name already exists</span></div>}
      </div>
      <div className="field-row"><label>Description <span style={{ color: 'var(--t4)', fontWeight: "var(--fw-regular)", fontSize: "var(--text-xs)" }}>(optional)</span></label>
        <input className="text-input" style={{ width: '100%' }} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="field-row"><label>Type</label>
        <div style={{ display: 'flex', gap: "var(--sp-6)", marginTop: "var(--sp-4)" }}>
          {[{ id: 'MANUAL', t: 'Manual', d: 'Add recordings yourself', ic: 'plus' }, { id: 'AUTO', t: 'Auto-updated', d: 'Match a filter, re-runs every 5 min', ic: 'refresh' }].map((o) => (
            <div key={o.id} className={`pl-type ${kind === o.id ? 'on' : ''}`} onClick={() => setKind(o.id)}>
              <span className="pl-type-ic"><Icon name={o.ic} size={15} /></span>
              <span className="pl-type-tx">
                <span className="pl-type-t">{o.t}</span>
                <span className="pl-type-d">{o.d}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      {kind === 'AUTO' && <PlaylistFilterEditor filter={filter} setFilter={setFilter} />}
    </Modal>
  );
}
