type ToggleProps = {
  on: boolean;
  onChange: (v: boolean) => void;
};

/* ---------- Toggle ---------- */
export function Toggle({ on, onChange }: ToggleProps) { return <button className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />; }
