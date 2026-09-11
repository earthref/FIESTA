import type { ReactNode } from "react";
import type { NodeConfig, SearchLevel, SearchResult } from "../lib/types";
import { depthPlotPlugin } from "./depth-plot";
import { plateauPlugin } from "./plateau-calculations";
import { polesPlugin } from "./poles";
import { recordCardsPlugin } from "./record-cards";

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
  /** The current free-text/token query string. */
  query: string;
  /** Active plugin range filters, each "field:gte:lte". */
  ranges: string[];
  /** Active bounding box: "minLon,minLat,maxLon,maxLat". */
  bbox?: string;
}

export interface PluginSubTab {
  name: string;
  render: (ctx: PluginSubTabContext) => ReactNode;
}

export interface PluginFiltersProps {
  levelName: string;
  /** The name of the active result sub-tab (Summaries/Rows/plugin tabs). */
  subTabName?: string;
  config: NodeConfig;
  /** Current range filters, each "field:gte:lte" (blank = open end). */
  ranges: string[];
  /** Current bounding box: "minLon,minLat,maxLon,maxLat". */
  bbox?: string;
  setRanges: (ranges: string[]) => void;
  setBbox: (bbox: string | undefined) => void;
}

export interface PluginHomeCard {
  key: string;
  title: ReactNode;
  subtitle?: ReactNode;
  to: string;
  search?: Record<string, unknown>;
}

export interface PluginModule {
  /** Full-width cards under the home page's primary cards (legacy "Poles / View"). */
  homeCards?: (config: NodeConfig) => PluginHomeCard[];
  /** Return a custom card for this hit, or null to fall through to the default. */
  resultItem?: (props: PluginResultItemProps) => ReactNode | null;
  /** Extra result-view sub-tabs contributed to a search level. */
  levelSubTabs?: (level: SearchLevel, config: NodeConfig) => PluginSubTab[];
  /** Replace the facet sidebar for a level; return null to keep the facet sidebar. */
  filtersPanel?: (props: PluginFiltersProps) => ReactNode | null;
}

/** All known plugin modules; activation is strictly by key presence in config.plugins. */
export const PLUGINS: Record<string, PluginModule> = {
  poles: polesPlugin,
  "depth-plot": depthPlotPlugin,
  "record-cards": recordCardsPlugin,
  "plateau-calculations": plateauPlugin,
};

export function activePlugins(config: NodeConfig | undefined): PluginModule[] {
  if (!config) return [];
  return Object.keys(config.plugins ?? {})
    .filter((name) => name in PLUGINS)
    .map((name) => PLUGINS[name]);
}

export function pluginHomeCards(config: NodeConfig | undefined): PluginHomeCard[] {
  if (!config) return [];
  return activePlugins(config).flatMap((plugin) => plugin.homeCards?.(config) ?? []);
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

/** First plugin-provided filters panel for a level, or null (keep facet sidebar). */
export function pluginFiltersPanel(
  config: NodeConfig | undefined,
  props: Omit<PluginFiltersProps, "config">,
): ReactNode | null {
  if (!config) return null;
  for (const plugin of activePlugins(config)) {
    const panel = plugin.filtersPanel?.({ ...props, config });
    if (panel) return panel;
  }
  return null;
}
