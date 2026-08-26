import { keepPreviousData, useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { contributionId, ResultItem } from "../components/result-item";
import { PageSpinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
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
  formatNumber,
  getQueryToken,
  hasQueryToken,
  parseQueryTokens,
  titleCase,
  toggleQueryToken,
} from "../lib/utils";
import {
  type PluginSubTabContext,
  pluginFiltersOverride,
  pluginResultItem,
  pluginSubTabs,
} from "../plugins";

const PAGE_SIZE = 10;
const routeApi = getRouteApi("/search");
const TAB_BORDER = "#d4d4d5";

type SortOption = "relevance" | "recent" | "id";

function searchParams(query: string, size: number, from = 0, facets = false) {
  return {
    query: query || undefined,
    size,
    from: from || undefined,
    facets: facets || undefined,
  };
}

/** Legacy circular basic count label: white bg, 1px border, min-width 4em. */
function CountLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full border border-gray-300 bg-white text-center text-[11px] font-medium"
      style={{
        color: "#0C0C0C",
        margin: "-1em -1em -1em 0.5em",
        minWidth: "4em",
        padding: "0.5em 0.6em",
      }}
    >
      {children}
    </span>
  );
}

// --- Facet accordion section (filter block, search.jsx:662-665) -----------------

function FacetSection({
  facet,
  buckets,
  q,
  onToggle,
}: {
  facet: string;
  buckets: FacetBucket[];
  q: string;
  onToggle: (facet: string, value: string) => void;
}) {
  const hasChecked = buckets.some((bucket) => hasQueryToken(q, facet, bucket.key));
  const [open, setOpen] = useState(hasChecked);
  const [find, setFind] = useState("");

  const visible = find
    ? buckets.filter((bucket) => bucket.key.toLowerCase().includes(find.toLowerCase()))
    : buckets;

  return (
    <div style={{ padding: "0.25em 1em 0.5em", borderBottom: `1px solid #D4D4D5` }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center text-left text-[13px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ marginBottom: "0.25em" }}
      >
        <span
          aria-hidden="true"
          className={cx("mr-1 text-[10px] text-gray-500 transition-transform", open && "rotate-90")}
        >
          ▶
        </span>
        <span className="grow whitespace-normal font-bold" style={{ marginRight: "0.5em" }}>
          {titleCase(facet)}
        </span>
        {hasChecked && <span className="h-2 w-2 rounded-full bg-node" aria-hidden="true" />}
      </button>
      {open && (
        <div style={{ padding: "0 0 0.25em" }}>
          {buckets.length > 10 && (
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              placeholder={`Find ${titleCase(facet).toLowerCase()}…`}
              aria-label={`Find ${titleCase(facet)}`}
              className="mb-1 w-full rounded-sm border border-gray-300 px-2 py-1 text-[12px] placeholder:text-[#AAAAAA] focus:border-node focus:outline-hidden"
            />
          )}
          <ul className="max-h-64 space-y-0.5 overflow-y-auto">
            {visible.map((bucket) => (
              <li key={bucket.key}>
                <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-gray-700">
                  <input
                    type="checkbox"
                    checked={hasQueryToken(q, facet, bucket.key)}
                    onChange={() => onToggle(facet, bucket.key)}
                    className="h-3.5 w-3.5 shrink-0 rounded-sm border-gray-300 accent-node"
                  />
                  <span className="min-w-0 flex-1 truncate" title={bucket.key}>
                    {bucket.key}
                  </span>
                  <span
                    className="inline-block shrink-0 rounded-full border border-gray-300 bg-white px-1.5 text-center text-[11px]"
                    style={{ color: "#0C0C0C", minWidth: "3em", lineHeight: "1.4em" }}
                  >
                    {abbreviateNumber(bucket.doc_count)}
                  </span>
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="text-[12px] text-[#AAAAAA]">No matches</li>}
          </ul>
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

// --- Search page ----------------------------------------------------------------

export function SearchPage() {
  const { data: config } = useNodeConfig();
  const { user } = useAuth();
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();

  const q = search.q ?? "";
  const sort: SortOption = (search.sort as SortOption) ?? "recent";
  const levels = config?.search_levels ?? [];
  const level: SearchLevel | undefined =
    levels.find((entry) => entry.name === search.level) ?? levels[0];
  const privateKey = getQueryToken(q, "private_key");
  const hasFreeText = parseQueryTokens(q).freeText.length > 0;
  const hasFacetFilters =
    parseQueryTokens(q).tokens.filter(([field]) => config?.facets.includes(field)).length > 0;

  const [input, setInput] = useState(q);
  const [view, setView] = useState("Summaries");
  useEffect(() => setInput(q), [q]);

  // Independent scroll regions: compute available height so the page body
  // doesn't scroll (legacy onWindowResize, search.jsx:775-793; footer ≈ 60px).
  const regionRef = useRef<HTMLDivElement>(null);
  const [regionHeight, setRegionHeight] = useState<number>();
  useEffect(() => {
    const update = () => {
      if (!regionRef.current) return;
      const top = regionRef.current.getBoundingClientRect().top;
      setRegionHeight(Math.max(300, window.innerHeight - top - 60));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const setSearch = (next: { q?: string; level?: string; sort?: string }) => {
    navigate({
      search: {
        q: next.q !== undefined ? next.q || undefined : q || undefined,
        level: next.level ?? search.level,
        sort: (next.sort ?? search.sort) === "recent" ? undefined : (next.sort ?? search.sort),
      },
    });
  };

  // Live totals for every level tab (size=1: the API requires size >= 1).
  const countQueries = useQueries({
    queries: levels.map((entry) => ({
      queryKey: ["search-count", entry.table, q],
      queryFn: () =>
        api<SearchPageData>(`/api/search/${entry.table}`, { params: searchParams(q, 1) }),
      staleTime: 60_000,
      placeholderData: keepPreviousData,
    })),
  });

  const results = useInfiniteQuery({
    queryKey: ["search", level?.table, q],
    queryFn: ({ pageParam }) =>
      api<SearchPageData>(`/api/search/${level?.table}`, {
        params: searchParams(q, PAGE_SIZE, pageParam, true),
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

  const filtersOverride = level ? pluginFiltersOverride(config, level.name) : null;
  type SubTab = { name: string; render?: (ctx: PluginSubTabContext) => ReactNode };
  const subTabs = useMemo<SubTab[]>(() => {
    if (!config || !level) return [];
    const tabs: SubTab[] = [{ name: "Summaries" }];
    if (level.table !== "contribution") tabs.push({ name: "Rows" });
    return [...tabs, ...pluginSubTabs(config, level)];
  }, [config, level]);
  const activeTab = subTabs.find((tab) => tab.name === view) ?? subTabs[0];

  const clearFilters = () => {
    const { tokens, freeText } = parseQueryTokens(q);
    const kept = tokens.filter(([field]) => !config?.facets.includes(field));
    setSearch({
      q: [freeText, ...kept.map(([f, v]) => `${f}:"${v}"`)].filter(Boolean).join(" "),
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSearch({ q: input.trim() });
  };

  if (!config || !level) return <PageSpinner />;

  const renderHit = (doc: SearchResult) =>
    pluginResultItem(config, { hit: doc, level, config, privateKey }) ?? (
      <ResultItem doc={doc} level={level} privateKey={privateKey} />
    );

  return (
    <div className="magic-search">
      {/* Level tabs: ui top attached tabular menu (1px #d4d4d5, joined below) */}
      <div
        className="flex flex-wrap items-stretch bg-white"
        style={{
          border: `1px solid ${TAB_BORDER}`,
          borderBottom: "none",
          borderTopLeftRadius: "0.28571429rem",
          borderTopRightRadius: "0.28571429rem",
        }}
      >
        {levels.map((entry, index) => {
          const active = entry.name === level.name;
          const count = countQueries[index]?.data?.total;
          return (
            <button
              key={entry.name}
              type="button"
              onClick={() => {
                setView("Summaries");
                setSearch({ level: entry.name });
              }}
              className={cx(
                "flex items-center text-[13px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                active ? "text-gray-900" : "cursor-pointer text-node",
              )}
              style={{
                padding: "0.92857143em 1.42857143em",
                ...(active
                  ? {
                      backgroundColor: "#F0F0F0",
                      borderLeft: `1px solid ${TAB_BORDER}`,
                      borderRight: `1px solid ${TAB_BORDER}`,
                      borderBottom: `1px dashed ${TAB_BORDER}`,
                      marginBottom: -1,
                    }
                  : {}),
              }}
            >
              {entry.name}
              <CountLabel>{count === undefined ? "…" : abbreviateNumber(count)}</CountLabel>
            </button>
          );
        })}
        {user && (
          <div className="ml-auto flex items-center" style={{ paddingRight: 0 }}>
            <Link
              to="/private"
              className="mr-2 inline-flex items-center whitespace-nowrap rounded-sm bg-node px-3 text-[13px] font-medium text-white hover:bg-node-dark"
              style={{ paddingTop: "0.5em", paddingBottom: "0.5em" }}
            >
              Private Workspace
            </Link>
          </div>
        )}
      </div>

      {/* Bottom attached secondary segment (light grey, padding 0) */}
      <div
        className="bg-[#f3f4f5]"
        style={{
          border: `1px solid ${TAB_BORDER}`,
          padding: 0,
          borderBottomLeftRadius: "0.28571429rem",
          borderBottomRightRadius: "0.28571429rem",
        }}
      >
        <div className="flex w-full">
          {/* Labeled fluid action input */}
          <form
            onSubmit={onSubmit}
            className="flex"
            style={{ padding: "1em", paddingBottom: 0, flex: 1 }}
          >
            <label
              htmlFor="search-input"
              className="flex items-center whitespace-nowrap rounded-l-sm bg-node px-[0.9em] text-[13px] font-bold text-white"
            >
              <span aria-hidden="true" className="mr-1">
                🔍
              </span>
              Search {config.key}
            </label>
            <input
              id="search-input"
              type="search"
              placeholder='e.g. metamorphic "field intensity" -precambrian'
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="min-w-0 bg-white px-3 py-2 text-sm placeholder:text-[#AAAAAA] focus:outline-hidden"
              style={{
                border: "1px solid #888888",
                borderLeft: "none",
                borderRight: "none",
                flex: 1,
              }}
            />
            <button
              type="submit"
              disabled={!input.trim() && !q}
              className="whitespace-nowrap border border-[#1b1c1d] bg-white px-3 py-2 text-[13px] font-bold text-[#1b1c1d] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              🔍 Search
            </button>
            <button
              type="button"
              disabled={!input && !q}
              onClick={() => {
                setInput("");
                setSearch({ q: "" });
              }}
              className="whitespace-nowrap rounded-r-sm border border-[#1b1c1d] bg-white px-3 py-2 text-[13px] font-bold text-[#1b1c1d] hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ marginLeft: -1 }}
            >
              ⊘ Clear
            </button>
          </form>
          {topContributionId ? (
            <a
              href={`/api/contributions/${topContributionId}/download${privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : ""}`}
              download
              className="self-start whitespace-nowrap rounded-sm border border-node bg-white px-3 py-2 text-[13px] font-medium text-node hover:bg-node-soft"
              style={{ margin: "1em 1em 0 0" }}
            >
              ⬇ Download Results
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
              className="self-start whitespace-nowrap rounded-sm border border-gray-300 bg-white px-3 py-2 text-[13px] font-medium text-gray-400"
              style={{ margin: "1em 1em 0 0", cursor: "not-allowed" }}
            >
              ⬇ Download Results
            </button>
          )}
        </div>

        {/* Results flex row with independent scroll regions */}
        <div
          ref={regionRef}
          className="flex"
          style={{ marginTop: "1em", height: regionHeight ?? "100%", width: "100%" }}
        >
          {/* Sidebar: fixed 275px */}
          <div className="flex h-full flex-col" style={{ width: 275, flexShrink: 0 }}>
            <div
              className="flex items-center bg-white"
              style={{
                border: `1px solid ${TAB_BORDER}`,
                borderTopLeftRadius: "0.28571429rem",
                paddingLeft: "1em",
              }}
            >
              <span
                className="text-[13px] font-medium text-gray-900"
                style={{
                  backgroundColor: "#F0F0F0",
                  padding: "0.6em 1em",
                  borderLeft: `1px solid ${TAB_BORDER}`,
                  borderRight: `1px solid ${TAB_BORDER}`,
                }}
              >
                Filters
              </span>
              <span className="ml-auto" style={{ padding: "0 1em" }}>
                <button
                  type="button"
                  onClick={clearFilters}
                  disabled={!hasFacetFilters}
                  className={cx(
                    "whitespace-nowrap rounded-sm text-[12px] font-medium",
                    hasFacetFilters
                      ? "bg-node text-white hover:bg-node-dark"
                      : "cursor-not-allowed border border-gray-300 bg-white text-gray-400",
                  )}
                  style={{ padding: "0.5em" }}
                >
                  ⊘ Clear Filters
                </button>
              </span>
            </div>
            <div
              className="flex-1 overflow-y-scroll whitespace-nowrap bg-white"
              style={{
                border: `1px solid ${TAB_BORDER}`,
                borderTop: "none",
                margin: 0,
                padding: 0,
              }}
            >
              {filtersOverride ? (
                <p className="px-[1em] py-3 text-[13px] text-gray-500">
                  Filters: {filtersOverride.join(" & ")} (coming soon)
                </p>
              ) : (
                <>
                  {config.facets.map((facet) => (
                    <FacetSection
                      key={facet}
                      facet={facet}
                      buckets={aggregations?.[facet] ?? []}
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
            {/* Sub-tab bar: ui top attached tabular small menu */}
            <div
              className="flex items-stretch bg-white"
              style={{ border: `1px solid ${TAB_BORDER}`, borderLeft: "none" }}
            >
              {subTabs.map((tab) => {
                const active = tab.name === (activeTab?.name ?? "Summaries");
                return (
                  <button
                    key={tab.name}
                    type="button"
                    onClick={() => setView(tab.name)}
                    className={cx(
                      "flex items-center text-[13px] font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
                      active ? "text-gray-900" : "cursor-pointer text-node",
                    )}
                    style={{
                      padding: "0.6em 1.2em",
                      ...(active ? { backgroundColor: "#F0F0F0" } : {}),
                    }}
                  >
                    {tab.name}
                    {tab.name === "Summaries" && <CountLabel>{abbreviateNumber(total)}</CountLabel>}
                  </button>
                );
              })}
              <span className="ml-auto flex items-center" style={{ padding: "0 1em" }}>
                <label htmlFor="sort-select" className="sr-only">
                  Sort results
                </label>
                <select
                  id="sort-select"
                  value={sort}
                  onChange={(event) => setSearch({ sort: event.target.value })}
                  className="rounded-sm border-0 bg-node text-[13px] font-medium text-white focus:outline-hidden"
                  style={{ padding: "0.5em" }}
                >
                  {hasFreeText && <option value="relevance">Most Relevant First</option>}
                  <option value="recent">Recently Contributed First</option>
                  <option value="id">Largest ID First</option>
                </select>
              </span>
            </div>

            {/* View container: border-left 1px #d4d4d5, independent scroll */}
            <div
              className="flex-1 overflow-y-scroll bg-white"
              style={{ borderLeft: `1px solid ${TAB_BORDER}`, padding: "0 1em" }}
            >
              {results.isPending && <PageSpinner label="Searching…" />}
              {results.error && <ErrorMessage error={results.error} className="my-3" />}

              {results.data && (
                <>
                  <p className="pt-2 text-[13px] text-gray-500" aria-live="polite">
                    {formatNumber(total)} {level.name.toLowerCase()} found
                    {results.isFetching && !results.isFetchingNextPage ? " (updating…)" : ""}
                  </p>

                  {activeTab?.name === "Summaries" && (
                    <div className="divide-y divide-gray-200">
                      {hits.map((doc, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: sub-contribution hits can share a contribution id; pages are append-only
                        <div key={`${contributionId(doc) ?? "hit"}-${index}`}>{renderHit(doc)}</div>
                      ))}
                    </div>
                  )}
                  {activeTab?.name === "Rows" && <RowsView results={hits} />}
                  {activeTab?.render && (
                    <div>{activeTab.render({ hits, level, config, privateKey })}</div>
                  )}

                  {hits.length === 0 && (
                    <p className="py-8 text-center text-[13px] text-gray-500">
                      No results. Try a different query or level.
                    </p>
                  )}

                  {results.hasNextPage && (
                    <div className="flex justify-center py-4">
                      <button
                        type="button"
                        disabled={results.isFetchingNextPage}
                        onClick={() => results.fetchNextPage()}
                        className="rounded-sm border border-gray-300 bg-white px-3 py-2 text-[13px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {results.isFetchingNextPage
                          ? "Loading…"
                          : `Load More (showing ${hits.length} of ${formatNumber(total)})`}
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
