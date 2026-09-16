import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type FocusEvent,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/primitives";
import { useEscapeKey, useOutsideClick } from "@/hooks";
import { countryName, flagEmoji } from "@/lib/device-format";
import { Sessions } from "@/api/endpoints";
import { useApi } from "@/api/useApi";
import {
  CHART_DIMS,
  CHART_METRICS,
  CHART_SEGMENTS,
  COMPARE_MODES,
  GRAN_LABELS,
  TIME_RANGES,
  chartDimByKey,
  chartMetricByKey,
  dimValueLabel,
  type ActivityQuery,
  type FilterRule,
  type GranKey,
  type TimeKey,
} from "../activity.query";

/** Real dimension values for the rule-value picker, from /v1/sessions/suggest. */
type SuggestItem = { type: string; value: string; count?: number };

/* ============================================================================
   ActivityFilter — ONE filter control for the Activity chart, anchored in the
   chart toolbar. Opens an analytics popover where everything lives: metric,
   breakdown, time range, granularity, comparison, segment and stacked AND
   rules. Drill-in panels with an effortless back control, one sliding hover
   highlight (the app's continuity pattern), full arrow-key navigation and
   instant apply — the chart morphs behind the popover.

   Keyboard: ↑/↓ move, Enter picks, ← or Esc steps back, Esc at the root
   closes.
   ========================================================================== */

type Panel =
  | "root"
  | "metric"
  | "breakdown"
  | "time"
  | "gran"
  | "compare"
  | "segment"
  | "rules"
  | "rule-dim"
  | "rule-value";

type HoverFn = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => void;

/* ---- rows (module-level: state changes must not remount them) ----------- */

function Row({
  label,
  value,
  onOpen,
  onHover,
}: {
  label: string;
  value: string;
  onOpen: () => void;
  onHover: HoverFn;
}) {
  return (
    <button
      className="av-row"
      role="menuitem"
      onClick={onOpen}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      <Icon
        name="chev"
        size={10}
        style={{ transform: "rotate(-90deg)", color: "var(--t4)" }}
      />
    </button>
  );
}

function Opt({
  label,
  lead,
  selected,
  disabled,
  hint,
  onPick,
  onHover,
}: {
  label: string;
  lead?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  hint?: string;
  onPick: () => void;
  onHover: HoverFn;
}) {
  return (
    <button
      className={"av-opt" + (selected ? " on" : "") + (disabled ? " off" : "")}
      role="menuitemradio"
      aria-checked={!!selected}
      disabled={disabled}
      onClick={onPick}
      onMouseEnter={disabled ? undefined : onHover}
      onFocus={disabled ? undefined : onHover}
    >
      {lead}
      <span className="l">{label}</span>
      {hint && <span className="h">{hint}</span>}
      {selected && <Icon name="check" size={12} />}
    </button>
  );
}

function SubHead({
  title,
  onBack,
  onClear,
}: {
  title: string;
  onBack: () => void;
  onClear?: () => void;
}) {
  return (
    <div className="av-pop-h">
      <button className="av-back" onClick={onBack} aria-label="Back">
        <Icon name="chev" size={15} style={{ transform: "rotate(90deg)" }} />
      </button>
      <span className="t">{title}</span>
      {onClear && (
        <button className="av-clear" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

/* ---- the control --------------------------------------------------------- */

type Props = { query: ActivityQuery; onChange: (q: ActivityQuery) => void };

export function ActivityFilter({ query, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const [dir, setDir] = useState(1);
  const [draftDim, setDraftDim] = useState<string | null>(null);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const close = () => {
    setOpen(false);
    setPanel("root");
    setDraftDim(null);
    setHl(null);
  };
  useOutsideClick(wrap, close, open);
  useEscapeKey(close, open);

  const go = (p: Panel, d: 1 | -1 = 1) => {
    setDir(d);
    setPanel(p);
    setHl(null);
  };
  const back = () => {
    if (panel === "rule-value") go(draftDim ? "rule-dim" : "rules", -1);
    else if (panel === "rule-dim") go("rules", -1);
    else go("root", -1);
  };
  const patch = (p: Partial<ActivityQuery>) => onChange({ ...query, ...p });

  const hover: HoverFn = (e) => {
    const pr = pop.current?.getBoundingClientRect();
    if (!pr) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHl({ top: r.top - pr.top, height: r.height });
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      if (panel !== "root") back();
      else close();
      return;
    }
    if (e.key === "ArrowLeft" && panel !== "root") {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const root = pop.current;
      if (!root) return;
      const els = Array.from(
        root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      if (!els.length) return;
      const idx = els.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        els[(idx + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    }
  };

  const timeDef = TIME_RANGES.find((t) => t.key === query.time)!;
  const seg =
    CHART_SEGMENTS.find((s) => s.key === query.segment) ?? CHART_SEGMENTS[0];
  const activeCount = query.rules.length + (query.segment !== "all" ? 1 : 0);

  // Real values for the dimension currently being filtered (rule-value panel).
  const ruleGroup = draftDim ? (chartDimByKey(draftDim)?.suggest ?? "") : "";
  const ruleValsQ = useApi<{ items: SuggestItem[] }>(
    () => Sessions.suggest<{ items: SuggestItem[] }>({ groups: [ruleGroup] }),
    [ruleGroup],
    {
      key: "activity/rule-values",
      enabled: panel === "rule-value" && !!ruleGroup,
    },
  );
  const ruleVals = (ruleValsQ.data?.items ?? []).filter(
    (v) => v.type === ruleGroup,
  );

  const upsertRule = (dim: string, value: string) => {
    const rules: FilterRule[] = [
      ...query.rules.filter((r) => r.dim !== dim),
      { dim, value },
    ];
    patch({ rules });
  };
  const removeRule = (dim: string) =>
    patch({ rules: query.rules.filter((r) => r.dim !== dim) });

  const pickTime = (key: TimeKey) => {
    const def = TIME_RANGES.find((t) => t.key === key)!;
    patch({
      time: key,
      gran: def.grans.includes(query.gran) ? query.gran : def.grans[0],
    });
    go("root", -1);
  };

  const slide = reduce
    ? {}
    : {
        initial: { x: dir * 22, opacity: 0 },
        animate: { x: 0, opacity: 1 },
        transition: {
          type: "spring" as const,
          duration: 0.2,
          bounce: 0.1,
        },
      };

  const list = (children: ReactNode, cap?: string) => (
    <>
      {cap && <div className="av-pop-cap">{cap}</div>}
      <div className="av-pop-list" onScroll={() => setHl(null)}>
        {children}
      </div>
    </>
  );

  return (
    <div className="av-fwrap" ref={wrap} onKeyDown={onKeys}>
      <button
        className={"av-fbtn" + (activeCount > 0 ? " on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="sliders" size={14} />
        Filter
        {activeCount > 0 && <span className="ct ox-num">{activeCount}</span>}
        <Icon name="chev" size={12} style={{ color: "var(--t4)" }} />
      </button>

      {open && (
        <div
          className="av-pop"
          role="menu"
          aria-label="Chart filters"
          ref={pop}
          onMouseLeave={() => setHl(null)}
        >
          <span
            className={"av-hl" + (hl ? " on" : "")}
            aria-hidden="true"
            style={
              hl
                ? { transform: `translateY(${hl.top}px)`, height: hl.height }
                : { height: 0 }
            }
          />
          <motion.div key={panel} {...slide}>
            {panel === "root" && (
              <>
                {list(
                  <>
                    <Row
                      label="Metric"
                      value={chartMetricByKey(query.metric).short}
                      onOpen={() => go("metric")}
                      onHover={hover}
                    />
                    <Row
                      label="Breakdown"
                      value={
                        query.breakdown === "none"
                          ? "None"
                          : (chartDimByKey(query.breakdown)?.label ?? "None")
                      }
                      onOpen={() => go("breakdown")}
                      onHover={hover}
                    />
                    <Row
                      label="Time"
                      value={timeDef.label}
                      onOpen={() => go("time")}
                      onHover={hover}
                    />
                    <Row
                      label="Granularity"
                      value={GRAN_LABELS[query.gran]}
                      onOpen={() => go("gran")}
                      onHover={hover}
                    />
                    <Row
                      label="Compare"
                      value={
                        COMPARE_MODES.find((c) => c.key === query.compare)!
                          .label
                      }
                      onOpen={() => go("compare")}
                      onHover={hover}
                    />
                    <Row
                      label="Segment"
                      value={seg.label}
                      onOpen={() => go("segment")}
                      onHover={hover}
                    />
                    <Row
                      label="Filters"
                      value={
                        query.rules.length === 0
                          ? "None"
                          : query.rules.length === 1
                            ? dimValueLabel(
                                query.rules[0].dim,
                                query.rules[0].value,
                              )
                            : `${query.rules.length} rules`
                      }
                      onOpen={() => go("rules")}
                      onHover={hover}
                    />
                  </>,
                  "Query",
                )}
                <div className="av-pop-f">
                  <button
                    className="av-clear"
                    onClick={() =>
                      onChange({
                        metric: query.metric,
                        breakdown: "platform",
                        time: "d30",
                        gran: "day",
                        compare: "off",
                        segment: "all",
                        rules: [],
                      })
                    }
                  >
                    Reset all
                  </button>
                  <span className="sp" />
                  <button className="btn sm primary" onClick={close}>
                    Done
                  </button>
                </div>
              </>
            )}

            {panel === "metric" && (
              <>
                <SubHead title="Metric" onBack={back} />
                {list(
                  CHART_METRICS.map((m) => (
                    <Opt
                      key={m.key}
                      label={m.label}
                      hint={m.short !== m.label ? m.short : undefined}
                      selected={query.metric === m.key}
                      onPick={() => {
                        patch({ metric: m.key });
                        go("root", -1);
                      }}
                      onHover={hover}
                    />
                  )),
                )}
              </>
            )}

            {panel === "breakdown" && (
              <>
                <SubHead title="Breakdown" onBack={back} />
                {list(
                  <>
                    <Opt
                      label="None"
                      selected={query.breakdown === "none"}
                      onPick={() => {
                        patch({ breakdown: "none" });
                        go("root", -1);
                      }}
                      onHover={hover}
                    />
                    {CHART_DIMS.map((d) => (
                      <Opt
                        key={d.key}
                        label={d.label}
                        selected={query.breakdown === d.key}
                        onPick={() => {
                          patch({ breakdown: d.key });
                          go("root", -1);
                        }}
                        onHover={hover}
                      />
                    ))}
                  </>,
                )}
              </>
            )}

            {panel === "time" && (
              <>
                <SubHead title="Time range" onBack={back} />
                {list(
                  TIME_RANGES.map((t) => (
                    <Opt
                      key={t.key}
                      label={t.label}
                      selected={query.time === t.key}
                      onPick={() => pickTime(t.key)}
                      onHover={hover}
                    />
                  )),
                )}
              </>
            )}

            {panel === "gran" && (
              <>
                <SubHead title="Granularity" onBack={back} />
                {list(
                  (Object.keys(GRAN_LABELS) as GranKey[]).map((g) => (
                    <Opt
                      key={g}
                      label={GRAN_LABELS[g]}
                      selected={query.gran === g}
                      disabled={!timeDef.grans.includes(g)}
                      hint={
                        !timeDef.grans.includes(g) ? timeDef.label : undefined
                      }
                      onPick={() => {
                        patch({ gran: g });
                        go("root", -1);
                      }}
                      onHover={hover}
                    />
                  )),
                )}
              </>
            )}

            {panel === "compare" && (
              <>
                <SubHead title="Compare" onBack={back} />
                {list(
                  COMPARE_MODES.map((c) => (
                    <Opt
                      key={c.key}
                      label={c.label}
                      selected={query.compare === c.key}
                      onPick={() => {
                        patch({ compare: c.key });
                        go("root", -1);
                      }}
                      onHover={hover}
                    />
                  )),
                )}
              </>
            )}

            {panel === "segment" && (
              <>
                <SubHead title="Segment" onBack={back} />
                {list(
                  CHART_SEGMENTS.map((s) => (
                    <Opt
                      key={s.key}
                      label={s.label}
                      selected={query.segment === s.key}
                      onPick={() => {
                        patch({ segment: s.key });
                        go("root", -1);
                      }}
                      onHover={hover}
                    />
                  )),
                )}
              </>
            )}

            {panel === "rules" && (
              <>
                <SubHead
                  title="Filters"
                  onBack={back}
                  onClear={
                    query.rules.length ? () => patch({ rules: [] }) : undefined
                  }
                />
                {list(
                  <>
                    {query.rules.map((r) => (
                      <div className="av-rule" key={r.dim}>
                        <button
                          className="body"
                          onClick={() => {
                            setDraftDim(r.dim);
                            go("rule-value");
                          }}
                          onMouseEnter={hover}
                          onFocus={hover}
                          title="Change value"
                        >
                          <span className="d">{chartDimByKey(r.dim)?.label}</span>
                          <span className="eq">is</span>
                          <span className="v">{dimValueLabel(r.dim, r.value)}</span>
                        </button>
                        <button
                          className="rm"
                          aria-label={`Remove ${chartDimByKey(r.dim)?.label} filter`}
                          onClick={() => removeRule(r.dim)}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </div>
                    ))}
                    {query.rules.length > 1 && (
                      <div className="av-and">
                        All rules apply together (AND)
                      </div>
                    )}
                    <button
                      className="av-opt add"
                      onClick={() => go("rule-dim")}
                      onMouseEnter={hover}
                      onFocus={hover}
                    >
                      <Icon name="plus" size={12} />
                      <span className="l">Add filter</span>
                    </button>
                  </>,
                )}
              </>
            )}

            {panel === "rule-dim" && (
              <>
                <SubHead title="Filter by" onBack={back} />
                {list(
                  CHART_DIMS.map((d) => {
                    const existing = query.rules.find((r) => r.dim === d.key);
                    return (
                      <Opt
                        key={d.key}
                        label={d.label}
                        hint={existing?.value}
                        selected={!!existing}
                        onPick={() => {
                          setDraftDim(d.key);
                          go("rule-value");
                        }}
                        onHover={hover}
                      />
                    );
                  }),
                )}
              </>
            )}

            {panel === "rule-value" && draftDim && (
              <>
                <SubHead
                  title={chartDimByKey(draftDim)?.label ?? "Value"}
                  onBack={back}
                />
                {list(
                  ruleValsQ.loading && !ruleVals.length ? (
                    <div className="av-pop-cap">Loading values…</div>
                  ) : !ruleVals.length ? (
                    <div className="av-pop-cap">No values in this window.</div>
                  ) : (
                    // REAL values for this dimension (from /v1/sessions/suggest),
                    // with the live session count — never a fixture share.
                    ruleVals.map((v) => (
                      <Opt
                        key={v.value}
                        // country is stored/filtered as an ISO code — show the
                        // full name + flag, but keep the applied value the ISO.
                        label={
                          draftDim === "country"
                            ? countryName(v.value) || v.value
                            : v.value || "(unknown)"
                        }
                        lead={
                          draftDim === "country" ? (
                            <span className="av-flag">{flagEmoji(v.value)}</span>
                          ) : undefined
                        }
                        hint={
                          typeof v.count === "number"
                            ? `${v.count.toLocaleString()} ${v.count === 1 ? "session" : "sessions"}`
                            : undefined
                        }
                        selected={query.rules.some(
                          (r) => r.dim === draftDim && r.value === v.value,
                        )}
                        onPick={() => {
                          upsertRule(draftDim, v.value);
                          setDraftDim(null);
                          go("rules", -1);
                        }}
                        onHover={hover}
                      />
                    ))
                  ),
                )}
              </>
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}
