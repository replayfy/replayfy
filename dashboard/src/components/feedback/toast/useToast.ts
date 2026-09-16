import { toast as sonner } from "sonner";
import type { ToastFn } from "./ToastCtx";

/* The app's historical API is `const toast = useToast(); toast('Saved', { kind:
   'ok' | 'err' })`. Per the owner we now render toasts with `sonner`, so this
   hook maps that legacy signature onto sonner. Every existing call site keeps
   working, and new code can `import { toast } from "sonner"` directly to reach
   `toast.warning` / `toast.success` / `toast.error` / `toast.promise`. */
export function useToast(): ToastFn {
  return (msg, opts = {}) => {
    const cfg = {
      duration: opts.duration,
      ...(opts.action ? { action: { label: opts.action.label, onClick: opts.action.onClick } } : {}),
    };
    if (opts.kind === "err") sonner.error(msg, cfg);
    else if (opts.kind === "ok") sonner.success(msg, cfg);
    else sonner(msg, cfg);
  };
}
