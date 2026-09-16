import { useState } from "react";
import { Icon } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import { FN_KINDS } from "../funnels.data";

type FnEventPickerProps = { current: string; onPick: (id: string) => void };

export function FnEventPicker({ current, onPick }: FnEventPickerProps) {
  const [q, setQ] = useState("");
  const [ai, setAi] = useState(() =>
    Math.max(
      0,
      FN_KINDS.findIndex((x) => x.id === current),
    ),
  );
  const list = FN_KINDS.filter(
    (x) => !q || x.label.toLowerCase().includes(q.toLowerCase()),
  );
  const filled = (ic: string) => ic === "cursor" || ic === "spark";
  const hl = useMovingHL<HTMLDivElement>();
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAi((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAi((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (list[ai]) onPick(list[ai].id);
    }
  };
  return (
    <div className="fn-ep" onKeyDown={onKey}>
      <div className="fn-ep-list" ref={hl.ref} onMouseLeave={hl.onLeave}>
        <div className="fn-ep-gh">Events</div>
        <span
          className={`fn-ep-hl ${hl.hl ? "on" : ""}`}
          style={
            hl.hl
              ? {
                  transform: `translateY(${hl.hl.top}px)`,
                  height: hl.hl.height,
                }
              : { height: 0 }
          }
        />
        {list.map((x, i) => (
          <button
            key={x.id}
            className={`fn-ep-item ${current === x.id ? "on" : ""}`}
            onMouseEnter={(e) => {
              setAi(i);
              hl.onEnter(e);
            }}
            onClick={() => onPick(x.id)}
          >
            <Icon name={x.ic} size={13} fill={filled(x.ic)} />
            {x.label}
            {current === x.id && (
              <Icon
                name="check"
                size={12}
                style={{ marginLeft: "auto", color: "var(--accent)" }}
              />
            )}
          </button>
        ))}
        {!list.length && <div className="fn-ep-empty">No events match</div>}
      </div>
    </div>
  );
}
