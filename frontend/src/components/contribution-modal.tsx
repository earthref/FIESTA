import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { nodeUrl, siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { useOpenContribution } from "../lib/contribution-modal";
import type { NodeConfig, SearchLevel, SearchPage, SearchResult } from "../lib/types";
import { cx, formatNumber, getPath, singularize } from "../lib/utils";
import { type ContributionTab, pluginContributionTabs, type TabCountQuery } from "../plugins";
import { ErrorMessage } from "./error-message";
import { type ApiMapPoint, type MapPoint, toMapPoint } from "./map/map-points";
import { citationOf, DefinitionTable, firstString, formatDateLL } from "./result-item";
import { RowsTable } from "./rows-table";
import { Icon } from "./ui/icon";
import { PageSpinner, Spinner } from "./ui/spinner";

// MapLibre (~1 MB) loads with the first map, as on the search page's Map tab.
const MapLibreMap = lazy(() => import("./map/maplibre-map"));

/** Rows per page in a level tab; more load on demand. */
const PAGE_SIZE = 100;

type Tab = {
  key: string;
  label: string;
  group: "levels" | "assets";
  count?: number;
  isLoading?: boolean;
  render: () => ReactNode;
};

/** The params that scope a search to this contribution (see docs/api.md). */
function scope(id: string, privateKey?: string) {
  return { contribution: id, private_key: privateKey || undefined };
}

function totalOf(page: SearchPage | undefined): number | undefined {
  return page?.total;
}

/**
 * One modal for everything about a contribution (ported in spirit from the
 * osu-mgr.org record modal): a header with its citation, link, download and
 * close; tabs down the left with counts, for the contribution itself (its
 * reference, links and revision history), each search level's rows in it, and
 * its assets (the Map, then plugin plots); the chosen tab's panel on the
 * right. Opened by `?contribution=<id>` on the search page (and /<id>).
 */
export function ContributionModal({
  id,
  tab,
  privateKey,
  onTab,
  onClose,
}: {
  id: string;
  tab?: string;
  privateKey?: string;
  onTab: (tab: string) => void;
  onClose: () => void;
}) {
  const { data: config } = useNodeConfig();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // The page behind stays put while the modal scrolls.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  const docQuery = useQuery({
    queryKey: ["contribution", id, privateKey],
    queryFn: () =>
      api<SearchResult>(`/contributions/${id}`, {
        params: { private_key: privateKey || undefined },
      }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-8">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-gray-900/40 backdrop-blur-sm"
      />
      <dialog
        open
        aria-modal="true"
        aria-label={`Contribution ${id}`}
        className="relative m-0 flex h-[calc(100vh-1rem)] w-full max-w-7xl flex-col overflow-hidden rounded-lg border-0 bg-white p-0 text-left shadow-2xl sm:h-[calc(100vh-4rem)]"
      >
        {config && docQuery.data ? (
          <ModalBody
            id={id}
            doc={docQuery.data}
            config={config}
            tab={tab}
            privateKey={privateKey}
            onTab={onTab}
            onClose={onClose}
          />
        ) : (
          <>
            <ModalHeader id={id} config={config} onClose={onClose} />
            <div className="flex flex-1 items-center justify-center p-6">
              {docQuery.error ? (
                <ErrorMessage error={docQuery.error} />
              ) : (
                <PageSpinner label={`Loading contribution ${id}…`} />
              )}
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

function ModalHeader({
  id,
  config,
  doc,
  privateKey,
  onClose,
}: {
  id: string;
  config?: NodeConfig;
  doc?: SearchResult;
  privateKey?: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const version = doc ? getPath(doc, "summary.contribution.version") : undefined;
  const citation = doc ? citationOf(doc) : undefined;
  const title = doc
    ? firstString(getPath(doc, "summary.contribution._reference.title"))
    : undefined;
  const keyQuery = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
  const copyLink = () => {
    const url = `${window.location.origin}${siteUrl(`/${id}`)}${keyQuery}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const button =
    "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-[13px] font-bold focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node";
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-gray-200 px-4 py-3 sm:px-6 sm:py-4">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-xl font-bold text-node">
          {config?.key} Contribution {id}
          {version !== undefined && version !== null && (
            <span className="ml-2 align-middle text-[13px] font-normal text-gray-500">
              v. {String(version)}
            </span>
          )}
        </h2>
        {(citation || title) && (
          <p className="m-0 mt-1 truncate text-[13px] text-gray-700">
            {citation && <b>{citation}</b>}
            {citation && title && " — "}
            {title}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={copyLink}
          title="Copy a link to this contribution"
          className={cx(button, "text-gray-500 hover:bg-gray-100")}
        >
          <Icon name={copied ? "check" : "share"} className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy Link"}
        </button>
        {doc && (
          <a
            href={nodeUrl(`/contributions/${id}/download${keyQuery}`)}
            download
            className={cx(button, "bg-node text-white hover:bg-node-dark")}
          >
            <Icon name="download" className="h-3.5 w-3.5" />
            Download
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ModalBody({
  id,
  doc,
  config,
  tab,
  privateKey,
  onTab,
  onClose,
}: {
  id: string;
  doc: SearchResult;
  config: NodeConfig;
  tab?: string;
  privateKey?: string;
  onTab: (tab: string) => void;
  onClose: () => void;
}) {
  const levels = config.search_levels.filter((level) => level.table !== "contribution");
  const plugins = pluginContributionTabs(config);
  // Every table counted (the levels', and plugin tabs' countTable), once each.
  const countTables = [
    ...new Set([...levels.map((l) => l.table), ...plugins.flatMap((t) => t.countTable ?? [])]),
  ];
  const countQueries = useQueries({
    queries: countTables.map((table) => ({
      queryKey: ["contribution-count", id, table, privateKey],
      queryFn: () =>
        api<SearchPage>(`/search/${table}`, { params: { ...scope(id, privateKey), size: 1 } }),
      staleTime: 60_000,
    })),
  });
  const countOf = (table: string) => {
    const query = countQueries[countTables.indexOf(table)];
    return { count: totalOf(query?.data), isLoading: query?.isPending ?? false };
  };
  // Plugin tabs counted by a query of their own.
  const queried = plugins.flatMap((tab) => (tab.countQuery ? [tab] : []));
  const queriedCounts = useQueries({
    queries: queried.map((tab) => ({
      ...(tab.countQuery?.(id, privateKey) as TabCountQuery),
      staleTime: 60_000,
    })),
  });
  const queriedCountOf = (tab: ContributionTab) => {
    const query = queriedCounts[queried.indexOf(tab)];
    return { count: query?.data as number | undefined, isLoading: query?.isPending ?? false };
  };

  // The Map tab plots the levels with positions that have rows here.
  const geoLevels = levels.filter((level) => level.geo);
  const pointQueries = useQueries({
    queries: geoLevels.map((level) => ({
      queryKey: ["contribution-points", id, level.table, privateKey],
      queryFn: () =>
        api<{ points: ApiMapPoint[] }>(`/search/${level.table}/points`, {
          params: scope(id, privateKey),
        }),
      enabled: (countOf(level.table).count ?? 0) > 0,
      staleTime: 60_000,
    })),
  });
  const mapLayers = geoLevels
    .map((level, index) => ({
      level,
      points: (pointQueries[index].data?.points ?? []).flatMap(
        (p) => toMapPoint(p, singularize(level.name), config.color) ?? [],
      ),
    }))
    .filter((layer) => layer.points.length > 0);
  // The map opens on the level with the most records (the first of equals).
  const mapDefault = mapLayers.reduce<(typeof mapLayers)[number] | undefined>(
    (best, layer) => (!best || layer.points.length > best.points.length ? layer : best),
    undefined,
  );
  const mapLoading = geoLevels.some(
    (level, index) =>
      countOf(level.table).isLoading ||
      ((countOf(level.table).count ?? 0) > 0 && pointQueries[index].isPending),
  );

  const ctx = { id, privateKey, config, doc };
  const tabs: Tab[] = [
    {
      key: "contribution",
      label: "Contribution",
      group: "levels",
      render: () => <ContributionPanel {...ctx} />,
    },
  ];
  // Tabs with nothing in them are hidden; one whose count is still loading
  // shows a spinner until it is known.
  const pushIfAny = (next: Tab) => {
    if (next.isLoading || next.count === undefined || next.count > 0) tabs.push(next);
  };
  for (const level of levels) {
    const { count, isLoading } = countOf(level.table);
    pushIfAny({
      key: level.table,
      label: level.name,
      group: "levels",
      count: count ?? 0,
      isLoading,
      render: () => <LevelPanel level={level} id={id} privateKey={privateKey} />,
    });
  }
  pushIfAny({
    key: "map",
    label: "Map",
    group: "assets",
    count: mapDefault?.points.length ?? 0,
    isLoading: mapLoading,
    render: () => <MapPanel layers={mapLayers} initial={mapDefault?.level.table} />,
  });
  for (const plugin of plugins) {
    const counted = plugin.countTable
      ? countOf(plugin.countTable)
      : plugin.countQuery
        ? queriedCountOf(plugin)
        : undefined;
    pushIfAny({
      key: plugin.key,
      label: plugin.label,
      group: "assets",
      count: counted ? (counted.count ?? 0) : undefined,
      isLoading: counted?.isLoading,
      render: () => plugin.render(ctx),
    });
  }
  const current = tabs.find((entry) => entry.key === tab) ?? tabs[0];

  return (
    <>
      <ModalHeader id={id} config={config} doc={doc} privateKey={privateKey} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <TabList tabs={tabs} current={current} onSelect={onTab} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{current.render()}</div>
      </div>
    </>
  );
}

// --- Tabs down the left (a select on narrow screens) -----------------------------------

function TabCount({ tab, active }: { tab: Tab; active: boolean }) {
  if (tab.count === undefined && !tab.isLoading) return null;
  return (
    <span
      className={cx(
        "inline-flex min-w-[2em] items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-[18px]",
        active ? "bg-node text-white" : "border border-gray-300 text-gray-600",
      )}
    >
      {tab.isLoading ? <Spinner className="h-3 w-3" /> : formatNumber(tab.count)}
    </span>
  );
}

function TabList({
  tabs,
  current,
  onSelect,
}: {
  tabs: Tab[];
  current: Tab;
  onSelect: (key: string) => void;
}) {
  const groups: [Tab["group"], string][] = [
    ["levels", "Records"],
    ["assets", "Assets"],
  ];
  return (
    <>
      <nav
        aria-label="Contribution sections"
        className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 py-3 lg:block"
      >
        {groups.map(([group, heading]) => {
          const members = tabs.filter((entry) => entry.group === group);
          if (members.length === 0) return null;
          return (
            <div key={group} className="mb-3">
              <h3 className="m-0 px-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                {heading}
              </h3>
              {members.map((entry) => {
                const active = entry.key === current.key;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelect(entry.key)}
                    className={cx(
                      "flex w-full items-center justify-between gap-3 border-l-4 py-2 pr-3 pl-3 text-left text-[13px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-inset",
                      active
                        ? "border-node bg-node-soft font-bold text-node"
                        : "border-transparent text-gray-700 hover:bg-gray-50",
                    )}
                  >
                    <span className="truncate">{entry.label}</span>
                    <TabCount tab={entry} active={active} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
      <div className="shrink-0 border-b border-gray-200 px-4 py-2 lg:hidden">
        <label className="sr-only" htmlFor="contribution-tab">
          Section
        </label>
        <select
          id="contribution-tab"
          value={current.key}
          onChange={(event) => onSelect(event.target.value)}
          className="w-full rounded-sm border border-gray-300 bg-white px-2 py-1.5 text-[13px] font-bold"
        >
          {tabs.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
              {entry.count !== undefined && !entry.isLoading
                ? ` (${formatNumber(entry.count)})`
                : ""}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

// --- Contribution tab: reference, links, revision history, fields ---------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
        {title}
      </h4>
      {children}
    </section>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-node hover:underline">
      {children}
    </a>
  );
}

function ContributionPanel({
  id,
  privateKey,
  config,
  doc,
}: {
  id: string;
  privateKey?: string;
  config: NodeConfig;
  doc: SearchResult;
}) {
  const summary = (getPath(doc, "summary.contribution") ?? {}) as Record<string, unknown>;
  const reference = (
    summary._reference && typeof summary._reference === "object" ? summary._reference : {}
  ) as Record<string, unknown>;
  const longCitation =
    firstString(reference.long_citation) ?? firstString(reference.citation) ?? citationOf(doc);
  const publicationDoi = firstString(reference.doi);
  const isActivated = summary._is_activated !== false;
  const contributor = firstString(summary._contributor);
  const description = firstString(summary.description);
  // The contribution row's own columns (workflow fields start with "_").
  const fields = Object.fromEntries(
    Object.entries(summary).filter(([key, value]) => !key.startsWith("_") && value !== ""),
  );

  return (
    <div className="p-4 text-[13px] sm:p-6">
      <Section title="Reference">
        {longCitation ? <p className="m-0 text-gray-800">{longCitation}</p> : <p>—</p>}
        {firstString(reference.title) && longCitation !== reference.title && (
          <p className="m-0 mt-1 italic text-gray-700">{firstString(reference.title)}</p>
        )}
        {description && <p className="m-0 mt-2 text-gray-700">{description}</p>}
      </Section>

      <Section title="Links">
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-bold">{config.key} Contribution Link</dt>
          <dd className="m-0">
            earthref.org/{config.key}/{id}
          </dd>
          {config.doi_prefix && (
            <>
              <dt className="font-bold">EarthRef Data DOI</dt>
              <dd className="m-0">
                {isActivated ? (
                  <ExternalLink href={`https://dx.doi.org/${config.doi_prefix}/${id}`}>
                    {config.doi_prefix}/{id}
                  </ExternalLink>
                ) : (
                  <span className="text-[#AAAAAA]">Queued For Creation</span>
                )}
              </dd>
            </>
          )}
          {publicationDoi && (
            <>
              <dt className="font-bold">Publication DOI</dt>
              <dd className="m-0">
                <ExternalLink href={`https://dx.doi.org/${publicationDoi}`}>
                  {publicationDoi}
                </ExternalLink>
              </dd>
            </>
          )}
          {contributor && (
            <>
              <dt className="font-bold">Contributor</dt>
              <dd className="m-0">
                {contributor}
                {formatDateLL(summary.timestamp) && `, ${formatDateLL(summary.timestamp)}`}
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title="Revision History">
        <VersionsTable
          summary={summary}
          currentId={id}
          isActivated={isActivated}
          privateKey={privateKey}
        />
      </Section>

      {Object.keys(fields).length > 0 && (
        <Section title="Contribution Values">
          <DefinitionTable data={fields} />
        </Section>
      )}
    </div>
  );
}

// --- Revision history (legacy "history table") -----------------------------------------

interface VersionRow {
  id: string;
  version: string;
  dataModel: string;
  date: unknown;
  contributor: string;
  isActivated: boolean;
}

function versionRows(
  summary: Record<string, unknown>,
  currentId: string,
  currentIsActivated: boolean,
): VersionRow[] {
  const toRow = (entry: Record<string, unknown>, fallbackId: string): VersionRow => ({
    id: String(entry.id ?? fallbackId),
    version: String(entry.version ?? summary.version ?? "1"),
    dataModel: String(entry.data_model_version ?? summary.data_model_version ?? ""),
    date: entry.timestamp ?? summary.timestamp,
    contributor: firstString(entry._contributor ?? entry.contributor) ?? "",
    isActivated: typeof entry.is_activated === "boolean" ? entry.is_activated : currentIsActivated,
  });

  const history = summary._history;
  if (Array.isArray(history) && history.length > 0) {
    return history
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => toRow(entry, currentId));
  }
  return [toRow(summary, currentId)];
}

function VersionsTable({
  summary,
  currentId,
  isActivated,
  privateKey,
}: {
  summary: Record<string, unknown>;
  currentId: string;
  isActivated: boolean;
  privateKey?: string;
}) {
  const { data: config } = useNodeConfig();
  const open = useOpenContribution();
  const keyQuery = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
  const rows = versionRows(summary, currentId, isActivated);
  const cell = "py-1 pr-3";
  const head = "py-1 pr-3 font-medium";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="text-gray-500">
            <th className={head}>Version</th>
            <th className={head}>Contribution</th>
            <th className={head}>EarthRef Data DOI</th>
            <th className={head}>Data Model</th>
            <th className={head}>Date</th>
            <th className={head}>Contributor</th>
            <th className="py-1 font-medium">Download</th>
          </tr>
        </thead>
        <tbody className="align-top">
          {rows.map((row) => (
            <tr
              key={`${row.id}-${row.version}`}
              className={row.id === currentId ? "font-bold" : ""}
            >
              <td className={cell}>{row.version}</td>
              <td className={cell}>
                {row.id === currentId ? (
                  row.id
                ) : (
                  <button
                    type="button"
                    onClick={() => open(row.id, "contribution")}
                    className="cursor-pointer text-node hover:underline"
                  >
                    {row.id}
                  </button>
                )}
              </td>
              <td className={cell}>
                {config?.doi_prefix ? (
                  row.isActivated ? (
                    <ExternalLink href={`https://dx.doi.org/${config.doi_prefix}/${row.id}`}>
                      {config.doi_prefix}/{row.id}
                    </ExternalLink>
                  ) : (
                    <span className="text-[#AAAAAA]">Queued For Creation</span>
                  )
                ) : (
                  <span className="text-[#AAAAAA]">—</span>
                )}
              </td>
              <td className={cell}>{row.dataModel || "—"}</td>
              <td className={cx(cell, "whitespace-nowrap")}>{formatDateLL(row.date) || "—"}</td>
              <td className={cell}>{row.contributor || "—"}</td>
              <td className="py-1">
                <a
                  href={nodeUrl(`/contributions/${row.id}/download${keyQuery}`)}
                  download
                  className="inline-flex items-center gap-1 font-normal text-node hover:underline"
                >
                  <Icon name="download" size="small" /> txt
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Level tabs: the contribution's rows at that level ---------------------------------

function LevelPanel({
  level,
  id,
  privateKey,
}: {
  level: SearchLevel;
  id: string;
  privateKey?: string;
}) {
  const rows = useInfiniteQuery({
    queryKey: ["contribution-rows", id, level.table, privateKey],
    queryFn: ({ pageParam }) =>
      api<SearchPage>(`/search/${level.table}`, {
        params: { ...scope(id, privateKey), size: PAGE_SIZE, from: pageParam || undefined },
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.results.length, 0);
      return loaded < last.total && last.results.length > 0 ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
  const hits = useMemo(() => rows.data?.pages.flatMap((page) => page.results) ?? [], [rows.data]);
  const total = rows.data?.pages[0]?.total ?? 0;

  if (rows.isPending) return <PageSpinner label={`Loading ${level.name.toLowerCase()}…`} />;
  if (rows.error) return <ErrorMessage error={rows.error} className="m-4" />;
  return (
    <div className="p-4 sm:p-6">
      <RowsTable results={hits} />
      {rows.hasNextPage && (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            disabled={rows.isFetchingNextPage}
            onClick={() => rows.fetchNextPage()}
            className="rounded-sm border border-gray-300 bg-white px-3 py-2 text-[13px] font-bold text-gray-700 hover:bg-gray-50"
          >
            {rows.isFetchingNextPage
              ? "Loading…"
              : `Load More (showing ${formatNumber(hits.length)} of ${formatNumber(total)})`}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Map tab: a globe of one level's records, labelled --------------------------------

function MapPanel({
  layers,
  initial,
}: {
  layers: { level: SearchLevel; points: MapPoint[] }[];
  initial?: string;
}) {
  const [table, setTable] = useState(initial);
  const layer = layers.find((entry) => entry.level.table === table) ?? layers[0];
  if (!layer) return <PageSpinner label="Loading the map…" />;
  return (
    <div className="flex h-full min-h-[420px] flex-col gap-2 p-4 sm:p-6">
      {layers.length > 1 && (
        <div className="inline-flex self-start text-[13px]">
          {layers.map((entry, index) => {
            const active = entry === layer;
            return (
              <button
                key={entry.level.table}
                type="button"
                aria-pressed={active}
                onClick={() => setTable(entry.level.table)}
                className={cx(
                  "border px-2 py-1 font-bold",
                  active
                    ? "border-node bg-node text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
                  index === 0 ? "rounded-l-sm" : "-ml-px",
                  index === layers.length - 1 && "rounded-r-sm",
                )}
              >
                {entry.level.name} ({formatNumber(entry.points.length)})
              </button>
            );
          })}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm border border-gray-300">
        <Suspense fallback={<PageSpinner label="Loading the map…" />}>
          <MapLibreMap
            // A new map per level, fitted to its records.
            key={layer.level.table}
            mode="globe"
            points={layer.points}
            fit
            labelPoints
          />
        </Suspense>
      </div>
    </div>
  );
}
