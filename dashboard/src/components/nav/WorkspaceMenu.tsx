import { useRef, useState } from "react";
import { Icon } from "@/components/primitives";
import type { Workspace } from "@/lib/workspaces";

/* ============================================================================
   WorkspaceMenu — the account switcher. One flat panel: account email on top,
   every workspace listed inline (no hover-flyout) with real ⌘1–⌘9 switching,
   then the workspace actions. Text-first rows, hairline groups, and the
   app's continuity highlight gliding across all of it.
   ========================================================================== */

type WorkspaceMenuProps = {
  ws: Workspace[];
  cur: Workspace;
  email?: string;
  onSwitch: (w: Workspace) => void;
  onNew: () => void;
  onSettings: () => void;
  onTeam: () => void;
  onSignOut: () => void;
};

type WsHl = { top: number; height: number } | null;

export function WorkspaceMenu({ ws, cur, email, onSwitch, onNew, onSettings, onTeam, onSignOut }: WorkspaceMenuProps) {
  const [hl, setHl] = useState<WsHl>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const enter = (e: React.MouseEvent<HTMLElement>) => {
    const w = bodyRef.current; if (!w) return;
    const wr = w.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setHl({ top: r.top - wr.top, height: r.height });
  };

  return (
    <div className="wsx">
      {email && <div className="wsx-h">{email}</div>}
      <div className="wsx-body" ref={bodyRef} onMouseLeave={() => setHl(null)}>
        <span className={"wsx-hl" + (hl ? " on" : "")} style={hl ? { transform: `translateY(${hl.top}px)`, height: hl.height } : { height: 0 }} aria-hidden="true" />

        {ws.map((w, i) => (
          <button key={w.id} className="wsx-row" onMouseEnter={enter} onClick={() => onSwitch(w)} role="menuitemradio" aria-checked={w.id === cur.id}>
            <span className="wsx-av" style={{ background: w.c }}>{w.name[0]}</span>
            <span className="wsx-l">{w.name}</span>
            {w.id === cur.id && <Icon name="check" size={14} className="wsx-check" />}
            {i < 9 && <span className="wsx-k">⌘{i + 1}</span>}
          </button>
        ))}

        <div className="wsx-sep" />

        <button className="wsx-row" onMouseEnter={enter} onClick={onSettings} role="menuitem">
          <span className="wsx-l">Workspace settings</span>
        </button>
        <button className="wsx-row" onMouseEnter={enter} onClick={onTeam} role="menuitem">
          <span className="wsx-l">Manage team</span>
        </button>

        <div className="wsx-sep" />

        <button className="wsx-row" onMouseEnter={enter} onClick={onNew} role="menuitem">
          <span className="wsx-l">New workspace…</span>
        </button>
        <button className="wsx-row" onMouseEnter={enter} onClick={onSignOut} role="menuitem">
          <span className="wsx-l">Sign out</span>
          <span className="wsx-k">⌥⇧Q</span>
        </button>
      </div>
    </div>
  );
}
