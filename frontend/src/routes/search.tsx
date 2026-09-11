import { keepPreviousData, useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorMessage } from "../components/error-message";
import { contributionId, ResultDivider, ResultItem } from "../components/result-item";
import { buttonIconStyle, SemanticIcon } from "../components/ui/fa-icon";
import { Icon } from "../components/ui/icon";
import { PageSpinner, Spinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import type {
  FacetBucket,
  SearchLevel,
  SearchPage as SearchPageData,
  SearchResult,
} from "../lib/types";
import {
  abbreviateNumber,
  cx,
  facetTitle,
  formatNumber,
  getQueryToken,
  parseQueryTokens,
  titleCase,
  toggleQueryToken,
} from "../lib/utils";
import {
  type PluginSubTabContext,
  pluginFiltersPanel,
  pluginResultItem,
  pluginSubTabs,
} from "../plugins";

const PAGE_SIZE = 10;
const routeApi = getRouteApi("/search");
const TAB_BORDER = "#d4d4d5";
/** Legacy `styles.activeTab` on the level tabs and the Filters tab. */
const ACTIVE_TAB_BG = "#F0F0F0";
const SEGMENT_BORDER = "rgba(34,36,38,.15)";
const SEGMENT_BG = "#F0F0F0";
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
function tabItemStyle(active: boolean, small = false, activeBg = "#fff"): CSSProperties {
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
    color: active ? "rgba(0,0,0,.95)" : "var(--node-color)",
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
      className="inline-block rounded-full border bg-white text-center font-bold"
      style={{
        color: "#0C0C0C",
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
    active ? "bg-node font-bold text-white hover:bg-node-dark" : "cursor-default bg-white",
  );
}
function compactButtonStyle(active: boolean): CSSProperties {
  return {
    fontSize: "0.92857143rem",
    lineHeight: "1em",
    padding: "0.5em",
    margin: "-0.5em 0",
    ...(active ? {} : { ...basicButtonStyle("rgba(0,0,0,.6)"), opacity: 0.45 }),
    ...(active ? {} : { boxShadow: "0 0 0 1px rgba(34,36,38,.15) inset" }),
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
) {
  return {
    query: query || undefined,
    size,
    from: from || undefined,
    facets: facets || undefined,
    range: ranges && ranges.length > 0 ? ranges : undefined,
    bbox: bbox || undefined,
    sort,
  };
}

// --- Facet accordion section (legacy SearchFiltersBuckets) -----------------------

function FilterRow({
  bucket,
  active,
  highlight,
  onToggle,
}: {
  bucket: FacetBucket;
  active: boolean;
  highlight?: string;
  onToggle: () => void;
}) {
  const label = bucket.key;
  const at = highlight ? label.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  return (
    <label className="flex cursor-pointer" style={{ marginBottom: "0.25em" }}>
      <span className="flex shrink-0 items-start" style={{ minWidth: 22, maxWidth: 22 }}>
        <input
          type="checkbox"
          checked={active}
          onChange={onToggle}
          className="mt-[1px] h-[17px] w-[17px] cursor-pointer rounded-sm border-gray-300 accent-node"
        />
      </span>
      <span
        className={cx("min-w-0 grow whitespace-normal break-words", active && "font-bold")}
        style={{ marginRight: "0.5em" }}
      >
        {at >= 0 && highlight ? (
          <>
            {label.slice(0, at)}
            <mark className="bg-yellow-200">{label.slice(at, at + highlight.length)}</mark>
            {label.slice(at + highlight.length)}
          </>
        ) : (
          label
        )}
      </span>
      <span
        className="inline-block shrink-0 self-start rounded-full border bg-white text-center font-bold"
        style={{
          borderColor: SEGMENT_BORDER,
          color: "rgba(0,0,0,.87)",
          fontSize: 11,
          lineHeight: "0.7em",
          padding: "0.5em",
          minWidth: "2em",
          minHeight: "2em",
        }}
      >
        {abbreviateNumber(bucket.doc_count)}
      </span>
    </label>
  );
}

function FacetSection({
  facet,
  buckets,
  loading,
  q,
  onToggle,
}: {
  facet: string;
  buckets: FacetBucket[];
  loading: boolean;
  q: string;
  onToggle: (facet: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const title = facetTitle(facet);
  const itemsName = titleCase(facet);

  // Active values may come from another level and no longer be in the
  // buckets: the legacy component prepends them with a zero count.
  const activeKeys = parseQueryTokens(q)
    .tokens.filter(([field]) => field === facet)
    .map(([, value]) => value);
  const activeSet = new Set(activeKeys);
  const active = activeKeys.map(
    (key) => buckets.find((bucket) => bucket.key === key) ?? { key, doc_count: 0 },
  );
  const needle = find.trim().toLowerCase();
  const matched = needle
    ? buckets.filter(
        (bucket) => !activeSet.has(bucket.key) && bucket.key.toLowerCase().includes(needle),
      )
    : [];
  const matchedSet = new Set(matched.map((bucket) => bucket.key));
  const inactive = buckets.filter(
    (bucket) => !activeSet.has(bucket.key) && !matchedSet.has(bucket.key),
  );

  return (
    <div
      className="text-[13px]"
      style={{
        padding: "0.25em 1em 0.5em",
        borderBottom: "1px solid #D4D4D5",
        color: "rgba(0,0,0,.87)",
      }}
    >
      {/* Title: caret + bold name, then the active filters (always visible) */}
      <div style={{ padding: "0.5em 0 0", lineHeight: "1.4285em" }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          style={{ marginBottom: "0.25em" }}
        >
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center"
            style={{ width: "1.25em", height: "1.25em", marginRight: "0.25rem" }}
          >
            <Icon
              name="caret-right"
              className={cx("transition-transform", open && "rotate-90")}
              style={{ width: "1.15em", height: "1.15em" }}
            />
          </span>
          <span className="grow whitespace-normal font-bold" style={{ marginRight: "0.5em" }}>
            {title}
          </span>
        </button>
        {active.map((bucket) => (
          <FilterRow
            key={bucket.key}
            bucket={bucket}
            active
            onToggle={() => onToggle(facet, bucket.key)}
          />
        ))}
      </div>
      {open && (
        <div style={{ paddingTop: 0 }}>
          <input
            type="text"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder={`Find ${itemsName}`}
            aria-label={`Find ${itemsName}`}
            className="w-full rounded-sm border border-gray-300 bg-white px-[0.8em] py-[0.5em] text-[13px] placeholder:text-[#AAAAAA] focus:border-node focus:outline-hidden"
            style={{ marginBottom: "0.25em" }}
          />
          {needle && matched.length === 0 && (
            <div className="text-center">
              <b>No Matches</b>
            </div>
          )}
          {matched.map((bucket) => (
            <FilterRow
              key={bucket.key}
              bucket={bucket}
              active={false}
              highlight={find.trim()}
              onToggle={() => onToggle(facet, bucket.key)}
            />
          ))}
          <hr
            style={{
              margin: "1em 0",
              border: 0,
              borderTop: `1px solid ${SEGMENT_BORDER}`,
              borderBottom: "1px solid rgba(255,255,255,.1)",
            }}
          />
          {loading && (
            <div className="text-center">
              <Spinner /> Loading ...
            </div>
          )}
          {!loading && inactive.length === 0 && (
            <div className="text-center">
              <b>No {itemsName}</b>
            </div>
          )}
          {inactive.map((bucket) => (
            <FilterRow
              key={bucket.key}
              bucket={bucket}
              active={false}
              onToggle={() => onToggle(facet, bucket.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Rows view ----------------------------------------------------------------

function RowsView({ results }: { results: SearchResult[] }) {
  const rows = useMemo(
    () => results.flatMap((hit) => (Array.isArray(hit.rows) ? (hit.rows as unknown[]) : [])),
    [results],
  );
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows.slice(0, 50)) {
      if (row && typeof row === "object") {
        for (const key of Object.keys(row as object)) keys.add(key);
      }
    }
    return [...keys];
  }, [rows]);

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-gray-500">No row data for these results.</p>
    );
  }

  return (
    <Table>
      <THead>
        <Tr>
          {columns.map((column) => (
            <Th key={column}>{column}</Th>
          ))}
        </Tr>
      </THead>
      <TBody>
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: raw OpenSearch rows have no stable id; the list is replaced wholesale per query
          <Tr key={`row-${index}-${columns.length}`}>
            {columns.map((column) => {
              const value = (row as Record<string, unknown>)[column];
              return (
                <Td key={column} className="whitespace-nowrap">
                  {value === undefined || value === null
                    ? ""
                    : typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                </Td>
              );
            })}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

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
          background: "#fffaf3",
          color: "#573a08",
          boxShadow: "0 0 0 1px #c9ba9b inset",
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
  const hasFacetFilters =
    parseQueryTokens(q).tokens.filter(([field]) => config?.facets.includes(field)).length > 0;
  // Legacy `sortDefault`: relevance whenever there is free text and the user
  // has not picked a sort, otherwise newest first.
  const sort = search.sort ?? (hasFreeText ? RELEVANCE_OPTION.value : SORT_OPTIONS[0].value);

  const [input, setInput] = useState(q);
  const [view, setView] = useState("Summaries");
  useEffect(() => setInput(q), [q]);

  // Independent scroll regions: compute the available height so the page body
  // does not scroll (legacy onWindowResize; footer ≈ 60px).
  const regionRef = useRef<HTMLDivElement>(null);
  const [regionHeight, setRegionHeight] = useState<number>();
  useEffect(() => {
    const update = () => {
      if (!regionRef.current) return;
      const top = regionRef.current.getBoundingClientRect().top;
      setRegionHeight(Math.max(300, window.innerHeight - top - 79));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const setSearch = (next: {
    q?: string;
    level?: string;
    sort?: string;
    ranges?: string[];
    bbox?: string | undefined;
  }) => {
    navigate({
      search: {
        q: next.q !== undefined ? next.q || undefined : q || undefined,
        level: next.level ?? search.level,
        sort: next.sort ?? search.sort,
        ranges: (next.ranges ?? ranges).length > 0 ? (next.ranges ?? ranges) : undefined,
        bbox: "bbox" in next ? next.bbox || undefined : bbox,
      },
    });
  };

  // Live totals for every level tab (size=1: the API requires size >= 1).
  const countQueries = useQueries({
    queries: levels.map((entry) => ({
      queryKey: ["search-count", entry.table, q],
      queryFn: () =>
        api<SearchPageData>(`/api/search/${entry.table}`, {
          params: searchRequestParams(q, 1),
        }),
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    })),
  });

  // Result sub-tabs: Summaries, Rows (non-contribution), then plugin tabs. The
  // chosen view persists across levels and falls back to the first tab when a
  // level lacks it (legacy `state.view`).
  type SubTab = { name: string; render?: (ctx: PluginSubTabContext) => ReactNode };
  const subTabs = useMemo<SubTab[]>(() => {
    if (!config || !level) return [];
    const tabs: SubTab[] = [{ name: "Summaries" }];
    if (level.table !== "contribution") tabs.push({ name: "Rows" });
    return [...tabs, ...pluginSubTabs(config, level)];
  }, [config, level]);
  const activeTab = subTabs.find((tab) => tab.name === view) ?? subTabs[0];

  // Plugin filters panel (e.g. poles ranges/bbox) — shown when a plugin claims
  // the active level + sub-tab. Its ranges/bbox filter that plugin's own fetch,
  // not the main level query.
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
  const pluginFiltersActive = ranges.length > 0 || !!bbox;

  const results = useInfiniteQuery({
    queryKey: ["search", level?.table, q, sort],
    queryFn: ({ pageParam }) =>
      api<SearchPageData>(`/api/search/${level?.table}`, {
        params: searchRequestParams(q, PAGE_SIZE, pageParam, true, undefined, undefined, sort),
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((total, page) => total + page.results.length, 0);
      return loaded < lastPage.total && lastPage.results.length > 0 ? loaded : undefined;
    },
    enabled: !!level,
    placeholderData: keepPreviousData,
  });

  const hits = useMemo(
    () => results.data?.pages.flatMap((page) => page.results) ?? [],
    [results.data],
  );
  const total = results.data?.pages[0]?.total ?? 0;
  const aggregations = results.data?.pages[0]?.aggregations ?? null;
  const topContributionId =
    level?.table === "contribution" ? contributionId(hits[0] ?? {}) : undefined;

  // Infinite scroll (legacy InfiniteScroller): load the next page when the
  // sentinel at the end of the list scrolls within 50px of the view. The
  // observer is re-armed after every page so a still-visible sentinel keeps
  // loading until the view is full.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results;
  const autoLoad = !activeTab?.render;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hits.length re-arms the observer after each page loads
  useEffect(() => {
    const root = scrollerRef.current;
    const target = sentinelRef.current;
    if (!root || !target || !autoLoad || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) fetchNextPage();
      },
      { root, rootMargin: "0px 0px 50px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [autoLoad, hasNextPage, isFetchingNextPage, fetchNextPage, hits.length]);

  const clearFilters = () => {
    if (filtersPanel) {
      setSearch({ ranges: [], bbox: undefined });
      return;
    }
    const { tokens, freeText } = parseQueryTokens(q);
    const kept = tokens.filter(([field]) => !config?.facets.includes(field));
    setSearch({
      q: [freeText, ...kept.map(([f, v]) => `${f}:"${v}"`)].filter(Boolean).join(" "),
    });
  };
  const clearActive = filtersPanel ? pluginFiltersActive : hasFacetFilters;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSearch({ q: input.trim() });
  };

  if (!config || !level) return <PageSpinner />;

  const renderHit = (doc: SearchResult) =>
    pluginResultItem(config, { hit: doc, level, config, privateKey }) ?? (
      <ResultItem doc={doc} level={level} privateKey={privateKey} />
    );

  const sortOptions = hasFreeText ? [RELEVANCE_OPTION, ...SORT_OPTIONS] : SORT_OPTIONS;

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
              onClick={() => setSearch({ level: entry.name, ranges: [], bbox: undefined })}
              className={cx(
                "flex items-center focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                !active && "cursor-pointer hover:text-node-dark",
              )}
              style={tabItemStyle(active, false, ACTIVE_TAB_BG)}
            >
              {entry.name}
              <CountLabel>{count === undefined ? "…" : formatNumber(count)}</CountLabel>
            </button>
          );
        })}
        {user && (
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
          color: "rgba(0,0,0,.6)",
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
              className="min-w-0 bg-white placeholder:text-[#AAAAAA] focus:outline-hidden"
              style={{
                fontSize: "1rem",
                lineHeight: "1.21428571em",
                padding: "0.67857143em 1em",
                border: "1px solid #888888",
                borderLeft: "none",
                borderRight: "none",
                flex: 1,
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() && !q}
              className="flex items-center whitespace-nowrap bg-white disabled:cursor-default disabled:opacity-45"
              style={{
                ...basicButtonStyle("#1b1c1d"),
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
              className="flex items-center whitespace-nowrap bg-white disabled:cursor-default disabled:opacity-45"
              style={{
                ...basicButtonStyle("#1b1c1d"),
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
                href={siteUrl(`/api/contributions/${topContributionId}/download`)}
                download
                className="flex items-center self-start whitespace-nowrap bg-white hover:bg-node-soft"
                style={{
                  ...basicButtonStyle("var(--node-color)"),
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
                className="flex items-center self-start whitespace-nowrap bg-white"
                style={{
                  ...basicButtonStyle("var(--node-color)"),
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
            width: "calc(100% - 10px)",
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
                  {config.facets.map((facet) => (
                    <FacetSection
                      key={facet}
                      facet={facet}
                      buckets={aggregations?.[facet] ?? []}
                      loading={results.isPending}
                      q={q}
                      onToggle={(name, value) => setSearch({ q: toggleQueryToken(q, name, value) })}
                    />
                  ))}
                  {config.facets.length === 0 && (
                    <p className="px-[1em] py-3 text-[12px] text-[#AAAAAA]">
                      No filters for this repository.
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
                      !active && "cursor-pointer hover:text-node-dark",
                    )}
                    style={tabItemStyle(active, true)}
                  >
                    {tab.name}
                    {tab.name === "Summaries" && (
                      <CountLabel>{results.isPending ? "…" : formatNumber(total)}</CountLabel>
                    )}
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

            {/* View container: border-left 1px #d4d4d5, white, independent scroll */}
            <div
              ref={scrollerRef}
              className="flex-1 overflow-y-scroll bg-white"
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
                    <div style={{ margin: "1em 0" }}>
                      {hits.map((doc, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: sub-contribution hits can share a contribution id; pages are append-only
                        <div key={`${contributionId(doc) ?? "hit"}-${index}`}>
                          {renderHit(doc)}
                          {hits.length > 1 && <ResultDivider />}
                        </div>
                      ))}
                      {isFetchingNextPage && <LoadingItem divider={false} />}
                    </div>
                  )}
                  {activeTab?.name === "Rows" && <RowsView results={hits} />}
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

                  {hits.length === 0 && <NoItemsMessage />}

                  {/* Infinite-scroll sentinel; the button is the no-observer fallback */}
                  <div ref={sentinelRef} aria-hidden="true" style={{ height: 1 }} />
                  {autoLoad && hasNextPage && !isFetchingNextPage && (
                    <div className="flex justify-center pb-4">
                      <button
                        type="button"
                        onClick={() => fetchNextPage()}
                        className="rounded-sm border border-gray-300 bg-white px-3 py-2 text-[13px] font-bold text-gray-700 hover:bg-gray-50"
                      >
                        Load More (showing {hits.length} of {formatNumber(total)})
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
