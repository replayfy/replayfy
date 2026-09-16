import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import { CO_COUNTRIES, type CoField } from "../cohorts.data";

type CoValueInputProps = {
  field: CoField;
  value: string;
  onChange: (v: string) => void;
};

/* Value control for a cohort rule pill. enum + country fields get the .fn-ac
   autocomplete (filterable, moving-highlight) that mirrors the funnel value
   field; the remaining kinds are plain inputs inside the .fn-cg-val slot. */
export function CoValueInput({ field, value, onChange }: CoValueInputProps) {
  if (field.kind === "bool") return <span className="co-noval">—</span>;
  if (field.kind === "enum") {
    return (
      <CoAutocomplete
        value={value}
        onChange={onChange}
        noun={field.label.toLowerCase()}
        options={field.options!.map((o) => ({ value: o, label: o, search: o }))}
      />
    );
  }
  if (field.kind === "country") {
    return (
      <CoAutocomplete
        value={value}
        onChange={onChange}
        noun="country"
        options={CO_COUNTRIES.map((c) => ({
          value: c[0],
          label: `${c[1]}  ${c[2]}`,
          search: `${c[2]} ${c[0]}`,
          flag: c[1],
        }))}
      />
    );
  }
  if (field.kind === "recency") {
    return (
      <div className="fn-cg-val">
        <input
          type="number"
          min="1"
          value={value}
          placeholder="7"
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: "0 0 auto", width: 56 }}
        />
        <span style={{ color: "var(--t3)", fontSize: "var(--text-sm)", flexShrink: 0 }}>
          days
        </span>
      </div>
    );
  }
  if (field.kind === "number") {
    return (
      <div className="fn-cg-val">
        <input
          type="number"
          value={value}
          placeholder="0"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  if (field.kind === "event") {
    return (
      <div className="fn-cg-val">
        <Icon name="spark" size={13} />
        <input
          value={value}
          placeholder="event name — e.g. purchase"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }
  return (
    <div className="fn-cg-val">
      <input
        value={value}
        placeholder="value"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

type CoOption = { value: string; label: string; search: string; flag?: string };
type CoAutocompleteProps = {
  options: CoOption[];
  value: string;
  onChange: (v: string) => void;
  noun: string;
};

function CoAutocomplete({
  options,
  value,
  onChange,
  noun,
}: CoAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxH: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hl = useMovingHL<HTMLDivElement>();

  const current = options.find((o) => o.value === value);
  const ql = q.trim().toLowerCase();
  const list = ql
    ? options.filter(
        (o) =>
          o.search.toLowerCase().includes(ql) ||
          o.label.toLowerCase().includes(ql),
      )
    : options;
  const display = open ? q : (current?.label ?? value);

  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        wrapRef.current &&
        !wrapRef.current.contains(t) &&
        (!popRef.current || !popRef.current.contains(t))
      )
        setOpen(false);
    };
    // The popup is portaled (position:fixed); close on ancestor scroll so it
    // doesn't visually detach from the input.
    const onScroll = (e: Event) => {
      if (popRef.current && popRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", h);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);
  // Anchor the portaled dropdown to the input; flip up when there's no room below
  // (so it never clips inside the drawer's scroll container).
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) {
      setPos(null);
      return;
    }
    const r = wrapRef.current.getBoundingClientRect();
    const gap = 6,
      margin = 8,
      desired = 300;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const down = below >= Math.min(desired, 180) || below >= above;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
      width: r.width,
      ...(down
        ? { top: r.bottom + gap, maxH: Math.max(160, below) }
        : { bottom: window.innerHeight - r.top + gap, maxH: Math.max(160, above) }),
    });
  }, [open]);
  useEffect(() => {
    setActive(0);
  }, [ql, open]);
  useEffect(() => {
    const el = itemRefs.current[active];
    if (open && el)
      hl.onEnter({
        currentTarget: el,
      } as unknown as ReactMouseEvent<HTMLElement>);
  }, [active, open, ql]);

  const openIt = () => {
    setQ("");
    setOpen(true);
  };
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openIt();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (list[active]) {
        e.preventDefault();
        pick(list[active].value);
      }
    }
  };

  return (
    <div className="fn-ac" ref={wrapRef}>
      <div
        className="fn-cg-val"
        onClick={() => {
          if (!open) openIt();
          inputRef.current?.focus();
        }}
      >
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          value={display}
          placeholder={`Search ${noun}…`}
          onFocus={() => {
            if (!open) openIt();
          }}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKey}
        />
        {value && !open && (
          <button
            className="fn-cg-clear"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
              openIt();
              inputRef.current?.focus();
            }}
            aria-label="Clear"
          >
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      {open && pos &&
        createPortal(
          <div
            className="fn-ac-pop"
            ref={popRef}
            style={{ position: "fixed", zIndex: 1200, left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, right: "auto", maxHeight: pos.maxH, overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
          <div className="fn-ac-h">
            {list.length} option{list.length === 1 ? "" : "s"}
          </div>
          <div className="fn-ac-list" ref={hl.ref} onMouseLeave={hl.onLeave}>
            <span
              className={`fn-ac-hl ${hl.hl ? "on" : ""}`}
              style={
                hl.hl
                  ? {
                      transform: `translateY(${hl.hl.top}px)`,
                      height: hl.hl.height,
                    }
                  : { height: 0 }
              }
            />
            {list.map((o, i) => (
              <button
                key={o.value}
                ref={(el) => (itemRefs.current[i] = el)}
                type="button"
                className={`fn-ac-item ${o.value === value ? "on" : ""}`}
                onMouseEnter={hl.onEnter}
                onClick={() => pick(o.value)}
              >
                {o.flag ? (
                  <span
                    style={{
                      fontSize: "var(--text-md)",
                      lineHeight: "var(--lh-none)",
                      width: 16,
                      flexShrink: 0,
                    }}
                  >
                    {o.flag}
                  </span>
                ) : (
                  <Icon
                    name="check"
                    size={12}
                    style={o.value === value ? undefined : { opacity: 0 }}
                  />
                )}
                <span className="fn-ac-v">
                  {o.flag ? o.label.replace(/^\S+\s+/, "") : o.label}
                </span>
              </button>
            ))}
            {list.length === 0 && <div className="fn-ac-empty">No matches</div>}
          </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
