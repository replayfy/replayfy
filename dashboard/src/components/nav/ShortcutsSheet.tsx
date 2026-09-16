import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/primitives";

/* The real, in-app keyboard shortcuts — sourced from the actual handlers
   (Sidebar's ⌘K / N-sequence (incl. N P → new playlist) / ⌘1–9 / ⌥⇧Q, and the replay player's
   Space / arrows / [ ] / F), never invented. Opened from the account menu,
   the app's ⌘/ equivalent. */
type Row = { action: string; keys: string[] };
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "General",
    rows: [
      { action: "Open command palette", keys: ["⌘", "K"] },
      { action: "New playlist", keys: ["N", "then", "P"] },
      { action: "New funnel", keys: ["N", "then", "F"] },
      { action: "New cohort", keys: ["N", "then", "C"] },
      { action: "Switch workspace", keys: ["⌘", "1–9"] },
      { action: "Sign out", keys: ["⌥", "⇧", "Q"] },
    ],
  },
  {
    title: "Session replay",
    rows: [
      { action: "Play / pause", keys: ["Space"] },
      { action: "Step back / forward", keys: ["←", "→"] },
      { action: "Previous / next session", keys: ["[", "]"] },
      { action: "Focus mode", keys: ["F"] },
    ],
  },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="ks-back" onMouseDown={onClose}>
      <div
        className="ks-sheet"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ks-head">
          <span className="ks-title">Keyboard shortcuts</span>
          <button className="ks-x" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="ks-body">
          {GROUPS.map((g) => (
            <div className="ks-grp" key={g.title}>
              <div className="ks-grp-t">{g.title}</div>
              {g.rows.map((r) => (
                <div className="ks-row" key={r.action}>
                  <span className="ks-act">{r.action}</span>
                  <span className="ks-keys">
                    {r.keys.map((k, i) =>
                      k === "then" ? (
                        <span className="ks-then" key={i}>
                          then
                        </span>
                      ) : (
                        <kbd key={i}>{k}</kbd>
                      ),
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
