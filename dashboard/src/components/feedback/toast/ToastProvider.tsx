import type { ReactNode } from "react";
import { Toaster } from "sonner";

/* Toasts are rendered by `sonner`. This provider mounts sonner's <Toaster/>
   once at the root; `useToast()` and `import { toast } from "sonner"` both
   drive it. Per the owner we use sonner's DEFAULT (neutral) styling — NOT
   `richColors` (the green success look was unwanted). Toast TYPE
   (success/error/warning/info), `toast.promise` for async, and per-toast
   `position` are chosen at each call site (e.g. top-left when the right-side
   share drawer is open). */
export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{ style: { fontFamily: "inherit" } }}
      />
    </>
  );
}
