import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import type { CellIssue, SearchResult } from "../lib/types";
import { cx } from "../lib/utils";
import { useVirtualRows } from "../lib/virtual-rows";
import type { GridSort } from "./summary-grid";
import { Icon } from "./ui/icon";

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
 * Search hits' raw rows, each hit's rows in order. The search sorts the hits
 * by a `rows.<column>` sort (on their rows' smallest or largest value), so
 * with `sort` each hit's own rows are ordered the same way (blanks last).
 */
export function rowsOfHits(hits: SearchResult[], sort?: GridSort): GridRow[] {
  return hits.flatMap((hit, h) => {
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
  });
}

/** The rows' columns in first-seen order. */
export function columnsOf(rows: GridRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 200)) {
    for (const key of Object.keys(row.values)) keys.add(key);
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

/**
 * Raw rows as one grid (the search page's Rows view, the contribution
 * modal's level tabs): a sticky header whose columns sort with `onSort`, and,
 * with `scrollRef` (the element it scrolls in), only the rows in view and
 * `overscan` above and below in the DOM; `onEndReached` asks for the next
 * page once the last row renders. Cells with validation issues take the
 * online editor's colors, with the messages as their tooltip.
 */
export function RowsGrid({
  rows,
  columns,
  sort,
  onSort,
  columnIssues,
  scrollRef,
  overscan = 25,
  onEndReached,
  footer,
  empty = "No row data for these results.",
}: {
  rows: GridRow[];
  columns: string[];
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  columnIssues?: Record<string, CellIssue>;
  scrollRef?: RefObject<HTMLElement | null>;
  overscan?: number;
  onEndReached?: () => void;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  const labelled = rows.some((row) => row.label !== undefined);
  const { bodyRef, indexes, measure, padTop, padBottom } = useVirtualRows({
    count: rows.length,
    scrollRef,
    estimateSize: 37,
    overscan,
  });
  const lastIndex = indexes[indexes.length - 1];
  const endReached = useRef(onEndReached);
  endReached.current = onEndReached;
  useEffect(() => {
    if (lastIndex !== undefined && lastIndex >= rows.length - 1) endReached.current?.();
  }, [lastIndex, rows.length]);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-[13px] text-gray-500">{empty}</p>;
  }
  const span = columns.length + (labelled ? 1 : 0);
  const spacer = (height: number) =>
    height > 0 && (
      <tr>
        <td colSpan={span} style={{ height, padding: 0 }} />
      </tr>
    );
  return (
    <>
      <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
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
        <tbody ref={bodyRef}>
          {spacer(padTop)}
          {indexes.map((index) => {
            const row = rows[index];
            const rowIssue = row.issues?.[""];
            return (
              <tr
                key={row.key}
                data-index={index}
                ref={measure}
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
                  return (
                    <td
                      key={column}
                      title={issue && issueTitle(issue)}
                      className={cx(
                        TD,
                        "border-b border-gray-100",
                        issue && ISSUE_CLASS[issue.severity],
                      )}
                    >
                      {display(row.values[column])}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {spacer(padBottom)}
        </tbody>
      </table>
      {footer}
    </>
  );
}
