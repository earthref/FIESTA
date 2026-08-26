import type { HTMLAttributes } from "react";
import { cx } from "../../lib/utils";

type Variant = "default" | "node" | "success" | "warning" | "danger" | "muted";

const variants: Record<Variant, string> = {
  default: "bg-gray-100 text-gray-700",
  node: "bg-node-soft text-node-dark",
  success: "bg-green-100 text-green-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  muted: "bg-gray-50 text-gray-500",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
