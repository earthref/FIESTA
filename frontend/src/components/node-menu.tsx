import { Link } from "@tanstack/react-router";
import { useNodeConfig } from "../lib/config";
import type { NodeConfig } from "../lib/types";
import { Icon, type IconName } from "./ui/icon";

const itemClass =
  "flex items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm " +
  "font-medium text-gray-600 hover:text-gray-900 focus-visible:outline-hidden " +
  "focus-visible:ring-2 focus-visible:ring-node " +
  "[&.active]:border-node [&.active]:font-semibold [&.active]:text-node";

export interface NodeMenuItem {
  key: string;
  label: string;
  to?: string;
  href?: string;
  icon?: IconName;
  exact?: boolean;
}

const featurePages: { page: string; label: string; to: string }[] = [
  { page: "about", label: "About", to: "/about" },
  { page: "technology", label: "Technology", to: "/technology" },
  { page: "grand-challenges", label: "Grand Challenges", to: "/grand-challenges" },
  { page: "workshops", label: "Workshops", to: "/workshops" },
  { page: "links", label: "Links", to: "/links" },
];

/** Node menu items, split into the left (nav) and right (help/contact) groups. */
export function nodeMenuItems(config: NodeConfig | undefined): {
  left: NodeMenuItem[];
  right: NodeMenuItem[];
} {
  const pages = config?.features.pages ?? [];
  const left: NodeMenuItem[] = [{ key: "home", label: "Home", to: "/", exact: true }];
  for (const entry of featurePages) {
    if (pages.includes(entry.page))
      left.push({ key: entry.page, label: entry.label, to: entry.to });
  }

  const right: NodeMenuItem[] = [];
  if (config?.links.github_issues) {
    right.push({
      key: "issues",
      label: "Report an Issue on GitHub",
      href: config.links.github_issues,
      icon: "warning",
    });
  }
  if (pages.includes("help")) {
    right.push({ key: "help", label: "Help", to: "/help", icon: "question-circle" });
  }
  right.push({ key: "contact", label: "Contact", to: "/contact", icon: "mail" });

  return { left, right };
}

/** Node-colored secondary pointing menu directly under the node header (≥1024px only). */
export function NodeMenu() {
  const { data: config } = useNodeConfig();
  const { left, right } = nodeMenuItems(config);

  const renderItem = (item: NodeMenuItem) =>
    item.href ? (
      <a key={item.key} href={item.href} target="_blank" rel="noreferrer" className={itemClass}>
        {item.icon && <Icon name={item.icon} size="small" className="text-[#555555]" />}
        {item.label}
      </a>
    ) : (
      <Link
        key={item.key}
        to={item.to ?? "/"}
        className={itemClass}
        activeOptions={item.exact ? { exact: true } : undefined}
      >
        {item.icon && <Icon name={item.icon} size="small" className="text-[#555555]" />}
        {item.label}
      </Link>
    );

  return (
    <nav aria-label="Node" className="hidden border-b border-gray-200 lg:block">
      <div className="mx-auto flex w-full max-w-6xl items-center overflow-x-auto px-4">
        <div className="flex items-center">{left.map(renderItem)}</div>
        <div className="ml-auto flex items-center">{right.map(renderItem)}</div>
      </div>
    </nav>
  );
}
