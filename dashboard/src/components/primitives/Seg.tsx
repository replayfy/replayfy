import type { ReactNode } from "react";
import { Icon } from "./Icon";

export type SegItem = { value?: string; label?: ReactNode; icon?: string };
export type SegOption = string | SegItem;

type SegProps = {
  value: string;
  options: SegOption[];
  onChange: (v: string) => void;
};

/* ---------- Segmented control ---------- */
export function Seg({ value, options, onChange }: SegProps) {
  return <div className="seg">{(options as SegItem[]).map((o) => {
    const v = (o.value ?? o) as string; const l = (o.label ?? o) as ReactNode;
    return <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{o.icon && <Icon name={o.icon} size={12} />}{l}</button>;
  })}</div>;
}
