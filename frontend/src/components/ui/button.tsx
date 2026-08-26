import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cx } from "../../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    "bg-node text-white border border-transparent hover:bg-node-dark focus-visible:ring-node",
  secondary:
    "bg-white text-gray-800 border border-gray-300 hover:bg-gray-50 focus-visible:ring-node",
  ghost:
    "bg-transparent text-gray-700 border border-transparent hover:bg-gray-100 focus-visible:ring-node",
  danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50 focus-visible:ring-red-500",
};

const sizes: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3.5 py-2 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", type = "button", className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
