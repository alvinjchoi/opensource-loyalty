import type { HTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames.js";

type SectionProps = HTMLAttributes<HTMLElement> & {
  action?: ReactNode;
  description?: ReactNode;
  heading?: ReactNode;
};

export function Section({
  action,
  children,
  className,
  description,
  heading,
  ...props
}: SectionProps) {
  return (
    <section
      className={classNames("content-section overflow-hidden rounded-lg border border-gray-200 bg-white", className)}
      {...props}
    >
      {heading ? (
        <div className="section-heading flex min-h-[62px] items-center justify-between border-b border-gray-100 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-950">{heading}</h3>
            {description ? <p className="mt-0.5 text-xs text-gray-500">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
