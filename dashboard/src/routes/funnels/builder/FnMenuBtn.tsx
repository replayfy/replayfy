import type { ReactNode } from "react";
import { Icon, Popover } from "@/components/primitives";

type FnMenuBtnProps = {
  label: ReactNode;
  children: ReactNode | ((args: { close: () => void }) => ReactNode);
  align?: "left" | "right";
  cls?: string;
};

export function FnMenuBtn({
  label,
  children,
  align = "left",
  cls = "fn-mini",
}: FnMenuBtnProps) {
  return (
    <Popover
      align={align}
      trigger={
        <button className={cls}>
          {label} <Icon name="chev" size={10} />
        </button>
      }
    >
      {children}
    </Popover>
  );
}
