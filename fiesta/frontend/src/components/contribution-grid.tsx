/**
 * The private workspace's spreadsheet editor (legacy MagIC's Handsontable
 * "Edit Contribution" modal, docs/legacy-ux-spec.md "Grid editor"): the data
 * model's tables as tabs, a virtualized grid of one page of rows, edited
 * cells outlined, the saved revision's validation issues on their cells,
 * light client checks on edited ones, undo/redo, row insert/delete from a
 * context menu, vocabulary pulldowns and a side panel describing the cell.
 *
 * It holds the edits; the parent saves `getText()` as a new revision.
 * Loaded lazily (React.lazy) so the editor costs nothing until opened.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ButtonHTMLAttributes,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  checkCell,
  columnReference,
  columnVocabulary,
  type GridDoc,
  type GridRow,
  type GridTable,
  type IndexedVocabulary,
  isListColumn,
  isReadOnly,
  isRequired,
  newRowId,
  orderedColumns,
  parseContribution,
  serializeContribution,
  splitValues,
  type VocabularyLookup,
} from "../lib/contribution-grid";
import type { DataModel, DataModelColumn, ValidationIssue, ValidationResult } from "../lib/types";
import { cx } from "../lib/utils";

export interface GridApi {
  getText: () => string;
}

const ROW_H = 26;
const HEADER_H = 30;
const GUTTER_W = 56;
const PAGE_SIZES = [100, 250, 500, 1000];
const HISTORY_LIMIT = 200;
const ITEM_LIMIT = 300;

type Pos = { r: number; c: number };
type Editing = Pos & { value: string };
type Menu = { x: number; y: number };
type CellIssues = { errors: string[]; warnings: string[] };

const key = (table: string, rowId: number, column: string) =>
  `${table}\u0000${rowId}\u0000${column}`;
const rowHasValues = (row: GridRow) => Object.values(row.cells).some(Boolean);

/** Rows of `draft` take the ids of `base`'s rows at the same index (edits and issues line up). */
function alignDraft(base: GridDoc, draft: GridDoc): GridDoc {
  return draft.map((table) => {
    const original = base.find((t) => t.name === table.name);
    return {
      ...table,
      rows: table.rows.map((row, i) =>
        original?.rows[i] ? { ...row, id: original.rows[i].id } : row,
      ),
    };
  });
}

export function ContributionGrid({
  baseText,
  draftText,
  model,
  lookup,
  validation,
  validationPending,
  readOnly,
  apiRef,
  onDirtyChange,
}: {
  /** The saved revision's text: edits are marked against it. */
  baseText: string;
  /** Text to start from instead (after editing in the text mode), or null. */
  draftText: string | null;
  model: DataModel;
  lookup: VocabularyLookup;
  /** The server's validation of the saved revision, if it has one yet. */
  validation: ValidationResult | null;
  validationPending: boolean;
  readOnly: boolean;
  apiRef: RefObject<GridApi | null>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // --- document, history and the saved revision's rows ------------------------------------
  const base = useMemo(() => parseContribution(baseText), [baseText]);
  const initial = useMemo(
    () => (draftText === null ? base : alignDraft(base, parseContribution(draftText))),
    [base, draftText],
  );
  const [history, setHistory] = useState({ stack: [initial], index: 0 });
  const doc = history.stack[history.index];
  const original = useMemo(() => {
    const rows = new Map<number, GridRow>();
    for (const table of base) for (const row of table.rows) rows.set(row.id, row);
    return rows;
  }, [base]);
  const dirty = doc !== base;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  apiRef.current = { getText: () => serializeContribution(doc, model.tables) };

  const commit = useCallback((next: GridDoc) => {
    setHistory((h) => {
      const stack = [...h.stack.slice(0, h.index + 1), next].slice(-HISTORY_LIMIT);
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const canUndo = history.index > 0;
  const canRedo = history.index < history.stack.length - 1;
  const undo = () => setHistory((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const redo = () =>
    setHistory((h) => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));

  // --- tables (tabs) and the server's issues ------------------------------------------------
  const tableNames = useMemo(() => {
    const names = Object.keys(model.tables).sort(
      (a, b) => (model.tables[a].position ?? 0) - (model.tables[b].position ?? 0),
    );
    for (const t of doc) if (!names.includes(t.name)) names.push(t.name);
    return names;
  }, [model, doc]);
  const [active, setActive] = useState(
    () => initial.find((t) => t.rows.length)?.name ?? tableNames[0] ?? "",
  );
  const emptyTable = useMemo<GridTable>(() => ({ name: active, columns: [], rows: [] }), [active]);
  const table = doc.find((t) => t.name === active) ?? emptyTable;
  const modelTable = model.tables[active];
  const columnDef = useCallback(
    (tableName: string, column: string): DataModelColumn | undefined =>
      model.tables[tableName]?.columns[column],
    [model],
  );

  const server = useMemo(() => {
    const cells = new Map<string, CellIssues>();
    const tables = new Map<string, (ValidationIssue & { kind: keyof CellIssues })[]>();
    const add = (issue: ValidationIssue, kind: keyof CellIssues) => {
      const rowId = issue.row
        ? base.find((t) => t.name === issue.table)?.rows[issue.row - 1]?.id
        : undefined;
      if (rowId === undefined || !issue.column) {
        const list = tables.get(issue.table) ?? [];
        list.push({ ...issue, kind });
        tables.set(issue.table, list);
        return;
      }
      const k = key(issue.table, rowId, issue.column);
      const entry = cells.get(k) ?? { errors: [], warnings: [] };
      entry[kind].push(issue.message);
      cells.set(k, entry);
    };
    for (const issue of validation?.errors ?? []) add(issue, "errors");
    for (const issue of validation?.warnings ?? []) add(issue, "warnings");
    return { cells, tables };
  }, [validation, base]);

  const isEdited = useCallback(
    (row: GridRow, column: string) =>
      (original.get(row.id)?.cells[column] ?? "") !== (row.cells[column] ?? ""),
    [original],
  );
  /** A cell's issues: the client's checks once edited (or in a new row), else the saved revision's. */
  const issuesOf = useCallback(
    (tableName: string, row: GridRow, column: string): CellIssues => {
      if (!original.has(row.id) || isEdited(row, column)) {
        const errors = checkCell(
          column,
          columnDef(tableName, column),
          row.cells[column] ?? "",
          rowHasValues(row),
          lookup,
        );
        return { errors, warnings: [] };
      }
      return server.cells.get(key(tableName, row.id, column)) ?? { errors: [], warnings: [] };
    },
    [original, isEdited, columnDef, lookup, server],
  );

  /** Per table: rows with errors, rows edited, rows (cached per table object). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh cache whenever the issues change
  const countCache = useMemo(
    () => new WeakMap<GridTable, { errors: number; edited: number; rows: number }>(),
    [issuesOf],
  );
  const serverErrorRows = useMemo(() => {
    const rows = new Set<string>();
    for (const [k, entry] of server.cells) {
      if (entry.errors.length) rows.add(k.slice(0, k.lastIndexOf("\u0000")));
    }
    return rows;
  }, [server]);
  const countsOf = (t: GridTable) => {
    const cached = countCache.get(t);
    if (cached) return cached;
    const required = Object.entries(model.tables[t.name]?.columns ?? {})
      .filter(([, c]) => isRequired(c))
      .map(([name]) => name);
    let errors = 0;
    let edited = 0;
    for (const row of t.rows) {
      const saved = original.get(row.id);
      if (saved === row) {
        if (serverErrorRows.has(`${t.name}\u0000${row.id}`)) errors += 1;
        continue;
      }
      const columns = new Set([
        ...Object.keys(row.cells),
        ...Object.keys(saved?.cells ?? {}),
        ...required,
      ]);
      let rowEdited = false;
      let rowError = false;
      for (const column of columns) {
        if (isEdited(row, column)) rowEdited = true;
        if (!rowError && issuesOf(t.name, row, column).errors.length) rowError = true;
      }
      if (rowEdited) edited += 1;
      if (rowError) errors += 1;
    }
    const result = { errors, edited, rows: t.rows.filter(rowHasValues).length };
    countCache.set(t, result);
    return result;
  };

  // --- columns, paging ---------------------------------------------------------------------
  const [showEmpty, setShowEmpty] = useState<Record<string, boolean>>({});
  const baseTable = base.find((t) => t.name === active);
  const showEmptyColumns = showEmpty[active] ?? !baseTable?.rows.length;
  const columns = useMemo(() => {
    const all = orderedColumns(modelTable);
    for (const c of table.columns) if (!all.includes(c)) all.push(c);
    if (showEmptyColumns) return all;
    const filled = new Set<string>();
    for (const t of [baseTable, table]) {
      for (const row of t?.rows ?? [])
        for (const [k, v] of Object.entries(row.cells)) if (v) filled.add(k);
    }
    return all.filter((c) => filled.has(c) || isRequired(modelTable?.columns[c]));
  }, [modelTable, table, baseTable, showEmptyColumns]);
  // Widths follow the table, not each keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: table.rows changes per edit
  const widths = useMemo(
    () =>
      columns.map((c) => {
        let chars = c.length + 3;
        for (const row of table.rows.slice(0, 50))
          chars = Math.max(chars, (row.cells[c] ?? "").length);
        return Math.min(320, Math.max(72, chars * 7.5 + 18));
      }),
    [columns, active],
  );

  const [pageSize, setPageSize] = useState(250);
  const [pages, setPages] = useState<Record<string, number>>({});
  const pageCount = Math.max(1, Math.ceil(table.rows.length / pageSize));
  const page = Math.min(pages[active] ?? 0, pageCount - 1);
  const offset = page * pageSize;
  const pageRows = table.rows.slice(offset, offset + pageSize);
  // One spare row after the last to type a new one into (legacy kept 100).
  const spare = !readOnly && page === pageCount - 1 && !isReadOnlyTable(modelTable);
  const rowCount = pageRows.length + (spare ? 1 : 0);

  // --- selection and editing ---------------------------------------------------------------
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 });
  const [focus, setFocus] = useState<Pos>({ r: 0, c: 0 });
  const [editing, setEditingState] = useState<Editing | null>(null);
  // The editor commits once, whether by key, blur or a click elsewhere.
  const editingRef = useRef<Editing | null>(null);
  const setEditing = (next: Editing | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  const [menu, setMenu] = useState<Menu | null>(null);
  const dragging = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const range = {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  };
  const selectedRows = Math.max(0, Math.min(range.r1, pageRows.length - 1) - range.r0 + 1);
  const inRange = (r: number, c: number) =>
    r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    paddingStart: HEADER_H,
    scrollPaddingStart: HEADER_H,
    overscan: 12,
  });
  const cols = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    paddingStart: GUTTER_W,
    scrollPaddingStart: GUTTER_W,
    overscan: 4,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the columns change
  useEffect(() => cols.measure(), [widths, cols]);

  const select = (pos: Pos, extend = false) => {
    const p = { r: clamp(pos.r, 0, rowCount - 1), c: clamp(pos.c, 0, columns.length - 1) };
    setFocus(p);
    if (!extend) setAnchor(p);
    rows.scrollToIndex(p.r);
    cols.scrollToIndex(p.c);
  };
  const resetSelection = () => {
    setAnchor({ r: 0, c: 0 });
    setFocus({ r: 0, c: 0 });
    setEditing(null);
    setMenu(null);
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  };
  const switchTable = (name: string) => {
    setActive(name);
    resetSelection();
  };
  const goToPage = (next: number) => {
    setPages((p) => ({ ...p, [active]: next }));
    resetSelection();
  };
  const refocus = () => scrollRef.current?.focus({ preventScroll: true });

  const editable = (c: number) => !readOnly && !isReadOnly(modelTable?.columns[columns[c]]);
  const valueAt = (r: number, c: number) => pageRows[r]?.cells[columns[c]] ?? "";

  /** Apply cell writes (page-relative rows) as one undoable step. */
  const write = (changes: { r: number; c: number; value: string }[]) => {
    const current = doc.find((t) => t.name === active) ?? { name: active, columns: [], rows: [] };
    const nextRows = current.rows.slice();
    const nextColumns = current.columns.slice();
    const copied = new Set<number>();
    let changed = false;
    for (const { r, c, value } of changes) {
      const column = columns[c];
      if (column === undefined || !editable(c)) continue;
      const clean = value.replace(/[\t\r\n]+/g, " ").trim();
      const index = offset + r;
      if ((nextRows[index]?.cells[column] ?? "") === clean) continue;
      while (nextRows.length <= index) nextRows.push({ id: newRowId(), cells: {} });
      if (!copied.has(index)) {
        nextRows[index] = { id: nextRows[index].id, cells: { ...nextRows[index].cells } };
        copied.add(index);
      }
      if (clean) nextRows[index].cells[column] = clean;
      else delete nextRows[index].cells[column];
      if (!nextColumns.includes(column)) nextColumns.push(column);
      changed = true;
    }
    if (!changed) return;
    // Rows appended past the end that stayed empty are dropped again.
    while (nextRows.length > current.rows.length && !rowHasValues(nextRows[nextRows.length - 1]))
      nextRows.pop();
    const next = { ...current, rows: nextRows, columns: nextColumns };
    commit(
      doc.some((t) => t.name === active)
        ? doc.map((t) => (t.name === active ? next : t))
        : [...doc, next],
    );
  };
  const replaceRows = (nextRows: GridRow[]) => {
    const next = { ...table, rows: nextRows };
    commit(
      doc.some((t) => t.name === active)
        ? doc.map((t) => (t.name === active ? next : t))
        : [...doc, next],
    );
  };
  const insertRows = (at: number, count: number) => {
    if (readOnly) return;
    const nextRows = table.rows.slice();
    nextRows.splice(
      offset + Math.min(at, pageRows.length),
      0,
      ...Array.from({ length: count }, () => ({ id: newRowId(), cells: {} })),
    );
    replaceRows(nextRows);
  };
  const deleteRows = () => {
    if (readOnly) return;
    const r1 = Math.min(range.r1, pageRows.length - 1);
    if (r1 < range.r0) return;
    replaceRows(table.rows.filter((_, i) => i < offset + range.r0 || i > offset + r1));
    select({ r: range.r0, c: focus.c });
  };
  const clearRange = () => {
    const changes = [];
    for (let r = range.r0; r <= range.r1; r++)
      for (let c = range.c0; c <= range.c1; c++) changes.push({ r, c, value: "" });
    write(changes);
  };

  const startEdit = (pos: Pos, value?: string) => {
    if (!editable(pos.c) || pos.r >= rowCount) return;
    setMenu(null);
    setEditing({ ...pos, value: value ?? valueAt(pos.r, pos.c) });
  };
  const finishEdit = (move?: Pos) => {
    const current = editingRef.current;
    if (!current) return;
    setEditing(null);
    write([{ r: current.r, c: current.c, value: current.value }]);
    if (move) select(move);
    refocus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== scrollRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const moves: Record<string, Pos> = {
      ArrowUp: { r: focus.r - 1, c: focus.c },
      ArrowDown: { r: focus.r + 1, c: focus.c },
      ArrowLeft: { r: focus.r, c: focus.c - 1 },
      ArrowRight: { r: focus.r, c: focus.c + 1 },
      PageUp: { r: focus.r - 20, c: focus.c },
      PageDown: { r: focus.r + 20, c: focus.c },
      Home: { r: mod ? 0 : focus.r, c: 0 },
      End: { r: mod ? rowCount - 1 : focus.r, c: columns.length - 1 },
    };
    if (moves[e.key]) {
      e.preventDefault();
      select(moves[e.key], e.shiftKey);
    } else if (e.key === "Tab") {
      e.preventDefault();
      select({ r: focus.r, c: focus.c + (e.shiftKey ? -1 : 1) });
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(focus);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearRange();
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setFocus({ r: rowCount - 1, c: columns.length - 1 });
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      startEdit(focus, e.key);
    }
  };

  const rangeText = () => {
    const lines = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const cells = [];
      for (let c = range.c0; c <= range.c1; c++) cells.push(valueAt(r, c));
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  };
  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", rangeText());
  };
  const onCut = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing) return;
    onCopy(e);
    clearRange();
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || readOnly) return;
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\n$/, "");
    const block = text.split("\n").map((line) => line.split("\t"));
    const changes = [];
    if (block.length === 1 && block[0].length === 1) {
      // One value fills the selection.
      for (let r = range.r0; r <= range.r1; r++)
        for (let c = range.c0; c <= range.c1; c++) changes.push({ r, c, value: block[0][0] });
    } else {
      block.forEach((cells, i) => {
        cells.forEach((value, j) => {
          changes.push({ r: range.r0 + i, c: range.c0 + j, value });
        });
      });
    }
    write(changes);
  };

  const onCellMouseDown = (e: MouseEvent, pos: Pos) => {
    if (e.button === 2 && inRange(pos.r, pos.c)) return;
    if (editing) finishEdit();
    setMenu(null);
    dragging.current = e.button === 0;
    select(pos, e.shiftKey);
    refocus();
    e.preventDefault();
  };
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // --- the selected cell, for the side panel ------------------------------------------------
  const focusColumn = columns[focus.c];
  const focusRow = pageRows[focus.r];
  const focusDef = focusColumn ? modelTable?.columns[focusColumn] : undefined;
  const focusValue = focusRow?.cells[focusColumn ?? ""] ?? "";
  const focusIssues = focusRow && focusColumn ? issuesOf(active, focusRow, focusColumn) : null;
  const vocabularyOf = useCallback(
    (column?: DataModelColumn) => columnVocabulary(column, lookup),
    [lookup],
  );
  const referenceValues = useCallback(
    (column?: DataModelColumn): { label: string; items: string[] } | undefined => {
      const target = columnReference(column);
      if (!target) return undefined;
      const values = new Set<string>();
      for (const row of doc.find((t) => t.name === target[0])?.rows ?? []) {
        const v = row.cells[target[1]];
        if (v) values.add(v);
      }
      return { label: `Values in ${target.join(".")}`, items: [...values].sort() };
    },
    [doc],
  );

  const tableIssues = server.tables.get(active) ?? [];
  const virtualRows = rows.getVirtualItems();
  const virtualCols = cols.getVirtualItems();

  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label="Tables"
        className="flex flex-wrap gap-1 border-b border-gray-200"
      >
        {tableNames.map((name) => {
          const t = doc.find((x) => x.name === name);
          const count = t ? countsOf(t) : undefined;
          const selected = name === active;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => switchTable(name)}
              className={cx(
                "-mb-px flex items-center gap-1.5 rounded-t-md border px-2.5 py-1.5 text-xs",
                selected
                  ? "border-gray-200 border-b-surface bg-surface font-semibold text-ink-strong"
                  : "border-transparent text-gray-600 hover:bg-gray-50",
              )}
            >
              {model.tables[name]?.label ?? name}
              {!!count?.errors && (
                <Badge className="bg-red-700 text-white" title="Rows with errors">
                  {count.errors}
                </Badge>
              )}
              {!!count?.edited && (
                <Badge className="bg-purple-700 text-white" title="Rows edited">
                  {count.edited}
                </Badge>
              )}
              <Badge className="border border-gray-300 text-gray-700" title="Rows">
                {count?.rows ?? 0}
              </Badge>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <ToolButton onClick={undo} disabled={!canUndo || readOnly} title="Undo (Ctrl+Z)">
          Undo
        </ToolButton>
        <ToolButton onClick={redo} disabled={!canRedo || readOnly} title="Redo (Ctrl+Y)">
          Redo
        </ToolButton>
        <ToolButton
          onClick={() => insertRows(pageRows.length, 1)}
          disabled={readOnly || isReadOnlyTable(modelTable)}
        >
          Add row
        </ToolButton>
        <ToolButton onClick={deleteRows} disabled={readOnly || focus.r >= pageRows.length}>
          {selectedRows > 1 ? `Delete ${selectedRows} rows` : "Delete row"}
        </ToolButton>
        <label className="ml-auto flex items-center gap-1.5 text-gray-700">
          <input
            type="checkbox"
            checked={showEmptyColumns}
            onChange={(e) => setShowEmpty((s) => ({ ...s, [active]: e.target.checked }))}
          />
          Show Empty Columns
        </label>
      </div>

      {tableIssues.length > 0 && (
        <ul className="max-h-24 overflow-y-auto rounded-md border border-gray-200 bg-panel-soft px-3 py-1.5 text-xs">
          {tableIssues.map((issue, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues have no id
            <li key={i} className={issue.kind === "errors" ? "text-red-800" : "text-amber-800"}>
              {issue.kind === "errors" ? "Error: " : "Warning: "}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-h-0 flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1">
          {/* biome-ignore lint/a11y/useSemanticElements: a virtualized grid of absolutely positioned cells, not a <table> */}
          <div
            ref={scrollRef}
            role="grid"
            aria-label={`${modelTable?.label ?? active} rows`}
            aria-rowcount={rowCount}
            aria-colcount={columns.length}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            onCut={onCut}
            onPaste={onPaste}
            className="relative h-[55vh] overflow-auto rounded-md border border-gray-200 bg-surface text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <div
              style={{
                width: cols.getTotalSize(),
                height: rows.getTotalSize(),
                position: "relative",
              }}
            >
              <div
                className="sticky top-0 z-20 bg-gray-100"
                style={{ height: HEADER_H, width: cols.getTotalSize() }}
              >
                <div
                  className="sticky left-0 z-30 h-full border-b border-r border-gray-200 bg-gray-100"
                  style={{ width: GUTTER_W }}
                />
                {virtualCols.map((vc) => {
                  const column = columns[vc.index];
                  const def = modelTable?.columns[column];
                  const vocabulary = vocabularyOf(def);
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a virtualized grid of absolutely positioned cells, not a <table>
                    <div
                      key={vc.key}
                      role="columnheader"
                      tabIndex={-1}
                      title={[
                        def?.label,
                        def
                          ? `${def.type ?? ""}${def.unit ? ` in ${def.unit}` : ""}`
                          : "not in the data model",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      className={cx(
                        "absolute top-0 flex h-full items-center truncate border-b border-r border-gray-200 px-1.5 font-semibold",
                        def ? "text-gray-800" : "text-red-700",
                        isReadOnly(def) && "text-gray-500",
                      )}
                      style={{ left: vc.start, width: vc.size }}
                    >
                      {column}
                      {isRequired(def) && <span className="text-red-700">*</span>}
                      {vocabulary?.controlled && (
                        <span className="ml-1 font-normal text-gray-500">(cv)</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {virtualRows.map((vr) => {
                const r = vr.index;
                const row = pageRows[r];
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a virtualized grid of absolutely positioned cells, not a <table>
                  <div
                    key={vr.key}
                    role="row"
                    tabIndex={-1}
                    className="absolute left-0 flex"
                    style={{ top: vr.start, height: ROW_H, width: cols.getTotalSize() }}
                  >
                    {/* biome-ignore lint/a11y/useSemanticElements: a virtualized grid of absolutely positioned cells, not a <table> */}
                    <div
                      role="rowheader"
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        setAnchor(e.shiftKey ? anchor : { r, c: 0 });
                        setFocus({ r, c: columns.length - 1 });
                        refocus();
                        e.preventDefault();
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!inRange(r, 0)) {
                          setAnchor({ r, c: 0 });
                          setFocus({ r, c: columns.length - 1 });
                        }
                        setMenu({ x: e.clientX, y: e.clientY });
                      }}
                      className={cx(
                        "sticky left-0 z-10 flex h-full shrink-0 cursor-default items-center justify-end border-b border-r border-gray-200 bg-gray-100 pr-1.5 tabular-nums text-gray-500",
                        r >= range.r0 && r <= range.r1 && "bg-gray-200 text-gray-800",
                      )}
                      style={{ width: GUTTER_W }}
                    >
                      {row ? offset + r + 1 : "+"}
                    </div>
                    {virtualCols.map((vc) => {
                      const c = vc.index;
                      const column = columns[c];
                      const value = row?.cells[column] ?? "";
                      const issues = row ? issuesOf(active, row, column) : null;
                      const edited = row ? isEdited(row, column) : false;
                      const isFocus = focus.r === r && focus.c === c;
                      const locked = !editable(c);
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: a virtualized grid of absolutely positioned cells, not a <table>
                        <div
                          key={vc.key}
                          role="gridcell"
                          tabIndex={-1}
                          aria-selected={inRange(r, c)}
                          title={issues?.errors.join("\n") || undefined}
                          onMouseDown={(e) => onCellMouseDown(e, { r, c })}
                          onMouseEnter={() => dragging.current && select({ r, c }, true)}
                          onDoubleClick={() => startEdit({ r, c })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (!inRange(r, c)) select({ r, c });
                            setMenu({ x: e.clientX, y: e.clientY });
                          }}
                          className={cx(
                            "absolute top-0 h-full border-b border-r border-gray-200 px-1.5 leading-[25px]",
                            // The open editor's pulldown hangs below the cell.
                            editing?.r === r && editing.c === c
                              ? "z-30 overflow-visible"
                              : "truncate",
                            locked && "bg-gray-50 text-gray-500",
                            issues?.errors.length ? "bg-red-50 text-red-800" : null,
                            inRange(r, c) && !isFocus && "bg-node-soft",
                            edited && "ring-2 ring-purple-500 ring-inset",
                            isFocus && "z-[5] outline-2 -outline-offset-2 outline-node",
                          )}
                          style={{ left: vc.start, width: vc.size }}
                        >
                          {editing && editing.r === r && editing.c === c ? (
                            <CellEditor
                              editing={editing}
                              column={modelTable?.columns[column]}
                              vocabulary={vocabularyOf(modelTable?.columns[column])}
                              reference={referenceValues(modelTable?.columns[column])}
                              onChange={(next) => setEditing({ ...editing, value: next })}
                              onCommit={(dr, dc) =>
                                finishEdit(dr || dc ? { r: r + dr, c: c + dc } : undefined)
                              }
                              onCancel={() => {
                                setEditing(null);
                                refocus();
                              }}
                            />
                          ) : (
                            value
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            <span>
              {table.rows.length
                ? `Rows ${offset + 1}–${offset + pageRows.length} of ${table.rows.length.toLocaleString()}`
                : "No rows yet: type into the first row, or paste from a spreadsheet."}
            </span>
            {pageCount > 1 && (
              <>
                <ToolButton onClick={() => goToPage(page - 1)} disabled={page === 0}>
                  Previous
                </ToolButton>
                <span>
                  Page {page + 1} of {pageCount}
                </span>
                <ToolButton onClick={() => goToPage(page + 1)} disabled={page >= pageCount - 1}>
                  Next
                </ToolButton>
              </>
            )}
            <label className="ml-auto flex items-center gap-1.5">
              Rows per page
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPages({});
                  resetSelection();
                }}
                className="rounded-sm border border-gray-300 bg-surface px-1 py-0.5"
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <SidePanel
          column={focusColumn}
          def={focusDef}
          value={focusValue}
          issues={focusIssues}
          vocabulary={vocabularyOf(focusDef)}
          reference={referenceValues(focusDef)}
          validation={validation}
          validationPending={validationPending}
          dirty={dirty}
          disabled={!focusColumn || !editable(focus.c) || focus.r >= rowCount}
          onSet={(value) => write([{ r: focus.r, c: focus.c, value }])}
        />
      </div>

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => {
            setMenu(null);
            refocus();
          }}
          items={[
            {
              label: "Insert row above",
              action: () => insertRows(range.r0, 1),
              disabled: readOnly,
            },
            {
              label: "Insert row below",
              action: () => insertRows(range.r1 + 1, 1),
              disabled: readOnly,
            },
            {
              label: selectedRows > 1 ? `Delete ${selectedRows} rows` : "Delete row",
              action: deleteRows,
              disabled: readOnly || range.r0 >= pageRows.length,
            },
            { label: "Clear cells", action: clearRange, disabled: readOnly },
            { label: "Undo", action: undo, disabled: !canUndo || readOnly },
            { label: "Redo", action: redo, disabled: !canRedo || readOnly },
          ]}
        />
      )}
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** A table whose every column is read-only takes no typed rows. */
function isReadOnlyTable(table?: { columns: Record<string, DataModelColumn> }) {
  return !!table && Object.values(table.columns).every(isReadOnly);
}

function Badge({
  className,
  title,
  children,
}: {
  className: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex min-w-5 justify-center rounded-full px-1.5 text-[11px] leading-4 tabular-nums",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ToolButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-sm border border-gray-300 bg-surface px-2 py-0.5 text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}

/** The list a cell's pulldown and panel offer: a vocabulary, or another table's values. */
function choices(
  vocabulary: IndexedVocabulary | undefined,
  reference: { label: string; items: string[] } | undefined,
): { item: string; label?: string }[] {
  if (vocabulary) return vocabulary.items.map((i) => ({ item: String(i.item), label: i.label }));
  return reference?.items.map((item) => ({ item })) ?? [];
}

function CellEditor({
  editing,
  column,
  vocabulary,
  reference,
  onChange,
  onCommit,
  onCancel,
}: {
  editing: Editing;
  column?: DataModelColumn;
  vocabulary?: IndexedVocabulary;
  reference?: { label: string; items: string[] };
  onChange: (value: string) => void;
  onCommit: (dr: number, dc: number) => void;
  onCancel: () => void;
}) {
  const list = isListColumn(column);
  const all = useMemo(() => choices(vocabulary, reference), [vocabulary, reference]);
  // A list column completes its last colon-separated value.
  const prefix =
    list && editing.value.includes(":")
      ? editing.value.slice(0, editing.value.lastIndexOf(":") + 1)
      : "";
  const term = editing.value.slice(prefix.length).trim().toLowerCase();
  const matches = useMemo(
    () =>
      all
        .filter(
          (i) =>
            !term ||
            i.item.toLowerCase().includes(term) ||
            (i.label ?? "").toLowerCase().includes(term),
        )
        .slice(0, 50),
    [all, term],
  );
  const [highlight, setHighlight] = useState(-1);
  const accept = (item: string) => onChange(prefix + item);
  return (
    <>
      <input
        // biome-ignore lint/a11y/noAutofocus: the cell editor opens on purpose
        autoFocus
        aria-label="Cell value"
        value={editing.value}
        onFocus={(e) =>
          e.currentTarget.setSelectionRange(
            e.currentTarget.value.length,
            e.currentTarget.value.length,
          )
        }
        onChange={(e) => {
          onChange(e.target.value);
          setHighlight(-1);
        }}
        onBlur={() => onCommit(0, 0)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown" && matches.length) {
            e.preventDefault();
            setHighlight((h) => Math.min(matches.length - 1, h + 1));
          } else if (e.key === "ArrowUp" && matches.length) {
            e.preventDefault();
            setHighlight((h) => Math.max(-1, h - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (highlight >= 0 && matches[highlight]) {
              accept(matches[highlight].item);
              setHighlight(-1);
            } else onCommit(e.shiftKey ? -1 : 1, 0);
          } else if (e.key === "Tab") {
            e.preventDefault();
            onCommit(0, e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="absolute inset-0 h-full w-full bg-surface px-1.5 text-xs text-ink-strong outline-2 -outline-offset-2 outline-node"
      />
      {matches.length > 0 && (
        <div
          role="listbox"
          aria-label="Choices"
          className="absolute left-0 top-full z-40 max-h-60 min-w-full overflow-y-auto rounded-b-md border border-gray-300 bg-surface py-0.5 shadow-lg"
        >
          {matches.map((m, i) => (
            <div
              key={m.item}
              role="option"
              tabIndex={-1}
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(m.item);
              }}
              className={cx(
                "cursor-pointer whitespace-nowrap px-2 py-0.5",
                i === highlight ? "bg-node-soft" : "hover:bg-gray-50",
              )}
            >
              <span className="font-medium">{m.item}</span>
              {m.label && m.label !== m.item && (
                <span className="ml-2 text-gray-500">{m.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SidePanel({
  column,
  def,
  value,
  issues,
  vocabulary,
  reference,
  validation,
  validationPending,
  dirty,
  disabled,
  onSet,
}: {
  column?: string;
  def?: DataModelColumn;
  value: string;
  issues: CellIssues | null;
  vocabulary?: IndexedVocabulary;
  reference?: { label: string; items: string[] };
  validation: ValidationResult | null;
  validationPending: boolean;
  dirty: boolean;
  disabled: boolean;
  onSet: (value: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const list = isListColumn(def);
  const selected = splitValues(def, value);
  const items = choices(vocabulary, reference);
  const term = filter.trim().toLowerCase();
  const shown = term
    ? items.filter(
        (i) => i.item.toLowerCase().includes(term) || (i.label ?? "").toLowerCase().includes(term),
      )
    : items;
  const toggle = (item: string) => {
    if (!list) return onSet(selected.includes(item) ? "" : item);
    onSet(
      (selected.includes(item) ? selected.filter((v) => v !== item) : [...selected, item]).join(
        ":",
      ),
    );
  };
  return (
    <aside
      aria-label="Selected cell"
      className="flex max-h-[62vh] w-full shrink-0 flex-col gap-2 overflow-y-auto rounded-md border border-gray-200 bg-panel-soft p-3 text-xs lg:w-80"
    >
      <p className="text-gray-600">
        {validationPending
          ? "Validating the saved revision…"
          : validation
            ? `Saved revision: ${validation.errors.length} errors, ${validation.warnings.length} warnings.`
            : "The saved revision has not been validated."}
        {dirty && " Edited cells are checked here as you type; save to validate everything."}
      </p>
      <h3 className="font-semibold uppercase tracking-wide text-gray-700">Selected Cell</h3>
      {!column ? (
        <p className="text-gray-500">Select a cell.</p>
      ) : (
        <>
          <p>
            <strong>Column:</strong> {column}
          </p>
          {issues && issues.errors.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-red-800">
              <p className="font-semibold">Validation Errors</p>
              <ul className="list-disc pl-4">
                {issues.errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {issues && issues.warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-800">
              <p className="font-semibold">Warnings</p>
              <ul className="list-disc pl-4">
                {issues.warnings.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {!def && <p className="text-red-700">This column is not in the data model.</p>}
          {def?.label && (
            <p>
              <strong>Label:</strong> {def.label}
            </p>
          )}
          {def?.type && (
            <p>
              <strong>Type:</strong> {def.type}
              {isListColumn(def) && " (colon-delimited)"}
            </p>
          )}
          {def?.unit && (
            <p>
              <strong>Unit:</strong> {def.unit}
            </p>
          )}
          {def?.description && (
            <p>
              <strong>Description:</strong> {def.description}
            </p>
          )}
          {def?.notes && (
            <p className="italic">
              <strong>Notes:</strong> {def.notes}
            </p>
          )}
          {def?.examples && def.examples.length > 0 && (
            <div>
              <strong>Examples:</strong>
              <ul className="list-disc pl-4">
                {def.examples.slice(0, 3).map((example) => (
                  <li key={example}>{example}</li>
                ))}
              </ul>
            </div>
          )}
          {items.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <h4 className="mt-1 font-semibold uppercase tracking-wide text-gray-700">
                {vocabulary ? vocabulary.label || vocabulary.name : reference?.label}
                {vocabulary && !vocabulary.controlled && (
                  <span className="ml-1 font-normal normal-case">(suggested)</span>
                )}
              </h4>
              {selected.length > 0 && (
                <p>
                  <strong>Selected ({selected.length}):</strong> {selected.join(", ")}
                </p>
              )}
              <input
                type="search"
                aria-label="Filter the list"
                placeholder={`Filter ${items.length.toLocaleString()} items`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded-sm border border-gray-300 bg-surface px-1.5 py-1"
              />
              <ul className="max-h-72 overflow-y-auto rounded-sm border border-gray-200 bg-surface">
                {shown.slice(0, ITEM_LIMIT).map((i) => (
                  <li key={i.item} className="border-b border-gray-100 last:border-0">
                    <label className="flex cursor-pointer items-start gap-2 px-2 py-1 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        disabled={disabled}
                        checked={selected.includes(i.item)}
                        onChange={() => toggle(i.item)}
                      />
                      <span>
                        <span className="font-medium">{i.item}</span>
                        {i.label && i.label !== i.item && (
                          <span className="block text-gray-500">{i.label}</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
                {shown.length > ITEM_LIMIT && (
                  <li className="px-2 py-1 text-gray-500">
                    …and {(shown.length - ITEM_LIMIT).toLocaleString()} more (refine the filter)
                  </li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function ContextMenu({
  menu,
  items,
  onClose,
}: {
  menu: Menu;
  items: { label: string; action: () => void; disabled?: boolean }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e: globalThis.MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", onEscape, true);
    ref.current?.querySelector("button")?.focus();
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[60] min-w-44 rounded-md border border-gray-200 bg-surface py-1 text-xs shadow-xl"
      style={{
        left: Math.min(menu.x, window.innerWidth - 190),
        top: Math.min(menu.y, window.innerHeight - 200),
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.action();
            onClose();
          }}
          className="block w-full px-3 py-1 text-left text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
