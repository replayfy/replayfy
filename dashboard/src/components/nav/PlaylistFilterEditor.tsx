import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon, Popover } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import {
  PL_FIELDS,
  PL_OPS,
  PL_COUNTRIES,
  plEmptyCond,
  plFieldDef,
  type PlField,
  type PlFilter,
} from "./nav.data";

type PlaylistFilterEditorProps = {
  filter: PlFilter;
  setFilter: (f: PlFilter) => void;
};

/* Playlist filter — rendered with the SAME enterprise .fn-cg rule pills as the
   cohort builder: each condition is one bordered pill holding a searchable field
   picker, a moving-highlight operator menu, and a value control (autocomplete
   for bool/enum/country, plain input for number/text). All the .fn-cg / .fn-ac /
   .fn-menu / .fn-fp2 / .co-* classes are global, so no CSS is added here. */
export function PlaylistFilterEditor({
  filter,
  setFilter,
}: PlaylistFilterEditorProps) {
  const conds = filter.conditions || [];
  const setAt = (i: number, next: PlFilter["conditions"][number]) =>
    setFilter({ conditions: conds.map((c, idx) => (idx === i ? next : c)) });
  const add = () => setFilter({ conditions: [...conds, plEmptyCond()] });
  const remove = (i: number) =>
    setFilter({ conditions: conds.filter((_, idx) => idx !== i) });

  // Switching field resets op + value to that field kind's defaults so the
  // condition stays valid (mirrors the cohort builder's field transition).
  const pickField = (i: number, nv: string) => {
    const nf = plFieldDef(nv);
    const dv =
      nf.kind === "bool"
        ? "true"
        : nf.kind === "enum"
          ? nf.options![0]
          : nf.kind === "country"
            ? "US"
            : "";
    setAt(i, { field: nv, op: PL_OPS[nf.kind][0][0], value: dv });
  };

  return (
    <div className="field-row">
      <label>
        Filter{" "}
        <span style={{ color: "var(--t4)", fontWeight: "var(--fw-regular)", fontSize: "var(--text-xs)" }}>
          (all conditions must match)
        </span>
      </label>
      <div className="co-conds" style={{ marginTop: "var(--sp-8)" }}>
        {conds.map((c, i) => {
          const field = plFieldDef(c.field);
          const ops = PL_OPS[field.kind] || PL_OPS.text;
          const opLabel = (ops.find((o) => o[0] === c.op) || ops[0])[1];
          return (
            <div className="co-row" key={i}>
              <span className="co-conn">{i === 0 ? "Where" : "and"}</span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--sp-8)",
                  minWidth: 0,
                }}
              >
                <div className="fn-cg" style={{ flex: 1, minWidth: 0 }}>
                  {/* field — searchable command-palette picker */}
                  <Popover
                    width={272}
                    trigger={
                      <button className="fn-cg-op" type="button">
                        <Icon name={field.icon} size={13} />
                        {field.label}
                        <Icon name="chev" size={11} />
                      </button>
                    }
                  >
                    {({ close }) => (
                      <PlFieldMenu
                        value={c.field}
                        onPick={(v) => {
                          pickField(i, v);
                          close();
                        }}
                      />
                    )}
                  </Popover>

                  {/* operator — moving-highlight menu */}
                  <Popover
                    trigger={
                      <button className="fn-cg-op" type="button">
                        {opLabel}
                        <Icon name="chev" size={11} />
                      </button>
                    }
                  >
                    {({ close }) => (
                      <PlOpMenu
                        ops={ops}
                        value={c.op}
                        onPick={(op) => {
                          setAt(i, { ...c, op });
                          close();
                        }}
                      />
                    )}
                  </Popover>

                  {/* value — .fn-ac autocomplete where applicable */}
                  <PlValueInput
                    field={field}
                    value={c.value}
                    onChange={(v) => setAt(i, { ...c, value: v })}
                  />
                </div>
                <button
                  className="fn-cg-clear"
                  type="button"
                  style={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    opacity: conds.length > 1 ? 1 : 0.3,
                    cursor: conds.length > 1 ? "pointer" : "not-allowed",
                  }}
                  onClick={() => remove(i)}
                  disabled={conds.length === 1}
                  title={
                    conds.length === 1
                      ? "At least one condition is required"
                      : "Remove condition"
                  }
                  aria-label="Remove condition"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          );
        })}
        <button className="co-addrule" type="button" onClick={add}>
          <Icon name="plus" size={12} /> AND condition
        </button>
      </div>
    </div>
  );
}

type PlFieldMenuProps = { value: string; onPick: (v: string) => void };

/* Flat searchable field list (playlist fields aren't grouped). Reuses the
   command-palette .fn-fp2 markup, minus the group headers. */
function PlFieldMenu({ value, onPick }: PlFieldMenuProps) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const list = PL_FIELDS.filter(
    (f) => !ql || f.label.toLowerCase().includes(ql),
  );
  return (
    <div style={{ margin: -6 }}>
      <div
        className="fn-fp2-search"
        style={{
          padding: "var(--sp-10) var(--sp-12)",
          borderBottom: "1px solid var(--line-2)",
        }}
      >
        <Icon name="search" size={14} />
        <input
          autoFocus
          value={q}
          placeholder="Search fields…"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {/* No own scroll — the Popover's .menu-pop is the single scroll container
          (a second overflow:auto here caused a double scrollbar). */}
      <div style={{ padding: "var(--sp-6)" }}>
        {list.length === 0 && (
          <div className="fn-fp2-empty">No fields match</div>
        )}
        {list.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`fn-fp2-item ${f.value === value ? "active" : ""}`}
            onClick={() => onPick(f.value)}
          >
            <span className="fn-fp2-ico">
              <Icon name={f.icon} size={13} />
            </span>
            {f.label}
            {f.value === value && (
              <Icon
                name="check"
                size={13}
                style={{ marginLeft: "auto", color: "var(--accent)" }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

type PlOpMenuProps = {
  ops: [string, string][];
  value: string;
  onPick: (op: string) => void;
};

function PlOpMenu({ ops, value, onPick }: PlOpMenuProps) {
  const hl = useMovingHL<HTMLDivElement>();
  return (
    <div className="fn-menu fn-menu-cont" ref={hl.ref} onMouseLeave={hl.onLeave}>
      <span
        className={`fn-menu-hl ${hl.hl ? "on" : ""}`}
        style={
          hl.hl
            ? { transform: `translateY(${hl.hl.top}px)`, height: hl.hl.height }
            : { height: 0 }
        }
      />
      {ops.map(([o, l]) => (
        <button
          key={o}
          type="button"
          className={value === o ? "on" : ""}
          onMouseEnter={hl.onEnter}
          onClick={() => onPick(o)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

type PlValueInputProps = {
  field: PlField;
  value: string;
  onChange: (v: string) => void;
};

/* Value control for a playlist rule pill. bool/enum/country get the .fn-ac
   autocomplete; number/text are plain inputs in the .fn-cg-val slot. Note:
   unlike cohort bool (which bakes the value into the operator → "—"), playlist
   bool keeps a true/false value, so it renders a two-option autocomplete. */
function PlValueInput({ field, value, onChange }: PlValueInputProps) {
  if (field.kind === "bool") {
    return (
      <PlAutocomplete
        value={value}
        onChange={onChange}
        noun="value"
        options={[
          { value: "true", label: "true", search: "true" },
          { value: "false", label: "false", search: "false" },
        ]}
      />
    );
  }
  if (field.kind === "enum") {
    return (
      <PlAutocomplete
        value={value}
        onChange={onChange}
        noun={field.label.toLowerCase()}
        options={field.options!.map((o) => ({ value: o, label: o, search: o }))}
      />
    );
  }
  if (field.kind === "country") {
    return (
      <PlAutocomplete
        value={value}
        onChange={onChange}
        noun="country"
        options={PL_COUNTRIES.map((c) => ({
          value: c[0],
          label: `${c[1]}  ${c[2]}`,
          search: `${c[2]} ${c[0]}`,
          flag: c[1],
        }))}
      />
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

type PlOption = { value: string; label: string; search: string; flag?: string };
type PlAutocompleteProps = {
  options: PlOption[];
  value: string;
  onChange: (v: string) => void;
  noun: string;
};

function PlAutocomplete({
  options,
  value,
  onChange,
  noun,
}: PlAutocompleteProps) {
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
    // doesn't visually detach from the input inside the modal.
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
  // (so it never clips at the modal edge).
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
