import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import { Funnels } from "@/api/endpoints";
import { fmtN } from "../funnels.helpers";
import type { FnStep } from "../funnels.data";

type FnValueFieldProps = {
  /** Step kind id (page|click|event|screen|tap) — picks the session_events
   *  column the suggest reads, so the picker lists what the funnel will match. */
  kind: string;
  /** Display noun for the placeholder + header ("Event", "URL", "Screen", …). */
  label: string;
  value: string;
  onChange: (patch: Partial<FnStep>) => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement>;
};

type Sugg = { value: string; count: number };

export function FnValueField({
  kind,
  label,
  value,
  onChange,
  onClose,
  inputRef,
}: FnValueFieldProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [items, setItems] = useState<Sugg[]>([]);
  // -1 = nothing pre-highlighted. Starting at 0 pre-lit row 0 even when the cursor
  // sat over a different row (the dropdown often opens under a stationary cursor
  // carried from the operator menu) → the pill read one row off from the cursor.
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hl = useMovingHL<HTMLDivElement>();
  const noun = label.toLowerCase();
  const q = value.trim();
  const qLower = q.toLowerCase();

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [open]);

  // Debounced (200ms) real suggest — one request per settled keystroke,
  // cancelled on unmount / kind / query change (never a loop). Mirrors
  // FnFilterButton's filter-value autocomplete. Empty q → workspace top-N.
  // Backend reads the same events column this step matches on, so the list
  // is exactly what the funnel will count.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase("loading");
    const t = setTimeout(async () => {
      try {
        const res = await Funnels.stepSuggest<{ items?: Sugg[] }>({
          kind,
          q: q || undefined,
        });
        if (!cancelled) {
          setItems(res.data.items ?? []);
          setPhase("ready");
        }
      } catch {
        if (!cancelled) {
          setItems([]);
          setPhase("error");
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, kind, q]);

  const list = items;
  // The typed value can always be used verbatim (funnels match un-seen names).
  const showCustom = !!q && !list.some((it) => it.value.toLowerCase() === qLower);
  const opts = list.map((it) => it.value).concat(showCustom ? [value] : []);

  useEffect(() => {
    setActive(-1);
  }, [q, phase]);
  useEffect(() => {
    const el = itemRefs.current[active];
    if (open && el)
      hl.onEnter({
        currentTarget: el,
      } as unknown as ReactMouseEvent<HTMLElement>);
  }, [active, open, phase, q]);

  const pick = (v: string) => {
    onChange({ value: v });
    setOpen(false);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    // Only commit a highlighted row when the list is FRESH (phase === "ready").
    // Mid-refetch the list is the previous query's stale results, so Tab/Enter
    // must not silently commit one — fall through to native focus / close.
    if (open && phase === "ready" && opts.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(i + 1, opts.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && active >= 0) {
        e.preventDefault();
        pick(opts[active]);
        return;
      }
    }
    if (e.key === "Enter") {
      // Dropdown open but nothing selectable → dismiss just the dropdown;
      // closed → commit the typed value and close the whole step editor.
      if (open) setOpen(false);
      else onClose();
    }
  };

  const loadingFresh = phase === "loading" && !list.length;
  return (
    <div className="fn-ac" ref={wrapRef}>
      <div
        className="fn-cg-val"
        onClick={() => {
          inputRef.current?.focus();
        }}
      >
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          value={value}
          placeholder={`Search ${noun}…`}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            onChange({ value: e.target.value });
            setOpen(true);
          }}
          onKeyDown={onKey}
        />
        {value && (
          <button
            className="fn-cg-clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ value: "" });
              inputRef.current?.focus();
            }}
            aria-label="Clear"
          >
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      {open && (
        <div className="fn-ac-pop">
          <div className="fn-ac-h">
            {loadingFresh ? (
              <>
                <span className="fn-ac-spin" /> Fetching tracked {noun}s…
              </>
            ) : phase === "error" ? (
              <>Couldn’t load — type to use a custom value</>
            ) : (
              <>
                {list.length} tracked {noun}
                {list.length === 1 ? "" : "s"}
              </>
            )}
          </div>
          {loadingFresh && (
            <div className="fn-ac-sk">
              {[68, 54, 60, 46, 58].map((w, i) => (
                <div className="fn-ac-skrow" key={i}>
                  <span className="sk sk-ic" />
                  <span className="sk sk-tx" style={{ width: w + "%" }} />
                  <span className="sk sk-n" />
                </div>
              ))}
            </div>
          )}
          {!loadingFresh && (
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
              {list.map((it, i) => (
                <button
                  key={it.value}
                  ref={(el) => (itemRefs.current[i] = el)}
                  className={`fn-ac-item ${value === it.value ? "on" : ""}`}
                  // Sync the keyboard `active` index to the hovered row too, so the
                  // sliding highlight has a single source of truth — it can never
                  // sit on a different row than the cursor. onMouseMove catches the
                  // case where a row materialises under an already-stationary cursor
                  // (no mouseenter fires); the guard keeps it a no-op mid-row.
                  onMouseEnter={(e) => { setActive(i); hl.onEnter(e); }}
                  onMouseMove={(e) => { if (active !== i) { setActive(i); hl.onEnter(e); } }}
                  onClick={() => pick(it.value)}
                >
                  <Icon name="search" size={12} />
                  <span className="fn-ac-v">{it.value}</span>
                  <span className="fn-ac-n">{fmtN(it.count)}</span>
                </button>
              ))}
              {showCustom && (
                <button
                  ref={(el) => (itemRefs.current[list.length] = el)}
                  className="fn-ac-item fn-ac-custom"
                  onMouseEnter={(e) => { setActive(list.length); hl.onEnter(e); }}
                  onMouseMove={(e) => { if (active !== list.length) { setActive(list.length); hl.onEnter(e); } }}
                  onClick={() => pick(value)}
                >
                  <Icon name="plus" size={12} />
                  <span className="fn-ac-v">Use “{value}”</span>
                </button>
              )}
              {!list.length && !q && phase === "ready" && (
                <div className="fn-ac-empty">No tracked {noun}s yet</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
