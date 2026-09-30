import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { GridColumn, SearchLevel, SearchResult } from "../lib/types";
import { cx } from "../lib/utils";
import { contributionId, SummaryCell } from "./result-item";
import { Icon } from "./ui/icon";

/** A column header's sort: `sort=<key>:asc|desc` in the search URL. */
export interface GridSort {
  key: string;
  order: "asc" | "desc";
}

export function parseGridSort(sort: string | undefined): GridSort | undefined {
  const match = sort?.match(/^(.+):(asc|desc)$/);
  return match ? { key: match[1], order: match[2] as GridSort["order"] } : undefined;
}

/** `filter=<key>:<text>` entries in the search URL, by column key. */
export function parseGridFilters(filters: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of filters ?? []) {
    const at = entry.indexOf(":");
    if (at > 0) out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

export function formatGridFilters(filters: Record<string, string>): string[] {
  return Object.entries(filters)
    .filter(([, text]) => text.trim())
    .map(([key, text]) => `${key}:${text}`);
}

const BORDER = "1px solid rgba(34,36,38,.15)";
// Space after each column: 1em of the 13px cells (the legacy cells' right margin).
const GAP = 13;

const cellStyle: CSSProperties = {
  boxSizing: "border-box",
  padding: `0 ${GAP}px 0 0`,
  verticalAlign: "top",
  textAlign: "left",
};

/** A column's filter box: typing updates the search after a pause. */
function FilterInput({
  column,
  value,
  onChange,
}: {
  column: GridColumn;
  value: string;
  onChange: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = window.setTimeout(() => latest.current(text), 400);
    return () => window.clearTimeout(timer);
  }, [text, value]);
  return (
    <input
      type="search"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") latest.current(text);
      }}
      placeholder="Filter"
      aria-label={`Filter by ${column.label}`}
      className="mt-1 w-full rounded-sm border border-gray-300 bg-white px-1.5 py-0.5 text-[12px] font-normal focus:border-node focus:outline-hidden"
    />
  );
}

function HeaderCell({
  column,
  sort,
  onSort,
  filter,
  onFilter,
}: {
  column: GridColumn;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  filter?: string;
  onFilter?: (text: string) => void;
}) {
  const active = sort?.key === column.key ? sort.order : undefined;
  // Ascending, then descending, then back to the default order.
  const next = (): GridSort | undefined =>
    active === undefined
      ? { key: column.key, order: "asc" }
      : active === "asc"
        ? { key: column.key, order: "desc" }
        : undefined;
  const label =
    onSort && column.sortable ? (
      <button
        type="button"
        onClick={() => onSort(next())}
        title={`Sort by ${column.label}`}
        className={cx(
          "flex w-full cursor-pointer items-center gap-1 text-left font-bold hover:text-node focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
          active && "text-node",
        )}
      >
        <span className="truncate">{column.label}</span>
        <Icon
          name={active === "desc" ? "caret-down" : "caret-up"}
          className={cx("shrink-0", !active && "opacity-25")}
          style={{ width: "0.9em", height: "0.9em" }}
        />
      </button>
    ) : (
      <span className="block truncate font-bold">{column.label}</span>
    );
  return (
    <th
      scope="col"
      aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
      className="sticky top-0 z-10 bg-white font-normal"
      style={{
        ...cellStyle,
        paddingTop: "0.5em",
        paddingBottom: "0.5em",
        boxShadow: "inset 0 -1px 0 rgba(34,36,38,.15)",
      }}
    >
      {label}
      {onFilter && column.filterable && (
        <FilterInput column={column} value={filter ?? ""} onChange={onFilter} />
      )}
    </th>
  );
}

/**
 * Search records as a grid: one row per record, one column per tile the
 * level's `columns` name (node YAML, admin Summary Grid tab), under a sticky
 * header. With `onSort` a sortable column's header sorts the search; with
 * `onFilter` a filterable one has a filter box. Without them (home page,
 * private workspace) the header only labels the tiles.
 */
export function SummaryGrid({
  level,
  hits,
  privateKey,
  header = true,
  sort,
  onSort,
  filters,
  onFilter,
  footer,
}: {
  level: SearchLevel;
  hits: SearchResult[];
  privateKey?: string;
  header?: boolean;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  filters?: Record<string, string>;
  onFilter?: (key: string, text: string) => void;
  /** Rendered under the rows (loading placeholder, messages). */
  footer?: ReactNode;
}) {
  const columns = level.columns ?? [];
  const width = columns.reduce((total, column) => total + column.width + GAP, 0);
  return (
    <>
      <table
        className="text-[13px]"
        style={{
          tableLayout: "fixed",
          width,
          borderCollapse: "separate",
          borderSpacing: 0,
          lineHeight: "16px",
          color: "rgba(0,0,0,.87)",
        }}
      >
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width + GAP }} />
          ))}
        </colgroup>
        {header && (
          <thead>
            <tr>
              {columns.map((column) => (
                <HeaderCell
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSort={onSort}
                  filter={filters?.[column.key]}
                  onFilter={onFilter ? (text) => onFilter(column.key, text) : undefined}
                />
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {hits.map((doc, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: sub-contribution hits can share a contribution id; pages are append-only
            <tr key={`${contributionId(doc) ?? "hit"}-${index}`}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{
                    ...cellStyle,
                    paddingTop: "0.75em",
                    paddingBottom: "0.75em",
                    borderBottom: index < hits.length - 1 || footer ? BORDER : undefined,
                  }}
                >
                  <div style={{ maxHeight: 105, overflow: "hidden" }}>
                    <SummaryCell column={column} doc={doc} level={level} privateKey={privateKey} />
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </>
  );
}
