import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cx } from "../lib/utils";

/**
 * Legacy IconButton (icon_button.jsx/.less): stacked large icon (#555) with a
 * 1.5em corner icon, node-color title header, #555 sub header; card look
 * bg #f8f8f9, hover #f0f0f0, padding 0.875em.
 */
export interface IconButtonProps {
  icon: ReactNode;
  cornerIcon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  to?: string;
  href?: string;
  borderless?: boolean;
  small?: boolean;
}

export function IconButton({
  icon,
  cornerIcon,
  title,
  subtitle,
  to,
  href,
  borderless,
  small,
}: IconButtonProps) {
  const className = cx(
    "er-icon-button block h-full text-center transition-colors",
    "bg-[#f8f8f9] hover:bg-[#f0f0f0] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
    borderless ? "rounded-sm" : "rounded-sm border border-[rgba(34,36,38,0.15)] shadow-xs",
  );
  const style = { padding: "0.875em" };

  const content = (
    <>
      <span
        className={cx("relative mx-auto block text-[#555555]", small ? "w-[2.5em]" : "w-[3.5em]")}
        style={{ marginTop: "0.875em" }}
      >
        <span className={cx("block", small ? "text-[2.5em]" : "text-[3.5em]", "leading-none")}>
          {icon}
        </span>
        {cornerIcon && (
          <span
            aria-hidden="true"
            className="absolute -bottom-1 -right-1 leading-none text-node"
            style={{ fontSize: "1.5em" }}
          >
            {cornerIcon}
          </span>
        )}
      </span>
      <span
        className={cx("block font-bold text-node", small ? "text-[13px]" : "text-[1.15em]")}
        style={{ marginTop: "0.875em", marginBottom: subtitle ? "0.5rem" : 0 }}
      >
        {title}
      </span>
      {subtitle && (
        <span className="block text-[13px] text-[#555555]" style={{ marginBottom: 0 }}>
          {subtitle}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className} style={style}>
        {content}
      </a>
    );
  }
  return (
    <Link to={to ?? "/"} className={className} style={style}>
      {content}
    </Link>
  );
}
