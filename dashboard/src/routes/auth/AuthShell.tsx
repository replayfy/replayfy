import type { ReactNode } from "react";

/* ============================================================================
   AuthShell v2 — one centered column on a light field with a quiet accent
   wash behind the headline. The product mark sits above the heading; no
   chrome, no card box.
   ========================================================================== */

/** The product mark, centered above the headline. */
export function AuthMark() {
  return (
    <div
      className="av-mark"
      aria-hidden="true"
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: "var(--fw-bold)",
        fontSize: "var(--text-2xl)",
        lineHeight: "var(--lh-none)",
      }}
    >
      {/* Placeholder Replayfy "R" mark (matches landing/docs) until a real logo. */}
      R
    </div>
  );
}

type AuthShellProps = { children: ReactNode };

export function AuthShell({ children }: AuthShellProps) {
  return (
    <div className="av-root">
      <div className="av-main">
        <div className="av-card">{children}</div>
      </div>
    </div>
  );
}
