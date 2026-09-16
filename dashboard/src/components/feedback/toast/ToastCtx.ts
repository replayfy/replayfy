/* ============================================================================
   toast.jsx — Toast notification system.
   API: const toast = useToast(); toast('Saved', { kind: 'ok' });
   Kinds: '' (default dark), 'ok' (green), 'err' (red).
   Options: { kind, icon, duration, action: { label, onClick } }
   ========================================================================== */

import { createContext } from "react";
import type { ReactNode } from "react";

export type ToastKind = "" | "ok" | "err";

export type ToastAction = {
  label: ReactNode;
  onClick: () => void;
};

export type ToastOptions = {
  kind?: ToastKind;
  icon?: string;
  duration?: number;
  action?: ToastAction;
};

export type ToastFn = (msg: ReactNode, opts?: ToastOptions) => void;

export const ToastCtx = createContext<ToastFn | null>(null);
