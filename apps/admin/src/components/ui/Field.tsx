import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { classNames } from "./classNames.js";

type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  containerClassName?: string;
  icon?: ReactNode;
};

export function SearchInput({ className, containerClassName, icon, ...props }: SearchInputProps) {
  return (
    <label className={classNames("search-control flex items-center text-gray-500", containerClassName)}>
      {icon}
      <input
        className={classNames(
          "h-9 w-full rounded-lg border border-gray-200 bg-white text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-gray-300 focus:ring-2 focus:ring-gray-100",
          className
        )}
        type="search"
        {...props}
      />
    </label>
  );
}

export function SelectField({ children, className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={classNames(
        "h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-gray-300 focus:ring-2 focus:ring-gray-100",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}
