import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import type { SearchLevel, SearchResult } from "../lib/types";
import { abbreviateNumber, cx, getPath, singularize } from "../lib/utils";
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

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

/** moment "LL" format: July 7, 2026 */
function formatDateLL(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function contributionId(doc: SearchResult): string | undefined {
  const id = getPath(doc, "summary.contribution.id") ?? doc.id;
  return id === undefined || id === null ? undefined : String(id);
}

function citationOf(doc: SearchResult): string | undefined {
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

const cellBase: CSSProperties = {
  marginRight: "1em",
  marginBottom: 5,
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
      className="shrink-0 overflow-hidden text-ellipsis text-center text-[#AAAAAA]"
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
function ClampedField({
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
        borderTop: "1px solid rgba(34,36,38,.15)",
        borderBottom: "1px solid rgba(255,255,255,.1)",
      }}
    />
  );
}

// --- Card frame (header row + collapsible data row + hover caret) ----------------

export interface ResultCardFrameProps {
  doc: SearchResult;
  level: SearchLevel;
  cells: ReactNode;
  expanded?: ReactNode;
  /** Collapsed data-row height cap; 105px default, 155px for the poles variant. */
  collapsedMaxHeight?: number;
}

export function ResultCardFrame({
  doc,
  level,
  cells,
  expanded,
  collapsedMaxHeight = 105,
}: ResultCardFrameProps) {
  const { data: config } = useNodeConfig();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // The caret tab hangs 1em below the card box (negative margin), so leaving
  // the card fires before the pointer reaches it; hide on a delay like legacy.
  const hideTimer = useRef<number | undefined>(undefined);
  const showCaret = () => {
    window.clearTimeout(hideTimer.current);
    setHovered(true);
  };
  const hideCaret = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHovered(false), 500);
  };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const id = contributionId(doc);
  const citation = citationOf(doc) ?? (id ? `Contribution ${id}` : "Unknown");
  const version = getPath(doc, "summary.contribution.version");
  const referenceTitle =
    level.table === "contribution"
      ? firstString(getPath(doc, "summary.contribution._reference.title"))
      : undefined;
  const breadcrumb = breadcrumbOf(doc, level, config?.search_levels ?? []);
  const timestamp = getPath(doc, "summary.contribution.timestamp");
  const contributor = firstString(getPath(doc, "summary.contribution._contributor"));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only toggles the caret button's visibility; expansion is keyboard-accessible via the header button
    <div
      className="relative flow-root text-left"
      style={{ lineHeight: "16px", color: "rgba(0,0,0,.87)" }}
      onMouseEnter={showCaret}
      onMouseLeave={hideCaret}
    >
      {/* Header/citation row (accordion trigger) */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="relative flex w-full cursor-pointer items-stretch text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ padding: "0 1em 0.5em", margin: "-3.5px -1em 0 0" }}
      >
        <span
          aria-hidden="true"
          className="absolute inline-flex items-center justify-center"
          style={{ left: -4.2, top: 0.8, width: "1.25em", height: "1.25em", fontSize: 14 }}
        >
          <Icon
            name="caret-right"
            className={cx("transition-transform", open && "rotate-90")}
            style={{ width: "1.15em", height: "1.15em" }}
          />
        </span>
        <span className="whitespace-nowrap text-[13px] font-bold">
          {citation}
          {version !== undefined && version !== null ? ` v. ${String(version)}` : ""}
        </span>
        <span
          className="mx-[0.5em] flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]"
          style={{ height: "1.25em" }}
        >
          {referenceTitle}
          {breadcrumb.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb parts can repeat and the ordered list is static per hit
            <span key={`${index}-${part}`}>
              {" ⇒ "}
              {index === breadcrumb.length - 1 ? <b>{part}</b> : part}
            </span>
          ))}
        </span>
        <span className="whitespace-nowrap text-right text-[13px]">
          {formatDateLL(timestamp)}
          {contributor && (
            <>
              {" by "}
              <b>{contributor}</b>
            </>
          )}
        </span>
      </button>

      {/* Flex data row: collapsed max-height cap with overflow hidden */}
      <div
        className="flex font-normal"
        style={
          open
            ? { flexWrap: "wrap", marginRight: "-1em" }
            : {
                maxHeight: collapsedMaxHeight,
                overflow: "hidden",
                whiteSpace: "nowrap",
                marginRight: "-1em",
              }
        }
      >
        {cells}
      </div>

      {open && expanded && (
        <div className="text-[13px]" style={{ padding: "0.5em 0 0" }}>
          {expanded}
        </div>
      )}

      {/* Grey caret tab straddling the card bottom edge, shown on hover */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseEnter={showCaret}
        onClick={() => setOpen(!open)}
        className={cx(
          "relative z-10 block h-[1.5em] w-[10em] rounded-b-sm border border-gray-300 bg-[#e0e1e2] p-[0.25em] text-center text-[10px] leading-none text-gray-600 hover:bg-[#cacbcd]",
          hovered ? "visible" : "invisible",
        )}
        style={{ margin: "1em auto -2.5em", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
      >
        <Icon name={open ? "caret-up" : "caret-down"} size="small" />
      </button>
    </div>
  );
}

// --- Default result item (11-cell legacy layout) ---------------------------------

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

function rangeText(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) {
    const numbers = value.map(Number).filter((n) => Number.isFinite(n));
    if (numbers.length === 0) return listOf(value).join(", ");
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return min === max ? String(min) : `${min} to ${max}`;
  }
  if (value === undefined || value === null) return "";
  return String(value);
}

/** Legacy intensity formatting: values are in Tesla; show nT/µT/mT/T. */
function formatIntensity(tesla: number): string {
  const nano = tesla * 1e9;
  const units: [number, string][] = [
    [1e9, "T"],
    [1e6, "mT"],
    [1e3, "µT"],
  ];
  for (const [threshold, unit] of units) {
    if (Math.abs(nano) >= threshold) return `${trimNumber(nano / threshold)} ${unit}`;
  }
  return `${trimNumber(nano)} nT`;
}

/** numeral "0[.]0[00]": up to three decimals, no trailing zeros. */
function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

const THIS_STUDY = /^this[_ ]study$/i;

/** Union of `summary._all.<column>` lists across several columns (legacy renderGeo). */
function unionOf(doc: SearchResult, columns: string[]): string[] {
  return columns.flatMap((column) => listOf(getPath(doc, `summary._all.${column}`)));
}

function markersOf(doc: SearchResult, level: SearchLevel): MapMarker[] {
  const sources =
    level.table === "contribution"
      ? [getPath(doc, "summary._all._geo_point")]
      : [
          getPath(doc, `summary.${level.table}._geo_point`),
          getPath(doc, "summary._all._geo_point"),
        ];
  for (const source of sources) {
    const markers = markersFromGeoPoint(source);
    if (markers.length > 0) return markers;
  }
  return [];
}

export function ResultItem({
  doc,
  level,
  privateKey,
  extraCell,
}: {
  doc: SearchResult;
  level: SearchLevel;
  privateKey?: string;
  /** Plugin slot: rendered in place of the plot-thumbnail placeholder cell. */
  extraCell?: ReactNode;
}) {
  const { data: config } = useNodeConfig();
  if (!config) return null;

  const id = contributionId(doc);
  const isActivated = doc._is_activated !== false;
  const keyParam = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";
  const publicationDoi = firstString(getPath(doc, "summary.contribution._reference.doi"));

  const counts = config.search_levels
    .filter((entry) => entry.count_field)
    .map((entry) => ({ entry, count: getPath(doc, entry.count_field as string) }))
    .filter(
      (item): item is { entry: SearchLevel; count: number } => typeof item.count === "number",
    );

  const geologyClasses = listOf(getPath(doc, "summary._all.geologic_classes"));
  const geologyTypes = listOf(getPath(doc, "summary._all.geologic_types"));
  const lithologies = listOf(getPath(doc, "summary._all.lithologies"));
  const geologyDefined = [geologyClasses, geologyTypes, lithologies].filter(
    (list) => list.length > 0,
  ).length;
  const geologyClamp = geologyDefined === 3 ? 1 : geologyDefined === 2 ? 2 : 5;

  const geologic = unionOf(doc, [
    "plate_blocks",
    "terranes",
    "geological_province_sections",
    "tectonic_settings",
  ]);
  const geographic = unionOf(doc, [
    "continent_ocean",
    "country",
    "ocean_sea",
    "region",
    "village_city",
    "location",
    "location_type",
    "location_alternatives",
  ]);

  const methodCodes = listOf(getPath(doc, "summary._all.method_codes"));
  const citations = listOf(
    getPath(doc, "summary._all.citation_dois") ?? getPath(doc, "summary._all.citations"),
  ).filter((citation) => !THIS_STUDY.test(citation));
  const age = rangeText(getPath(doc, "summary._all.ages") ?? getPath(doc, "summary._all.age"));
  const ageUnit = firstString(getPath(doc, "summary._all.age_unit"));
  const intensities = listOf(
    getPath(doc, "summary._all.int_abs") ?? getPath(doc, "summary._all.intensities"),
  )
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const markers = markersOf(doc, level);

  const contributionSummary = getPath(doc, "summary.contribution");
  const levelBlock = level.table !== "contribution" ? getPath(doc, `summary.${level.table}`) : null;

  // Legacy renderDownloadButton/renderLinks only exist on contribution cards.
  const isContribution = level.table === "contribution";

  const cells = (
    <>
      {/* 1. Download (100px cell; basic tiny fluid compact icon header button, height 100px) */}
      {!isContribution ? null : id ? (
        <Cell width={100} style={{ fontSize: 14, height: 104 }}>
          <a
            href={siteUrl(`/api/contributions/${id}/download${keyParam}`)}
            download
            className="inline-block w-full bg-white text-center font-bold text-node hover:bg-node-soft"
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
      ) : (
        <NoDataCell label="Download" width={100} />
      )}

      {/* 2. Links (200px) */}
      {!isContribution ? null : id ? (
        <Cell width={200}>
          <b>{config.key} Contribution Link:</b>
          <p className="m-0 overflow-hidden text-ellipsis leading-[1.4285em]">
            <Link
              to="/contributions/$id"
              params={{ id }}
              search={{ private_key: privateKey }}
              className="text-node hover:underline"
            >
              earthref.org/{config.key}/{id}
            </Link>
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
                    className="text-node hover:underline"
                  >
                    {config.doi_prefix}/{id}
                  </a>
                ) : (
                  <span className="text-[#AAAAAA]">Queued For Creation</span>
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
                  className="text-node hover:underline"
                >
                  {publicationDoi}
                </a>
              </p>
            </>
          )}
        </Cell>
      ) : (
        <NoDataCell label="Link" width={200} />
      )}

      {/* 3. Counts (135px table, right-aligned counts, singular/plural labels, line-height 1);
          legacy renders the (possibly empty) table, never a placeholder */}
      {counts.length > 0 ? (
        <Cell width={135}>
          <table style={{ lineHeight: 1 }}>
            <tbody>
              {counts.map(({ entry, count }) => (
                <tr key={entry.name}>
                  <td className="text-right" style={{ padding: 1 }}>
                    {abbreviateNumber(count)}
                  </td>
                  <td style={{ padding: 1 }}>
                    {` ${count === 1 ? singularize(entry.name) : entry.name}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cell>
      ) : (
        <Cell width={135}>{null}</Cell>
      )}

      {/* 4. Map thumbnail (100px globe) */}
      {markers.length > 0 ? (
        <Cell width={100} style={{ fontSize: 14, height: 104 }}>
          <MapThumbnail markers={markers} width={100} height={100} />
        </Cell>
      ) : (
        <NoDataCell label="Geospatial" width={100} />
      )}

      {/* 5. Plot thumbnail — plugin slot (legacy SearchPlotThumbnail container) */}
      {extraCell ?? (
        <div
          className="shrink-0 overflow-hidden text-ellipsis text-center text-[#AAAAAA]"
          style={{
            boxSizing: "content-box",
            minWidth: 98,
            maxWidth: 98,
            minHeight: 98,
            maxHeight: 98,
            marginRight: "1rem",
            marginBottom: 5,
            fontSize: 13,
            border: "1px solid rgba(0,0,0,.1)",
          }}
        >
          <br />
          No
          <br />
          <b>Plots</b>
          <br />
          Available
          <br />
          <br />
        </div>
      )}

      {/* 6. Geo (125px): geologic units then geographic names */}
      {geologic.length > 0 || geographic.length > 0 ? (
        <Cell width={125} wrap>
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
      ) : (
        <NoDataCell label="Geographic" width={125} />
      )}

      {/* 7. Geology (125px): Class / Type / Lithology */}
      {geologyDefined > 0 ? (
        <Cell width={125} wrap>
          {geologyClasses.length > 0 && (
            <ClampedField label="Class:" lines={geologyClamp}>
              {geologyClasses.join(", ")}
            </ClampedField>
          )}
          {geologyTypes.length > 0 && (
            <ClampedField label="Type:" lines={geologyClamp}>
              {geologyTypes.join(", ")}
            </ClampedField>
          )}
          {lithologies.length > 0 && (
            <ClampedField label="Lithology:" lines={geologyClamp}>
              {lithologies.join(", ")}
            </ClampedField>
          )}
        </Cell>
      ) : (
        <NoDataCell label="Geologic" width={125} />
      )}

      {/* 8. Age (120px) */}
      {age ? (
        <Cell width={120} wrap>
          <b>Age:</b>
          <br />
          {age}
          {ageUnit ? ` ${ageUnit}` : ""}
        </Cell>
      ) : (
        <NoDataCell label="Age" width={120} />
      )}

      {/* 9. Intensity (75px) */}
      {intensities.length > 0 ? (
        <Cell width={75} wrap>
          {Math.min(...intensities) === Math.max(...intensities) ? (
            <>
              <b>Int:</b>
              <br />
              {formatIntensity(intensities[0])}
              <br />
            </>
          ) : (
            <>
              <b>Min Int:</b>
              <br />
              {formatIntensity(Math.min(...intensities))}
              <br />
              <b>Max Int:</b>
              <br />
              {formatIntensity(Math.max(...intensities))}
              <br />
            </>
          )}
          <b>N: </b>
          {intensities.length}
        </Cell>
      ) : (
        <NoDataCell label="Intensity" width={75} />
      )}

      {/* 10. Method Codes (125px) */}
      {methodCodes.length > 0 ? (
        <Cell width={125} wrap>
          <ClampedField label="Method Codes:" lines={5}>
            {methodCodes.join(", ")}
          </ClampedField>
        </Cell>
      ) : (
        <NoDataCell
          label={
            <>
              Method
              <br />
              Codes
            </>
          }
          width={125}
          dataWord={false}
        />
      )}

      {/* 11. Citations (125px) */}
      {citations.length > 0 ? (
        <Cell width={125} wrap>
          <ClampedField label="Citations:" lines={5}>
            {citations.join(", ")}
          </ClampedField>
        </Cell>
      ) : (
        <NoDataCell
          label={
            <>
              Additional
              <br />
              Citations
            </>
          }
          width={125}
          dataWord={false}
        />
      )}
    </>
  );

  const summary = (
    typeof contributionSummary === "object" && contributionSummary !== null
      ? contributionSummary
      : {}
  ) as Record<string, unknown>;
  const citation = citationOf(doc);

  const expanded = (
    <div className="space-y-3 py-2">
      {/* Reference block: citation + Publication DOI */}
      {(citation || publicationDoi) && (
        <div className="text-[13px]">
          {citation && <p className="m-0 text-gray-800">{citation}</p>}
          {publicationDoi && (
            <p className="m-0 mt-0.5">
              <b>Publication DOI: </b>
              <a
                href={`https://dx.doi.org/${publicationDoi}`}
                target="_blank"
                rel="noreferrer"
                className="text-node hover:underline"
              >
                {publicationDoi}
              </a>
            </p>
          )}
        </div>
      )}

      {/* Versions table (contribution-level card only) */}
      {level.table === "contribution" && id && (
        <VersionsTable
          doc={doc}
          currentId={id}
          isActivated={isActivated}
          keyParam={keyParam}
          privateKey={privateKey}
          config={config}
          summary={summary}
        />
      )}

      {/* Per-level definition table for non-contribution cards */}
      {typeof levelBlock === "object" && levelBlock !== null && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {level.name} values
          </h4>
          <DefinitionTable data={levelBlock as Record<string, unknown>} />
        </div>
      )}
    </div>
  );

  return <ResultCardFrame doc={doc} level={level} cells={cells} expanded={expanded} />;
}

// --- Versions table (legacy "history table") ------------------------------------

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
  currentId,
  isActivated,
  keyParam,
  privateKey,
  config,
  summary,
}: {
  doc: SearchResult;
  currentId: string;
  isActivated: boolean;
  keyParam: string;
  privateKey?: string;
  config: { key: string; doi_prefix: string | null };
  summary: Record<string, unknown>;
}) {
  const rows = versionRows(summary, currentId, isActivated);
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Versions</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-gray-500">
              <th className="py-1 pr-3 font-medium">Download</th>
              <th className="py-1 pr-3 font-medium">Contribution Link</th>
              <th className="py-1 pr-3 font-medium">EarthRef Data DOI</th>
              <th className="py-1 pr-3 font-medium">Version</th>
              <th className="py-1 pr-3 font-medium">Data Model</th>
              <th className="py-1 pr-3 font-medium">Date</th>
              <th className="py-1 font-medium">Contributor</th>
            </tr>
          </thead>
          <tbody className="align-top">
            {rows.map((row) => (
              <tr key={`${row.id}-${row.version}`}>
                <td className="py-1 pr-3">
                  <a
                    href={siteUrl(`/api/contributions/${row.id}/download${keyParam}`)}
                    download
                    className="inline-flex items-center gap-1 text-node hover:underline"
                  >
                    <Icon name="download" size="small" /> txt
                  </a>
                </td>
                <td className="py-1 pr-3">
                  <Link
                    to="/contributions/$id"
                    params={{ id: row.id }}
                    search={{ private_key: privateKey }}
                    className="text-node hover:underline"
                  >
                    /contributions/{row.id}
                  </Link>
                </td>
                <td className="py-1 pr-3">
                  {config.doi_prefix ? (
                    row.isActivated ? (
                      <a
                        href={`https://dx.doi.org/${config.doi_prefix}/${row.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-node hover:underline"
                      >
                        {config.doi_prefix}/{row.id}
                      </a>
                    ) : (
                      <span className="text-[#AAAAAA]">Queued For Creation</span>
                    )
                  ) : (
                    <span className="text-[#AAAAAA]">—</span>
                  )}
                </td>
                <td className="py-1 pr-3">{row.version}</td>
                <td className="py-1 pr-3">{row.dataModel || "—"}</td>
                <td className="py-1 pr-3 whitespace-nowrap">{formatDateLL(row.date) || "—"}</td>
                <td className="py-1">{row.contributor || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
