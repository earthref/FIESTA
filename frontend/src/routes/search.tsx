import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ColumnFilterMenu } from "../components/column-filter-menu";
import { ContributionModal } from "../components/contribution-modal";
import { ErrorMessage } from "../components/error-message";
import { type Area, areaToBbox, parseArea } from "../components/map/map-points";
import { type AreaRequest, SearchMap } from "../components/map/search-map";
import { contributionId, ResultDivider } from "../components/result-item";
import { columnsOf, RowsGrid, rowsOfHit } from "../components/rows-table";
import {
  applicableFilters,
  BboxFilter,
  FacetSection,
  filterLabel,
  GeospatialFilter,
  RangeFilter,
  rangesFor,
} from "../components/search-filters";
import { isSourceMode } from "../components/source-mode-notice";
import {
  ColumnTextFilter,
  formatGridFilters,
  type GridSort,
  parseGridFilters,
  parseGridSort,
  SummaryGrid,
} from "../components/summary-grid";
import { buttonIconStyle, SemanticIcon } from "../components/ui/fa-icon";
import { Icon } from "../components/ui/icon";
import { PageSpinner, Spinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { nodeUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { useOpenContribution } from "../lib/contribution-modal";
import { usePagedItems } from "../lib/paged";
import type {
  FacetBucket,
  GridColumn,
  SearchFilter,
  SearchLevel,
  SearchPage as SearchPageData,
  SearchResult,
} from "../lib/types";
import { cx, formatNumber, getQueryToken, parseQueryTokens, toggleQueryToken } from "../lib/utils";
import { type PluginSubTabContext, pluginFiltersPanel, pluginSubTabs } from "../plugins";

const PAGE_SIZE = 20;
/** OpenSearch's max_result_window: `from` + `size` past it is refused, so the
 * grids scroll through the first 10,000 records of a search. */
const MAX_RESULTS = 10_000;
const pageTotal = (page: SearchPageData) => page.total;
const pageResults = (page: SearchPageData) => page.results;
/** The Rows grid's header sort names a raw row column: `rows.<column>:asc|desc`. */
const ROWS_SORT = "rows.";
const routeApi = getRouteApi("/search");
const TAB_BORDER = "var(--er-edge)";
/** Legacy `styles.activeTab` on the level tabs and the Filters tab. */
const ACTIVE_TAB_BG = "var(--er-panel)";
const SEGMENT_BORDER = "var(--er-line)";
const SEGMENT_BG = "var(--er-panel)";
/** `.ui.basic.button` look: transparent/white, 1px inset shadow, weight 400. */
function basicButtonStyle(color: string): CSSProperties {
  return {
    boxShadow: `0 0 0 1px ${color} inset`,
    color,
    fontWeight: 400,
    borderRadius: "0.28571429rem",
  };
}

/** Legacy sort dropdown (search.jsx `sortOptions`), keyed by the API's `sort` names. */
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "recent", label: "Recently Contributed First" },
  { value: "recent_asc", label: "Recently Contributed Last" },
  { value: "published", label: "Recently Published First" },
  { value: "published_asc", label: "Recently Published Last" },
  { value: "cited", label: "Most Cited Publication First" },
  { value: "citation_az", label: "Citations A-z" },
  { value: "citation_za", label: "Citations z-A" },
  { value: "id_desc", label: "Largest ID First" },
  { value: "id_asc", label: "Largest ID Last" },
];
const RELEVANCE_OPTION = { value: "relevance", label: "Most Relevant First" };

/** Semantic tabular menu item: the row has only a bottom border; the active
 * tab is a top/left/right-bordered, top-rounded item overlapping it by 1px.
 * Inactive items are node-colored links (legacy `styles.a`). */
function tabItemStyle(
  active: boolean,
  small = false,
  activeBg = "var(--er-surface)",
): CSSProperties {
  const sideColor = active ? TAB_BORDER : "transparent";
  const sidePad = small ? "1.14285714em" : "1.42857143em";
  return {
    fontSize: small ? "0.92857143rem" : "1rem",
    lineHeight: "1em",
    // Longhands only: React removes a longhand that disappears from the style
    // object without restoring the shorthand it overrode.
    paddingTop: "0.92857143em",
    paddingRight: sidePad,
    paddingBottom: active && !small ? "calc(0.92857143em + 1px)" : "0.92857143em",
    paddingLeft: sidePad,
    color: active ? "var(--er-ink-strong)" : "var(--node-ink)",
    fontWeight: active ? 700 : 400,
    background: active ? activeBg : "transparent",
    borderTop: `1px solid ${sideColor}`,
    borderRight: `1px solid ${sideColor}`,
    borderLeft: `1px solid ${sideColor}`,
    borderBottom: active ? `1px dashed ${TAB_BORDER}` : "1px solid transparent",
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    marginBottom: -1,
  };
}

/** `ui circular small basic label` + legacy `styles.countLabel`: white bg, 1px
 * border, bold 11px text, min-width 4em, pulled into the tab's padding. */
function CountLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full border bg-surface text-center font-bold"
      style={{
        color: "var(--er-ink-heading)",
        borderColor: SEGMENT_BORDER,
        margin: "-1em -1em -1em 0.5em",
        minWidth: "4em",
        minHeight: "2em",
        fontSize: 11,
        lineHeight: "0.7em",
        padding: "0.5em",
      }}
    >
      {children}
    </span>
  );
}

/** Semantic "basic small compact button" (Clear buttons) / node-colored when active. */
function compactButtonClass(active: boolean): string {
  return cx(
    "flex items-center whitespace-nowrap rounded-sm",
    active ? "bg-node font-bold text-white hover:bg-node-dark" : "cursor-default bg-surface",
  );
}
function compactButtonStyle(active: boolean): CSSProperties {
  return {
    fontSize: "0.92857143rem",
    lineHeight: "1em",
    padding: "0.5em",
    margin: "-0.5em 0",
    ...(active ? {} : { ...basicButtonStyle("var(--er-ink-muted)"), opacity: 0.45 }),
    ...(active ? {} : { boxShadow: "0 0 0 1px var(--er-line) inset" }),
  };
}

function searchRequestParams(
  query: string,
  size: number,
  from = 0,
  facets = false,
  ranges?: string[],
  bbox?: string,
  sort?: string,
  filters?: string[],
) {
  return {
    query: query || undefined,
    size,
    from: from || undefined,
    facets: facets || undefined,
    range: ranges && ranges.length > 0 ? ranges : undefined,
    bbox: bbox || undefined,
    sort,
    filter: filters && filters.length > 0 ? filters : undefined,
  };
}

// --- Summary grid column menus ---------------------------------------------------

/**
 * A grid column's facet lists: the sidebar's FacetSection, counted for the
 * search as it stands (`facet=<column>`, fetched once the menu opens).
 */
function ColumnFacets({
  table,
  facets,
  labels,
  params,
  q,
  onToggle,
}: {
  table: string;
  facets: string[];
  labels: Record<string, string>;
  params: ReturnType<typeof searchRequestParams>;
  q: string;
  onToggle: (facet: string, value: string) => void;
}) {
  const counts = useQuery({
    queryKey: ["search-column-facets", table, facets, params],
    queryFn: () =>
      api<SearchPageData>(`/search/${table}`, { params: { ...params, facet: facets } }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      {facets.map((facet) => (
        <FacetSection
          key={facet}
          facet={facet}
          label={labels[facet]}
          buckets={counts.data?.aggregations?.[facet] ?? []}
          loading={counts.isPending}
          q={q}
          onToggle={onToggle}
          defaultOpen={facets.length === 1}
        />
      ))}
    </>
  );
}

/** The search box's string without the given fields' tokens. */
function queryWithout(q: string, fields: string[]): string {
  const { tokens, freeText } = parseQueryTokens(q);
  const kept = tokens.filter(([field]) => !fields.includes(field));
  return [freeText, ...kept.map(([f, v]) => `${f}:"${v}"`)].filter(Boolean).join(" ");
}

// --- Rows view ----------------------------------------------------------------

/** Legacy SearchDividedList placeholder: a 100px item with a "Loading" dimmer. */
function LoadingItem({ divider }: { divider: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-center" style={{ minHeight: 100 }}>
        <Spinner label="Loading" />
      </div>
      {divider && <ResultDivider />}
    </div>
  );
}

/** Legacy `ui fluid warning message` + `ui center aligned huge basic segment`. */
function NoItemsMessage() {
  return (
    <div style={{ margin: "1em 0" }}>
      <div
        className="rounded-sm"
        style={{
          background: "var(--er-warning-bg)",
          color: "var(--er-warning-ink)",
          boxShadow: "0 0 0 1px var(--er-warning-line) inset",
          padding: "1em 1.5em",
        }}
      >
        <div className="text-center" style={{ fontSize: "1.42857143rem", padding: "1em" }}>
          No Items to Display
        </div>
      </div>
    </div>
  );
}

// --- Search page ----------------------------------------------------------------

export function SearchPage() {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();

  const q = search.q ?? "";
  const ranges = useMemo(() => search.ranges ?? [], [search.ranges]);
  const bbox = search.bbox;
  const levels = config?.search_levels ?? [];
  const level: SearchLevel | undefined =
    levels.find((entry) => entry.name === search.level) ?? levels[0];
  const privateKey = getQueryToken(q, "private_key");
  const hasFreeText = parseQueryTokens(q).freeText.length > 0;
  // Legacy `sortDefault`: relevance whenever there is free text and the user
  // has not picked a sort, otherwise newest first.
  const sort = search.sort ?? (hasFreeText ? RELEVANCE_OPTION.value : SORT_OPTIONS[0].value);
  // The Summaries grid's header sort ("<column>:asc|desc") and column filters,
  // both on this level's columns; the Rows grid's ("rows.<column>:asc|desc")
  // on a raw row column. Either sorts the search itself, every match.
  const { headerSort, gridSort, rowsSort } = useMemo(() => {
    const header = parseGridSort(search.sort);
    const rows = header?.key.startsWith(ROWS_SORT)
      ? { ...header, key: header.key.slice(ROWS_SORT.length) }
      : undefined;
    return { headerSort: header, gridSort: rows ? undefined : header, rowsSort: rows };
  }, [search.sort]);
  const gridFilterList = useMemo(() => search.filter ?? [], [search.filter]);
  const gridFilters = useMemo(() => parseGridFilters(gridFilterList), [gridFilterList]);

  const [input, setInput] = useState(q);
  // A link may open a sub-tab (the home page's plugin cards); it is kept in
  // the page's state from then on.
  const [view, setView] = useState(search.view ?? "Summaries");
  useEffect(() => setInput(q), [q]);

  // Independent scroll regions: compute the available height so the page body
  // does not scroll (legacy onWindowResize). The fixed footer's height comes
  // from --footer-h (set by Footer), so a footer that wraps taller on a narrow
  // viewport no longer covers the bottom of the results.
  const regionRef = useRef<HTMLDivElement>(null);
  const [regionHeight, setRegionHeight] = useState<string>();
  useEffect(() => {
    const update = () => {
      if (!regionRef.current) return;
      const top = regionRef.current.getBoundingClientRect().top;
      setRegionHeight(`max(300px, calc(100vh - ${top}px - var(--footer-h, 48px) - 31px))`);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const setSearch = (next: {
    q?: string;
    level?: string;
    sort?: string | undefined;
    ranges?: string[];
    filter?: string[];
    bbox?: string | undefined;
    area?: string | undefined;
  }) => {
    const filter = next.filter ?? gridFilterList;
    navigate({
      search: {
        q: next.q !== undefined ? next.q || undefined : q || undefined,
        level: next.level ?? search.level,
        sort: "sort" in next ? next.sort : search.sort,
        ranges: (next.ranges ?? ranges).length > 0 ? (next.ranges ?? ranges) : undefined,
        filter: filter.length > 0 ? filter : undefined,
        bbox: "bbox" in next ? next.bbox || undefined : bbox,
        area: "area" in next ? next.area || undefined : search.area,
      },
    });
  };
  // A contribution's modal, over the search (?contribution=<id>&tab=...).
  const openContribution = useOpenContribution();
  const setModalTab = useCallback(
    (tab: string) => navigate({ search: (prev) => ({ ...prev, tab }), replace: true }),
    [navigate],
  );
  const closeModal = useCallback(
    () =>
      navigate({
        search: (prev) => ({
          ...prev,
          contribution: undefined,
          tab: undefined,
          private_key: undefined,
        }),
      }),
    [navigate],
  );
  // The geospatial filter (the Map tab's area, the sidebar's Geospatial
  // checkbox) narrows every level with positions, and each level tab's count;
  // it stays across level tabs. An area asked for is made by the Map tab.
  const area = parseArea(search.area);
  const areaBbox = (entry: SearchLevel | undefined) =>
    area && entry?.geo ? areaToBbox(area) : undefined;
  const [areaRequest, setAreaRequest] = useState<AreaRequest | null>(null);
  const setArea = (next: Area | null) => {
    setAreaRequest(null);
    setSearch({ area: next?.join(",") });
  };

  // Live totals for every level tab (size=1: the API requires size >= 1).
  const countQueries = useQueries({
    queries: levels.map((entry) => ({
      queryKey: ["search-count", entry.table, q, areaBbox(entry)],
      queryFn: () =>
        api<SearchPageData>(`/search/${entry.table}`, {
          params: searchRequestParams(q, 1, 0, false, undefined, areaBbox(entry)),
        }),
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    })),
  });

  // Result sub-tabs: Summaries, Rows (non-contribution), Map (levels with
  // positions), then plugin tabs. The
  // chosen view persists across levels and falls back to the first tab when a
  // level lacks it (legacy `state.view`).
  type SubTab = {
    name: string;
    render?: (ctx: PluginSubTabContext) => ReactNode;
    countTable?: string;
  };
  const subTabs = useMemo<SubTab[]>(() => {
    if (!config || !level) return [];
    const tabs: SubTab[] = [{ name: "Summaries" }];
    if (level.table !== "contribution") tabs.push({ name: "Rows" });
    if (level.geo) tabs.push({ name: "Map" });
    return [...tabs, ...pluginSubTabs(config, level)];
  }, [config, level]);
  const activeTab = subTabs.find((tab) => tab.name === view) ?? subTabs[0];

  // A plugin view's count: its own docs matching the search and its filters
  // (ranges on its summary block, the bbox), as it fetches them. Switching
  // sub-tabs never changes the level tabs' counts. Its facets are the
  // sidebar's counts while that view is open.
  const countedTabs = subTabs.filter((tab) => tab.countTable);
  const pluginCounts = useQueries({
    queries: countedTabs.map(({ countTable }) => {
      const tableRanges = ranges.filter((r) => r.startsWith(`summary.${countTable}.`));
      return {
        queryKey: ["search-count", countTable, q, tableRanges, bbox, "facets"],
        queryFn: () =>
          api<SearchPageData>(`/search/${countTable}`, {
            params: searchRequestParams(q, 1, 0, true, tableRanges, bbox),
          }),
        staleTime: 60_000,
        placeholderData: keepPreviousData,
      };
    }),
  });

  // The sidebar's controls for this level + sub-tab (node YAML `search.filters`).
  // A plugin may still replace the whole panel. Range/bbox values apply to the
  // main query only when their filter is visible here; a plugin view (Poles)
  // reads them from its sub-tab context for its own fetch.
  const filters: SearchFilter[] = applicableFilters(config, level?.name, activeTab?.name);
  const filtersPanel = level
    ? pluginFiltersPanel(config, {
        levelName: level.name,
        subTabName: activeTab?.name,
        ranges,
        bbox,
        setRanges: (next) => setSearch({ ranges: next }),
        setBbox: (next) => setSearch({ bbox: next }),
      })
    : null;
  const facetFields = filters.filter((f) => f.type === "facet").map((f) => f.field ?? "");
  const activeRanges = rangesFor(ranges, filters);
  const activeBbox = filters.some((f) => f.type === "bbox") ? bbox : undefined;
  // The grid columns' facet lists filter through the same tokens.
  const columnFacetFields = (level?.columns ?? []).flatMap((column) => column.facets);
  const clearedFacets = [...facetFields, ...columnFacetFields];
  const hasFacetFilters =
    parseQueryTokens(q).tokens.filter(([field]) => clearedFacets.includes(field)).length > 0;
  // A plugin view renders from its own fetch; keep its ranges out of the level query.
  const queryRanges = activeTab?.render ? undefined : activeRanges;
  const queryBbox = activeTab?.render ? undefined : (areaBbox(level) ?? activeBbox);

  // The grids are sized to every match (up to MAX_RESULTS) and fetch the
  // pages under their visible rows; page 0 carries the facets and totals.
  const searchKey = ["search", level?.table, q, sort, queryRanges, queryBbox, gridFilterList];
  const paged = usePagedItems({
    queryKey: searchKey,
    pageSize: PAGE_SIZE,
    fetchPage: (page) =>
      api<SearchPageData>(`/search/${level?.table}`, {
        params: {
          ...searchRequestParams(
            q,
            PAGE_SIZE,
            page * PAGE_SIZE,
            page === 0,
            queryRanges,
            queryBbox,
            sort,
            gridFilterList,
          ),
          // The Rows and Map sub-tabs' counts, with the first page.
          totals: page === 0 || undefined,
        },
      }),
    totalOf: pageTotal,
    itemsOf: pageResults,
    limit: MAX_RESULTS,
    enabled: !!level,
  });
  const results = paged.first;
  // The records loaded so far (plugin views, the download link).
  const hits = useMemo(
    () => paged.items.filter((hit): hit is SearchResult => hit !== undefined),
    [paged.items],
  );
  const total = results.data?.total ?? 0;
  const rowItems = useMemo(
    () => paged.items.map((hit, h) => hit && rowsOfHit(hit, h, rowsSort)),
    [paged.items, rowsSort],
  );
  const gridRowColumns = useMemo(() => columnsOf(rowItems), [rowItems]);
  const rowsPerRecord = total > 0 && results.data?.rows_total ? results.data.rows_total / total : 1;
  // Each sub-tab's count (undefined while loading, null for none): the
  // records (Summaries), their rows, those on the map, a plugin view's docs.
  const subTabCount = (tab: SubTab): number | null | undefined => {
    const first = results.isPending ? undefined : results.data;
    if (tab.name === "Summaries") return first?.total;
    if (tab.name === "Rows") return first && (first.rows_total ?? first.total);
    if (tab.name === "Map") return first && (first.mapped_total ?? null);
    const index = countedTabs.indexOf(tab);
    return index < 0 ? null : pluginCounts[index]?.data?.total;
  };
  const aggregations = results.data?.aggregations ?? null;
  // The sidebar's facet counts follow the sub-tab: records (Summaries), their
  // rows, those on the map, or a plugin view's own docs. A value with none
  // drops out (an active one stays, at zero).
  const activeCounted = activeTab ? countedTabs.indexOf(activeTab) : -1;
  const pluginFacets = activeCounted >= 0 ? pluginCounts[activeCounted] : undefined;
  const facetsLoading = pluginFacets ? pluginFacets.isPending : results.isPending;
  const facetBuckets = (field: string): FacetBucket[] => {
    if (pluginFacets) return pluginFacets.data?.aggregations?.[field] ?? [];
    const buckets = aggregations?.[field] ?? [];
    const count =
      activeTab?.name === "Rows"
        ? (bucket: FacetBucket) => bucket.rows_count
        : activeTab?.name === "Map"
          ? (bucket: FacetBucket) => bucket.mapped_count
          : undefined;
    if (!count) return buckets;
    return buckets
      .map((bucket) => ({ key: bucket.key, doc_count: count(bucket) ?? bucket.doc_count }))
      .filter((bucket) => bucket.doc_count > 0)
      .sort((a, b) => b.doc_count - a.doc_count);
  };
  const topContributionId =
    level?.table === "contribution" ? contributionId(hits[0] ?? {}) : undefined;

  const scrollerRef = useRef<HTMLDivElement>(null);
  // A new search starts at the top of its grid.
  const searchKeyText = JSON.stringify(searchKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key's text is the change
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [searchKeyText]);

  // Clear every visible control: facet tokens (the sidebar's and the grid
  // columns'), ranges and the bbox it shows.
  const clearFilters = () => {
    const keptRanges = ranges.filter((entry) => !activeRanges.includes(entry));
    setSearch({
      q: queryWithout(q, clearedFacets),
      ranges: keptRanges,
      filter: [],
      bbox: activeBbox ? undefined : bbox,
      area: undefined,
    });
  };
  const clearActive =
    hasFacetFilters ||
    activeRanges.length > 0 ||
    !!activeBbox ||
    !!area ||
    gridFilterList.length > 0;

  // The sidebar's Geospatial filter opens the Map, in the Mercator view and
  // zoomed to the new area when coming from a list (as on osu-mgr.org).
  const requestArea = () => {
    setAreaRequest(activeTab?.name === "Map" ? {} : { mode: "flat", zoomTo: true });
    setView("Map");
  };
  const showArea = () => {
    if (activeTab?.name !== "Map") setAreaRequest({ zoomTo: true });
    setView("Map");
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSearch({ q: input.trim() });
  };

  if (!config || !level) return <PageSpinner />;

  // A header sort shows in the dropdown as its own (selected) entry.
  const gridSortColumn = gridSort && level.columns?.find((c) => c.key === gridSort.key);
  const sortOptions = [
    ...(gridSort && gridSortColumn
      ? [
          {
            value: sort,
            label: `${gridSortColumn.label} ${gridSort.order === "asc" ? "Ascending" : "Descending"}`,
          },
        ]
      : []),
    ...(rowsSort
      ? [
          {
            value: sort,
            label: `${rowsSort.key} ${rowsSort.order === "asc" ? "Ascending" : "Descending"}`,
          },
        ]
      : []),
    ...(hasFreeText ? [RELEVANCE_OPTION] : []),
    ...SORT_OPTIONS,
  ];
  const onGridSort = (next: GridSort | undefined) =>
    setSearch({ sort: next ? `${next.key}:${next.order}` : undefined });
  const windowNote = paged.matched > MAX_RESULTS && (
    <p className="py-4 text-center text-[13px] text-gray-500">
      Showing the first {formatNumber(MAX_RESULTS)} of {formatNumber(paged.matched)} records. Narrow
      the search or change the sort to reach the rest.
    </p>
  );
  const onRowsSort = (next: GridSort | undefined) =>
    setSearch({ sort: next ? `${ROWS_SORT}${next.key}:${next.order}` : undefined });
  const onGridFilter = (key: string, text: string) =>
    setSearch({ filter: formatGridFilters({ ...gridFilters, [key]: text }) });

  // A column header's filter icon: its facet lists (the sidebar's, sharing
  // its tokens and labels), else a text box, and on the map tile the area.
  const facetLabels = Object.fromEntries(
    (config.filters ?? [])
      .filter((f) => f.type === "facet" && f.field && f.label)
      .map((f) => [f.field ?? "", f.label ?? ""]),
  );
  const columnFacetParams = searchRequestParams(
    q,
    1,
    0,
    true,
    queryRanges,
    queryBbox,
    undefined,
    gridFilterList,
  );
  const queryTokens = parseQueryTokens(q).tokens;
  const columnFilterMenu = (column: GridColumn) => {
    const geospatial = column.geospatial && !!level.geo;
    if (column.facets.length === 0 && !column.filterable && !geospatial) return null;
    const text = column.filterable ? (gridFilters[column.key] ?? "") : "";
    const active =
      queryTokens.filter(([field]) => column.facets.includes(field)).length +
      (text.trim() ? 1 : 0) +
      (geospatial && area ? 1 : 0);
    const clear = () =>
      setSearch({
        q: queryWithout(q, column.facets),
        filter: formatGridFilters({ ...gridFilters, [column.key]: "" }),
        ...(geospatial ? { area: undefined } : {}),
      });
    return (
      <ColumnFilterMenu label={column.label} active={active} onClear={clear}>
        {column.facets.length > 0 && (
          <ColumnFacets
            table={level.table}
            facets={column.facets}
            labels={facetLabels}
            params={columnFacetParams}
            q={q}
            onToggle={(name, value) => setSearch({ q: toggleQueryToken(q, name, value) })}
          />
        )}
        {column.filterable && (
          <ColumnTextFilter
            column={column}
            value={text}
            onChange={(next) => onGridFilter(column.key, next)}
          />
        )}
        {geospatial && (
          <GeospatialFilter
            area={area}
            onRequest={requestArea}
            onShow={showArea}
            onRemove={() => setArea(null)}
          />
        )}
      </ColumnFilterMenu>
    );
  };

  return (
    <div className="magic-search">
      {/* Level tabs: Semantic tabular menu (bottom border only; grey active tab) */}
      <div className="flex flex-wrap items-end" style={{ borderBottom: `1px solid ${TAB_BORDER}` }}>
        {levels.map((entry, index) => {
          const active = entry.name === level.name;
          const count = countQueries[index]?.data?.total;
          return (
            <button
              key={entry.name}
              type="button"
              onClick={() =>
                setSearch({
                  level: entry.name,
                  ranges: [],
                  filter: [],
                  bbox: undefined,
                  // A header sort names this level's columns.
                  sort: headerSort ? undefined : search.sort,
                })
              }
              className={cx(
                "flex items-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                !active && "cursor-pointer hover:text-node-ink-strong",
              )}
              style={tabItemStyle(active, false, ACTIVE_TAB_BG)}
            >
              {entry.name}
              <CountLabel>{count === undefined ? "…" : formatNumber(count)}</CountLabel>
            </button>
          );
        })}
        {user && !isSourceMode(config) && (
          <div className="ml-auto flex items-center self-center" style={{ paddingRight: 0 }}>
            <Link
              to="/private"
              className="mr-1 inline-flex items-center whitespace-nowrap rounded-sm bg-node px-3 text-[13px] font-bold text-white hover:bg-node-dark"
              style={{ paddingTop: "0.5em", paddingBottom: "0.5em" }}
            >
              Private Workspace
            </Link>
          </div>
        )}
      </div>

      {/* Attached secondary segment (light grey, padding 0, joined to the tab row) */}
      <div
        style={{
          background: SEGMENT_BG,
          color: "var(--er-ink-muted)",
          border: `1px solid ${SEGMENT_BORDER}`,
          borderTop: "none",
          padding: 0,
          borderBottomLeftRadius: "0.28571429rem",
          borderBottomRightRadius: "0.28571429rem",
        }}
      >
        <div className="flex w-full flex-wrap">
          {/* Labeled fluid action input */}
          <form
            onSubmit={onSubmit}
            className="flex min-w-64"
            style={{ padding: "1em", paddingBottom: 0, flex: 1 }}
          >
            <label
              htmlFor="search-input"
              className="flex items-center whitespace-nowrap rounded-l-sm bg-node font-bold text-white"
              style={{ fontSize: "1rem", padding: "0.78571429em 0.833em", lineHeight: "1em" }}
            >
              <SemanticIcon name="search" style={{ marginRight: "0.75em" }} />
              Search {config.key}
            </label>
            <input
              id="search-input"
              type="search"
              placeholder='e.g. metamorphic "field intensity" -precambrian'
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="min-w-0 bg-surface placeholder:text-ink-faint focus:outline-hidden"
              style={{
                fontSize: "1rem",
                lineHeight: "1.21428571em",
                padding: "0.67857143em 1em",
                border: "1px solid var(--er-input-line)",
                borderLeft: "none",
                borderRight: "none",
                flex: 1,
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() && !q}
              className="flex items-center whitespace-nowrap bg-surface disabled:cursor-default disabled:opacity-45"
              style={{
                ...basicButtonStyle("var(--er-inverse)"),
                borderRadius: 0,
                fontSize: "1rem",
                padding: "0.78571429em 1.5em",
                lineHeight: "1em",
              }}
            >
              <SemanticIcon name="search" style={buttonIconStyle} />
              Search
            </button>
            <button
              type="button"
              disabled={!input && !q}
              onClick={() => {
                setInput("");
                setSearch({ q: "" });
              }}
              className="flex items-center whitespace-nowrap bg-surface disabled:cursor-default disabled:opacity-45"
              style={{
                ...basicButtonStyle("var(--er-inverse)"),
                borderRadius: "0 0.28571429rem 0.28571429rem 0",
                fontSize: "1rem",
                padding: "0.78571429em 1.5em",
                lineHeight: "1em",
                marginLeft: -1,
              }}
            >
              <SemanticIcon name="remove circle" style={buttonIconStyle} />
              Clear
            </button>
          </form>
          {/* Download Results: hidden when searching a private_key (legacy) */}
          {!privateKey &&
            (topContributionId ? (
              <a
                href={nodeUrl(`/contributions/${topContributionId}/download`)}
                download
                className="flex items-center self-start whitespace-nowrap bg-surface hover:bg-node-soft"
                style={{
                  ...basicButtonStyle("var(--node-ink)"),
                  margin: "1em 1em 0 0",
                  fontSize: "1rem",
                  padding: "0.78571429em 1.5em",
                  lineHeight: "1em",
                }}
              >
                <SemanticIcon name="download" style={buttonIconStyle} />
                Download Results
              </a>
            ) : (
              <button
                type="button"
                disabled
                title={
                  level.table === "contribution"
                    ? "No results to download"
                    : "Switch to the Contributions level to download results"
                }
                className="flex items-center self-start whitespace-nowrap bg-surface"
                style={{
                  ...basicButtonStyle("var(--node-ink)"),
                  opacity: 0.45,
                  margin: "1em 1em 0 0",
                  cursor: "default",
                  fontSize: "1rem",
                  padding: "0.78571429em 1.5em",
                  lineHeight: "1em",
                }}
              >
                <SemanticIcon name="download" style={buttonIconStyle} />
                Download Results
              </button>
            ))}
        </div>

        {/* Results flex row with independent scroll regions */}
        <div
          ref={regionRef}
          className="flex"
          style={{
            marginTop: "1em",
            height: regionHeight ?? "100%",
            width: "100%",
          }}
        >
          {/* Sidebar: fixed 275px */}
          <div className="flex h-full flex-col" style={{ width: 275, flexShrink: 0 }}>
            <div
              className="flex items-end"
              style={{
                borderBottom: `1px solid ${TAB_BORDER}`,
                paddingLeft: "1em",
                fontSize: "0.92857143rem",
              }}
            >
              <span style={tabItemStyle(true, true, ACTIVE_TAB_BG)}>Filters</span>
              <span className="ml-auto self-center" style={{ padding: "0 1em" }}>
                <button
                  type="button"
                  onClick={clearFilters}
                  disabled={!clearActive}
                  className={compactButtonClass(clearActive)}
                  style={compactButtonStyle(clearActive)}
                >
                  <SemanticIcon name="remove circle" style={buttonIconStyle} />
                  Clear Filters
                </button>
              </span>
            </div>
            {/* `ui small basic attached segment`: transparent, borderless, scrolls */}
            <div
              className="flex-1 overflow-y-scroll whitespace-nowrap"
              style={{
                border: "none",
                margin: 0,
                padding: 0,
                width: "100%",
                fontSize: "0.92857143rem",
              }}
            >
              {filtersPanel ?? (
                <>
                  {level.geo && (
                    <GeospatialFilter
                      area={area}
                      onRequest={requestArea}
                      onShow={showArea}
                      onRemove={() => setArea(null)}
                    />
                  )}
                  {filters.map((filter) =>
                    filter.type === "facet" ? (
                      <FacetSection
                        key={filter.field}
                        facet={filter.field ?? ""}
                        label={filter.label ?? undefined}
                        buckets={facetBuckets(filter.field ?? "")}
                        loading={facetsLoading}
                        q={q}
                        onToggle={(name, value) =>
                          setSearch({ q: toggleQueryToken(q, name, value) })
                        }
                      />
                    ) : filter.type === "range" ? (
                      <RangeFilter
                        key={filter.field}
                        filter={filter}
                        ranges={ranges}
                        setRanges={(next) => setSearch({ ranges: next })}
                      />
                    ) : (
                      <BboxFilter
                        key={`bbox-${filterLabel(filter)}`}
                        filter={filter}
                        bbox={bbox}
                        setBbox={(next) => setSearch({ bbox: next })}
                      />
                    ),
                  )}
                  {filters.length === 0 && !level.geo && (
                    <p className="px-[1em] py-3 text-[12px] text-ink-faint">
                      No filters for this view.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Results pane */}
          <div className="flex h-full min-w-0 flex-1 flex-col">
            {/* Sub-tab bar (small tabular; white active tab) + sort dropdown */}
            <div
              className="flex items-end"
              style={{ borderBottom: `1px solid ${TAB_BORDER}`, fontSize: "0.92857143rem" }}
            >
              {subTabs.map((tab) => {
                const active = tab.name === (activeTab?.name ?? "Summaries");
                return (
                  <button
                    key={tab.name}
                    type="button"
                    onClick={() => setView(tab.name)}
                    className={cx(
                      "flex items-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                      !active && "cursor-pointer hover:text-node-ink-strong",
                    )}
                    style={tabItemStyle(active, true)}
                  >
                    {tab.name}
                    {(() => {
                      const count = subTabCount(tab);
                      return count === null ? null : (
                        <CountLabel>{count === undefined ? "…" : formatNumber(count)}</CountLabel>
                      );
                    })()}
                  </button>
                );
              })}
              <span className="relative ml-auto self-center" style={{ padding: "0 1em" }}>
                <label htmlFor="sort-select" className="sr-only">
                  Sort results
                </label>
                {/* Legacy `<color> ui dropdown label`: node-colored pill with a caret */}
                <select
                  id="sort-select"
                  value={sort}
                  onChange={(event) => setSearch({ sort: event.target.value })}
                  className="cursor-pointer appearance-none border-0 bg-node font-bold text-white focus:outline-hidden"
                  style={{
                    padding: "0.5em calc(1.86em - 8px) 0.5em 0.5em",
                    fontSize: "0.85714286rem",
                    lineHeight: "1em",
                    borderRadius: "0.28571429rem",
                  }}
                >
                  {sortOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Icon
                  name="caret-down"
                  className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-white"
                  style={{ right: "1.5em", width: "0.857em", height: "0.857em" }}
                />
              </span>
            </div>

            {activeTab?.name === "Map" ? (
              <div
                className="min-h-0 flex-1 bg-surface"
                style={{ borderLeft: `1px solid ${TAB_BORDER}`, padding: "0 1em" }}
              >
                <SearchMap
                  level={level}
                  query={q}
                  ranges={queryRanges}
                  filters={gridFilterList}
                  area={area}
                  onAreaChange={setArea}
                  areaRequest={areaRequest}
                  onRequestArea={() => setAreaRequest({})}
                  onAreaRequestDone={() => setAreaRequest(null)}
                  color={config.color}
                  onSelect={(id) => openContribution(id, level.table)}
                />
              </div>
            ) : (
              /* View container: border-left 1px #d4d4d5, white, independent scroll */
              <div
                ref={scrollerRef}
                className="flex-1 overflow-y-scroll bg-surface"
                style={{ borderLeft: `1px solid ${TAB_BORDER}`, padding: "0 1em" }}
              >
                {results.error && <ErrorMessage error={results.error} className="my-3" />}

                {results.isPending && !results.error && (
                  <div style={{ margin: "1em 0" }}>
                    {Array.from({ length: 5 }, (_, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count placeholders
                      <LoadingItem key={index} divider />
                    ))}
                  </div>
                )}

                {results.data && (
                  <>
                    {activeTab?.name === "Summaries" && (
                      // Rows run edge to edge of the view; the cells carry the padding.
                      <div style={{ margin: "0 -1em 1em" }}>
                        <SummaryGrid
                          level={level}
                          hits={paged.items}
                          privateKey={privateKey}
                          sort={gridSort}
                          onSort={onGridSort}
                          filterMenu={columnFilterMenu}
                          footer={windowNote}
                          scrollRef={scrollerRef}
                          overscan={10}
                          onRange={paged.onRange}
                          onOpen={(doc) => {
                            const id = contributionId(doc);
                            if (id) openContribution(id, level.table);
                          }}
                        />
                      </div>
                    )}
                    {activeTab?.name === "Rows" && (
                      <div style={{ marginBottom: "1em" }}>
                        <RowsGrid
                          items={rowItems}
                          columns={gridRowColumns}
                          estimateRows={rowsPerRecord}
                          sort={rowsSort}
                          onSort={onRowsSort}
                          scrollRef={scrollerRef}
                          onRange={paged.onRange}
                          footer={windowNote}
                        />
                      </div>
                    )}
                    {activeTab?.render && (
                      <div>
                        {activeTab.render({
                          hits,
                          level,
                          config,
                          privateKey,
                          query: q,
                          ranges,
                          bbox,
                        })}
                      </div>
                    )}

                    {total === 0 && <NoItemsMessage />}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {search.contribution !== undefined && (
        <ContributionModal
          id={String(search.contribution)}
          tab={search.tab}
          privateKey={search.private_key ?? privateKey}
          onTab={setModalTab}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
