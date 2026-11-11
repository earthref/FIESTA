// The plugin UI contract and registry. Each plugin's UI lives with the rest of
// the plugin in configurations/plugins/<name>/ (docs/plugins.md): its index.tsx
// default-exports a PluginModule and imports core code as "@/..." (src/).
import type { ReactNode } from "react";
import type { SearchParams } from "../components/filter-modals";
import type {
  FacetBucket,
  GridColumn,
  NodeConfig,
  SearchLevel,
  SearchResult,
  SearchScope,
} from "../lib/types";

export interface PluginGridCellProps {
  /** The summary grid column being rendered (its `cell` names the tile). */
  column: GridColumn;
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
  /** Only this contribution (any version; the contribution modal's tabs). */
  contribution?: string;
  /** The search's scope filters (My contributions, Previous versions): add
   * them to the view's own search requests (and their query keys). */
  scope?: SearchScope;
}

export interface PluginSubTab {
  name: string;
  render: (ctx: PluginSubTabContext) => ReactNode;
  /** A search table whose matches (with the ranges on its summary block and
   * the bbox) are the tab's count. */
  countTable?: string;
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

/** What a plugin's sidebar filter reads and sets: the search's query, whose
 * `<field>:"<value>"` tokens are facet picks (OR'd within a field), and the
 * request params its counts use, the same as the core facet modal's. */
export interface PluginFilterContext {
  levelName: string;
  /** The name of the active result sub-tab (Summaries/Rows/plugin tabs). */
  subTabName?: string;
  config: NodeConfig;
  /** The search's query string. */
  q: string;
  /** Apply a new query string (the search runs once). */
  setQuery: (q: string) => void;
  /** The search table its counts are on: the level's, or an open plugin view's. */
  table: string;
  /** The search's request params (ranges, bbox, grid filters, scope) for a
   * query string; count a facet with `facet: [field]` added. */
  paramsFor: (q: string) => SearchParams;
  /** A facet bucket's count on the open sub-tab (its rows, its mapped
   * records); undefined = its doc_count. */
  count?: (bucket: FacetBucket) => number | undefined;
}

/** A filter a plugin adds to the search sidebar, after the node's own. */
export interface PluginFilter {
  key: string;
  /** The query-token fields it sets; the sidebar's Clear removes them. A
   * field the search API counts must be a facet (a plugin's `search_facets`). */
  fields: string[];
  render: (ctx: PluginFilterContext) => ReactNode;
}

export interface PluginHomeCard {
  key: string;
  title: string;
  subtitle?: ReactNode;
  to: string;
  search?: Record<string, unknown>;
}

export interface ContributionTabContext {
  /** The contribution's id and, for a private one, its key. */
  id: string;
  privateKey?: string;
  config: NodeConfig;
  /** The contribution's own search doc. */
  doc: SearchResult;
  /** The plot selected in the tab (`?plot=`, the tab's own key for it), and
   * how the tab names a new selection (kept in the URL, so a link opens it). */
  plot?: string;
  onPlot?: (plot: string | undefined) => void;
}

/** An asset tab in the contribution modal (plots, maps, images, ...). */
export interface ContributionTab {
  /** The `tab` search param that opens it; unique within the modal. */
  key: string;
  label: string;
  /** A search table whose matches in this contribution are the tab's count;
   * a tab counted this way is hidden when there are none. Without one the
   * tab always shows, with no count. */
  countTable?: string;
  /** Or a query for the count, hidden the same way at 0; tabs sharing a
   * queryKey (several counts in one document) fetch it once. */
  countQuery?: (id: string, privateKey?: string) => TabCountQuery;
  render: (ctx: ContributionTabContext) => ReactNode;
}

export interface TabCountQuery {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  select: (data: unknown) => number;
}

export interface PluginModule {
  /** Full-width cards under the home page's primary cards (legacy "Poles / View"). */
  homeCards?: (config: NodeConfig) => PluginHomeCard[];
  /** Render a summary grid tile for this hit (e.g. the `plot` tile), or null
   * to fall through to the built-in tile. */
  gridCell?: (props: PluginGridCellProps) => ReactNode | null;
  /** Extra result-view sub-tabs contributed to a search level. */
  levelSubTabs?: (level: SearchLevel, config: NodeConfig) => PluginSubTab[];
  /** Replace the facet sidebar for a level; return null to keep the facet sidebar. */
  filtersPanel?: (props: PluginFiltersProps) => ReactNode | null;
  /** Filters added to the facet sidebar for a level + result view. */
  sidebarFilters?: (
    levelName: string,
    subTabName: string | undefined,
    config: NodeConfig,
  ) => PluginFilter[];
  /** Asset tabs for the contribution modal, after its Map tab. */
  contributionTabs?: (config: NodeConfig) => ContributionTab[];
}

const MODULES = import.meta.glob<PluginModule>("@plugins/*/index.tsx", {
  eager: true,
  import: "default",
});

/** All known plugin modules, keyed by folder name (the backend plugin's
 * `name`); activation is strictly by key presence in config.plugins. */
export const PLUGINS: Record<string, PluginModule> = Object.fromEntries(
  Object.entries(MODULES).map(([path, module]) => [
    path.replace(/\/index\.tsx$/, "").replace(/^.*\//, ""),
    module,
  ]),
);

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

/** First plugin-provided grid tile for a hit's column, or null. */
export function pluginGridCell(
  config: NodeConfig | undefined,
  props: PluginGridCellProps,
): ReactNode | null {
  for (const plugin of activePlugins(config)) {
    const node = plugin.gridCell?.(props);
    if (node) return node;
  }
  return null;
}

export function pluginSubTabs(config: NodeConfig | undefined, level: SearchLevel): PluginSubTab[] {
  if (!config) return [];
  return activePlugins(config).flatMap((plugin) => plugin.levelSubTabs?.(level, config) ?? []);
}

export function pluginContributionTabs(config: NodeConfig | undefined): ContributionTab[] {
  if (!config) return [];
  return activePlugins(config).flatMap((plugin) => plugin.contributionTabs?.(config) ?? []);
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

/** Every plugin's sidebar filters for a level + result view. */
export function pluginSidebarFilters(
  config: NodeConfig | undefined,
  levelName: string | undefined,
  subTabName: string | undefined,
): PluginFilter[] {
  if (!config || !levelName) return [];
  return activePlugins(config).flatMap(
    (plugin) => plugin.sidebarFilters?.(levelName, subTabName, config) ?? [],
  );
}
