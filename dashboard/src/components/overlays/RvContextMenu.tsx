/* ---------- Shared right-click menu (sessions list, sidebar nav) ---------- */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/primitives";
import { createPortal } from "react-dom";

export type RvCtxItem = {
  label: string;
  icon: string;
  onClick: () => void;
  /** Red destructive styling (e.g. "Delete playlist"). */
  danger?: boolean;
};

/* The menu's `icon` strings mapped to shared <Icon> names. Most pass through
   unchanged; these four either rename (chat→comment, status→activity) or point
   at the context-menu-specific variant (`zap` simple lightning, `recPlay` filled
   play-in-circle) so the menu keeps its exact glyphs. */
const CTX_ALIAS: Record<string, string> = {
  chat: "comment",
  status: "activity",
  bolt: "zap",
  rec: "recPlay",
};


type Props = {
  /** Viewport coordinates of the originating right-click. */
  x: number;
  y: number;
  items: RvCtxItem[];
  /** Extra class on the menu box — e.g. `rv-ctx-acct` for the roomier,
   *  wider account menu. Compact by default. */
  className?: string;
  onClose: () => void;
};

export function RvContextMenu({ x, y, items, className, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Flip/clamp against the measured menu box — a right-click near a bottom or
  // right edge would otherwise open a menu that runs off the viewport. Layout
  // effect so the corrected position is committed before the first paint; until
  // then the menu is laid out but not painted (visibility below).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const m = 8;
    setPos({
      left: x + width + m > window.innerWidth ? Math.max(m, x - width) : x,
      top: y + height + m > window.innerHeight ? Math.max(m, y - height) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      className={`menu-pop rv-ctx${className ? ` ${className}` : ""}`}
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          className={it.danger ? "danger" : undefined}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          <Icon name={CTX_ALIAS[it.icon] ?? it.icon} strokeWidth={2.7} size={14} />
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
