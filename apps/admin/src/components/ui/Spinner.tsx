import type { HTMLAttributes } from "react";
import { classNames } from "./classNames.js";

export function Spinner({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={classNames("ui-spinner", className)} {...props} />;
}
