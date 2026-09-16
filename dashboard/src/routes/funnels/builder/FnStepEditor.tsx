import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Icon, Popover } from "@/components/primitives";
import { fnKind, fnMatch } from "../funnels.helpers";
import type { FnStep } from "../funnels.data";
import { FnEventPicker } from "./FnEventPicker";
import { FnOpMenu } from "./FnOpMenu";
import { FnValueField } from "./FnValueField";

export type EdPos = {
  left: number;
  w: number;
  up: boolean;
  top: number | null;
  bottom: number | null;
  ax: number;
};

type FnStepEditorProps = {
  st: FnStep;
  idx: number;
  pos: EdPos;
  onChange: (patch: Partial<FnStep>) => void;
  onDup: () => void;
  onRemove: () => void;
  canRemove: boolean;
  onClose: () => void;
};

export function FnStepEditor({
  st,
  idx,
  pos,
  onChange,
  onDup,
  onRemove,
  canRemove,
  onClose,
}: FnStepEditorProps) {
  const k = fnKind(st.kind);
  const [adv, setAdv] = useState(false);
  const [props, setProps] = useState<unknown[]>(st._props || []);
  const [confirmDel, setConfirmDel] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  useEffect(() => {
    setTimeout(() => inRef.current?.focus(), 120);
  }, []);
  const style: CSSProperties = {
    position: "fixed",
    left: pos.left,
    width: pos.w,
    zIndex: 60,
    ...(pos.up ? { bottom: pos.bottom! } : { top: pos.top! }),
  };
  const filled = (ic: string) => ic === "cursor" || ic === "spark";
  const advCount =
    (st.caseSensitive ? 1 : 0) +
    (st.negate ? 1 : 0) +
    (st.regex ? 1 : 0) +
    (st.ignoreQuery === false ? 0 : 0);
  return (
    <div
      ref={ref}
      className={`fn-sed ${pos.up ? "up" : ""}`}
      style={style}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="fn-sed-arrow"
        style={{ left: Math.max(22, Math.min(pos.w - 22, pos.ax - pos.left)) }}
      />
      <div className="fn-sed-hd">
        <span className="fn-sed-eyebrow">Step {idx + 1}</span>
        <span className="sp" style={{ flex: 1 }} />
        <button className="fn-sed-x" onClick={onClose} aria-label="Close">
          <Icon name="x" size={13} />
        </button>
      </div>

      {/* event — command-palette row */}
      <div className="fn-ev-wrap">
        <Popover
          trigger={
            <button className="fn-ev-row">
              <span className="fn-ev-ic">
                <Icon name={k.ic} size={16} fill={filled(k.ic)} />
              </span>
              <span className="fn-ev-meta">
                <span className="fn-ev-cap">Event</span>
                <span className="fn-ev-name">{k.label}</span>
              </span>
              <Icon name="chev" size={15} className="fn-ev-chev" />
            </button>
          }
        >
          {({ close }) => (
            <FnEventPicker
              current={st.kind}
              onPick={(id) => {
                onChange({ kind: id });
                close();
              }}
            />
          )}
        </Popover>
      </div>

      {/* condition — one unified control */}
      <div className="fn-cond3">
        <div className="fn-cond3-lead">
          where <span className="fld">{k.field}</span>
        </div>
        <div className="fn-cg">
          <Popover
            trigger={
              <button className="fn-cg-op">
                {fnMatch(st.matchType)}
                <Icon name="chev" size={11} />
              </button>
            }
          >
            {({ close }) => (
              <FnOpMenu
                value={st.matchType}
                onPick={(m) => {
                  onChange({ matchType: m });
                  close();
                }}
              />
            )}
          </Popover>
          <FnValueField
            // Remount on kind change so suggestions/phase reset — otherwise the
            // previous kind's values linger and stay clickable until the refetch.
            key={k.id}
            kind={k.id}
            label={k.field}
            value={st.value}
            onChange={onChange}
            onClose={onClose}
            inputRef={inRef}
          />
        </div>
      </div>

      {confirmDel && (
        <div className="fn-sed-confirm">
          <span>Delete this step?</span>
          <span className="sp" style={{ flex: 1 }} />
          <button onClick={() => setConfirmDel(false)}>Cancel</button>
          <button className="del" onClick={onRemove}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
