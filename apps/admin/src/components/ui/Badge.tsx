import type { HTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames.js";

export type BadgeTone = "info" | "success" | "warning" | "error" | "muted";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: BadgeTone;
};

export function Badge({ children, className, tone = "info", ...props }: BadgeProps) {
  return (
    <span
      className={classNames(
        "ui-badge w-fit rounded-lg px-[5px] text-xs font-medium uppercase leading-5 line-clamp-1",
        `ui-badge-${tone}`,
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
