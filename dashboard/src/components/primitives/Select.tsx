import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { Popover } from "./Popover";

export type SelectItem = { value?: string; label?: ReactNode; divider?: boolean; header?: string };
export type SelectOption = string | SelectItem;

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  icon?: string;
  width?: number | "trigger";
  label?: string;
  menuClass?: string;
};

/* ---------- Select (reusable dropdown) ----------
   Reference style (period-picker video): optional section-label header,
   whitespace group dividers, and the SELECTED row marked with a small indigo
   dot on the right. Backward compatible — options stay a flat array of
   strings/{value,label}; optionally interleave {divider:true} for a whitespace
   gap or {header:'…'} for a sub-label, and pass `label` for the top header. */
export function Select({ value, options, onChange, icon, width, label, menuClass }: SelectProps) {
  const isOpt = (o: SelectOption): o is SelectItem => !!o && typeof o === 'object' && !o.divider && o.header === undefined;
  const cur = options.find((o) => isOpt(o) ? (o.value ?? o) === value : o === value);
  const curLabel: ReactNode = cur ? ((cur as SelectItem).label ?? (cur as string)) : value;
  const num = typeof width === 'number';
  return (
    <Popover align="left" width={num ? width : 'trigger'} menuClass={menuClass}
      trigger={<button className="sel-trigger" style={num ? { minWidth: width } : { minWidth: 0, width: '100%' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: "var(--sp-6)", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{icon && <Icon name={icon} size={13} />}{curLabel}</span>
        <Icon name="chev" size={11} />
      </button>}>
      {({ close }) => <SelMenu options={options} value={value} label={label} onPick={(v) => { onChange(v); close(); }} />}
    </Popover>
  );
}

type SelMenuProps = {
  options: SelectOption[];
  value: string;
  label?: string;
  onPick: (v: string) => void;
};

/* Menu body: rows highlight with a plain hover background (the single app
   standard) and use the default cursor — not a link pointer. */
export function SelMenu({ options, value, label, onPick }: SelMenuProps) {
  return (
    <div className="sel-menu">
      {label && <div className="sel-lbl">{label}</div>}
      {(options as SelectItem[]).map((o, i) => {
        if (o && typeof o === 'object' && o.divider) return <div key={'d' + i} className="sel-gap" />;
        if (o && typeof o === 'object' && o.header !== undefined) return <div key={'h' + i} className="sel-lbl sub">{o.header}</div>;
        const v = (o.value ?? o) as string; const l = (o.label ?? o) as ReactNode; const on = v === value;
        return (
          <button key={v} className={`sel-row ${on ? 'on' : ''}`} onClick={() => onPick(v)}>
            <span className="sel-row-l">{l}</span>
            {on && <span className="sel-dot" />}
          </button>
        );
      })}
    </div>
  );
}
