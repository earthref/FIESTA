// Quick-launch views: the node's main search views (Map and its plugin
// views: Poles, Rock Magnetism, plots) one click away: wide cards on the home
// page, buttons beside the search box on the search page. Which show and in
// what order is node configuration (`search.map_level`, `search.quick_launch`);
// a node only gets buttons for views it has.
import type { NodeConfig, SearchLevel } from "../lib/types";
import { pluginSubTabs } from "../plugins";
import type { IconName } from "./ui/icon";

export interface QuickLaunchView {
  /** The result sub-tab it opens. */
  name: string;
  /** Its button's label: the sub-tab's name, the Map's with its level ("Sites Map"). */
  label: string;
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
  if (mapLevel)
    views.set("Map", {
      name: "Map",
      label: `${mapLevel.name} Map`,
      level: mapLevel.name,
      icon: "map",
    });
  for (const level of config.search_levels) {
    for (const tab of pluginSubTabs(config, level)) {
      if (!views.has(tab.name)) {
        views.set(tab.name, {
          name: tab.name,
          label: tab.name,
          level: level.name,
          icon: tab.icon ?? "chart-line",
        });
      }
    }
  }
  return (config.quick_launch ?? [...views.keys()]).flatMap((name) => views.get(name) ?? []);
}
