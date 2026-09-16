import { Icon } from "./Icon";

type CheckboxProps = {
  on: boolean;
  onChange: (v: boolean) => void;
};

/* ---------- Checkbox ---------- */
export function Checkbox({ on, onChange }: CheckboxProps) {
  return <button className={`cbox ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>{on && <Icon name="check" size={11} />}</button>;
}
