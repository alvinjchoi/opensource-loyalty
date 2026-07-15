import type { ButtonHTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames.js";

type CommandButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  variant?: "primary" | "text";
};

export function CommandButton({
  children,
  className,
  icon,
  variant = "primary",
  ...props
}: CommandButtonProps) {
  return (
    <button
      className={classNames(
        variant === "text"
          ? "text-command inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-gray-700 transition hover:bg-gray-100 hover:text-gray-950"
          : "primary-command inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 text-sm font-medium text-white transition hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:pointer-events-none disabled:opacity-60",
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
};

export function IconButton({ children, className, label, title, ...props }: IconButtonProps) {
  return (
    <button
      aria-label={props["aria-label"] ?? label}
      className={classNames(
        "icon-command inline-flex size-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 transition hover:bg-gray-50 hover:text-gray-950 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:pointer-events-none disabled:opacity-60",
        className
      )}
      title={title ?? label}
      {...props}
    >
      {children}
    </button>
  );
}
