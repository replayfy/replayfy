import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@/components/primitives";
import { useEscapeKey, useOutsideClick } from "@/hooks";

/* ============================================================================
   FilterMenu — one dropdown holding the chart's controls as nested rows that
   fly out beside their parent (the workspace-switcher pattern). Hover uses
   the app's continuity highlight: one pill gliding between rows.
   ========================================================================== */

export type FilterGroup = {
  key: string;
  label: string;
  current: string; // display value on the parent row
  options: { value: string; label: string }[];
  selected: string; // selected option value
  onPick: (v: string) => void;
};

type HL = { top: number; height: number } | null;

function useSlideHL() {
  const ref = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<HL>(null);
  const onEnter = (e: ReactMouseEvent<HTMLElement>) => {
    const w = ref.current;
    if (!w) return;
    const wr = w.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setHl({ top: r.top - wr.top + w.scrollTop, height: r.height });
  };
  return { ref, hl, onEnter, clear: () => setHl(null) };
}

export function FilterMenu({
  trigger,
  groups,
}: {
  trigger: string;
  groups: FilterGroup[];
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const [subTop, setSubTop] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const main = useSlideHL();
  const flyout = useSlideHL();
  const close = () => {
    setOpen(false);
    setSub(null);
  };
  useOutsideClick(wrap, close, open);
  useEscapeKey(close, open);

  const enterRow = (i: number, e: ReactMouseEvent<HTMLButtonElement>) => {
    main.onEnter(e);
    const p = main.ref.current!.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setSub(i);
    setSubTop(r.top - p.top - 5);
  };

  return (
    <div className="ox-ddwrap" ref={wrap}>
      <button
        className="sel-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--sp-6)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {trigger}
        </span>
        <Icon name="chev" size={11} />
      </button>
      {open && (
        <div
          className="ox-dd"
          ref={main.ref}
          role="menu"
          onMouseLeave={() => {
            setSub(null);
            main.clear();
          }}
        >
          <span
            className={"ox-dd-hl" + (main.hl ? " on" : "")}
            style={
              main.hl
                ? {
                    transform: `translateY(${main.hl.top}px)`,
                    height: main.hl.height,
                  }
                : { height: 0 }
            }
            aria-hidden="true"
          />
          {groups.map((g, i) => (
            <button
              key={g.key}
              className="ox-dd-row"
              role="menuitem"
              onMouseEnter={(e) => enterRow(i, e)}
              onClick={(e) => enterRow(i, e)}
            >
              <span className="l">{g.label}</span>
              <span className="cur">{g.current}</span>
              <Icon
                name="chev"
                size={10}
                style={{ transform: "rotate(-90deg)", color: "var(--t4)" }}
              />
            </button>
          ))}
          {sub != null && (
            <div
              className="ox-dd-sub"
              style={{ top: subTop }}
              role="menu"
              ref={flyout.ref}
              onMouseLeave={flyout.clear}
            >
              <span
                className={"ox-dd-hl" + (flyout.hl ? " on" : "")}
                style={
                  flyout.hl
                    ? {
                        transform: `translateY(${flyout.hl.top}px)`,
                        height: flyout.hl.height,
                      }
                    : { height: 0 }
                }
                aria-hidden="true"
              />
              {groups[sub].options.map((o) => (
                <button
                  key={o.value}
                  className={
                    "ox-dd-opt" +
                    (o.value === groups[sub].selected ? " on" : "")
                  }
                  role="menuitemradio"
                  aria-checked={o.value === groups[sub].selected}
                  onMouseEnter={flyout.onEnter}
                  onClick={() => {
                    groups[sub].onPick(o.value);
                    close();
                  }}
                >
                  <span className="l">{o.label}</span>
                  {o.value === groups[sub].selected && <span className="dot" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
