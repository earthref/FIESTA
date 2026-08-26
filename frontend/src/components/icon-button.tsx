import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cx } from "../lib/utils";

/**
 * Legacy IconButton (icon_button.jsx/.less): a base icon (#555) with a 1.5em
 * corner icon, node-color title header, #555 sub header; card look bg #f8f8f9,
 * hover #f0f0f0, padding 0.875em. Primary cards use a ~2em base icon + ~1.28em
 * title; resource (small) cards use a ~1em base icon + ~1.07em title.
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

  const content = (
    <div style={{ padding: "0.875em" }}>
      {/* Icon sizes itself via its `size` prop; the wrapper anchors the 1.5em corner icon. */}
      <span
        className="relative inline-block text-[#555555]"
        style={{ marginTop: "0.875em", lineHeight: 1 }}
      >
        {icon}
        {cornerIcon && (
          <span
            aria-hidden="true"
            className="absolute -bottom-1 -right-2 leading-none text-node"
            style={{ fontSize: "1.5em" }}
          >
            {cornerIcon}
          </span>
        )}
      </span>
      <div
        className="font-bold text-node"
        style={{
          marginTop: "0.875em",
          marginBottom: subtitle ? "0.5rem" : 0,
          fontSize: small ? "1.07em" : "1.28em",
          lineHeight: 1.2,
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          className="text-[#555555]"
          style={{ fontSize: "0.85em", textTransform: "none", marginBottom: 0 }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }
  return (
    <Link to={to ?? "/"} className={className}>
      {content}
    </Link>
  );
}
