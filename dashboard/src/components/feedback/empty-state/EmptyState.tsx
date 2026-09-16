import type { ReactNode } from "react";
import { Icon } from "@/components/primitives";

type EmptyAction = {
  label: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  icon?: string;
  /** Keyboard-shortcut hint shown as chips in the button, e.g. ["N","F"] → "N then F". */
  kbd?: [string, string];
};

type EmptyStateProps = {
  art?: ReactNode;
  title?: ReactNode;
  desc?: ReactNode;
  actions?: EmptyAction[];
};

/* ---------- EmptyState (renders a unique 4D SVG via `art`) ---------- */
export function EmptyState({ art, title, desc, actions = [] }: EmptyStateProps) {
  return (
    <div className="empty">
      <div>
        <div className="empty-art">{art}</div>
        <h2>{title}</h2>
        <p>{desc}</p>
        {actions.length > 0 && (
          <div className="empty-actions">
            {actions.map((a, i) => (
              <button key={i} className={`btn ${a.primary ? 'primary' : ''}`} onClick={a.onClick}>
                {a.icon && <Icon name={a.icon} size={13} />}{a.label}
                {a.kbd && (
                  <span className="empty-kbd">
                    <kbd>{a.kbd[0]}</kbd>
                    <span className="then">then</span>
                    <kbd>{a.kbd[1]}</kbd>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
