import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/primitives";
import { useMovingHL } from "@/hooks";
import { ASK_ROTATE } from "../overview.data";
import { AskRotator } from "./AskRotator";

export function AskBar({ onSubmit }: { onSubmit: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const hl = useMovingHL<HTMLDivElement>();
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [open]);
  const submit = (q?: string) => {
    const query = (q != null ? q : val).trim();
    if (!query) return;
    setOpen(false);
    setVal("");
    onSubmit(query);
  };
  const list = ASK_ROTATE.filter((q) =>
    q.toLowerCase().includes(val.toLowerCase()),
  );
  return (
    <div className="ask-wrap" ref={ref}>
      <div
        className={"ask-cmd-box" + (open ? " focused" : "")}
        onClick={() => {
          setOpen(true);
          inp.current && inp.current.focus();
        }}
      >
        <Icon name="spark" size={15} style={{ color: "var(--accent)" }} />
        <span className="ask-input-shell">
          <input
            ref={inp}
            value={val}
            onFocus={() => setOpen(true)}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {!val && <span className="ask-fakecaret" aria-hidden="true" />}
          {!val && <AskRotator />}
        </span>
        <span className="kbd">⏎</span>
      </div>
      {open && (
        <div className="ask-suggest">
          <div className="ask-suggest-h">
            {val ? "Press ⏎ to ask" : "Suggested questions"}
          </div>
          <div className="ask-sug-list" ref={hl.ref} onMouseLeave={hl.onLeave}>
            <span
              className={`ask-sug-hl ${hl.hl ? "on" : ""}`}
              style={
                hl.hl
                  ? {
                      transform: `translateY(${hl.hl.top}px)`,
                      height: hl.hl.height,
                    }
                  : { height: 0 }
              }
            />
            {val && (
              <button
                className="ask-sug-row typed"
                onMouseEnter={hl.onEnter}
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <Icon name="spark" size={13} /> <span>Ask “{val}”</span>
              </button>
            )}
            {list.map((q) => (
              <button
                className="ask-sug-row"
                key={q}
                onMouseEnter={hl.onEnter}
                onMouseDown={(e) => {
                  e.preventDefault();
                  submit(q);
                }}
              >
                <Icon name="search" size={13} /> <span>{q}</span>
              </button>
            ))}
            {val && list.length === 0 && (
              <div className="ask-sug-empty">
                No suggestions — press ⏎ to ask your own.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
