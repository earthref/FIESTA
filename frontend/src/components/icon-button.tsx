import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/utils";
import { Icon, type IconName } from "./ui/icon";

/**
 * Legacy IconButton (icon_button.jsx/.less), measured on the MagIC home page:
 * `ui icon header basic fluid button <color> card er-icon-button`.
 *
 * - card   (`ui three cards`): 14px, padding .875em, bg #f8f8f9 with a 1px
 *          inset node-colored shadow; 54px base icon (3× the 18px header) with
 *          a .45em corner icon; title 1.2857em/700 node color; `ui sub header`
 *          14px/1.2 #555. 158px tall.
 * - small  (`ui nine cards`, borderless): 10px, padding .875em, transparent;
 *          32px icon (3× the 10.71px small header); title 1.0714em/700. 82px tall.
 * - wide   (`tiny card` / `small card`, full width): padding .786em, no icon,
 *          title on one or two header lines.
 * Hover bg #f0f0f0 on all of them.
 */
export interface IconButtonProps {
  icon?: IconName;
  cornerIcon?: IconName;
  title: ReactNode;
  subtitle?: ReactNode;
  to?: string;
  search?: Record<string, unknown>;
  href?: string;
  variant?: "card" | "small" | "wide";
  /** Card font size in px (legacy: 14 for cards, 10 for nine-cards, 15 for the small wide card). */
  fontSize?: number;
  /** Title size in em of the card font (legacy header 1.2857, small header 1.0714). */
  titleEm?: number;
}

export function IconButton({
  icon,
  cornerIcon,
  title,
  subtitle,
  to,
  search,
  href,
  variant = "card",
  fontSize,
  titleEm,
}: IconButtonProps) {
  const small = variant === "small";
  const wide = variant === "wide";
  const cardFont = fontSize ?? (small ? 10 : 14);
  const titleSize = titleEm ?? (small ? 1.07142857 : 1.28571429);
  const iconPx = Math.round(cardFont * titleSize * 3);

  const className = cx(
    "er-icon-button block text-center transition-colors hover:bg-[#f0f0f0]",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
    wide ? "w-full" : "h-full",
  );
  const style: CSSProperties = {
    fontSize: cardFont,
    padding: wide ? "0.786em" : "0.875em",
    borderRadius: "0.28571429rem",
    ...(small ? {} : { background: "#f8f8f9", boxShadow: "0 0 0 1px var(--node-color) inset" }),
  };

  const content = (
    <>
      {icon && (
        <span
          className="relative inline-block text-[#555555]"
          style={{ fontSize: iconPx, lineHeight: 1, marginBottom: small ? 5 : 16 }}
        >
          <Icon name={icon} />
          {cornerIcon && (
            <span
              aria-hidden="true"
              className="absolute text-node"
              style={{
                right: 0,
                bottom: 0,
                fontSize: "0.45em",
                lineHeight: 1,
                textShadow:
                  "-1px -1px 0 #f8f8f9, 1px -1px 0 #f8f8f9, -1px 1px 0 #f8f8f9, 1px 1px 0 #f8f8f9",
              }}
            >
              <Icon name={cornerIcon} />
            </span>
          )}
        </span>
      )}
      <div
        className="font-bold text-node"
        style={{
          fontSize: `${titleSize}em`,
          lineHeight: "1.28571429em",
          margin: subtitle ? "0 0 0.5rem" : 0,
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div className="text-[#555555]" style={{ fontSize: "1em", lineHeight: 1.2 }}>
          {subtitle}
        </div>
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
    <Link to={to ?? "/"} search={search as never} className={className} style={style}>
      {content}
    </Link>
  );
}
