import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useNodeConfig } from "../lib/config";
import type { SearchLevel, SearchResult } from "../lib/types";
import { abbreviateNumber, cx, getPath } from "../lib/utils";

const NAME_COLUMNS = ["location", "site", "sample", "specimen", "core", "section", "experiment"];

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

function joined(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
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

/** "{location} ⇒ {site}" breadcrumb from each summary block's name column. */
function breadcrumbOf(doc: SearchResult, level: SearchLevel, levels: SearchLevel[]): string[] {
  if (level.table === "contribution") return [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const entry of levels) {
    if (entry.table === "contribution" || seen.has(entry.table)) continue;
    seen.add(entry.table);
    const block = getPath(doc, `summary.${entry.table}`);
    if (block && typeof block === "object") {
      for (const column of NAME_COLUMNS) {
        const name = firstString((block as Record<string, unknown>)[column]);
        if (name) {
          parts.push(name);
          break;
        }
      }
    }
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
}: {
  width: number;
  wrap?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("shrink-0 overflow-hidden", className)}
      style={{
        ...cellBase,
        minWidth: width,
        maxWidth: width,
        whiteSpace: wrap ? "normal" : "nowrap",
      }}
    >
      {children}
    </div>
  );
}

/** Grey centered "No X Data" placeholder with the legacy <br> structure. */
export function NoDataCell({ label, width }: { label: string; width: number }) {
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
      Data
      <br />
      <br />
    </div>
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

  const id = contributionId(doc);
  const citation = citationOf(doc) ?? (id ? `Contribution ${id}` : "Contribution");
  const version = getPath(doc, "summary.contribution.version");
  const breadcrumb = breadcrumbOf(doc, level, config?.search_levels ?? []);
  const timestamp = getPath(doc, "summary.contribution.timestamp");
  const contributor = firstString(getPath(doc, "summary.contribution._contributor"));

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only toggles the caret button's visibility; expansion is keyboard-accessible via the header button
    <div
      className="relative py-2 text-left"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Header/citation row (accordion trigger) */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-baseline px-[1em] pb-[0.5em] text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        <span
          aria-hidden="true"
          className={cx("mr-1 text-[10px] text-gray-400 transition-transform", open && "rotate-90")}
        >
          ▶
        </span>
        <span className="whitespace-nowrap text-[13px] font-bold">
          {citation}
          {version !== undefined && version !== null ? `, v.${String(version)}` : ""}
        </span>
        <span
          className="mx-[0.5em] flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]"
          style={{ height: "1.25em" }}
        >
          {breadcrumb.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb parts can repeat and the ordered list is static per hit
            <span key={`${index}-${part}`}>
              {index > 0 && " ⇒ "}
              {index === breadcrumb.length - 1 ? <b>{part}</b> : part}
            </span>
          ))}
        </span>
        <span className="whitespace-nowrap text-right text-[13px] text-gray-600">
          {formatDateLL(timestamp)}
          {contributor && (
            <>
              {" by "}
              <b>{contributor}</b>
            </>
          )}
        </span>
      </button>

      {/* Flex data row: collapsed max-height cap with overflow hidden */}
      <div
        className="flex px-[1em] font-normal"
        style={
          open
            ? { flexWrap: "wrap" }
            : { maxHeight: collapsedMaxHeight, overflow: "hidden", whiteSpace: "nowrap" }
        }
      >
        {cells}
      </div>

      {open && expanded && (
        <div className="px-[1em] text-[13px]" style={{ paddingBottom: 0 }}>
          {expanded}
        </div>
      )}

      {/* Grey caret tab straddling the card bottom edge, shown on hover */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setOpen(!open)}
        className={cx(
          "relative z-10 block h-[1.5em] w-[10em] rounded-b-sm border border-gray-300 bg-[#e0e1e2] p-[0.25em] text-center text-[10px] leading-none text-gray-600 hover:bg-[#cacbcd]",
          hovered ? "visible" : "invisible",
        )}
        style={{ margin: "1em auto -2.5em", borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
      >
        {open ? "▲" : "▼"}
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
    if (numbers.length === 0) return joined(value);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    return min === max ? String(min) : `${min} to ${max}`;
  }
  if (value === undefined || value === null) return "";
  return String(value);
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
    .filter(({ count }) => typeof count === "number");

  const geologyClasses = joined(getPath(doc, "summary._all.geologic_classes"));
  const geologyTypes = joined(getPath(doc, "summary._all.geologic_types"));
  const lithologies = joined(getPath(doc, "summary._all.lithologies"));
  const methodCodes = joined(getPath(doc, "summary._all.method_codes"));
  const lat = rangeText(getPath(doc, "summary._all.lat"));
  const lon = rangeText(getPath(doc, "summary._all.lon"));
  const age = rangeText(getPath(doc, "summary._all.ages") ?? getPath(doc, "summary._all.age"));
  const ageUnit = firstString(getPath(doc, "summary._all.age_unit"));
  const intensity = rangeText(
    getPath(doc, "summary._all.int_abs") ?? getPath(doc, "summary._all.intensities"),
  );
  const citations = joined(
    getPath(doc, "summary._all.citation_dois") ?? getPath(doc, "summary._all.citations"),
  );

  const contributionSummary = getPath(doc, "summary.contribution");
  const levelBlock = level.table !== "contribution" ? getPath(doc, `summary.${level.table}`) : null;

  const cells = (
    <>
      {/* 1. Download (100px cell, button height 100px, padding 20px 0) */}
      {id ? (
        <Cell width={100}>
          <a
            href={`/api/contributions/${id}/download${keyParam}`}
            download
            className="block w-full rounded-sm border border-node text-center font-medium text-node hover:bg-node-soft"
            style={{ padding: "20px 0", height: 100 }}
          >
            <span aria-hidden="true" className="block text-[1.5em]">
              📄
            </span>
            Download
          </a>
        </Cell>
      ) : (
        <NoDataCell label="Download" width={100} />
      )}

      {/* 2. Links (200px) */}
      {id ? (
        <Cell width={200}>
          <b>{config.key} Contribution Link:</b>
          <p className="m-0 overflow-hidden text-ellipsis">
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
              <p className="m-0 overflow-hidden text-ellipsis">
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
              <p className="m-0 overflow-hidden text-ellipsis">
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

      {/* 3. Counts (135px table, right-aligned counts, line-height 1) */}
      {counts.length > 0 ? (
        <Cell width={135}>
          <table style={{ lineHeight: 1 }}>
            <tbody>
              {counts.map(({ entry, count }) => (
                <tr key={entry.name}>
                  <td className="pr-1 text-right font-medium">{abbreviateNumber(count)}</td>
                  <td className="text-gray-600">{entry.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cell>
      ) : (
        <NoDataCell label="Count" width={135} />
      )}

      {/* 4. Map thumbnail placeholder (100px) */}
      <NoDataCell label="Map" width={100} />

      {/* 5. Plot thumbnail — plugin slot */}
      {extraCell ?? <NoDataCell label="Plot" width={125} />}

      {/* 6. Geo (125px) */}
      {lat || lon ? (
        <Cell width={125} wrap>
          <b>Geographic:</b>
          <br />
          {lat && <>Lat {lat}</>}
          {lat && lon && <br />}
          {lon && <>Lon {lon}</>}
        </Cell>
      ) : (
        <NoDataCell label="Geographic" width={125} />
      )}

      {/* 7. Geology (125px) */}
      {geologyClasses || geologyTypes || lithologies ? (
        <Cell width={125} wrap>
          {geologyClasses && (
            <div className="line-clamp-2">
              <b>Class:</b> {geologyClasses}
            </div>
          )}
          {geologyTypes && (
            <div className="line-clamp-2">
              <b>Type:</b> {geologyTypes}
            </div>
          )}
          {lithologies && (
            <div className="line-clamp-2">
              <b>Lithology:</b> {lithologies}
            </div>
          )}
        </Cell>
      ) : (
        <NoDataCell label="Geology" width={125} />
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
      {intensity ? (
        <Cell width={75} wrap>
          <b>Intensity:</b>
          <br />
          {intensity}
        </Cell>
      ) : (
        <NoDataCell label="Intensity" width={75} />
      )}

      {/* 10. Method Codes (125px) */}
      {methodCodes ? (
        <Cell width={125} wrap>
          <div className="line-clamp-4">
            <b>Method Codes:</b> {methodCodes}
          </div>
        </Cell>
      ) : (
        <NoDataCell label="Method Codes" width={125} />
      )}

      {/* 11. Citations (125px) */}
      {citations ? (
        <Cell width={125} wrap>
          <div className="line-clamp-4">
            <b>Citations:</b> {citations}
          </div>
        </Cell>
      ) : (
        <NoDataCell label="Citations" width={125} />
      )}
    </>
  );

  const expanded = (
    <div className="space-y-3">
      {typeof contributionSummary === "object" && contributionSummary !== null && (
        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Contribution summary
          </h4>
          <DefinitionTable data={contributionSummary as Record<string, unknown>} />
        </div>
      )}
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
