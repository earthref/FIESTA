import { Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react";
import { typeUnitLabel, useDataModelTable } from "../lib/data-model";
import type { CellIssue, DataModelColumn, DataModelTable, SearchResult } from "../lib/types";
import { cx } from "../lib/utils";
import { useVirtualRows } from "../lib/virtual-rows";
import { type GridSort, isRowClick } from "./summary-grid";
import { Icon } from "./ui/icon";
import { Skeleton, skeletonWidth } from "./ui/skeleton";

/** One row of a Rows grid: its values, an optional leading label (its row in
 * the file) and validation issues by column ("" for the whole row). */
export interface GridRow {
  key: string;
  label?: string;
  /** The row's core id in its contribution (else its values' `row_id`). */
  rowId?: number;
  values: Record<string, unknown>;
  issues?: Record<string, CellIssue>;
  /** The search hit the row is from (the search page's Data view). */
  hit?: SearchResult;
}

/** A row's persistent link: its number (`<contribution>.<row_id>`), the
 * node path it links to (`672.59`, the /$page route) and what a plain click
 * does instead of following it. */
export interface RowLink {
  label: string;
  page: string;
  onOpen: () => void;
}

/** The columns a row's number (`<contribution>.<row_id>`) shows, so a grid
 * with row links leaves them out. */
export const ROW_ID_COLUMNS = new Set(["contribution_id", "row_id"]);

/** A row's persistent link, from its core id (the API's, else its values'
 * `row_id`) and its contribution, or undefined. */
export function rowLinkOf(
  row: GridRow,
  onOpen: () => void,
  contribution?: string,
): RowLink | undefined {
  const rowId = String(row.rowId ?? row.values.row_id ?? "").trim();
  const id = String(contribution ?? row.values.contribution_id ?? "").trim();
  if (!/^\d+$/.test(rowId) || !/^\d+$/.test(id)) return undefined;
  return { label: `${id}.${rowId}`, page: `${id}.${rowId}`, onOpen };
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
  return ordered.map((values, i) => ({ key: `${h}-${i}`, values: values ?? {}, hit }));
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

const TH = "whitespace-nowrap bg-gray-50 px-3 text-left text-[13px]";
const TD = "whitespace-nowrap px-3 py-2 align-top text-gray-800";
const UNDERLINE = { boxShadow: "inset 0 -1px 0 var(--er-line)" };

/** The header's three cells for one column: its name (sorting with
 * `onSort`), its field (the column in the file) and its type, from the data
 * model. A column the data model lacks is named by its field. */
function headerCells({
  column,
  model,
  sort,
  onSort,
  issue,
}: {
  column: string;
  model?: DataModelColumn;
  sort?: GridSort;
  onSort?: (sort: GridSort | undefined) => void;
  issue?: CellIssue;
}): [ReactNode, ReactNode, ReactNode] {
  const active = sort?.key === column ? sort.order : undefined;
  // Ascending, then descending, then back to the default order.
  const next = (): GridSort | undefined =>
    active === undefined
      ? { key: column, order: "asc" }
      : active === "asc"
        ? { key: column, order: "desc" }
        : undefined;
  const tint = issue && ISSUE_CLASS[issue.severity];
  const title = issue && issueTitle(issue);
  const name = model?.label || column;
  return [
    <th
      key={column}
      scope="col"
      aria-sort={active === "asc" ? "ascending" : active === "desc" ? "descending" : undefined}
      title={title ?? model?.description}
      className={cx(TH, "overflow-hidden text-ellipsis pt-2 font-semibold text-gray-700", tint)}
    >
      {onSort ? (
        <button
          type="button"
          onClick={() => onSort(next())}
          title={`Sort by ${name}`}
          className={cx(
            "inline-flex cursor-pointer items-center gap-1 hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
            active && "text-node-ink",
          )}
        >
          {name}
          <Icon
            name={active === "desc" ? "caret-down" : "caret-up"}
            className={cx("shrink-0", !active && "opacity-25")}
            style={{ width: "0.9em", height: "0.9em" }}
          />
        </button>
      ) : (
        name
      )}
    </th>,
    <th
      key={column}
      scope="col"
      title={title}
      className={cx(TH, "overflow-hidden text-ellipsis font-mono font-normal text-gray-600", tint)}
    >
      {column}
    </th>,
    <th
      key={column}
      scope="col"
      title={title}
      className={cx(TH, "overflow-hidden text-ellipsis pb-2 font-normal text-gray-500", tint)}
      style={UNDERLINE}
    >
      {model ? typeUnitLabel(model) : ""}
    </th>,
  ];
}

/** Fixed column widths from the header (name, field, type) and the first
 * loaded rows' values, so the columns hold still while rows scroll in and out. */
function columnWidths(
  columns: string[],
  items: (GridRow[] | undefined)[],
  model?: DataModelTable,
): number[] {
  const longest = columns.map((column) => {
    const entry = model?.columns[column];
    // In characters of the 14px cells: the 12px bold name and its sort caret,
    // the 12px monospaced field, the 12px type.
    const name = (entry?.label || column).length * 0.95 + 2.5;
    const type = entry ? typeUnitLabel(entry).length * 0.85 : 0;
    return Math.max(name, column.length * 0.97, type);
  });
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
/** A group header row's height (one line of 13px text and its padding). */
const GROUP_HEIGHT = 33;

/**
 * Raw rows as one grid (the search page's Data view, the contribution
 * modal's level tabs) under a sticky three-row header: each column's name,
 * field and type from the node's latest data model (`table`), the name
 * sorting with `onSort`.
 * `items` are the grid's records, each its rows (a search hit's rows, or one
 * row of a file's table), and may be sparse: undefined until its page
 * arrives, shown as `estimateRows` skeleton rows. With `scrollRef`
 * (the element it scrolls in) only the items in view and `overscan` above
 * and below are in the DOM, and `onRange` hears their indexes so their pages
 * can be fetched. Cells with validation issues take the online editor's
 * colors, with the messages as their tooltip; a long value is cut short with
 * the whole of it as the tooltip. With `onRowClick` a row is clickable (or
 * Enter on a focused one); `selected` (a row's key) is highlighted, and
 * `scrollTo` (an item's index) is brought to the middle of the view once it
 * is among the items. With `groupKey` (an item's group: the search page's
 * contribution) a full-width `groupHeader` row opens an item whenever its
 * group differs from the item's above, under any sort: the items are not
 * reordered, so a group split by the sort gets a header at each run.
 */
export function RowsGrid({
  items,
  columns: allColumns,
  labelled = false,
  estimateRows = 1,
  sort,
  onSort,
  columnIssues,
  scrollRef,
  overscan = 25,
  onRange,
  table,
  onRowClick,
  selected,
  scrollTo,
  footer,
  empty = "No row data for these results.",
  groupKey,
  groupHeader,
  rowLink,
  selectedColumn,
}: {
  items: (GridRow[] | undefined)[];
  columns: string[];
  /** The data-model table the rows are from, for the header's names and types. */
  table?: string;
  onRowClick?: (row: GridRow) => void;
  selected?: string;
  scrollTo?: number;
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
  /** An item's group (undefined: none). */
  groupKey?: (index: number) => string | undefined;
  /** The header row's content for the group an item opens. */
  groupHeader?: (index: number) => ReactNode;
  /** A row's persistent link, shown as its number in the leading column
   * (in place of its label) when it has one. */
  rowLink?: (row: GridRow) => RowLink | undefined;
  /** The selected row's cell in this column is outlined and scrolled into view. */
  selectedColumn?: string;
}) {
  const model = useDataModelTable(table);
  // With row links, each row's number shows its contribution and row ids.
  const linked = rowLink !== undefined;
  const columns = useMemo(
    () => (linked ? allColumns.filter((column) => !ROW_ID_COLUMNS.has(column)) : allColumns),
    [allColumns, linked],
  );
  // A record still loading: skeleton rows, as many as a record has on average.
  const placeholderRows = Math.max(1, Math.round(estimateRows));
  // Whether a loaded item with rows opens a group: its key differs from the
  // nearest item above with rows (or that item is still loading, when the
  // header shows until it arrives).
  const startsGroup = (index: number): boolean => {
    if (!groupKey || !items[index]?.length) return false;
    const key = groupKey(index);
    if (key === undefined) return false;
    for (let above = index - 1; above >= 0; above--) {
      const item = items[above];
      if (!item) return true;
      if (item.length > 0) return groupKey(above) !== key;
    }
    return true;
  };
  const { startRef, indexes, measure, padTop, padBottom, scrollToIndex } = useVirtualRows({
    count: items.length,
    scrollRef,
    estimateSize: (index) =>
      (items[index]?.length || Math.max(1, estimateRows)) * ROW_HEIGHT +
      (startsGroup(index) ? GROUP_HEIGHT : 0),
    overscan,
    onRange,
  });
  // Widths settle once the first rows arrive; later pages keep them.
  const loaded = items.some(Boolean);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured from the first rows only
  const widths = useMemo(() => columnWidths(columns, items, model), [columns, loaded, model]);
  // The leading column (the rows' labels and/or their persistent links, when
  // the first rows have any), wide enough for their numbers ("16901.123456").
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured from the first rows only
  const { leading, labelWidth } = useMemo(() => {
    let chars = 0;
    let linked = false;
    let seen = 0;
    outer: for (const item of items) {
      if (!item) continue;
      for (const row of item) {
        const link = rowLink?.(row);
        linked ||= !!link;
        chars = Math.max(chars, (link?.label ?? row.label ?? "").length);
        if (++seen >= 200) break outer;
      }
    }
    return { leading: labelled || linked, labelWidth: Math.max(64, Math.ceil(chars * 7.5) + 24) };
  }, [loaded, labelled, rowLink === undefined]);

  // Bring the selected row's `selectedColumn` cell into view sideways, once.
  const pointed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const target = selected !== undefined && selectedColumn ? `${selected}:${selectedColumn}` : "";
    if (!target || pointed.current === target) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const cell = scrollRef?.current?.querySelector<HTMLElement>('[data-pointed="true"]');
      if (cell) {
        cell.scrollIntoView({ block: "nearest", inline: "center" });
        pointed.current = target;
      } else if (++tries <= 60) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [selected, selectedColumn, scrollRef]);

  // Scroll to `scrollTo` once, when it is among the items. The virtualizer
  // may not have its scroller yet: try again each frame (a few) until the
  // item is rendered.
  const scrolled = useRef<number | undefined>(undefined);
  const scrollBy = useRef(scrollToIndex);
  scrollBy.current = scrollToIndex;
  const target = scrollTo !== undefined && scrollTo < items.length ? scrollTo : undefined;
  useEffect(() => {
    if (target === undefined || scrolled.current === target) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      scrollBy.current(target);
      const shown = scrollRef?.current?.querySelector(`[data-index="${target}"]`);
      if (shown || ++tries > 30) {
        scrolled.current = target;
        return;
      }
      frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [target, scrollRef]);

  if (items.length === 0) {
    return <p className="py-8 text-center text-[13px] text-gray-500">{empty}</p>;
  }
  const span = columns.length + (leading ? 1 : 0);
  const headers = columns.map((column) =>
    headerCells({
      column,
      model: model?.columns[column],
      sort,
      onSort,
      issue: columnIssues?.[column],
    }),
  );
  const width = widths.reduce((total, w) => total + w, leading ? labelWidth : 0);
  return (
    <>
      <table
        className="border-separate border-spacing-0 text-left text-[13px]"
        style={{ tableLayout: "fixed", width: `max(${width}px, 100%)` }}
      >
        <colgroup>
          {leading && <col style={{ width: labelWidth }} />}
          {widths.map((w, i) => (
            <col key={columns[i]} style={{ width: w }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          {[0, 1, 2].map((line) => (
            <tr key={line}>
              {line === 0 && leading && (
                <th
                  scope="col"
                  rowSpan={3}
                  className={cx(TH, "text-right font-semibold text-gray-700")}
                  style={UNDERLINE}
                  title={rowLink ? "Each row's link: <contribution>.<row id>" : undefined}
                >
                  {rowLink ? "Row" : <span className="sr-only">Row</span>}
                </th>
              )}
              {headers.map((cells) => cells[line])}
            </tr>
          ))}
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
                    {leading && (
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
              {startsGroup(index) && (
                <tr style={{ height: GROUP_HEIGHT }}>
                  <th
                    scope="colgroup"
                    colSpan={span}
                    className="whitespace-nowrap border-gray-200 border-y bg-gray-50 px-3 py-1.5 text-left font-normal text-[13px] text-gray-700"
                  >
                    {/* Stays in view when the grid scrolls sideways. */}
                    <div className="sticky left-3 inline-block max-w-full overflow-hidden text-ellipsis align-bottom">
                      {groupHeader?.(index)}
                    </div>
                  </th>
                </tr>
              )}
              {item.map((row) => {
                const rowIssue = row.issues?.[""];
                const isSelected = selected !== undefined && row.key === selected;
                const open = onRowClick && (() => onRowClick(row));
                return (
                  <tr
                    key={row.key}
                    tabIndex={open ? 0 : undefined}
                    aria-selected={open ? isSelected : undefined}
                    onClick={open && ((event) => isRowClick(event) && open())}
                    onKeyDown={
                      open &&
                      ((event) => {
                        if (event.key === "Enter" && event.target === event.currentTarget) open();
                      })
                    }
                    className={cx(
                      open &&
                        "cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-node",
                      isSelected ? "bg-node-soft" : "hover:bg-gray-50/60",
                    )}
                    title={rowIssue && issueTitle(rowIssue)}
                  >
                    {leading && (
                      <td
                        className={cx(
                          TD,
                          "border-b border-gray-100 text-right text-[13px] text-gray-500 tabular-nums",
                          rowIssue && ISSUE_CLASS[rowIssue.severity],
                        )}
                      >
                        {(() => {
                          const link = rowLink?.(row);
                          if (!link) return row.label;
                          return (
                            <Link
                              to="/$page"
                              params={{ page: link.page }}
                              title={`Link to row ${link.label}`}
                              className="text-node-ink hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
                              onClick={(event) => {
                                // A plain click opens the row here; a modified
                                // one (new tab, copy) follows the link.
                                if (
                                  event.button !== 0 ||
                                  event.metaKey ||
                                  event.ctrlKey ||
                                  event.shiftKey ||
                                  event.altKey
                                ) {
                                  return;
                                }
                                event.preventDefault();
                                link.onOpen();
                              }}
                            >
                              {link.label}
                            </Link>
                          );
                        })()}
                      </td>
                    )}
                    {columns.map((column) => {
                      const issue = row.issues?.[column] ?? rowIssue;
                      const text = display(row.values[column]);
                      const isPointed = isSelected && column === selectedColumn;
                      return (
                        <td
                          key={column}
                          data-pointed={isPointed || undefined}
                          title={issue ? issueTitle(issue) : text.length > 40 ? text : undefined}
                          className={cx(
                            TD,
                            "overflow-hidden text-ellipsis border-b border-gray-100",
                            issue && ISSUE_CLASS[issue.severity],
                            isPointed && "font-semibold ring-2 ring-node ring-inset",
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
