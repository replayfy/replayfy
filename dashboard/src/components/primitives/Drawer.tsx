import { type ReactNode, useEffect } from "react";
import { Icon } from "./Icon";
import { MobileSheet } from "./MobileSheet";
import { useIsMobile } from "@/hooks";

type DrawerProps = {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
};

/* ---------- Drawer (right-side panel on desktop, bottom sheet on mobile) ---------- */
export function Drawer({ title, onClose, children, footer, width = 460 }: DrawerProps) {
  const isMobile = useIsMobile();

  useEffect(() => {
    // Desktop only: on mobile the MobileSheet owns Escape (so it can play the
    // slide-out) — a second listener here would call onClose synchronously and
    // unmount before that animation runs.
    if (isMobile) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [isMobile]);

  const header = (
    <div className="modal-h"><h3>{title}</h3><button className="modal-x" onClick={onClose}><Icon name="x" size={15} /></button></div>
  );

  // Mobile: the same header/body/footer inside a drag-to-dismiss bottom sheet.
  if (isMobile) {
    return (
      <MobileSheet onClose={onClose} className="msheet-drawer">
        {header}
        <div className="drawer-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </MobileSheet>
    );
  }

  // Desktop: unchanged right-side panel.
  return (
    <div className="ov drawer-ov" onClick={onClose}>
      <div className="drawer" style={{ width }} onClick={(e) => e.stopPropagation()}>
        {header}
        <div className="drawer-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}
