import {
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Icon } from "@/components/primitives";
import { useEscapeKey, useOutsideClick } from "@/hooks";
import { COUNTRIES } from "@/lib/countries";

/* ============================================================================
   UsersFilter — ONE filter control for the Users page (replaces the separate
   country dropdown + filter popover). Same control language as the Overview
   Activity filter: 34px sliders button with a count chip, drill-in panels,
   one sliding hover highlight, arrow-key navigation, instant apply.

   Keyboard: ↑/↓ move, Enter picks, ← or Esc steps back, Esc at the root
   closes.
   ========================================================================== */

export type UsersFilterValue = {
  country: string;
  lastSeen: string;
  platform: string;
  userType: string;
  online: string;
};
export const USERS_FILTER_DEFAULTS: UsersFilterValue = {
  country: "All countries",
  lastSeen: "Any time",
  platform: "All",
  userType: "All",
  online: "All",
};

const LAST_SEEN = ["Any time", "Last 24 hours", "Last 7 days", "Last 30 days"];
const PLATFORMS = ["All", "Android", "iOS", "Browser"];
const USER_TYPES = ["All", "Identified", "Anonymous"];
// Backed by EndUser.isOnline, maintained live by the presence gateway.
const ONLINE = ["All", "Online now", "Offline"];

type Panel = "root" | "country" | "seen" | "platform" | "type" | "online";
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
  onPick,
  onHover,
}: {
  label: string;
  lead?: ReactNode;
  selected?: boolean;
  onPick: () => void;
  onHover: HoverFn;
}) {
  return (
    <button
      className={"av-opt" + (selected ? " on" : "")}
      role="menuitemradio"
      aria-checked={!!selected}
      onClick={onPick}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      {lead}
      <span className="l">{label}</span>
      {selected && <Icon name="check" size={12} />}
    </button>
  );
}

function SubHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="av-pop-h">
      <button className="av-back" onClick={onBack} aria-label="Back">
        <Icon name="chev" size={15} style={{ transform: "rotate(90deg)" }} />
      </button>
      <span className="t">{title}</span>
    </div>
  );
}

/* ---- the control --------------------------------------------------------- */

type Props = {
  value: UsersFilterValue;
  onChange: (v: UsersFilterValue) => void;
};

export function UsersFilter({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const [dir, setDir] = useState(1);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const close = () => {
    setOpen(false);
    setPanel("root");
    setHl(null);
  };
  useOutsideClick(wrap, close, open);
  useEscapeKey(close, open);

  const go = (p: Panel, d: 1 | -1 = 1) => {
    setDir(d);
    setPanel(p);
    setHl(null);
  };
  const back = () => go("root", -1);
  const patch = (p: Partial<UsersFilterValue>) => onChange({ ...value, ...p });

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

  const activeCount = [
    value.country !== USERS_FILTER_DEFAULTS.country,
    value.lastSeen !== USERS_FILTER_DEFAULTS.lastSeen,
    value.platform !== USERS_FILTER_DEFAULTS.platform,
    value.userType !== USERS_FILTER_DEFAULTS.userType,
    value.online !== USERS_FILTER_DEFAULTS.online,
  ].filter(Boolean).length;

  const slide = reduce
    ? {}
    : {
        initial: { x: dir * 22, opacity: 0 },
        animate: { x: 0, opacity: 1 },
        transition: { type: "spring" as const, duration: 0.2, bounce: 0.1 },
      };

  const pick = (p: Partial<UsersFilterValue>) => {
    patch(p);
    go("root", -1);
  };

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
          aria-label="User filters"
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
                <div className="av-pop-cap">Filters</div>
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  <Row
                    label="Country"
                    value={value.country}
                    onOpen={() => go("country")}
                    onHover={hover}
                  />
                  <Row
                    label="Last seen"
                    value={value.lastSeen}
                    onOpen={() => go("seen")}
                    onHover={hover}
                  />
                  <Row
                    label="Platform"
                    value={value.platform}
                    onOpen={() => go("platform")}
                    onHover={hover}
                  />
                  <Row
                    label="User type"
                    value={value.userType}
                    onOpen={() => go("type")}
                    onHover={hover}
                  />
                  <Row
                    label="Online"
                    value={value.online}
                    onOpen={() => go("online")}
                    onHover={hover}
                  />
                </div>
                <div className="av-pop-f">
                  <button
                    className="av-clear"
                    onClick={() => onChange({ ...USERS_FILTER_DEFAULTS })}
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

            {panel === "country" && (
              <>
                <SubHead title="Country" onBack={back} />
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  <Opt
                    label="All countries"
                    lead={<span className="av-flag">🌐</span>}
                    selected={value.country === "All countries"}
                    onPick={() => pick({ country: "All countries" })}
                    onHover={hover}
                  />
                  {COUNTRIES.map((c) => (
                    <Opt
                      key={c.name}
                      label={c.name}
                      lead={<span className="av-flag">{c.flag}</span>}
                      selected={value.country === c.name}
                      onPick={() => pick({ country: c.name })}
                      onHover={hover}
                    />
                  ))}
                </div>
              </>
            )}

            {panel === "seen" && (
              <>
                <SubHead title="Last seen" onBack={back} />
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  {LAST_SEEN.map((o) => (
                    <Opt
                      key={o}
                      label={o}
                      selected={value.lastSeen === o}
                      onPick={() => pick({ lastSeen: o })}
                      onHover={hover}
                    />
                  ))}
                </div>
              </>
            )}

            {panel === "platform" && (
              <>
                <SubHead title="Platform" onBack={back} />
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  {PLATFORMS.map((o) => (
                    <Opt
                      key={o}
                      label={o}
                      selected={value.platform === o}
                      onPick={() => pick({ platform: o })}
                      onHover={hover}
                    />
                  ))}
                </div>
              </>
            )}

            {panel === "type" && (
              <>
                <SubHead title="User type" onBack={back} />
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  {USER_TYPES.map((o) => (
                    <Opt
                      key={o}
                      label={o}
                      selected={value.userType === o}
                      onPick={() => pick({ userType: o })}
                      onHover={hover}
                    />
                  ))}
                </div>
              </>
            )}

            {panel === "online" && (
              <>
                <SubHead title="Online" onBack={back} />
                <div className="av-pop-list" onScroll={() => setHl(null)}>
                  {ONLINE.map((o) => (
                    <Opt
                      key={o}
                      label={o}
                      selected={value.online === o}
                      onPick={() => pick({ online: o })}
                      onHover={hover}
                    />
                  ))}
                </div>
              </>
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}
