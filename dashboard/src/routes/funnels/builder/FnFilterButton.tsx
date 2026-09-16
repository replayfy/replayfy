import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "@/components/primitives";
import { Funnels } from "@/api/endpoints";
import { fnOpsFor, fnDefOp } from "../funnels.helpers";
import {
  FN_FGROUPS,
  FN_COUNTRIES,
  FN_FVALUES,
  FN_FKIND,
  FN_OPS,
  FN_FLABEL,
  FN_FICON,
  FN_FGROUP_COLOR,
  FN_FGROUP_OF,
  type FnFilter,
} from "../funnels.data";

type FnFilterButtonProps = { onCommit: (f: FnFilter) => void; note?: string; allow?: string[] };
type FpItem = { k: string; l: string; group?: string; flag?: string };
type FnSuggestItem = { value: string; count: number };

/** Fixed session dimensions that GET /v1/funnels/suggest can autocomplete
 *  (the keys of the backend FIELD_COL map + startUrlContains). userAttr is
 *  intentionally excluded (its values live in a separate discovery endpoint). */
const SUGGESTABLE = new Set<string>([
  "startUrlContains",
  "urlPath",
  "referrerUrl",
  "userId",
  "anonymousId",
  // browser / os / device / plan: no longer hardcoded in FN_FVALUES, so the
  // value step autocompletes them from the REAL workspace values via
  // /v1/funnels/suggest (FIELD_COL resolves each to its ClickHouse column).
  "browser",
  "os",
  "device",
  "plan",
  "browserVersion",
  "osVersion",
  "city",
  "state",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "revId",
  "pageCount",
  "errorCount",
]);

/** Resolve the group-accent inline style for a filter field's icon square (F1). */
function fnIcoStyle(k: string): CSSProperties | undefined {
  const c = FN_FGROUP_COLOR[FN_FGROUP_OF[k]];
  return c
    ? { background: c.tint, borderColor: "transparent", color: c.fg }
    : undefined;
}

export function FnFilterButton({ onCommit, note = "Filter this funnel’s sessions", allow }: FnFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number } | null>(null);
  const [level, setLevel] = useState("fields");
  const [dir, setDir] = useState(1);
  const [field, setField] = useState<string | null>(null);
  const [op, setOp] = useState("is");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  // Value autocomplete (F2) — distinct real values for the current field from
  // GET /v1/funnels/suggest, most-common first. Only for SUGGESTABLE dimensions.
  const [sugg, setSugg] = useState<FnSuggestItem[]>([]);
  // True while a suggest request is in flight (incl. the 200ms debounce) so the
  // value list can show a skeleton instead of a blank gap, mirroring FnValueField.
  const [suggLoading, setSuggLoading] = useState(false);
  const btnRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const gap = 6, margin = 12, desired = 460;
    const left = Math.max(16, Math.min(r.left, window.innerWidth - 616));
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    // Open downward by default; flip upward ONLY when there isn't room below for a
    // usable panel AND above is roomier. Mid-page triggers (the funnel builder)
    // keep opening down exactly as before; a trigger near the viewport bottom
    // (e.g. Analytics' filter) anchors its BOTTOM to the trigger top instead.
    if (below >= desired || below >= above) {
      setPos({ top: r.bottom + gap, left, maxHeight: Math.min(540, Math.max(220, below - gap)) });
    } else {
      setPos({ bottom: window.innerHeight - r.top + gap, left, maxHeight: Math.min(540, Math.max(220, above - gap)) });
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  useEffect(() => {
    if (open) {
      setTimeout(() => inRef.current?.focus(), 40);
    } else {
      setLevel("fields");
      setField(null);
      setQ("");
      setActive(0);
    }
  }, [open, level]);

  // When `allow` is provided, restrict the field catalogue to those keys (and
  // drop now-empty groups) — lets a host reuse this exact command-palette but
  // scope it to only its own relevant fields (e.g. Analytics' dimensions).
  const GROUPS = allow
    ? FN_FGROUPS.map((g) => ({ ...g, keys: g.keys.filter(([k]) => allow.includes(k)) })).filter((g) => g.keys.length)
    : FN_FGROUPS;

  // build the flat list for the current level (drives keyboard nav + render)
  let items: FpItem[] = [];
  if (level === "fields") {
    for (const g of GROUPS)
      for (const [k, l] of g.keys)
        if (
          !q ||
          l.toLowerCase().includes(q.toLowerCase()) ||
          g.title.toLowerCase().includes(q.toLowerCase())
        )
          items.push({ k, l, group: g.title });
  } else if (level === "ops") {
    items = fnOpsFor(field!).map((o) => ({ k: o, l: FN_OPS[o] }));
  } else if (level === "values") {
    if (field === "country") {
      items = FN_COUNTRIES.filter(
        ([n]) => !q || n.toLowerCase().includes(q.toLowerCase()),
      ).map(([n, f]) => ({ k: n, l: n, flag: f }));
    } else if (FN_FKIND[field!] === "bool") {
      // Boolean signals collapse the two-step is/is-not → true/false into one
      // choice: "is true" (has the signal) / "is false" (doesn't).
      items = [
        { k: "true", l: "is true" },
        { k: "false", l: "is false" },
      ];
    } else {
      const vals = FN_FVALUES[field!] || [];
      items = vals
        .filter((v) => !q || v.toLowerCase().includes(q.toLowerCase()))
        .map((v) => ({ k: v, l: v }));
    }
  }
  const isText =
    level === "values" && field !== "country" && !FN_FVALUES[field!];
  // Autocomplete is only offered for free-text values on a suggestable dimension.
  const suggestOn = isText && !!field && SUGGESTABLE.has(field);

  // Debounced (200ms) value autocomplete, keyed on [field, q] (F2). Mirrors the
  // legacy FilterValueInput: fetch distinct workspace values from /suggest and
  // surface them as one-click rows above the free-text input. A single request
  // per settled keystroke; cancelled on unmount / field change (never a loop).
  useEffect(() => {
    if (!suggestOn || !field) {
      setSugg([]);
      setSuggLoading(false);
      return;
    }
    let cancelled = false;
    // Flag the fetch synchronously (covers debounce + request) so a fresh open or
    // query change paints a skeleton; cleared on settle. A keystroke re-runs this
    // effect and re-flags — never a loop (one timeout, cancelled on cleanup).
    setSuggLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await Funnels.suggest<{ items?: FnSuggestItem[] }>({
          field,
          q: q || "",
        });
        if (!cancelled) {
          setSugg(res.data.items ?? []);
          setSuggLoading(false);
        }
      } catch {
        if (!cancelled) {
          setSugg([]);
          setSuggLoading(false);
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [field, q, suggestOn]);

  const goFields = () => {
    setDir(-1);
    setLevel("fields");
    setField(null);
    setQ("");
    setActive(0);
  };
  const goOps = () => {
    setDir(-1);
    setLevel("ops");
    setQ("");
    setActive(0);
  };
  const pickField = (k: string) => {
    setDir(1);
    setField(k);
    setOp(fnDefOp(k));
    // Boolean signal fields (Error / Rage / Dead) have no meaningful operator —
    // skip the is/is-not step and go straight to the is-true / is-false choice.
    setLevel(FN_FKIND[k] === "bool" ? "values" : "ops");
    setQ("");
    setActive(0);
  };
  const pickOp = (o: string) => {
    setDir(1);
    setOp(o);
    setLevel("values");
    setQ("");
    setActive(0);
  };
  const commit = (val: string) => {
    onCommit({ key: field!, op, val });
    setOpen(false);
  };
  const choose = (it: FpItem) => {
    if (level === "fields") pickField(it.k);
    else if (level === "ops") pickOp(it.k);
    else commit(it.k);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && q === "") {
      if (level === "values") {
        e.preventDefault();
        // bool fields skipped the ops step, so step back to fields, not ops
        if (FN_FKIND[field!] === "bool") goFields();
        else goOps();
      } else if (level === "ops") {
        e.preventDefault();
        goFields();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isText && q.trim()) commit(q.trim());
      else if (items[active]) choose(items[active]);
    }
  };

  const label = field ? FN_FLABEL[field] || field : "";
  const two = level === "fields" && !q;
  // Quick-pick "Suggested" filter fields (the common ones) — real fields surfaced
  // as chips for the enterprise command-palette feel; skips any not registered.
  const suggested = [
    "platform",
    "country",
    "browser",
    "device",
    "urlPath",
  ].filter((k) => FN_FLABEL[k] && (!allow || allow.includes(k)));

  return (
    <span ref={btnRef} style={{ display: "inline-flex" }}>
      <button className={"fn-addf" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={11} /> Add filter
      </button>
      {open && pos && (
        <div
          className="fn-fp2 fn-compact"
          ref={panelRef}
          data-flip={pos.bottom !== undefined ? "up" : "down"}
          // Anchored either top-to-trigger-bottom (down) or bottom-to-trigger-top
          // (flipped up near the viewport bottom); maxHeight is pre-bounded to the
          // room on the chosen side so a long value list scrolls in view instead
          // of spilling off-screen.
          style={{
            position: "fixed",
            ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
            left: pos.left,
            maxHeight: pos.maxHeight,
          }}
          onKeyDown={onKey}
        >
          <div className="fn-fp2-head">
            {level !== "fields" && (
              <div className="fn-fp2-crumb">
                <button onClick={goFields}>
                  {level === "values" ? "Filters" : "‹ Filters"}
                </button>
                {level === "values" && (
                  <>
                    <span className="sep">›</span>
                    {FN_FKIND[field!] === "bool" ? (
                      // No ops step for booleans — the crumb ends at the field.
                      <span className="cur">{label}</span>
                    ) : (
                      <>
                        <button onClick={goOps}>{label}</button>
                        <span className="sep">›</span>
                        <span className="cur">{FN_OPS[op]}</span>
                      </>
                    )}
                  </>
                )}
                {level === "ops" && (
                  <>
                    <span className="sep">›</span>
                    <span className="cur">{label}</span>
                  </>
                )}
              </div>
            )}
            <div className="fn-fp2-search">
              <Icon name="search" size={15} />
              <input
                ref={inRef}
                value={q}
                placeholder={
                  level === "fields"
                    ? "Search filters or press…"
                    : level === "values"
                      ? `Search ${label.toLowerCase()}…`
                      : "Search…"
                }
                onChange={(e) => {
                  setQ(e.target.value);
                  setActive(0);
                }}
              />
              <kbd className="fn-fp2-kbd">esc</kbd>
            </div>
          </div>
          {level === "fields" && !q && suggested.length > 0 && (
            <div className="fn-fp2-suggest">
              <span className="fn-fp2-suggest-l">Suggested</span>
              {suggested.map((k) => (
                <button
                  key={k}
                  className="fn-fp2-chip"
                  onClick={() => pickField(k)}
                >
                  {FN_FLABEL[k] || k}
                </button>
              ))}
            </div>
          )}
          <div
            className={`fn-fp2-body slide-${dir > 0 ? "f" : "b"}`}
            key={level + (field || "")}
          >
            {isText ? (
              <div className="fn-fp2-textwrap">
                {suggestOn && suggLoading && sugg.length === 0 ? (
                  // First load / query change with no cached rows → skeleton
                  // (reuses FnValueField's global .fn-ac-sk). During a refetch that
                  // still has rows we keep the old list visible below.
                  <div className="fn-fp2-sugg">
                    <div className="fn-fp2-sugg-h">Matching values</div>
                    <div className="fn-ac-sk">
                      {[70, 52, 61, 44].map((w, i) => (
                        <div className="fn-ac-skrow" key={i}>
                          <span className="sk sk-ic" />
                          <span className="sk sk-tx" style={{ width: w + "%" }} />
                          <span className="sk sk-n" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : suggestOn && sugg.length > 0 ? (
                  <div className="fn-fp2-sugg">
                    <div className="fn-fp2-sugg-h">Matching values</div>
                    {sugg.map((s) => (
                      <button
                        key={s.value}
                        type="button"
                        className="fn-fp2-sugg-item"
                        onClick={() => commit(s.value)}
                      >
                        <span className="fn-fp2-sugg-val mono">{s.value}</span>
                        <span className="fn-fp2-sugg-cnt">
                          {s.count.toLocaleString()}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="fn-fp2-textrow">
                  <input
                    className="fn-fp2-in"
                    autoFocus
                    placeholder="Enter value…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && q.trim()) commit(q.trim());
                    }}
                  />
                  <button
                    className="fn-fp2-apply"
                    disabled={!q.trim()}
                    onClick={() => q.trim() && commit(q.trim())}
                  >
                    Apply
                  </button>
                </div>
              </div>
            ) : two ? (
              <div className="fn-fp2-cols">
                {GROUPS.map((g) => (
                  <div key={g.title} className="fn-fp2-cell">
                    <div className="fn-fp2-gh">{g.title}</div>
                    {g.keys.map(([k, l]) => {
                      const ai = items.findIndex((x) => x.k === k);
                      return (
                        <button
                          key={k}
                          className={`fn-fp2-item ${ai === active ? "active" : ""}`}
                          onMouseEnter={() => setActive(ai)}
                          onClick={() => pickField(k)}
                        >
                          <span className="fn-fp2-ico" style={fnIcoStyle(k)}>
                            <Icon name={FN_FICON[k] || "funnel"} size={13} />
                          </span>
                          {l}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : (
              <div className="fn-fp2-list">
                {items.length === 0 && (
                  <div className="fn-fp2-empty">No matches</div>
                )}
                {items.map((it, i) => (
                  <button
                    key={it.k}
                    className={`fn-fp2-item ${i === active ? "active" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(it)}
                  >
                    {level === "fields" && (
                      <span className="fn-fp2-ico" style={fnIcoStyle(it.k)}>
                        <Icon name={FN_FICON[it.k] || "funnel"} size={13} />
                      </span>
                    )}
                    {it.flag && <span className="fn-fp2-flag">{it.flag}</span>}
                    {it.l}
                    {level === "fields" && (
                      <span className="fn-fp2-grp">{it.group}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="fn-fp2-foot">
            <span className="fn-fp2-nav">
              <kbd>↑</kbd>
              <kbd>↓</kbd> Navigate
            </span>
            <span className="fn-fp2-nav">
              <kbd>↵</kbd> Select
            </span>
            <span className="sp" />
            <span className="fn-fp2-foot-note">
              {note}
            </span>
          </div>
        </div>
      )}
    </span>
  );
}
