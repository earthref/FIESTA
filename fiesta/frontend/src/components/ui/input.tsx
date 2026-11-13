import { forwardRef, type InputHTMLAttributes } from "react";
import { cx } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          "w-full rounded-md border border-gray-300 bg-surface px-3 py-2 text-[13px] text-gray-900",
          "placeholder:text-ink-faint",
          "focus:border-node focus:outline-hidden focus:ring-1 focus:ring-node",
          "disabled:cursor-not-allowed disabled:bg-gray-50 disabled:opacity-70",
          className,
        )}
        {...props}
      />
    );
  },
);
