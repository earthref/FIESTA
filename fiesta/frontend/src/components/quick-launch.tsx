// Quick-launch buttons: the node's main search views (Map and its plugin
// views: Poles, Rock Magnetism, plots) one click away, on the home page and
// the search page. Which show and in what order is node configuration
// (`search.map_level`, `search.quick_launch`); a node only gets buttons for
// views it has.
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import type { NodeConfig, SearchLevel } from "../lib/types";
import { cx } from "../lib/utils";
import { pluginSubTabs } from "../plugins";
import { Icon, type IconName } from "./ui/icon";

export interface QuickLaunchView {
  /** The result sub-tab it opens, and its button's label. */
  name: string;
  /** The search level it opens that sub-tab on. */
  level: string;
  icon: IconName;
}

/** The level has a Map sub-tab: its rows have positions and the YAML leaves it on. */
export function hasMap(level: SearchLevel): boolean {
  return !!level.geo && level.map !== false;
}

/** The node's quick-launch views, in order: Map on `map_level`, then each
 * plugin search view on the first level offering it, or the names
 * `quick_launch` lists (one the node has no view for is left out). */
export function quickLaunchViews(config: NodeConfig | undefined): QuickLaunchView[] {
  if (!config) return [];
  const views = new Map<string, QuickLaunchView>();
  const mapLevel = config.search_levels.find(
    (level) => level.name === config.map_level && hasMap(level),
  );
  if (mapLevel) views.set("Map", { name: "Map", level: mapLevel.name, icon: "map" });
  for (const level of config.search_levels) {
    for (const tab of pluginSubTabs(config, level)) {
      if (!views.has(tab.name)) {
        views.set(tab.name, { name: tab.name, level: level.name, icon: tab.icon ?? "chart-line" });
      }
    }
  }
  return (config.quick_launch ?? [...views.keys()]).flatMap((name) => views.get(name) ?? []);
}

const buttonClass =
  "inline-flex items-center whitespace-nowrap rounded-sm bg-surface font-bold text-node-ink " +
  "hover:bg-node hover:text-white focus-visible:outline-hidden focus-visible:ring-2 " +
  "focus-visible:ring-node";
const buttonStyle: CSSProperties = {
  boxShadow: "0 0 0 1px var(--node-color) inset",
  fontSize: 13,
  padding: "0.45em 0.85em",
  lineHeight: "1em",
};

/** A row of small icon + label buttons. Each links to the search page on its
 * level and sub-tab, or with `onLaunch` (the search page) calls it instead. */
export function QuickLaunch({
  config,
  onLaunch,
  current,
  className,
  style,
}: {
  config: NodeConfig;
  onLaunch?: (view: QuickLaunchView) => void;
  /** The open level and sub-tab: its button shows as pressed. */
  current?: { level?: string; view?: string };
  className?: string;
  style?: CSSProperties;
}) {
  const views = quickLaunchViews(config);
  if (views.length === 0) return null;
  return (
    <nav
      aria-label="Quick launch"
      className={cx("flex flex-wrap items-center gap-2", className)}
      style={style}
    >
      {views.map((view) => {
        const pressed = current?.level === view.level && current?.view === view.name;
        const content = (
          <>
            <Icon name={view.icon} style={{ marginRight: "0.5em" }} />
            {view.name}
          </>
        );
        const style = pressed
          ? { ...buttonStyle, background: "var(--node-color)", color: "white" }
          : buttonStyle;
        return onLaunch ? (
          <button
            key={view.name}
            type="button"
            aria-pressed={pressed}
            onClick={() => onLaunch(view)}
            className={cx(buttonClass, "cursor-pointer")}
            style={style}
          >
            {content}
          </button>
        ) : (
          <Link
            key={view.name}
            to="/search"
            search={{ level: view.level, view: view.name } as never}
            className={buttonClass}
            style={style}
          >
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
