import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useNodeConfig } from "../lib/config";
import type { NodeConfig, NodePage } from "../lib/types";
import { cx } from "../lib/utils";
import { Icon, type IconName } from "./ui/icon";

/**
 * Legacy `ui secondary small pointing <color> menu` (magic/components/menu/menu.jsx,
 * measured): 13px, min-height 2.857em, margin .25em 0 1.25em, 2px bottom border;
 * items padding .5em 1em, line-height 1em, rgba(0,0,0,.87), aligned to the
 * bottom edge with a 2px transparent border that turns node-colored (+ bold
 * text) when active. Icons are 1em with margin-right .357em.
 */
const itemClass =
  "flex items-center self-end whitespace-nowrap text-[rgba(0,0,0,0.87)] " +
  "hover:text-[rgba(0,0,0,0.95)] focus-visible:outline-hidden focus-visible:ring-2 " +
  "focus-visible:ring-node [&.active]:border-node [&.active]:font-bold [&.active]:text-node";

const itemStyle: CSSProperties = {
  padding: "0.5em 1em",
  lineHeight: "1em",
  margin: "0 0 -2px",
  borderBottom: "2px solid transparent",
};

export interface NodeMenuItem {
  key: string;
  label: string;
  to?: string;
  href?: string;
  icon?: IconName;
  exact?: boolean;
}

/** Node menu items, split into the left (nav) and right (help/contact) groups:
 * Home, the YAML `pages` with `menu: left` in list order; then the issues link,
 * the `menu: right` pages (with their icons) and Contact. */
export function nodeMenuItems(config: NodeConfig | undefined): {
  left: NodeMenuItem[];
  right: NodeMenuItem[];
} {
  const pages = config?.pages ?? [];
  const item = (page: NodePage): NodeMenuItem => ({
    key: page.slug,
    label: page.title,
    to: `/${page.slug}`,
    icon: page.icon ? (page.icon as IconName) : undefined,
  });
  const left: NodeMenuItem[] = [
    { key: "home", label: "Home", to: "/", exact: true },
    ...pages.filter((page) => page.menu === "left").map(item),
  ];

  const right: NodeMenuItem[] = [];
  if (config?.links.github_issues) {
    right.push({
      key: "issues",
      label: "Report an Issue on GitHub",
      href: config.links.github_issues,
      icon: "warning",
    });
  }
  right.push(...pages.filter((page) => page.menu === "right").map(item));
  right.push({ key: "contact", label: "Contact", to: "/contact", icon: "mail" });

  return { left, right };
}

const iconStyle: CSSProperties = { width: "1.18em", height: "1em", margin: "0 0.35714286em 0 0" };

/** Node-colored secondary pointing menu directly under the node header (≥1024px only). */
export function NodeMenu({ fullWidth = false }: { fullWidth?: boolean }) {
  const { data: config } = useNodeConfig();
  const { left, right } = nodeMenuItems(config);

  const renderItem = (item: NodeMenuItem) =>
    item.href ? (
      <a
        key={item.key}
        href={item.href}
        target="_blank"
        rel="noreferrer"
        className={itemClass}
        style={itemStyle}
      >
        {item.icon && <Icon name={item.icon} style={iconStyle} />}
        {item.label}
      </a>
    ) : (
      <Link
        key={item.key}
        to={item.to ?? "/"}
        className={itemClass}
        style={itemStyle}
        activeOptions={item.exact ? { exact: true } : undefined}
      >
        {item.icon && <Icon name={item.icon} style={iconStyle} />}
        {item.label}
      </Link>
    );

  return (
    <nav aria-label="Node" className="hidden lg:block">
      <div className={cx("block", fullWidth ? "px-[2em]" : "er-container")}>
        <div
          className="flex w-full"
          style={{
            fontSize: "0.92857143rem",
            minHeight: "2.85714286em",
            margin: "0.25em 0 1.25em",
            borderBottom: "2px solid rgba(34,36,38,.15)",
          }}
        >
          <div className="flex">{left.map(renderItem)}</div>
          <div className="ml-auto flex">{right.map(renderItem)}</div>
        </div>
      </div>
    </nav>
  );
}
