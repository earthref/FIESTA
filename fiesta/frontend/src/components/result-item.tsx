import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { apiUrl, nodeSiteUrl, nodeUrl, siteUrl } from "../lib/base";
import { NodeConfigScope, useNodeConfig } from "../lib/config";
import { useOpenContribution } from "../lib/contribution-modal";
import { sanitizeInlineHtml } from "../lib/sanitize";
import type { GridColumn, NodeConfig, SearchLevel, SearchResult } from "../lib/types";
import { abbreviateNumber, cx, getPath, singularize } from "../lib/utils";
import { pluginGridCell } from "../plugins";
import { type MapMarker, MapThumbnail, markersFromGeoPoint } from "./map-thumbnail";
import { Icon } from "./ui/icon";

/** Fallback name columns, tried in order when a level's own key column is absent. */
const NAME_COLUMNS = [
  "location",
  "site",
  "sample",
  "specimen",
  "core",
  "section",
  "experiment",
  "object",
  "file",
  "cruise",
  "dive",
  "dive_sample",
];

/** A level's own key column: the singular of its table ("sections" -> "section").
 * Tried before NAME_COLUMNS so a block that also holds its parent's key (a
 * sections row carries `core`) is still named after itself. */
function keyColumnOf(table: string): string {
  return table.endsWith("s") ? table.slice(0, -1) : table;
}

/** The API URL of a route of the node a result belongs to: this SPA's node,
 * or the scoped one on the portal home (NodeConfigScope). */
function useNodeApiUrl(): (path: string) => string {
  const scoped = useContext(NodeConfigScope);
  return scoped ? (path) => apiUrl(`/${scoped.slug}${path}`) : nodeUrl;
}

/** Link to a contribution: opens its modal on the search page (a page load
 * of the scoped node's on the portal home); the href is its /<id> link. */
function ContributionLink({
  id,
  privateKey,
  children,
}: {
  id: string;
  privateKey?: string;
  children: ReactNode;
}) {
  const scoped = useContext(NodeConfigScope);
  const open = useOpenContribution();
  const query = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
  const href = scoped ? nodeSiteUrl(scoped.key, `/${id}${query}`) : siteUrl(`/${id}${query}`);
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        open(id, "contribution");
      }}
      className="text-node-ink hover:underline"
    >
      {children}
    </a>
  );
}

export function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

export function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

/** moment "LL" format: July 7, 2026 */
export function formatDateLL(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function contributionId(doc: SearchResult): string | undefined {
  const id = getPath(doc, "summary.contribution.id") ?? doc.id;
  return id === undefined || id === null ? undefined : String(id);
}

export function citationOf(doc: SearchResult): string | undefined {
  const reference = getPath(doc, "summary.contribution._reference");
  if (reference && typeof reference === "object") {
    const ref = reference as Record<string, unknown>;
    for (const key of ["citation", "long_citation", "title"]) {
      if (typeof ref[key] === "string" && ref[key]) return ref[key] as string;
    }
  }
  if (typeof reference === "string" && reference) return reference;
  return undefined;
}

/** "{location} ⇒ {site}" breadcrumb (legacy renderTitle): each ancestor
 * level's name column, from that level's summary block when the doc carries
 * one, else from the row's own `summary._all` (a sites doc has no `locations`
 * block but its `_all.location` names the parent). */
function breadcrumbOf(doc: SearchResult, level: SearchLevel, levels: SearchLevel[]): string[] {
  if (level.table === "contribution") return [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const entry of levels) {
    if (entry.table === "contribution" || seen.has(entry.table)) continue;
    seen.add(entry.table);
    const block = getPath(doc, `summary.${entry.table}`);
    const keyColumn = keyColumnOf(entry.table);
    let name: string | undefined;
    if (block && typeof block === "object") {
      for (const column of [keyColumn, ...NAME_COLUMNS]) {
        name = firstString((block as Record<string, unknown>)[column]);
        if (name) break;
      }
    }
    name ??= firstString(getPath(doc, `summary._all.${keyColumn}`));
    if (name) parts.push(name);
    if (entry.table === level.table) break;
  }
  return parts;
}

// --- Cell building blocks (legacy search_summaries_list_item.jsx) ---------------
// The summary grid spaces its columns (1em, the legacy cells' right margin).

const cellBase: CSSProperties = {
  fontSize: 13,
};

/** Fixed-width data-row cell (minWidth = maxWidth per legacy). */
export function Cell({
  width,
  wrap,
  children,
  className,
  style,
}: {
  width: number;
  wrap?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cx("shrink-0 overflow-hidden", className)}
      style={{
        ...cellBase,
        minWidth: width,
        maxWidth: width,
        whiteSpace: wrap ? "normal" : "nowrap",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The Plot tile without a plot: legacy SearchPlotThumbnail's bordered "No
 * Plots Available" box. `children` replace its text (a plugin's thumbnail). */
export function NoPlotsCell({ width, children }: { width: number; children?: ReactNode }) {
  return (
    <div
      className="relative shrink-0 overflow-hidden text-ellipsis text-center text-ink-faint"
      style={{
        boxSizing: "content-box",
        minWidth: width - 2,
        maxWidth: width - 2,
        minHeight: 98,
        maxHeight: 98,
        fontSize: 13,
        border: "1px solid rgba(0,0,0,.1)",
      }}
    >
      {children ?? (
        <>
          <br />
          No
          <br />
          <b>Plots</b>
          <br />
          Available
          <br />
          <br />
        </>
      )}
    </div>
  );
}

/** Grey centered "No X Data" placeholder with the legacy <br> structure. The
 * label may be multi-line (legacy "No Method<br/>Codes"); `dataWord` is false
 * for placeholders whose label already ends the sentence. */
export function NoDataCell({
  label,
  width,
  dataWord = true,
}: {
  label: ReactNode;
  width: number;
  dataWord?: boolean;
}) {
  return (
    <div
      className="shrink-0 overflow-hidden text-ellipsis text-center text-ink-faint"
      style={{ ...cellBase, minWidth: width, maxWidth: width }}
    >
      <br />
      No
      <br />
      <b>{label}</b>
      <br />
      {dataWord && (
        <>
          Data
          <br />
        </>
      )}
      <br />
    </div>
  );
}

/** Label on its own line above a value clamped to `lines` (legacy <b/> + Clamp). */
export function ClampedField({
  label,
  lines,
  children,
}: {
  label: string;
  lines: number;
  children: ReactNode;
}) {
  return (
    <span>
      <b>{label}</b>
      <div
        className="overflow-hidden"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: lines,
          WebkitBoxOrient: "vertical",
        }}
      >
        {children}
      </div>
    </span>
  );
}

/** Legacy `ui fitted divider` between result list items (margin 1em 0). */
export function ResultDivider() {
  return (
    <hr
      style={{
        margin: "0.5em 0 1em",
        border: 0,
        borderTop: "1px solid var(--er-line)",
        borderBottom: "1px solid rgba(255,255,255,.1)",
      }}
    />
  );
}

// --- Card frame (a header row over one row of cells; the Poles detail card) -------

/** A single record as a card: the header opens the contribution's modal at
 * this level; the cells wrap, showing only their first row. */
export function ResultCardFrame({
  doc,
  level,
  cells,
}: {
  doc: SearchResult;
  level: SearchLevel;
  cells: ReactNode;
}) {
  const { data: config } = useNodeConfig();
  const openContribution = useOpenContribution();
  const id = contributionId(doc);
  const breadcrumb = breadcrumbOf(doc, level, config?.search_levels ?? []);
  const contributor = firstString(getPath(doc, "summary.contribution._contributor"));
  return (
    <div className="relative flow-root text-left" style={{ lineHeight: "16px" }}>
      <button
        type="button"
        onClick={() => id && openContribution(id, level.table)}
        title="Open this contribution"
        className="group flex w-full cursor-pointer items-stretch text-left text-[13px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ paddingBottom: "0.5em" }}
      >
        <span className="whitespace-nowrap font-bold group-hover:text-node-ink">
          {citationLabel(doc)}
        </span>
        <span className="mx-[0.5em] flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {breadcrumb.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb parts can repeat and the ordered list is static per hit
            <span key={`${index}-${part}`}>
              {" ⇒ "}
              {index === breadcrumb.length - 1 ? <b>{part}</b> : part}
            </span>
          ))}
        </span>
        <span className="whitespace-nowrap text-right">
          {formatDateLL(getPath(doc, "summary.contribution.timestamp"))}
          {contributor && (
            <>
              {" by "}
              <b>{contributor}</b>
            </>
          )}
        </span>
      </button>
      <div
        className="flex flex-wrap"
        style={{ columnGap: "1em", maxHeight: 105, overflow: "hidden" }}
      >
        {cells}
      </div>
    </div>
  );
}

// --- Summary grid cells (the legacy result card's tiles) ------------------------

export function DefinitionTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) return null;
  return (
    <table className="w-full text-left text-[13px]">
      <tbody className="divide-y divide-gray-100">
        {entries.map(([key, value]) => (
          <tr key={key}>
            <th className="w-48 py-1 pr-3 align-top font-mono font-medium text-gray-500">{key}</th>
            <td className="break-all py-1 text-gray-700">
              {typeof value === "object" ? JSON.stringify(value) : String(value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const THIS_STUDY = /^this[_ ]study$/i;

/** Union of `summary._all.<column>` lists across several columns (legacy renderGeo). */
function unionOf(doc: SearchResult, columns: string[]): string[] {
  return columns.flatMap((column) => listOf(getPath(doc, `summary._all.${column}`)));
}

function markersOf(doc: SearchResult, level: SearchLevel): MapMarker[] {
  const blocks = level.table === "contribution" ? ["_all"] : [level.table, "_all"];
  for (const block of blocks) {
    // With those on another body (the thumbnail draws the body with most).
    const markers = [
      ...markersFromGeoPoint(getPath(doc, `summary.${block}._geo_point`)),
      ...markersFromGeoPoint(getPath(doc, `summary.${block}._body_point`)),
    ];
    if (markers.length > 0) return markers;
  }
  return [];
}

function joined(value: unknown): string {
  return listOf(value).join(", ");
}

/** "2.20 MB" — a byte count as the legacy repositories render file sizes. */
function formatBytes(value: unknown): string {
  const bytes = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(bytes)) return joined(value);
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(2)} ${units[unit]}`;
}

/** A cell that opens the record's contribution in its modal, at this level's tab.
 * `fill` makes it a column as tall as the row's thumbnail tiles (download, map,
 * plot: 104px), so a last child with `mt-auto` sits at the bottom. The grid is a
 * table, so the cell cannot stretch to the row. */
function OpenCell({
  id,
  table,
  width,
  fill,
  children,
}: {
  id: string | undefined;
  table: string;
  width: number;
  fill?: boolean;
  children: ReactNode;
}) {
  const openContribution = useOpenContribution();
  return (
    <button
      type="button"
      onClick={() => id && openContribution(id, table)}
      title="Open this contribution"
      className={cx(
        "shrink-0 cursor-pointer overflow-hidden text-left hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
        fill ? "flex flex-col" : "block self-start",
      )}
      style={{ ...cellBase, minWidth: width, maxWidth: width, ...(fill && { height: 104 }) }}
    >
      {children}
    </button>
  );
}

/** A block of at most `lines` lines (inline content, so it may sit in a button). */
function Clamped({
  lines,
  className,
  children,
  ref,
}: {
  lines: number;
  className?: string;
  children: ReactNode;
  ref?: Ref<HTMLSpanElement>;
}) {
  return (
    <span
      ref={ref}
      className={cx("overflow-hidden", className)}
      style={{ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" }}
    >
      {children}
    </span>
  );
}

/** "Behar et al. (2019) v. 2". */
function citationLabel(doc: SearchResult): string {
  const id = contributionId(doc);
  const version = getPath(doc, "summary.contribution.version");
  return `${citationOf(doc) ?? (id ? `Contribution ${id}` : "Unknown")}${
    version !== undefined && version !== null ? ` v. ${String(version)}` : ""
  }`;
}

/** "Behar et al. (2019) v. 2", bold. */
function CitationText({ doc }: { doc: SearchResult }) {
  return <b>{citationLabel(doc)}</b>;
}

/** Contributor text with inline markup (<sup>, <i>, …) rendered after
 * sanitizing to text formatting only. */
export function InlineHtml({ html, className }: { html: string | undefined; className?: string }) {
  if (!html) return null;
  return (
    <span
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized to inline formatting tags by DOMPurify
      dangerouslySetInnerHTML={{ __html: sanitizeInlineHtml(html) }}
    />
  );
}

/** The reference title (contributions) or the "{location} ⇒ {site}" breadcrumb. */
function NameText({
  doc,
  level,
  levels,
}: {
  doc: SearchResult;
  level: SearchLevel;
  levels: SearchLevel[];
}) {
  if (level.table === "contribution")
    return <InlineHtml html={firstString(getPath(doc, "summary.contribution._reference.title"))} />;
  const breadcrumb = breadcrumbOf(doc, level, levels);
  return (
    <>
      {breadcrumb.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb parts can repeat and the ordered list is static per hit
        <span key={`${index}-${part}`}>
          {index > 0 && " ⇒ "}
          {index === breadcrumb.length - 1 ? <b>{part}</b> : part}
        </span>
      ))}
    </>
  );
}

/** "July 7, 2026 by <b>contributor</b>"; `breakLine` puts "by …" on its own line. */
function ContributedText({ doc, breakLine }: { doc: SearchResult; breakLine?: boolean }) {
  const contributor = firstString(getPath(doc, "summary.contribution._contributor"));
  return (
    <>
      {formatDateLL(getPath(doc, "summary.contribution.timestamp"))}
      {contributor && (
        <>
          {breakLine ? <br /> : " "}
          {"by "}
          <b>{contributor}</b>
        </>
      )}
    </>
  );
}

/** A contribution's record cell: citation, up to 4 lines of the reference
 * title (3 when the date and contributor wrap onto a second line, so the cell
 * stays within its 104px), then the date and contributor bottom-right. */
function ContributionRecord({
  doc,
  level,
  levels,
}: {
  doc: SearchResult;
  level: SearchLevel;
  levels: SearchLevel[];
}) {
  const contributed = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const element = contributed.current;
    if (!element) return;
    // One 16px line, or more; re-measured when web fonts land.
    const measure = () => setWrapped(element.offsetHeight > 20);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <Clamped lines={2}>
        <CitationText doc={doc} />
      </Clamped>
      <Clamped lines={wrapped ? 3 : 4}>
        <NameText doc={doc} level={level} levels={levels} />
      </Clamped>
      <Clamped ref={contributed} lines={2} className="mt-auto text-right text-ink-muted">
        <ContributedText doc={doc} />
      </Clamped>
    </>
  );
}

export interface SummaryCellProps {
  column: GridColumn;
  doc: SearchResult;
  level: SearchLevel;
  privateKey?: string;
}

/** One grid cell: the tile its column names, for one search record. A plugin
 * may render any tile itself (plateau-calculations' age spectrum in `plot`). */
export function SummaryCell(props: SummaryCellProps) {
  const { data: config } = useNodeConfig();
  if (!config) return null;
  return (
    pluginGridCell(config, {
      column: props.column,
      hit: props.doc,
      level: props.level,
      config,
      privateKey: props.privateKey,
    }) ?? <BuiltinCell {...props} config={config} />
  );
}

function BuiltinCell({
  column,
  doc,
  level,
  privateKey,
  config,
}: SummaryCellProps & { config: NodeConfig }) {
  const nodeApiUrl = useNodeApiUrl();
  const openContribution = useOpenContribution();
  const width = column.width;
  const id = contributionId(doc);

  switch (column.cell) {
    // One column: a contribution's citation over up to 4 lines of its reference
    // title; a record's name over "{citation} ⇒ {ancestors}" bottom-right; both
    // ending with the date and contributor bottom-right.
    case "record": {
      if (level.table === "contribution")
        return (
          <OpenCell id={id} table={level.table} width={width} fill>
            <ContributionRecord doc={doc} level={level} levels={config.search_levels} />
          </OpenCell>
        );
      const breadcrumb = breadcrumbOf(doc, level, config.search_levels);
      const name = breadcrumb[breadcrumb.length - 1];
      return (
        <OpenCell id={id} table={level.table} width={width} fill>
          <Clamped lines={2}>
            <b>{name ?? "Unnamed"}</b>
          </Clamped>
          <span className="mt-auto text-right text-ink-muted">
            <Clamped lines={2}>
              {[citationLabel(doc), ...breadcrumb.slice(0, -1)].join(" ⇒ ")}
            </Clamped>
            <Clamped lines={2}>
              <ContributedText doc={doc} />
            </Clamped>
          </span>
        </OpenCell>
      );
    }

    case "citation":
      return (
        <OpenCell id={id} table={level.table} width={width}>
          <CitationText doc={doc} />
        </OpenCell>
      );

    // The reference title (contributions) or the "{location} ⇒ {site}" breadcrumb
    case "name":
      return (
        <OpenCell id={id} table={level.table} width={width}>
          <Clamped lines={6}>
            <NameText doc={doc} level={level} levels={config.search_levels} />
          </Clamped>
        </OpenCell>
      );

    case "contributed":
      return (
        <Cell width={width} wrap>
          <ContributedText doc={doc} breakLine />
        </Cell>
      );

    // Download (basic tiny fluid compact icon header button, height 100px)
    case "download": {
      if (!id) return <NoDataCell label="Download" width={width} />;
      const keyParam = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
      return (
        <Cell width={width} style={{ fontSize: 14, height: 104 }}>
          <a
            href={nodeApiUrl(`/contributions/${id}/download${keyParam}`)}
            download
            className="inline-block w-full bg-panel-soft text-center font-bold text-node-ink hover:bg-panel"
            style={{
              padding: "20px 0",
              height: 100,
              fontSize: 14,
              lineHeight: "18px",
              borderRadius: "0.28571429rem",
              boxShadow: "0 0 0 1px var(--node-color) inset",
            }}
          >
            <span aria-hidden="true" className="block" style={{ lineHeight: "42px" }}>
              <Icon name="file-text" style={{ width: 42, height: 42, verticalAlign: "top" }} />
            </span>
            Download
          </a>
        </Cell>
      );
    }

    case "links": {
      if (!id) return <NoDataCell label="Link" width={width} />;
      const isActivated = doc._is_activated !== false;
      const publicationDoi = firstString(getPath(doc, "summary.contribution._reference.doi"));
      return (
        <Cell width={width}>
          <b>{config.key} Contribution Link:</b>
          <p className="m-0 overflow-hidden text-ellipsis leading-[1.4285em]">
            <ContributionLink id={id} privateKey={privateKey}>
              earthref.org/{config.key}/{id}
            </ContributionLink>
          </p>
          {config.doi_prefix && (
            <>
              <b>EarthRef Data DOI:</b>
              <p className="m-0 overflow-hidden text-ellipsis leading-[1.4285em]">
                {isActivated ? (
                  <a
                    href={`https://dx.doi.org/${config.doi_prefix}/${id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-node-ink hover:underline"
                  >
                    {config.doi_prefix}/{id}
                  </a>
                ) : (
                  <span className="text-ink-faint">Queued For Creation</span>
                )}
              </p>
            </>
          )}
          {publicationDoi && (
            <>
              <b>Publication DOI:</b>
              <p className="m-0 overflow-hidden text-ellipsis leading-[1.4285em]">
                <a
                  href={`https://dx.doi.org/${publicationDoi}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-node-ink hover:underline"
                >
                  {publicationDoi}
                </a>
              </p>
            </>
          )}
        </Cell>
      );
    }

    // Counts (right-aligned counts, singular/plural labels, line-height 1); each
    // opens the contribution's modal at that level's tab. Legacy renders the
    // (possibly empty) table, never a placeholder.
    case "counts": {
      const counts = config.search_levels
        .filter((entry) => entry.count_field)
        .map((entry) => ({ entry, count: getPath(doc, entry.count_field as string) }))
        // A level with no records gets no row (and so no link to an empty tab).
        .filter(
          (item): item is { entry: SearchLevel; count: number } =>
            typeof item.count === "number" && item.count > 0,
        );
      return (
        <Cell width={width}>
          <table style={{ lineHeight: 1 }}>
            <tbody>
              {counts.map(({ entry, count }) => {
                const open = () => id && openContribution(id, entry.table);
                return (
                  <tr key={entry.name} className="hover:text-node-ink">
                    <td className="text-right" style={{ padding: 1 }}>
                      <button type="button" tabIndex={-1} onClick={open} className="cursor-pointer">
                        {abbreviateNumber(count)}
                      </button>
                    </td>
                    <td style={{ padding: 1 }}>
                      <button
                        type="button"
                        onClick={open}
                        title={`Show this contribution's ${entry.name}`}
                        className="cursor-pointer text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
                      >
                        {count === 1 ? singularize(entry.name) : entry.name}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Cell>
      );
    }

    // Map thumbnail (100px globe); click opens the contribution's Map tab
    case "map": {
      const markers = markersOf(doc, level);
      if (markers.length === 0) return <NoDataCell label="Geospatial" width={width} />;
      return (
        <Cell width={width} style={{ fontSize: 14, height: 104 }}>
          <button
            type="button"
            onClick={() => id && openContribution(id, "map")}
            aria-label="Show the locations on a map"
            className="block cursor-pointer rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <MapThumbnail markers={markers} width={100} height={100} />
          </button>
        </Cell>
      );
    }

    // Plot thumbnail: a plugin's (legacy SearchPlotThumbnail container), else none
    case "plot":
      return <NoPlotsCell width={width} />;

    // Geologic units then geographic names
    case "geo": {
      // The node's geography columns (node YAML `search.geography`).
      const geologic = unionOf(doc, config.geography?.geologic ?? []);
      const geographic = unionOf(doc, config.geography?.geographic ?? []);
      if (geologic.length === 0 && geographic.length === 0)
        return <NoDataCell label="Geographic" width={width} />;
      return (
        <Cell width={width} wrap>
          {geologic.length > 0 && (
            <ClampedField label="Geologic:" lines={geographic.length > 0 ? 2 : 5}>
              {geologic.join(", ")}
            </ClampedField>
          )}
          {geographic.length > 0 && (
            <ClampedField label="Geographic:" lines={geologic.length > 0 ? 2 : 5}>
              {geographic.join(", ")}
            </ClampedField>
          )}
        </Cell>
      );
    }

    case "citations": {
      const citations = listOf(
        getPath(doc, "summary._all.citation_dois") ?? getPath(doc, "summary._all.citations"),
      ).filter((citation) => !THIS_STUDY.test(citation));
      if (citations.length === 0)
        return (
          <NoDataCell
            label={
              <>
                Additional
                <br />
                Citations
              </>
            }
            width={width}
            dataWord={false}
          />
        );
      return (
        <Cell width={width} wrap>
          <ClampedField label="Citations:" lines={5}>
            {citations.join(", ")}
          </ClampedField>
        </Cell>
      );
    }

    // A column in bold over an optional subtitle column (the old record cards' title)
    case "title": {
      const block = (getPath(doc, `summary.${level.table}`) ?? {}) as Record<string, unknown>;
      const title = joined(block[column.column ?? ""]) || "Untitled";
      const subtitle = column.subtitle_column ? joined(block[column.subtitle_column]) : "";
      return (
        <OpenCell id={id} table={level.table} width={width}>
          <b>{title}</b>
          {subtitle && (
            <span className="block overflow-hidden text-gray-600" style={{ maxHeight: "4.5em" }}>
              {subtitle}
            </span>
          )}
        </OpenCell>
      );
    }

    // One column of the level's summary block: "Label: value"
    default: {
      const block = (getPath(doc, `summary.${level.table}`) ?? {}) as Record<string, unknown>;
      const value = block[column.column ?? ""];
      const text = column.format === "bytes" ? formatBytes(value) : joined(value);
      if (!text) return <NoDataCell label={column.label} width={width} />;
      return (
        <Cell width={width} wrap>
          <b>{column.label}:</b>
          <br />
          {text}
        </Cell>
      );
    }
  }
}
