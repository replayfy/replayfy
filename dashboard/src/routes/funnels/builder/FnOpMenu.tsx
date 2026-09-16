import { useMovingHL } from "@/hooks";
import { FN_MATCH } from "../funnels.data";

type FnOpMenuProps = { value: string; onPick: (m: string) => void };

export function FnOpMenu({ value, onPick }: FnOpMenuProps) {
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
      {FN_MATCH.map(([m, l]) => (
        <button
          key={m}
          className={value === m ? "on" : ""}
          onMouseEnter={hl.onEnter}
          onClick={() => onPick(m)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
