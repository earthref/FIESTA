import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { isNodeAdmin } from "../lib/admin";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { IS_LOCAL_HOST, nodeUrl, siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { type RowMatch, useOpenContribution } from "../lib/contribution-modal";
import { dataModelQuery, unwrapModel } from "../lib/data-model";
import { usePagedItems } from "../lib/paged";
import { slug, slugMatches } from "../lib/search-state";
import type {
  ContributionRowStats,
  ContributionVersion,
  NodeConfig,
  SearchLevel,
  SearchPage,
  SearchResult,
  TablePage,
} from "../lib/types";
import { cx, formatNumber, getPath, singularize } from "../lib/utils";
import { type ContributionTab, pluginContributionTabs, type TabCountQuery } from "../plugins";
import { ErrorMessage } from "./error-message";
import { bodiesOf } from "./map/bodies";
import {
  BODY_PLACES,
  BodyButtons,
  IN_MODE,
  MODE_PLACES,
  ModeButtons,
  useBody,
  useSavedMode,
} from "./map/map-mode";
import {
  type ApiMapContribution,
  type ApiMapPoint,
  type MapPoint,
  MODES,
  type Mode,
  toMapPoint,
} from "./map/map-points";
import { citationOf, DefinitionTable, firstString, formatDateLL, InlineHtml } from "./result-item";
import { type GridRow, RowsGrid, rowLinkOf } from "./rows-table";
import { isSourceMode } from "./source-mode-notice";
import type { GridSort } from "./summary-grid";
import { Icon } from "./ui/icon";
import { PageSpinner, Spinner } from "./ui/spinner";

// MapLibre (~1 MB) loads with the first map, as on the search page's Map tab.
const MapLibreMap = lazy(() => import("./map/maplibre-map"));

/** Rows per page in a level tab; more load on demand. */
const PAGE_SIZE = 100;

/** A badge beside a tab's count: rows flagged by validation or changed. */
type Flag = { key: string; text: string; title: string; className: string };

type Tab = {
  key: string;
  label: string;
  group: "levels" | "assets" | "admin";
  count?: number;
  isLoading?: boolean;
  flags?: Flag[];
  render: () => ReactNode;
};

/** A table's badges: rows with validation errors (red) and warnings (yellow),
 * and rows added or changed since the previous version (node color). */
function rowFlags(stats: ContributionRowStats | undefined, table: string): Flag[] {
  const entry = stats?.tables[table];
  if (!entry) return [];
  const rows = (n: number) => `${formatNumber(n)} row${n === 1 ? "" : "s"}`;
  const flags: Flag[] = [];
  if (entry.errors)
    flags.push({
      key: "errors",
      text: formatNumber(entry.errors),
      title: `${rows(entry.errors)} with validation errors`,
      className: "bg-danger text-white",
    });
  if (entry.warnings)
    flags.push({
      key: "warnings",
      text: formatNumber(entry.warnings),
      title: `${rows(entry.warnings)} with validation warnings`,
      className: "bg-yellow-400 text-gray-900",
    });
  const changed = entry.changed ?? 0;
  const removed = entry.removed ?? 0;
  if (stats?.previous && (changed || removed)) {
    const since = `since version ${stats.previous.version}`;
    const parts = [
      changed && `${rows(changed)} added or changed`,
      removed && `${rows(removed)} removed`,
    ].filter(Boolean);
    flags.push({
      key: "changed",
      text: changed ? formatNumber(changed) : `−${formatNumber(removed)}`,
      title: `${parts.join(", ")} ${since}`,
      className: "border border-node bg-surface text-node-ink",
    });
  }
  return flags;
}

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
  row,
  column,
  plot,
  rowMatch,
  privateKey,
  onTab,
  onRow,
  onPlot,
  onClose,
}: {
  id: string;
  tab?: string;
  /** The row selected in a level tab (its 1-based place in the file's table). */
  row?: number;
  /** A column of the selected row to point at (a data point's link). */
  column?: string;
  /** The plot selected in a plot tab (`?plot=`; `onPlot` names a new one). */
  plot?: string;
  /** A search row to find in the level tab and select (then `onRow` names it). */
  rowMatch?: RowMatch;
  privateKey?: string;
  onTab: (tab: string, respell?: boolean) => void;
  onRow: (row: number | undefined) => void;
  onPlot: (plot: string | undefined) => void;
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
        className="absolute inset-0 cursor-default bg-backdrop backdrop-blur-sm"
      />
      <dialog
        open
        aria-modal="true"
        aria-label={`Contribution ${id}`}
        className="relative m-0 flex h-[calc(100vh-1rem)] w-full flex-col overflow-hidden rounded-lg border-0 bg-surface p-0 text-left shadow-2xl sm:h-[calc(100vh-4rem)]"
      >
        {config && docQuery.data ? (
          <ModalBody
            id={id}
            doc={docQuery.data}
            config={config}
            tab={tab}
            row={row}
            column={column}
            rowMatch={rowMatch}
            privateKey={privateKey}
            onTab={onTab}
            onRow={onRow}
            plot={plot}
            onPlot={onPlot}
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
        <h2 className="m-0 text-xl font-bold text-node-ink">
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
            <InlineHtml html={title} />
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
          className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        >
          <Icon name="close" style={{ width: 20, height: 20 }} />
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
  row,
  column,
  plot,
  rowMatch,
  privateKey,
  onTab,
  onRow,
  onPlot,
  onClose,
}: {
  id: string;
  doc: SearchResult;
  config: NodeConfig;
  tab?: string;
  row?: number;
  column?: string;
  plot?: string;
  rowMatch?: RowMatch;
  privateKey?: string;
  onTab: (tab: string, respell?: boolean) => void;
  onRow: (row: number | undefined) => void;
  onPlot: (plot: string | undefined) => void;
  onClose: () => void;
}) {
  const { user } = useAuth();
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
  // The latest data model's tables that are not a search level, in its order.
  const { data: model } = useQuery({
    ...dataModelQuery(config.data_model_latest ?? ""),
    enabled: !!config.data_model_latest,
    select: unwrapModel,
  });
  const otherTables = Object.entries(model?.tables ?? {})
    .filter(([table]) => table !== "contribution" && !levels.some((l) => l.table === table))
    .sort(([, a], [, b]) => (a.position ?? 0) - (b.position ?? 0));
  // Rows flagged by validation or changed since the previous version, per table.
  const { data: rowStats } = useQuery({
    queryKey: ["contribution-rows", id, privateKey],
    queryFn: () =>
      api<ContributionRowStats>(`/contributions/${id}/rows`, {
        params: { private_key: privateKey || undefined },
      }),
    staleTime: 60_000,
  });
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

  // The Map tab plots the levels with positions (and a map) that have rows here.
  const geoLevels = levels.filter((level) => level.geo && level.map !== false);
  const pointQueries = useQueries({
    queries: geoLevels.map((level) => ({
      queryKey: ["contribution-points", id, level.table, privateKey],
      queryFn: () =>
        api<{ points: ApiMapPoint[]; contributions?: Record<string, ApiMapContribution> }>(
          `/search/${level.table}/points`,
          { params: scope(id, privateKey) },
        ),
      enabled: (countOf(level.table).count ?? 0) > 0,
      staleTime: 60_000,
    })),
  });
  // One contribution's records name their level and the rows above them; its
  // own point is its citation, date and contributor.
  const levelLabel = (table: string) =>
    singularize(levels.find((l) => l.table === table)?.name ?? table);
  const mapLayers = geoLevels
    .map((level, index) => ({
      level,
      points: (pointQueries[index].data?.points ?? []).flatMap(
        (p) =>
          toMapPoint(p, singularize(level.name), config.color, undefined, {
            table: level.table,
            contributions: pointQueries[index].data?.contributions,
            levelLabel,
          }) ?? [],
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

  const ctx = { id, privateKey, config, doc, plot, onPlot };
  const tabs: Tab[] = [
    {
      key: "contribution",
      label: "Contribution",
      group: "levels",
      render: () => <ContributionPanel {...ctx} />,
    },
  ];
  // Tabs with nothing in them are hidden; the tab list holds back those whose
  // count is still loading (see TabList).
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
      flags: rowFlags(rowStats, level.table),
      render: () => (
        <LevelPanel
          // A level's sort and scroll are its own.
          key={level.table}
          level={level}
          id={id}
          privateKey={privateKey}
          selected={row}
          column={column}
          match={
            rowMatch?.id === id && rowMatch.table === level.table ? rowMatch.values : undefined
          }
          onSelect={onRow}
        />
      ),
    });
  }
  // The file's other data-model tables (MagIC images, criteria, …): no search
  // level indexes them, so the file's own row counts say which have rows.
  for (const [table, def] of otherTables) {
    const count = rowStats?.rows?.[table] ?? 0;
    if (!count) continue;
    const name = def.label ?? table;
    tabs.push({
      key: table,
      label: name,
      group: "levels",
      count,
      flags: rowFlags(rowStats, table),
      render: () => (
        <LevelPanel
          key={table}
          level={{ name, table }}
          id={id}
          privateKey={privateKey}
          selected={row}
          column={column}
          onSelect={onRow}
        />
      ),
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
  // Admin tools: for the node's admins, and on a local stack.
  if (IS_LOCAL_HOST || isNodeAdmin(user, config.slug)) {
    tabs.push({
      key: "jsonld",
      label: "JSON-LD",
      group: "admin",
      render: () => <JsonLdPanel id={id} privateKey={privateKey} />,
    });
  }
  // The URL names a tab by its label (/16901/Sites), any case; an older link
  // by its key (?tab=sites).
  const named =
    tabs.find((entry) => slugMatches(entry.label, tab)) ?? tabs.find((entry) => entry.key === tab);
  const current = named ?? tabs[0];
  const selectTab = (key: string) => onTab(tabs.find((entry) => entry.key === key)?.label ?? key);
  // Another spelling of a tab's name becomes its canonical one (its label).
  const respell = named && tab !== slug(named.label) ? named.label : undefined;
  useEffect(() => {
    if (respell) onTab(respell, true);
  }, [respell, onTab]);

  return (
    <>
      <ModalHeader id={id} config={config} doc={doc} privateKey={privateKey} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <TabList tabs={tabs} current={current} onSelect={selectTab} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{current.render()}</div>
      </div>
    </>
  );
}

// --- Tabs down the left (a select on narrow screens) -----------------------------------

const pill =
  "inline-flex min-w-[2em] items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-[18px]";

function TabCount({ tab, active }: { tab: Tab; active: boolean }) {
  if (tab.count === undefined && !tab.isLoading) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {tab.flags?.map((flag) => (
        <span key={flag.key} title={flag.title} className={cx(pill, flag.className)}>
          {flag.text}
          <span className="sr-only"> ({flag.title})</span>
        </span>
      ))}
      <span
        className={cx(
          pill,
          active && !tab.isLoading ? "bg-node text-white" : "border border-gray-300 text-gray-600",
        )}
      >
        {tab.isLoading ? <Spinner size="xs" /> : formatNumber(tab.count)}
      </span>
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
    ["admin", "Admin"],
  ];
  // While counts load, one "Loading…" row stands in for the tabs they decide
  // (each would otherwise show a spinner, then vanish at zero): a group's
  // counted tabs appear together once all its counts are known. Tabs without
  // a count, and the open one, show throughout.
  const loading = tabs.some((entry) => entry.isLoading);
  const settled = (group: Tab["group"]) =>
    !tabs.some((entry) => entry.group === group && entry.isLoading);
  const shown = tabs.filter(
    (entry) =>
      settled(entry.group) ||
      entry.key === current.key ||
      (entry.count === undefined && !entry.isLoading),
  );
  return (
    <>
      <nav
        aria-label="Contribution sections"
        className="hidden w-56 shrink-0 overflow-y-auto border-r border-gray-200 py-3 lg:block"
      >
        {groups.map(([group, heading]) => {
          const members = shown.filter((entry) => entry.group === group);
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
                        ? "border-node bg-node-soft font-bold text-node-ink"
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
        {loading && (
          <div className="flex items-center gap-2 px-4 py-2 text-[13px] text-gray-500">
            <Spinner size="xs" />
            <span aria-hidden="true">Loading…</span>
          </div>
        )}
      </nav>
      <div className="shrink-0 border-b border-gray-200 px-4 py-2 lg:hidden">
        <label className="sr-only" htmlFor="contribution-tab">
          Section
        </label>
        <select
          id="contribution-tab"
          value={current.key}
          onChange={(event) => onSelect(event.target.value)}
          className="w-full rounded-sm border border-gray-300 bg-surface px-2 py-1.5 text-[13px] font-bold"
        >
          {shown.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {entry.label}
              {entry.count !== undefined && !entry.isLoading
                ? ` (${[formatNumber(entry.count), ...(entry.flags ?? []).map((f) => f.title)].join(" · ")})`
                : ""}
            </option>
          ))}
          {loading && <option disabled>Loading…</option>}
        </select>
      </div>
    </>
  );
}

// --- Admin tab: the contribution's schema.org JSON-LD ---------------------------------

/** The schema.org Dataset (JSON-LD, after Science-on-Schema.org) the API builds
 * for this contribution's landing page: what search engines, language models
 * and dataset harvesters are to read (fiesta.domain.jsonld). */
function JsonLdPanel({ id, privateKey }: { id: string; privateKey?: string }) {
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ["contribution-jsonld", id, privateKey],
    queryFn: () =>
      api<Record<string, unknown>>(`/contributions/${id}/jsonld`, {
        params: { private_key: privateKey || undefined },
      }),
  });
  const text = query.data ? JSON.stringify(query.data, null, 2) : "";
  const keyQuery = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const button =
    "inline-flex items-center gap-1.5 rounded-sm border border-gray-300 px-2.5 py-1 text-[13px] font-bold text-gray-700 hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node";
  return (
    <div className="p-4 sm:p-6">
      <p className="m-0 mb-3 text-[13px] text-gray-600">
        The schema.org <code>Dataset</code> describing this contribution, after{" "}
        <ExternalLink href="https://science-on-schema.org/">Science-on-Schema.org</ExternalLink>.
        Check it with the{" "}
        <ExternalLink href="https://validator.schema.org/">Schema Markup Validator</ExternalLink>.
        Shown to node admins, and on a local stack.
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} disabled={!text} className={button}>
          <Icon name={copied ? "check" : "check-clipboard"} className="h-3.5 w-3.5" />
          {copied ? "Copied" : "Copy JSON-LD"}
        </button>
        <a
          href={nodeUrl(`/contributions/${id}/jsonld${keyQuery}`)}
          target="_blank"
          rel="noreferrer"
          className={button}
        >
          <Icon name="external" className="h-3.5 w-3.5" />
          Open Raw
        </a>
      </div>
      {query.error ? (
        <ErrorMessage error={query.error} />
      ) : query.data ? (
        <pre className="m-0 overflow-x-auto rounded-sm border border-gray-200 bg-gray-50 p-3 text-xs leading-5 text-gray-800">
          {text}
        </pre>
      ) : (
        <PageSpinner label="Building JSON-LD…" />
      )}
    </div>
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
    <a href={href} target="_blank" rel="noreferrer" className="text-node-ink hover:underline">
      {children}
    </a>
  );
}

interface ReferenceAuthor {
  family?: string;
  given?: string;
  _orcid?: string;
}

/** `/v2/portal/references/{doi}`: what the DOI cache knows beyond `_reference`. */
interface ReferenceDetailsOut {
  abstract?: string;
  openalex?: string;
  citations_by_year?: { year: number; count: number }[];
  topics?: string[];
  keywords?: string[];
  open_access?: { url: string; status?: string };
}

/** The publication's authors (an ORCID iD links each one that has one), its
 * citation count, free-to-read copy, topics and abstract. */
function ReferenceDetails({ reference }: { reference: Record<string, unknown> }) {
  const doi = firstString(reference.doi);
  const { data } = useQuery({
    queryKey: ["reference-details", doi],
    queryFn: () => api<ReferenceDetailsOut>(`/v2/portal/references/${encodeURI(doi ?? "")}`),
    enabled: Boolean(doi),
    retry: false,
    staleTime: 60 * 60 * 1000,
  });
  const authors = (Array.isArray(reference.authors) ? reference.authors : []) as ReferenceAuthor[];
  const citations = Number(reference.n_citations) || 0;
  const subjects = [...(data?.topics ?? []), ...(data?.keywords ?? [])].filter(
    (subject, index, all) => all.indexOf(subject) === index,
  );
  return (
    <>
      {authors.some((author) => author._orcid) && (
        <p className="m-0 mt-1 text-gray-700">
          {authors.map((author, index) => {
            const name = [author.given, author.family].filter(Boolean).join(" ");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: author order is the publication's and static
              <span key={`${index}-${name}`}>
                {index > 0 && ", "}
                {name}
                {author._orcid && (
                  <a
                    href={`https://orcid.org/${author._orcid}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`ORCID ${author._orcid}`}
                    className="ml-0.5 align-super text-[10px] font-bold text-[#a6ce39] hover:underline"
                  >
                    iD
                  </a>
                )}
              </span>
            );
          })}
        </p>
      )}
      {(citations > 0 || data?.open_access) && (
        <p className="m-0 mt-1 text-gray-700">
          {citations > 0 &&
            (data?.openalex ? (
              <ExternalLink
                href={`https://openalex.org/works?filter=cites:${data.openalex.split("/").pop()}`}
              >
                Cited by {formatNumber(citations)}
              </ExternalLink>
            ) : (
              `Cited by ${formatNumber(citations)}`
            ))}
          {citations > 0 && data?.open_access && " · "}
          {data?.open_access && (
            <ExternalLink href={data.open_access.url}>Free to read</ExternalLink>
          )}
        </p>
      )}
      {subjects.length > 0 && (
        <p className="m-0 mt-1 text-gray-500">{subjects.slice(0, 6).join(" · ")}</p>
      )}
      {data?.abstract && (
        <details className="mt-1">
          <summary className="cursor-pointer text-node-ink">Abstract</summary>
          <p className="m-0 mt-1 text-gray-700">{data.abstract}</p>
        </details>
      )}
    </>
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
          <p className="m-0 mt-1 italic text-gray-700">
            <InlineHtml html={firstString(reference.title)} />
          </p>
        )}
        <ReferenceDetails reference={reference} />
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
                  <span className="text-ink-faint">Queued For Creation</span>
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
        {isActivated && summary._is_latest !== false && !isSourceMode(config) && (
          <PrepareVersion id={id} nodeKey={config.key} />
        )}
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

/** Anyone signed in may prepare the next version of the latest published
 * one, in their private workspace. Its earlier versions' contributors and the
 * node's admins publish it; anyone else asks an admin to approve it. */
function PrepareVersion({ id, nodeKey }: { id: string; nodeKey: string }) {
  const { user } = useAuth();
  const prepare = useMutation({
    mutationFn: () =>
      api<{ id: number }>(`/private/contributions/${id}/versions`, { method: "POST" }),
    onSuccess: () => window.location.assign(siteUrl("/Private")),
  });
  if (!user) return null;
  return (
    <div className="mt-2 text-[13px] text-gray-600">
      <button
        type="button"
        onClick={() => prepare.mutate()}
        disabled={prepare.isPending}
        className="cursor-pointer text-node-ink hover:underline disabled:opacity-60"
      >
        {prepare.isPending ? "Preparing…" : "Prepare a new version"}
      </button>{" "}
      in your private workspace to correct or extend this contribution. Unless you contributed an
      earlier version, a {nodeKey} admin approves it before it is published.
      {prepare.error && <ErrorMessage error={prepare.error} />}
    </div>
  );
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
  // Every published version of this contribution, newest first; this one
  // alone until they load (or if they cannot).
  const { data: chain } = useQuery({
    queryKey: ["contribution-versions", currentId, privateKey],
    queryFn: () =>
      api<ContributionVersion[]>(`/contributions/${currentId}/versions`, {
        params: { private_key: privateKey || undefined },
      }),
    staleTime: 60_000,
  });
  const rows: VersionRow[] = chain
    ? [...chain].reverse().map((entry) => ({
        id: String(entry.id),
        version: String(entry.version),
        dataModel: entry.data_model_version,
        date: entry.timestamp,
        contributor: entry.contributor ?? "",
        isActivated: entry.is_activated,
      }))
    : versionRows(summary, currentId, isActivated);
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
                    className="cursor-pointer text-node-ink hover:underline"
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
                    <span className="text-ink-faint">Queued For Creation</span>
                  )
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className={cell}>{row.dataModel || "—"}</td>
              <td className={cx(cell, "whitespace-nowrap")}>{formatDateLL(row.date) || "—"}</td>
              <td className={cell}>{row.contributor || "—"}</td>
              <td className="py-1">
                <a
                  href={nodeUrl(`/contributions/${row.id}/download${keyQuery}`)}
                  download
                  className="inline-flex items-center gap-1 font-normal text-node-ink hover:underline"
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

const tableTotal = (page: TablePage) => page.total;
/** A file table's rows as grid items, one row each, labelled with its row in
 * the file (what validation names). */
const tableItems = (page: TablePage): GridRow[][] =>
  page.rows.map((row) => [
    {
      key: String(row.row),
      label: formatNumber(row.row),
      rowId: row.row_id ?? undefined,
      values: row.values,
      issues: row.issues,
    },
  ]);

function LevelPanel({
  level,
  id,
  privateKey,
  selected,
  column,
  match,
  onSelect,
}: {
  /** The table and its name: a search level, or another table of the data model. */
  level: Pick<SearchLevel, "name" | "table">;
  id: string;
  privateKey?: string;
  /** The selected row: its 1-based place in the file's table. */
  selected?: number;
  /** A column of the selected row to point at (a data point's link). */
  column?: string;
  /** A search row's values to find in the table, then select. */
  match?: Record<string, unknown>;
  onSelect: (row: number | undefined) => void;
}) {
  // A header sort orders the whole table, server-side.
  const [sort, setSort] = useState<GridSort | undefined>();
  const scroller = useRef<HTMLDivElement>(null);
  // The table opens on the selected row (in file order), in the middle of the view.
  const [target, setTarget] = useState(() => (selected !== undefined ? selected - 1 : undefined));
  // A search row (the Data grid) is found in the file, then selected.
  const located = useQuery({
    queryKey: ["contribution-row", id, level.table, privateKey, match],
    queryFn: () =>
      api<{ row: number | null }>(`/contributions/${id}/tables/${level.table}/locate`, {
        params: { values: JSON.stringify(match), private_key: privateKey || undefined },
      }),
    enabled: !!match,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const found = located.data?.row ?? undefined;
  useEffect(() => {
    if (!match || !located.isSuccess) return;
    if (found !== undefined) setTarget(found - 1);
    onSelect(found);
  }, [match, located.isSuccess, found, onSelect]);
  // The grid is sized to the whole table and fetches the pages it shows.
  const table = usePagedItems({
    queryKey: ["contribution-table", id, level.table, privateKey, sort?.key, sort?.order],
    pageSize: PAGE_SIZE,
    fetchPage: (page) =>
      api<TablePage>(`/contributions/${id}/tables/${level.table}`, {
        params: {
          private_key: privateKey || undefined,
          sort: sort ? `${sort.key}:${sort.order}` : undefined,
          size: PAGE_SIZE,
          from: page * PAGE_SIZE || undefined,
        },
      }),
    totalOf: tableTotal,
    itemsOf: tableItems,
  });
  const first = table.first.data;

  if (table.first.isPending || (match && located.isPending)) {
    return <PageSpinner label={`Loading ${level.name.toLowerCase()}…`} />;
  }
  const error = table.first.error ?? located.error;
  if (error) return <ErrorMessage error={error} className="m-4" />;
  return (
    // The rows run edge to edge of the panel; the cells carry the padding.
    <div ref={scroller} className="h-full overflow-auto">
      <RowsGrid
        items={table.items}
        columns={first?.columns ?? []}
        table={level.table}
        labelled
        selected={selected !== undefined ? String(selected) : undefined}
        selectedColumn={column}
        onRowClick={(row) => onSelect(Number(row.key))}
        // Each row's number (<contribution>.<row_id>) copies its persistent link.
        rowLink={(row) => rowLinkOf(row, id, privateKey)}
        // Each item is one row of the file's table.
        scrollTo={sort ? undefined : target}
        columnIssues={first?.column_issues}
        sort={sort}
        onSort={(next) => {
          setSort(next);
          scroller.current?.scrollTo({ top: 0 });
        }}
        scrollRef={scroller}
        onRange={table.onRange}
        empty={`No ${level.name.toLowerCase()} rows in this contribution's file.`}
      />
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
  // The level's records on the body chosen (or with the most of them).
  const bodies = useMemo(() => bodiesOf(layer?.points ?? []), [layer]);
  const [body, setBody] = useBody(bodies);
  const points = useMemo(
    () => (layer?.points ?? []).filter((p) => (p.body ?? "earth") === body),
    [layer, body],
  );
  // The view (Globe / Mercator / poles), remembered apart from the search map's,
  // with the points each one draws in its button.
  const [mode, setMode] = useSavedMode("contribution-map-mode");
  const modeCounts = useMemo(
    () =>
      Object.fromEntries(
        MODES.map(([each]) => [each, points.filter((p) => IN_MODE[each](p.lat)).length]),
      ) as Record<Mode, number>,
    [points],
  );
  if (!layer) return <PageSpinner label="Loading the map…" />;
  const records = layer.level.name.toLowerCase();
  return (
    <div className="flex h-full min-h-[420px] flex-col gap-2 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <BodyButtons
          bodies={bodies}
          body={body}
          setBody={setBody}
          counts={Object.fromEntries(
            bodies.map((each) => [
              each,
              layer.points.filter((p) => (p.body ?? "earth") === each).length,
            ]),
          )}
        />
        {layers.length > 1 && (
          <div className="inline-flex self-start">
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
                      : "border-gray-300 bg-surface text-gray-700 hover:bg-gray-50",
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
        <ModeButtons
          mode={mode}
          setMode={setMode}
          counts={modeCounts}
          emptyTitle={(each) =>
            `No mapped ${records} ${each === "globe" ? BODY_PLACES[body] : MODE_PLACES[each]}`
          }
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm border border-gray-300">
        <Suspense fallback={<PageSpinner label="Loading the map…" />}>
          <MapLibreMap
            // A new map per level, fitted to its records.
            key={layer.level.table}
            mode={mode}
            body={body}
            points={points}
            fit
            labelPoints
          />
        </Suspense>
      </div>
    </div>
  );
}
