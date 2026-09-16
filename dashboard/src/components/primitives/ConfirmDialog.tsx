import { type ReactNode } from "react";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

type ConfirmDialogProps = {
  title: ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  /** The body copy (what/why + "can't be undone"). */
  children?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: string;
  /** Modal glyph + the confirm button's leading icon. Defaults to a trash can. */
  icon?: string;
  /** Disables both buttons while the action is in flight. */
  busy?: boolean;
};

/**
 * The one "are you sure?" dialog for destructive actions — modelled exactly on
 * the Comments "Remove comment?" modal (danger tone, trash glyph, Cancel + a
 * red confirm). Extracted so delete confirmations across the app (comment /
 * funnel / cohort) look and behave identically instead of some using this modal
 * and others falling back to the browser's native window.confirm()/alert().
 */
export function ConfirmDialog({
  title,
  onConfirm,
  onClose,
  children,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  icon = "trash",
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Modal
      icon={icon}
      tone="danger"
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            <Icon name={icon} size={13} /> {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
