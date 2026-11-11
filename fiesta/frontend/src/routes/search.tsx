import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type FormEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ColumnFilterButton } from "../components/column-filter-menu";
import { ContributionModal } from "../components/contribution-modal";
import { ErrorMessage } from "../components/error-message";
import {
  ExistsModal,
  FacetModal,
  type FacetSpec,
  GeoModal,
  hasText,
  NumericModal,
  RangeModal,
  rangeText,
  useLatestDataModel,
  useNumberFilter,
} from "../components/filter-modals";
import { type Area, areaToBbox, formatArea, parseArea } from "../components/map/map-points";
import { type AreaRequest, SearchMap } from "../components/map/search-map";
import { contributionId, ResultDivider } from "../components/result-item";
import { columnsOf, RowsGrid, rowsOfHit } from "../components/rows-table";
import {
  applicableFilters,
  type FilterChip,
  FilterChoices,
  FilterEntry,
  filterLabel,
  hasFor,
  parseHas,
  parseRange,
  pickedRanges,
  rangesFor,
} from "../components/search-filters";
import { isSourceMode } from "../components/source-mode-notice";
import {
  formatGridFilters,
  type GridSort,
  parseGridFilters,
  parseGridSort,
  SummaryGrid,
} from "../components/summary-grid";
import { CountLabel } from "../components/ui/count-label";
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
  ContributionOut,
  FacetBucket,
  GridColumn,
  SearchFilter,
  SearchLevel,
  SearchPage as SearchPageData,
  SearchResult,
  SearchScope,
} from "../lib/types";
import {
  cx,
  facetTitle,
  formatNumber,
  getQueryToken,
  parseQueryTokens,
  queryWithout,
  toggleQueryToken,
} from "../lib/utils";
import {
  type PluginSubTabContext,
  pluginFiltersPanel,
  pluginSidebarFilters,
  pluginSubTabs,
} from "../plugins";

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
  has?: string[],
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
    has: has && has.length > 0 ? has : undefined,
  };
}

// --- Filter modals ----------------------------------------------------------------

/** The filter modal open over the search: a facet list (the sidebar's, or a
 * grid column's with its text box), a numeric range, or the geospatial area
 * (`area`, every level with positions) / a bbox filter (`bbox`, a plugin view). */
type FilterModalState =
  | { kind: "facet"; title: string; facets: FacetSpec[]; column?: GridColumn }
  // `back`: the numeric filter whose picker it was chosen from.
  | { kind: "range"; filter: SearchFilter; back?: SearchFilter }
  | { kind: "numeric"; filter: SearchFilter }
  | { kind: "exists"; filter: SearchFilter }
  | { kind: "geo"; title: string; target: "area" | "bbox" };

/** An area's extent as one chip's text. */
function areaText(area: Area): string {
  const { latitude, longitude } = formatArea(area);
  return `${latitude}, ${longitude}`;
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
  const has = useMemo(() => search.has ?? [], [search.has]);
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

  // The scope filters, on every level, its count and every view (URL
  // `mine` / `versions`). "My contributions" needs a login: signed out, a
  // `mine` left in the URL is dropped (the API refuses it anonymously). It is
  // offered once the user has a contribution here (the private workspace's
  // list, whose cache it shares); one chosen stays shown so it can be cleared.
  const sourceMode = isSourceMode(config);
  const myContributions = useQuery({
    queryKey: ["private", "contributions"],
    queryFn: () => api<ContributionOut[]>("/private/contributions"),
    enabled: !!user && !!config && !sourceMode,
  });
  const mine = user ? search.mine : undefined;
  const versions = search.versions;
  const scope = useMemo<SearchScope>(() => ({ mine, versions }), [mine, versions]);
  const showMine = !!user && !sourceMode && ((myContributions.data?.length ?? 0) > 0 || !!mine);
  // An unpublished one of the user's opens in the modal by its private key.
  const ownKey = (id: number | undefined) =>
    myContributions.data?.find((c) => c.id === id)?.private_key;

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
    has?: string[];
    bbox?: string | undefined;
    area?: string | undefined;
    mine?: SearchScope["mine"];
    versions?: SearchScope["versions"];
  }) => {
    const filter = next.filter ?? gridFilterList;
    navigate({
      search: {
        q: next.q !== undefined ? next.q || undefined : q || undefined,
        level: next.level ?? search.level,
        sort: "sort" in next ? next.sort : search.sort,
        ranges: (next.ranges ?? ranges).length > 0 ? (next.ranges ?? ranges) : undefined,
        filter: filter.length > 0 ? filter : undefined,
        has: (next.has ?? has).length > 0 ? (next.has ?? has) : undefined,
        bbox: "bbox" in next ? next.bbox || undefined : bbox,
        area: "area" in next ? next.area || undefined : search.area,
        mine: "mine" in next ? next.mine : search.mine,
        versions: "versions" in next ? next.versions : search.versions,
      },
    });
  };
  // A contribution's modal, over the search (?contribution=<id>&tab=...).
  const openContribution = useOpenContribution();
  const setModalTab = useCallback(
    (tab: string) =>
      navigate({
        search: (prev) => ({ ...prev, tab, row: undefined, plot: undefined }),
        replace: true,
      }),
    [navigate],
  );
  // The row selected in the modal's level tab; replacing the entry drops the
  // Rows grid's row to find (the history state) once it is found.
  const setModalRow = useCallback(
    (row: number | undefined) => navigate({ search: (prev) => ({ ...prev, row }), replace: true }),
    [navigate],
  );
  // The plot selected in a plot tab of the modal.
  const setModalPlot = useCallback(
    (plot: string | undefined) =>
      navigate({ search: (prev) => ({ ...prev, plot }), replace: true }),
    [navigate],
  );
  const rowMatch = useRouterState({ select: (state) => state.location.state.rowMatch });
  const closeModal = useCallback(
    () =>
      navigate({
        search: (prev) => ({
          ...prev,
          contribution: undefined,
          tab: undefined,
          row: undefined,
          plot: undefined,
          private_key: undefined,
        }),
      }),
    [navigate],
  );
  // The Rows grid's row last opened, highlighted (a new search replaces the rows).
  const [openedRow, setOpenedRow] = useState<string>();
  // The geospatial filter (the Map tab's area, the sidebar's Geospatial
  // checkbox) narrows every level with positions, and each level tab's count;
  // it stays across level tabs. An area asked for is made by the Map tab.
  const area = parseArea(search.area);
  const areaBbox = (entry: SearchLevel | undefined) =>
    area && entry?.geo ? areaToBbox(area) : undefined;
  const [areaRequest, setAreaRequest] = useState<AreaRequest | null>(null);
  const [filterModal, setFilterModal] = useState<FilterModalState | null>(null);
  const setArea = (next: Area | null) => {
    setAreaRequest(null);
    setSearch({ area: next?.join(",") });
  };

  // The with/without data entries a level's search applies on a view: those
  // on the tables its records cover, while an `exists` filter shows there.
  const hasAt = (entry: SearchLevel | undefined, viewName: string | undefined) =>
    entry && applicableFilters(config, entry.name, viewName).some((f) => f.type === "exists")
      ? hasFor(has, config?.exists_tables?.[entry.table])
      : [];

  // Live totals for every level tab (size=1: the API requires size >= 1). The
  // open level's also follows its ranges (as its Summaries view applies them,
  // whichever view is open); a level tab clears them. Every level's follows
  // the with/without data entries on its tables, which a level tab keeps.
  const levelRanges = rangesFor(ranges, applicableFilters(config, level?.name, "Summaries"));
  const countQueries = useQueries({
    queries: levels.map((entry) => {
      const entryRanges = entry.name === level?.name ? levelRanges : undefined;
      const entryHas = hasAt(entry, "Summaries");
      return {
        queryKey: ["search-count", entry.table, q, areaBbox(entry), entryRanges, entryHas, scope],
        queryFn: () =>
          api<SearchPageData>(`/search/${entry.table}`, {
            params: {
              ...searchRequestParams(
                q,
                1,
                0,
                false,
                entryRanges,
                areaBbox(entry),
                undefined,
                undefined,
                entryHas,
              ),
              ...scope,
            },
          }),
        staleTime: 60_000,
        placeholderData: keepPreviousData,
      };
    }),
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
  // sub-tabs never changes the level tabs' counts. Its docs are what the
  // filter modals count while that view is open.
  const countedTabs = subTabs.filter((tab) => tab.countTable);
  const pluginParams = (table: string, query: string, rangeList: string[]) => ({
    ...searchRequestParams(
      query,
      1,
      0,
      false,
      rangeList.filter((r) => r.startsWith(`summary.${table}.`)),
      bbox,
    ),
    ...scope,
  });
  const pluginCounts = useQueries({
    queries: countedTabs.map(({ countTable = "" }) => {
      const params = pluginParams(countTable, q, ranges);
      return {
        queryKey: ["search-count", countTable, params],
        queryFn: () => api<SearchPageData>(`/search/${countTable}`, { params }),
        staleTime: 60_000,
        placeholderData: keepPreviousData,
      };
    }),
  });

  // The sidebar's controls for this level + sub-tab (node YAML `search.filters`).
  // A plugin may still replace the whole panel. Range/bbox values apply to the
  // main query only when their filter is visible here; a plugin view (Poles)
  // reads them from its sub-tab context for its own fetch.
  // An `exists` filter only where the level's records cover a table.
  const existsTabs = (level && config?.exists_tables?.[level.table]) || [];
  const filters: SearchFilter[] = applicableFilters(config, level?.name, activeTab?.name).filter(
    (filter) => filter.type !== "exists" || existsTabs.length > 0,
  );
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
  // Plugin filters after the node's own (the KdD periodic table); their
  // query tokens clear with the sidebar's facets.
  const pluginFilters = pluginSidebarFilters(config, level?.name, activeTab?.name);
  const facetFields = [
    ...filters.filter((f) => f.type === "facet").map((f) => f.field ?? ""),
    ...pluginFilters.flatMap((filter) => filter.fields),
  ];
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
  const activeHas = hasAt(level, activeTab?.name);
  const queryHas = activeTab?.render ? undefined : activeHas;
  const dataModel = useLatestDataModel();
  // A picked number column as a range filter (its label and unit).
  const numberFilter = useNumberFilter(level?.table ?? "");

  // The grids are sized to every match (up to MAX_RESULTS) and fetch the
  // pages under their visible rows; page 0 carries the totals. Facet values
  // are counted by their modal when it opens.
  const searchKey = [
    "search",
    level?.table,
    q,
    sort,
    queryRanges,
    queryBbox,
    gridFilterList,
    queryHas,
    scope,
  ];
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
            false,
            queryRanges,
            queryBbox,
            sort,
            gridFilterList,
            queryHas,
          ),
          ...scope,
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
  // A facet modal's counts follow the sub-tab: records (Summaries), their
  // rows, those on the map, or a plugin view's own docs.
  const pluginTable = activeTab?.countTable;
  const bucketCount =
    pluginTable === undefined && activeTab?.name === "Rows"
      ? (bucket: FacetBucket) => bucket.rows_count
      : pluginTable === undefined && activeTab?.name === "Map"
        ? (bucket: FacetBucket) => bucket.mapped_count
        : undefined;
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
      has: has.filter((entry) => !activeHas.includes(entry)),
      bbox: activeBbox ? undefined : bbox,
      area: undefined,
      mine: undefined,
      versions: undefined,
    });
  };
  const clearActive =
    hasFacetFilters ||
    activeRanges.length > 0 ||
    activeHas.length > 0 ||
    !!activeBbox ||
    !!area ||
    gridFilterList.length > 0 ||
    !!scope.mine ||
    !!scope.versions;

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

  // A column header's filter icon opens its modal: its facet lists (the
  // sidebar's, sharing their tokens and labels) and/or a text box, or on the
  // map tile the area.
  const facetLabel = (field: string) =>
    config.filters?.find((f) => f.type === "facet" && f.field === field)?.label ??
    facetTitle(field);
  const queryTokens = parseQueryTokens(q).tokens;
  const columnFilterMenu = (column: GridColumn) => {
    const geospatial = column.geospatial && !!level.geo;
    if (column.facets.length === 0 && !column.filterable && !geospatial) return null;
    const text = column.filterable ? (gridFilters[column.key] ?? "") : "";
    const active =
      queryTokens.filter(([field]) => column.facets.includes(field)).length +
      (text.trim() ? 1 : 0) +
      (geospatial && area ? 1 : 0);
    const open = () =>
      setFilterModal(
        geospatial && column.facets.length === 0 && !column.filterable
          ? { kind: "geo", title: column.label, target: "area" }
          : {
              kind: "facet",
              title: column.label,
              facets: column.facets.map((field) => ({ field, label: facetLabel(field) })),
              column,
            },
      );
    return <ColumnFilterButton label={column.label} active={active} onOpen={open} />;
  };

  // The search's request params for a filter modal's counts: a plugin view's
  // own docs, or the level's records (with the grid's column filters).
  const levelParams = (query: string, rangeList: string[], hasList = activeHas) => ({
    ...searchRequestParams(
      query,
      1,
      0,
      false,
      activeTab?.render ? undefined : rangesFor(rangeList, filters),
      queryBbox,
      undefined,
      gridFilterList,
      activeTab?.render ? undefined : hasList,
    ),
    ...scope,
  });
  const modalParams = (query: string, rangeList: string[]) =>
    pluginTable ? pluginParams(pluginTable, query, rangeList) : levelParams(query, rangeList);
  // A range filter's docs: a plugin view's block (summary.<table>.*), else the level's.
  const rangeTable = (filter: SearchFilter) => {
    const block = (filter.field ?? "").split(".")[1];
    return countedTabs.some((tab) => tab.countTable === block) ? block : level.table;
  };

  // The sidebar: each filter with its applied values as chips.
  const chipsFor = (filter: SearchFilter): FilterChip[] => {
    if (filter.type === "facet") {
      const field = filter.field ?? "";
      return queryTokens
        .filter(([f]) => f === field)
        .map(([, value]) => ({
          key: value,
          label: value,
          onRemove: () => setSearch({ q: toggleQueryToken(q, field, value) }),
        }));
    }
    const removeRange = (field: string) => () =>
      setSearch({ ranges: ranges.filter((r) => parseRange(r).field !== field) });
    if (filter.type === "range") {
      const entry = ranges.map(parseRange).find((r) => r.field === filter.field);
      if (!entry) return [];
      const text = rangeText(filter, entry);
      return [
        {
          key: "range",
          label: text,
          title: `${filterLabel(filter)} ${text}`,
          onRemove: removeRange(entry.field),
        },
      ];
    }
    if (filter.type === "numeric") {
      // Each picked column's range, named.
      return pickedRanges(ranges, filters).map((spec) => {
        const entry = parseRange(spec);
        const picked = numberFilter(entry.field);
        const text = `${filterLabel(picked)} ${rangeText(picked, entry)}`;
        return { key: entry.field, label: text, title: text, onRemove: removeRange(entry.field) };
      });
    }
    if (filter.type === "exists") {
      return activeHas.map((entry) => {
        const text = hasText(dataModel, parseHas(entry));
        return {
          key: entry,
          label: text,
          title: text,
          onRemove: () => setSearch({ has: has.filter((e) => e !== entry) }),
        };
      });
    }
    const box = parseArea(bbox);
    return box
      ? [{ key: "bbox", label: areaText(box), onRemove: () => setSearch({ bbox: undefined }) }]
      : [];
  };
  const openFilter = (filter: SearchFilter) =>
    setFilterModal(
      filter.type === "facet"
        ? {
            kind: "facet",
            title: filterLabel(filter),
            facets: [{ field: filter.field ?? "", label: filterLabel(filter) }],
          }
        : filter.type === "range"
          ? { kind: "range", filter }
          : filter.type === "numeric"
            ? { kind: "numeric", filter }
            : filter.type === "exists"
              ? { kind: "exists", filter }
              : { kind: "geo", title: filterLabel(filter), target: "bbox" },
    );

  const renderFilterModal = () => {
    if (!filterModal) return null;
    const close = () => setFilterModal(null);
    if (filterModal.kind === "facet") {
      const { column } = filterModal;
      return (
        <FacetModal
          title={filterModal.title}
          facets={filterModal.facets}
          // A column's lists count the level's records (the Summaries grid).
          table={column ? level.table : (pluginTable ?? level.table)}
          q={q}
          paramsFor={(query) => (column ? levelParams(query, ranges) : modalParams(query, ranges))}
          count={column ? undefined : bucketCount}
          text={
            column?.filterable
              ? { label: column.label, value: gridFilters[column.key] ?? "" }
              : undefined
          }
          onApply={({ q: next, text }) => {
            close();
            setSearch({
              q: next,
              ...(column?.filterable
                ? { filter: formatGridFilters({ ...gridFilters, [column.key]: text ?? "" }) }
                : {}),
            });
          }}
          onClose={close}
        />
      );
    }
    if (filterModal.kind === "exists") {
      return (
        <ExistsModal
          title={filterLabel(filterModal.filter)}
          table={level.table}
          levelName={level.name}
          tabs={existsTabs}
          has={activeHas}
          paramsFor={(hasList) => levelParams(q, ranges, hasList)}
          onApply={(next) => {
            close();
            setSearch({ has: [...has.filter((entry) => !activeHas.includes(entry)), ...next] });
          }}
          onClose={close}
        />
      );
    }
    if (filterModal.kind === "numeric") {
      const picker = filterModal.filter;
      return (
        <NumericModal
          title={filterLabel(picker)}
          table={level.table}
          ranges={ranges}
          paramsFor={(rangeList) => levelParams(q, rangeList)}
          onPick={(filter) => setFilterModal({ kind: "range", filter, back: picker })}
          onClose={close}
        />
      );
    }
    if (filterModal.kind === "range") {
      const { filter, back } = filterModal;
      return (
        <RangeModal
          key={filter.field}
          filter={filter}
          onBack={back ? () => setFilterModal({ kind: "numeric", filter: back }) : undefined}
          table={rangeTable(filter)}
          ranges={ranges}
          paramsFor={(rangeList) =>
            rangeTable(filter) === level.table
              ? levelParams(q, rangeList)
              : pluginParams(rangeTable(filter), q, rangeList)
          }
          color={config.color}
          onApply={(next) => {
            close();
            setSearch({ ranges: next });
          }}
          onClose={close}
        />
      );
    }
    const isArea = filterModal.target === "area";
    return (
      <GeoModal
        title={filterModal.title}
        level={level}
        query={q}
        ranges={queryRanges}
        filters={gridFilterList}
        has={queryHas}
        area={isArea ? area : parseArea(bbox)}
        color={config.color}
        onApply={(next) => {
          close();
          if (isArea) setArea(next);
          else setSearch({ bbox: next ? areaToBbox(next) : undefined });
        }}
        onClose={close}
      />
    );
  };

  return (
    <div className="fiesta-search">
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
                  // The with/without data entries on tables its records cover.
                  has: hasAt(entry, "Summaries"),
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
              placeholder={config.search_placeholder}
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
          {/* Sidebar: fixed 220px (legacy 275px; the filters' controls are in modals) */}
          <div className="flex h-full flex-col" style={{ width: 220, flexShrink: 0 }}>
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
              {showMine && (
                <FilterChoices
                  label="My contributions"
                  choices={[
                    {
                      value: "in_prep",
                      label: "My in preparation",
                      title: "Only your contributions not yet published",
                    },
                    {
                      value: "published",
                      label: "My published",
                      title: "Only your published contributions",
                    },
                  ]}
                  value={mine}
                  onChange={(next) => setSearch({ mine: next })}
                />
              )}
              <FilterChoices
                label="Versions"
                choices={[
                  {
                    value: "all",
                    label: "Previous versions",
                    title: "Also show older versions of contributions",
                  },
                ]}
                value={versions}
                onChange={(next) => setSearch({ versions: next })}
              />
              {filtersPanel ?? (
                <>
                  {/* A view with its own bbox filter (Poles) shows the area only while set. */}
                  {level.geo && (area || !filters.some((f) => f.type === "bbox")) && (
                    <FilterEntry
                      label="Geospatial"
                      chips={
                        area
                          ? [{ key: "area", label: areaText(area), onRemove: () => setArea(null) }]
                          : []
                      }
                      onOpen={() =>
                        setFilterModal({ kind: "geo", title: "Geospatial", target: "area" })
                      }
                    />
                  )}
                  {filters.map((filter) => (
                    <FilterEntry
                      key={`${filter.type}-${filter.field ?? filterLabel(filter)}`}
                      label={filterLabel(filter)}
                      chips={chipsFor(filter)}
                      onOpen={() => openFilter(filter)}
                    />
                  ))}
                  {pluginFilters.map((filter) => (
                    <Fragment key={filter.key}>
                      {filter.render({
                        levelName: level.name,
                        subTabName: activeTab?.name,
                        config,
                        q,
                        setQuery: (next) => setSearch({ q: next }),
                        table: pluginTable ?? level.table,
                        paramsFor: (query) => modalParams(query, ranges),
                        count: bucketCount,
                      })}
                    </Fragment>
                  ))}
                  {filters.length === 0 && pluginFilters.length === 0 && !level.geo && (
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
                  has={queryHas}
                  scope={scope}
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
                      // Rows run edge to edge of the view, as Summaries do.
                      <div style={{ margin: "0 -1em 1em" }}>
                        <RowsGrid
                          items={rowItems}
                          columns={gridRowColumns}
                          table={level.table}
                          selected={openedRow}
                          onRowClick={(row) => {
                            const id = row.hit && contributionId(row.hit);
                            if (!id) return;
                            setOpenedRow(row.key);
                            // A level row opens its tab with the row selected.
                            openContribution(
                              id,
                              level.table,
                              level.table === "contribution" ? undefined : row.values,
                            );
                          }}
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
                          scope,
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
      {renderFilterModal()}
      {search.contribution !== undefined && (
        <ContributionModal
          id={String(search.contribution)}
          tab={search.tab}
          row={search.row}
          plot={search.plot}
          rowMatch={rowMatch}
          privateKey={search.private_key ?? privateKey ?? ownKey(search.contribution)}
          onTab={setModalTab}
          onRow={setModalRow}
          onPlot={setModalPlot}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
