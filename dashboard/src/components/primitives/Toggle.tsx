type ToggleProps = {
  on: boolean;
  onChange: (v: boolean) => void;
  /** Ignores clicks and looks like .btn:disabled (dimmed, not-allowed
   *  cursor). Omitted (the default), the button renders exactly as before. */
  disabled?: boolean;
};

/* ---------- Toggle ---------- */
export function Toggle({ on, onChange, disabled }: ToggleProps) { return <button className={`toggle ${on ? 'on' : ''}`} disabled={disabled} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined} onClick={() => onChange(!on)} />; }
