import type { ReactNode } from "react";

type SetRowProps = { label: ReactNode; help?: ReactNode; children?: ReactNode };

export function SetRow({ label, help, children }: SetRowProps) {
  return (
    <div className="set-row">
      <div className="set-row-l">
        <div className="set-lab">{label}</div>
        {help && <div className="set-help">{help}</div>}
      </div>
      <div className="set-row-c">{children}</div>
    </div>
  );
}

export function SecTitle({ children }: { children?: ReactNode }) {
  return <div className="set-sec-t">{children}</div>;
}
