import { useState } from "react";
import { Icon, Popover } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import { CoValueInput } from "./CoValueInput";
import { CO_FGROUPS, CO_OPS, coFieldDef, type CoCond } from "../cohorts.data";

type CohortRuleProps = {
  cond: CoCond;
  index: number;
  connector: string;
  canRemove: boolean;
  onField: (v: string) => void;
  onOp: (op: string) => void;
  onValue: (v: string) => void;
  onRemove: () => void;
};

/* One cohort rule rendered as the enterprise .fn-cg filter pill (the same
   palette the funnel step editor uses): a grouped field picker, a moving-
   highlight operator menu, and a value control. Pure presentation — all rule
   logic (field/op/value transitions) stays in CohortBuilder via the callbacks. */
export function CohortRule({
  cond,
  index,
  connector,
  canRemove,
  onField,
  onOp,
  onValue,
  onRemove,
}: CohortRuleProps) {
  const field = coFieldDef(cond.field);
  const ops = CO_OPS[field.kind] || CO_OPS.text;
  const opLabel = (ops.find((o) => o[0] === cond.op) || ops[0])[1];

  return (
    <div className="co-row">
      <span className="co-conn">{index === 0 ? "Where" : connector}</span>
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--sp-8)", minWidth: 0 }}
      >
        <div className="fn-cg" style={{ flex: 1, minWidth: 0 }}>
          {/* field — grouped command-palette picker */}
          <Popover
            width={288}
            trigger={
              <button className="fn-cg-op" type="button">
                <Icon name={field.icon} size={13} />
                {field.label}
                <Icon name="chev" size={11} />
              </button>
            }
          >
            {({ close }) => (
              <CohortFieldMenu
                value={cond.field}
                onPick={(v) => {
                  onField(v);
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
              <CohortOpMenu
                ops={ops}
                value={cond.op}
                onPick={(op) => {
                  onOp(op);
                  close();
                }}
              />
            )}
          </Popover>

          {/* value — .fn-ac autocomplete where applicable */}
          <CoValueInput field={field} value={cond.value} onChange={onValue} />
        </div>
        <button
          className="fn-cg-clear"
          type="button"
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            opacity: canRemove ? 1 : 0.3,
            cursor: canRemove ? "pointer" : "not-allowed",
          }}
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? "Remove rule" : "At least one rule is required"}
          aria-label="Remove rule"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    </div>
  );
}

type CohortFieldMenuProps = { value: string; onPick: (v: string) => void };

function CohortFieldMenu({ value, onPick }: CohortFieldMenuProps) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const groups = CO_FGROUPS.map((g) => ({
    title: g.title,
    fields: g.fields
      .map(coFieldDef)
      .filter((f) => !ql || f.label.toLowerCase().includes(ql)),
  })).filter((g) => g.fields.length > 0);
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
        {groups.length === 0 && (
          <div className="fn-fp2-empty">No fields match</div>
        )}
        {groups.map((g) => (
          <div key={g.title}>
            <div className="fn-fp2-gh">{g.title}</div>
            {g.fields.map((f) => (
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
        ))}
      </div>
    </div>
  );
}

type CohortOpMenuProps = {
  ops: [string, string][];
  value: string;
  onPick: (op: string) => void;
};

function CohortOpMenu({ ops, value, onPick }: CohortOpMenuProps) {
  const hl = useMovingHL<HTMLDivElement>();
  return (
    <div
      className="fn-menu fn-menu-cont"
      ref={hl.ref}
      onMouseLeave={hl.onLeave}
    >
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
