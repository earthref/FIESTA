import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";
import type { GridColumn, SearchLevel, SearchResult } from "../lib/types";
import { cx } from "../lib/utils";
import { useVirtualRows } from "../lib/virtual-rows";
import { contributionId, SummaryCell } from "./result-item";
import { Icon } from "./ui/icon";
import { Skeleton, skeletonWidth } from "./ui/skeleton";

/** A tile's stand-in while its record's page loads: a thumbnail's square (a
 * map's globe), the record column's citation and title lines, or a label
 * and a value line. */
function SkeletonCell({ column, row, index }: { column: GridColumn; row: number; index: number }) {
  if (column.cell === "map" || column.cell === "plot") {
    const size = Math.min(column.width, 100);
    return <Skeleton round={column.cell === "map"} style={{ width: size, height: size }} />;
  }
  const lines = column.cell === "record" ? 3 : 2;
  return (
    <div className="flex flex-col gap-2 pt-0.5">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count lines
          key={line}
          className="h-3"
          style={{
            width: line === 0 && column.cell !== "record" ? "40%" : skeletonWidth(row, index, line),
          }}
        />
      ))}
    </div>
  );
}

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

const BORDER = "1px solid var(--er-line)";
// Padding on each side of a cell: 1em of the 13px cells (the legacy cells' right margin).
const GAP = 13;

/** A click on a link, button or form control inside a row is its own, as is
 * the end of a text selection. */
export function isRowClick(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  if (target.closest("a, button, input, select, textarea, label, summary, [role=button]")) {
    return false;
  }
  return !(event.type === "click" && window.getSelection()?.toString());
}

const cellStyle: CSSProperties = {
  boxSizing: "border-box",
  padding: `0 ${GAP}px`,
  verticalAlign: "top",
  textAlign: "left",
};

function HeaderCell({
  column,
  sort,
  onSort,
  filterMenu,
}: {
  column: GridColumn;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  filterMenu?: ReactNode;
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
          "flex min-w-0 cursor-pointer items-center gap-1 text-left font-bold hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
          active && "text-node-ink",
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
      <span className="block min-w-0 truncate font-bold">{column.label}</span>
    );
  return (
    <th
      scope="col"
      aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
      className="sticky top-0 z-10 bg-surface font-normal"
      style={{
        ...cellStyle,
        paddingTop: "0.5em",
        paddingBottom: "0.5em",
        boxShadow: "inset 0 -1px 0 var(--er-line)",
      }}
    >
      <div className="flex items-center gap-0.5">
        {label}
        {filterMenu}
      </div>
    </th>
  );
}

/**
 * Search records as a grid: one row per record, one column per tile the
 * level's `columns` name (node YAML, admin Summary Grid tab), under a sticky
 * header. With `onSort` a sortable column's header sorts the search; with
 * `filterMenu` a column may have a filter icon opening its filters (the search
 * page's ColumnFilterMenu). Without them (home page, private workspace) the
 * header only labels the tiles. With `scrollRef` (the element the grid
 * scrolls in) only the rows in view and `overscan` above and below are in the
 * DOM; `hits` may then be sparse (one entry per match, undefined until its
 * page arrives: a placeholder row), and `onRange` hears the rendered indexes
 * so their pages can be fetched. With `onOpen` a row is clickable: it
 * highlights and opens its record.
 */
export function SummaryGrid({
  level,
  hits,
  privateKey,
  header = true,
  sort,
  onSort,
  filterMenu,
  footer,
  scrollRef,
  overscan = 10,
  onOpen,
  onRange,
}: {
  level: SearchLevel;
  hits: (SearchResult | undefined)[];
  privateKey?: string;
  header?: boolean;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  /** A column's header filter icon and menu, or null for none. */
  filterMenu?: (column: GridColumn) => ReactNode;
  /** Rendered under the rows (loading placeholder, messages). */
  footer?: ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
  overscan?: number;
  onOpen?: (doc: SearchResult) => void;
  onRange?: (start: number, end: number) => void;
}) {
  const columns = level.columns ?? [];
  // The row last opened, highlighted (a new search replaces the records).
  const [selected, setSelected] = useState<SearchResult | null>(null);
  // A row with a thumbnail tile is its 105px cap tall; otherwise one line.
  const estimate = columns.some((c) => c.cell === "map" || c.cell === "plot") ? 129 : 41;
  const { startRef, indexes, measure, padTop, padBottom } = useVirtualRows({
    count: hits.length,
    scrollRef,
    estimateSize: () => estimate,
    overscan,
    onRange,
  });
  const open = (doc: SearchResult) => {
    setSelected(doc);
    onOpen?.(doc);
  };
  const spacer = (height: number, ref?: typeof startRef) => (
    <tr ref={ref}>
      <td colSpan={columns.length} style={{ height, padding: 0 }} />
    </tr>
  );
  const width = columns.reduce((total, column) => total + column.width + 2 * GAP, 0);
  return (
    <>
      <table
        className="text-[13px]"
        style={{
          tableLayout: "fixed",
          // Rows span the container; narrower columns than that share the extra.
          width: `max(${width}px, 100%)`,
          borderCollapse: "separate",
          borderSpacing: 0,
          lineHeight: "16px",
          color: "var(--er-ink)",
        }}
      >
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.width + 2 * GAP }} />
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
                  filterMenu={filterMenu?.(column)}
                />
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {spacer(padTop, startRef)}
          {indexes.map((index) => {
            const doc = hits[index];
            const divider = index < hits.length - 1 || footer ? BORDER : undefined;
            if (!doc) {
              return (
                <tr key={`loading-${index}`} data-index={index} ref={measure} aria-busy="true">
                  {columns.map((column, c) => (
                    <td
                      key={column.key}
                      style={{
                        ...cellStyle,
                        height: estimate,
                        paddingTop: "0.75em",
                        paddingBottom: "0.75em",
                        borderBottom: divider,
                      }}
                    >
                      <SkeletonCell column={column} row={index} index={c} />
                    </td>
                  ))}
                </tr>
              );
            }
            return (
              <tr
                // Sub-contribution hits can share a contribution id.
                key={`${contributionId(doc) ?? "hit"}-${index}`}
                data-index={index}
                ref={measure}
                tabIndex={onOpen ? 0 : undefined}
                aria-selected={onOpen ? selected === doc : undefined}
                onClick={onOpen && ((event) => isRowClick(event) && open(doc))}
                onKeyDown={
                  onOpen &&
                  ((event) => {
                    if (event.key === "Enter" && event.target === event.currentTarget) open(doc);
                  })
                }
                className={cx(
                  onOpen &&
                    "cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-node",
                  onOpen && selected !== doc && "hover:bg-gray-50",
                  selected === doc && "bg-node-soft",
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{
                      ...cellStyle,
                      paddingTop: "0.75em",
                      paddingBottom: "0.75em",
                      borderBottom: divider,
                    }}
                  >
                    <div style={{ maxHeight: 105, overflow: "hidden" }}>
                      <SummaryCell
                        column={column}
                        doc={doc}
                        level={level}
                        privateKey={privateKey}
                      />
                    </div>
                  </td>
                ))}
              </tr>
            );
          })}
          {padBottom > 0 && spacer(padBottom)}
        </tbody>
      </table>
      {footer}
    </>
  );
}
