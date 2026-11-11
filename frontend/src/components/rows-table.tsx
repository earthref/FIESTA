import { type ReactNode, type RefObject, useMemo } from "react";
import type { CellIssue, SearchResult } from "../lib/types";
import { cx } from "../lib/utils";
import { useVirtualRows } from "../lib/virtual-rows";
import type { GridSort } from "./summary-grid";
import { Icon } from "./ui/icon";
import { Skeleton, skeletonWidth } from "./ui/skeleton";

/** One row of a Rows grid: its values, an optional leading label (its row in
 * the file) and validation issues by column ("" for the whole row). */
export interface GridRow {
  key: string;
  label?: string;
  values: Record<string, unknown>;
  issues?: Record<string, CellIssue>;
}

/** The validation colors of the online editor's cells (error red, warning amber). */
const ISSUE_CLASS: Record<CellIssue["severity"], string> = {
  error: "bg-red-100",
  warning: "bg-amber-100",
};

function issueTitle(issue: CellIssue): string {
  const kind = issue.severity === "error" ? "Error" : "Warning";
  return issue.messages.map((message) => `${kind}: ${message}`).join("\n");
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isBlank(value: unknown): boolean {
  return display(value).trim() === "";
}

/** Two cells' order: numerically when both are numbers, otherwise as text. */
function compareCells(a: unknown, b: unknown): number {
  const left = display(a).trim();
  const right = display(b).trim();
  const x = Number(left);
  const y = Number(right);
  if (left && right && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/**
 * A search hit's raw rows. The search sorts the hits by a `rows.<column>`
 * sort (on their rows' smallest or largest value), so with `sort` the hit's
 * own rows are ordered the same way (blanks last).
 */
export function rowsOfHit(hit: SearchResult, h: number, sort?: GridSort): GridRow[] {
  const rows = Array.isArray(hit.rows) ? (hit.rows as Record<string, unknown>[]) : [];
  const ordered = sort
    ? [...rows].sort((a, b) => {
        const blankA = isBlank(a?.[sort.key]);
        const blankB = isBlank(b?.[sort.key]);
        if (blankA || blankB) return Number(blankA) - Number(blankB);
        const order = compareCells(a[sort.key], b[sort.key]);
        return sort.order === "asc" ? order : -order;
      })
    : rows;
  return ordered.map((values, i) => ({ key: `${h}-${i}`, values: values ?? {} }));
}

/** The loaded rows' columns in first-seen order (from the first 200 rows). */
export function columnsOf(items: (GridRow[] | undefined)[]): string[] {
  const keys = new Set<string>();
  let seen = 0;
  for (const item of items) {
    if (!item) continue;
    for (const row of item) {
      for (const key of Object.keys(row.values)) keys.add(key);
      if (++seen >= 200) return [...keys];
    }
  }
  return [...keys];
}

const TH =
  "sticky top-0 z-10 whitespace-nowrap bg-gray-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600";
const TD = "whitespace-nowrap px-3 py-2 align-top text-gray-800";

function SortHeader({
  column,
  sort,
  onSort,
  issue,
}: {
  column: string;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  issue?: CellIssue;
}) {
  const active = sort?.key === column ? sort.order : undefined;
  // Ascending, then descending, then back to the default order.
  const next = (): GridSort | undefined =>
    active === undefined
      ? { key: column, order: "asc" }
      : active === "asc"
        ? { key: column, order: "desc" }
        : undefined;
  return (
    <th
      scope="col"
      aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
      title={issue && issueTitle(issue)}
      className={cx(TH, issue && ISSUE_CLASS[issue.severity])}
      style={{ boxShadow: "inset 0 -1px 0 var(--er-line)" }}
    >
      {onSort ? (
        <button
          type="button"
          onClick={() => onSort(next())}
          title={`Sort by ${column}`}
          className={cx(
            "inline-flex cursor-pointer items-center gap-1 uppercase hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
            active && "text-node-ink",
          )}
        >
          {column}
          <Icon
            name={active === "desc" ? "caret-down" : "caret-up"}
            className={cx("shrink-0", !active && "opacity-25")}
            style={{ width: "0.9em", height: "0.9em" }}
          />
        </button>
      ) : (
        column
      )}
    </th>
  );
}

/** Fixed column widths from the header and the first loaded rows' values, so
 * the columns hold still while rows scroll in and out. */
function columnWidths(columns: string[], items: (GridRow[] | undefined)[]): number[] {
  const longest = columns.map((column) => column.length * 1.1 + 2);
  let seen = 0;
  outer: for (const item of items) {
    if (!item) continue;
    for (const row of item) {
      columns.forEach((column, i) => {
        longest[i] = Math.max(longest[i], display(row.values[column]).length);
      });
      if (++seen >= 200) break outer;
    }
  }
  // ~7.5px a character at 14px, the cell's 24px padding, within 60–360px.
  return longest.map((chars) => Math.min(360, Math.max(60, Math.ceil(chars * 7.5) + 24)));
}

/** A row's height (one line of 14px text and its padding). */
const ROW_HEIGHT = 37;

/**
 * Raw rows as one grid (the search page's Rows view, the contribution
 * modal's level tabs): a sticky header whose columns sort with `onSort`.
 * `items` are the grid's records, each its rows (a search hit's rows, or one
 * row of a file's table), and may be sparse: undefined until its page
 * arrives, shown as `estimateRows` skeleton rows. With `scrollRef`
 * (the element it scrolls in) only the items in view and `overscan` above
 * and below are in the DOM, and `onRange` hears their indexes so their pages
 * can be fetched. Cells with validation issues take the online editor's
 * colors, with the messages as their tooltip; a long value is cut short with
 * the whole of it as the tooltip.
 */
export function RowsGrid({
  items,
  columns,
  labelled = false,
  estimateRows = 1,
  sort,
  onSort,
  columnIssues,
  scrollRef,
  overscan = 25,
  onRange,
  footer,
  empty = "No row data for these results.",
}: {
  items: (GridRow[] | undefined)[];
  columns: string[];
  /** A leading column of the rows' labels (their row in the file). */
  labelled?: boolean;
  estimateRows?: number;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  columnIssues?: Record<string, CellIssue>;
  scrollRef?: RefObject<HTMLElement | null>;
  overscan?: number;
  onRange?: (start: number, end: number) => void;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  // A record still loading: skeleton rows, as many as a record has on average.
  const placeholderRows = Math.max(1, Math.round(estimateRows));
  const { startRef, indexes, measure, padTop, padBottom } = useVirtualRows({
    count: items.length,
    scrollRef,
    estimateSize: (index) => (items[index]?.length || Math.max(1, estimateRows)) * ROW_HEIGHT,
    overscan,
    onRange,
  });
  // Widths settle once the first rows arrive; later pages keep them.
  const loaded = items.some(Boolean);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured from the first rows only
  const widths = useMemo(() => columnWidths(columns, items), [columns, loaded]);

  if (items.length === 0) {
    return <p className="py-8 text-center text-[13px] text-gray-500">{empty}</p>;
  }
  const span = columns.length + (labelled ? 1 : 0);
  const labelWidth = 64;
  const width = widths.reduce((total, w) => total + w, labelled ? labelWidth : 0);
  return (
    <>
      <table
        className="border-separate border-spacing-0 text-left text-sm"
        style={{ tableLayout: "fixed", width: `max(${width}px, 100%)` }}
      >
        <colgroup>
          {labelled && <col style={{ width: labelWidth }} />}
          {widths.map((w, i) => (
            <col key={columns[i]} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {labelled && (
              <th scope="col" className={TH} style={{ boxShadow: "inset 0 -1px 0 var(--er-line)" }}>
                <span className="sr-only">Row</span>
              </th>
            )}
            {columns.map((column) => (
              <SortHeader
                key={column}
                column={column}
                sort={sort}
                onSort={onSort}
                issue={columnIssues?.[column]}
              />
            ))}
          </tr>
        </thead>
        <tbody ref={startRef}>
          <tr>
            <td colSpan={span} style={{ height: padTop, padding: 0 }} />
          </tr>
        </tbody>
        {indexes.map((index) => {
          const item = items[index];
          if (!item) {
            return (
              <tbody key={`loading-${index}`} data-index={index} ref={measure} aria-busy="true">
                {Array.from({ length: placeholderRows }, (_, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton rows
                  <tr key={r} style={{ height: ROW_HEIGHT }}>
                    {labelled && (
                      <td className={cx(TD, "border-b border-gray-100")}>
                        <Skeleton className="ml-auto h-3 w-6" />
                      </td>
                    )}
                    {columns.map((column, c) => (
                      <td key={column} className={cx(TD, "border-b border-gray-100")}>
                        <Skeleton className="h-3" style={{ width: skeletonWidth(index + r, c) }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            );
          }
          return (
            <tbody key={`item-${index}`} data-index={index} ref={measure}>
              {item.map((row) => {
                const rowIssue = row.issues?.[""];
                return (
                  <tr
                    key={row.key}
                    className="hover:bg-gray-50/60"
                    title={rowIssue && issueTitle(rowIssue)}
                  >
                    {labelled && (
                      <td
                        className={cx(
                          TD,
                          "border-b border-gray-100 text-right text-xs text-gray-500 tabular-nums",
                          rowIssue && ISSUE_CLASS[rowIssue.severity],
                        )}
                      >
                        {row.label}
                      </td>
                    )}
                    {columns.map((column) => {
                      const issue = row.issues?.[column] ?? rowIssue;
                      const text = display(row.values[column]);
                      return (
                        <td
                          key={column}
                          title={issue ? issueTitle(issue) : text.length > 40 ? text : undefined}
                          className={cx(
                            TD,
                            "overflow-hidden text-ellipsis border-b border-gray-100",
                            issue && ISSUE_CLASS[issue.severity],
                          )}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          );
        })}
        {padBottom > 0 && (
          <tbody>
            <tr>
              <td colSpan={span} style={{ height: padBottom, padding: 0 }} />
            </tr>
          </tbody>
        )}
      </table>
      {footer}
    </>
  );
}
