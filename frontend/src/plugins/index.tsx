import type { ReactNode } from "react";
import type { NodeConfig, SearchLevel, SearchResult } from "../lib/types";
import { depthPlotPlugin } from "./depth-plot";
import { plateauPlugin } from "./plateau-calculations";
import { polesPlugin } from "./poles";

export interface PluginResultItemProps {
  hit: SearchResult;
  level: SearchLevel;
  config: NodeConfig;
  privateKey?: string;
}

export interface PluginSubTabContext {
  hits: SearchResult[];
  level: SearchLevel;
  config: NodeConfig;
  privateKey?: string;
}

export interface PluginSubTab {
  name: string;
  render: (ctx: PluginSubTabContext) => ReactNode;
}

export interface PluginModule {
  /** Return a custom card for this hit, or null to fall through to the default. */
  resultItem?: (props: PluginResultItemProps) => ReactNode | null;
  /** Extra result-view sub-tabs contributed to a search level. */
  levelSubTabs?: (level: SearchLevel, config: NodeConfig) => PluginSubTab[];
  /** Replace the facet sidebar for a level: return filter names, or null to keep facets. */
  filtersOverride?: (levelName: string, config: NodeConfig) => string[] | null;
}

/** All known plugin modules; activation is strictly by key presence in config.plugins. */
export const PLUGINS: Record<string, PluginModule> = {
  poles: polesPlugin,
  "depth-plot": depthPlotPlugin,
  "plateau-calculations": plateauPlugin,
};

export function activePlugins(config: NodeConfig | undefined): PluginModule[] {
  if (!config) return [];
  return Object.keys(config.plugins ?? {})
    .filter((name) => name in PLUGINS)
    .map((name) => PLUGINS[name]);
}

/** First plugin-provided card for a hit, or null. */
export function pluginResultItem(
  config: NodeConfig | undefined,
  props: PluginResultItemProps,
): ReactNode | null {
  for (const plugin of activePlugins(config)) {
    const node = plugin.resultItem?.(props);
    if (node) return node;
  }
  return null;
}

export function pluginSubTabs(config: NodeConfig | undefined, level: SearchLevel): PluginSubTab[] {
  if (!config) return [];
  return activePlugins(config).flatMap((plugin) => plugin.levelSubTabs?.(level, config) ?? []);
}

export function pluginFiltersOverride(
  config: NodeConfig | undefined,
  levelName: string,
): string[] | null {
  if (!config) return null;
  for (const plugin of activePlugins(config)) {
    const override = plugin.filtersOverride?.(levelName, config);
    if (override) return override;
  }
  return null;
}
