/**
 * One sheet's import (legacy MagIC common/components/data_importer.jsx,
 * redesigned 2026-11-16): a collapsible card whose header says where the
 * sheet goes and whether it needs anything; inside, the items to fix or look
 * at with their fixes beside them, then the sheet's columns as a list (input
 * header, sample values, data-model column, how it was matched) and the
 * legacy preview grid for including rows. The parent owns the state and
 * computes the import and its review.
 */
import { useId, useState } from "react";
import {
  MATCH_LABELS,
  matchTemplate,
  type ReviewItem,
  type SheetReview,
  SOFT_MATCHES,
} from "../lib/import-review";
import {
  applyTemplate,
  initialState,
  type Sheet,
  type SheetImport,
  type SheetState,
  templateSettings,
} from "../lib/importer";
import type { DataModel, ImportSettings, ImportTemplate } from "../lib/types";
import { cx } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

const PREVIEW_ROWS = 6;
const ATTENTION_SHOWN = 8;

export interface TemplateActions {
  templates: ImportTemplate[] | undefined;
  create: (name: string, settings: ImportSettings) => Promise<ImportTemplate>;
  save: (id: number, settings: ImportSettings) => Promise<unknown>;
  rename: (id: number, name: string) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
}

type Dialog = { kind: "create" | "rename" | "delete" | "save"; name: string } | null;

type Filter = "attention" | "unmatched" | "all";

const selectClass =
  "rounded-md border border-gray-300 bg-surface px-2 py-1.5 text-[13px] text-gray-900 focus:border-node focus:outline-hidden focus:ring-1 focus:ring-node disabled:opacity-60";

export const STATUS_STYLE: Record<
  SheetReview["status"],
  { label: string; badge: "danger" | "warning" | "success" | "muted"; edge: string }
> = {
  fix: { label: "Fix", badge: "danger", edge: "border-l-red-500" },
  review: { label: "Review", badge: "warning", edge: "border-l-amber-400" },
  ready: { label: "Ready", badge: "success", edge: "border-l-green-500" },
  skipped: { label: "Skipped", badge: "muted", edge: "border-l-gray-300" },
};

function tablesInOrder(model: DataModel | null): string[] {
  const tables = model?.tables ?? {};
  return Object.keys(tables).sort((a, b) => (tables[a].position ?? 0) - (tables[b].position ?? 0));
}

function columnsInOrder(model: DataModel | null, table: string): string[] {
  const columns = model?.tables[table]?.columns ?? {};
  return Object.keys(columns).sort(
    (a, b) => (columns[a].position ?? 0) - (columns[b].position ?? 0),
  );
}

/** A data-model column picker: type to search the sheet's shared list of
 * column names (with labels), committed on Enter, blur or an exact pick. */
function ColumnPicker({
  value,
  listId,
  known,
  onPick,
  label,
  disabled,
  invalid,
}: {
  value: string;
  listId: string;
  known: (name: string) => boolean;
  onPick: (column: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (next: string) => {
    setDraft(null);
    if (next.trim() !== value) onPick(next.trim());
  };
  return (
    <input
      aria-label={label}
      list={listId}
      disabled={disabled}
      placeholder="Pick a column"
      className={cx(selectClass, "w-full min-w-36 py-1 text-[12px]", invalid && "border-red-400")}
      value={draft ?? value}
      onChange={(event) => {
        const next = event.target.value;
        // A pick from the list commits at once; typing waits for Enter or blur
        // (typing "lat" on the way to "lat_sigma" must not pick lat).
        const inputType = (event.nativeEvent as InputEvent).inputType;
        const picked = !inputType || inputType === "insertReplacementText";
        if (picked && known(next)) commit(next);
        else setDraft(next);
      }}
      onBlur={() => draft !== null && commit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && draft !== null) commit(draft);
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

export function DataImporter({
  sheet,
  title,
  state,
  onChange,
  model,
  templates,
  result,
  review,
  open,
  onToggle,
  anchor,
  sameHeaders,
  onApplyToSameHeaders,
}: {
  sheet: Sheet;
  /** "file › sheet", or the file name for a one-table file. */
  title: string;
  state: SheetState;
  onChange: (state: SheetState) => void;
  model: DataModel | null;
  templates: TemplateActions;
  result: SheetImport;
  review: SheetReview;
  open: boolean;
  onToggle: () => void;
  /** The card's element id (the overview links to it). */
  anchor: string;
  /** Other sheets in this upload with the same column headers. */
  sameHeaders: number;
  onApplyToSameHeaders: () => void;
}) {
  const listId = useId();
  const headerRowsId = useId();
  const templateNameId = useId();
  const [filter, setFilterState] = useState<Filter | null>(null);
  const [touched, setTouched] = useState<number[]>([]);
  const setFilter = (next: Filter) => {
    setFilterState(next);
    setTouched([]);
  };
  const touch = (i: number) => setTouched((t) => (t.includes(i) ? t : [...t, i]));
  const [tab, setTab] = useState<"columns" | "preview">("columns");
  const [previewRows, setPreviewRows] = useState(PREVIEW_ROWS);
  const [showAll, setShowAll] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [offerDismissed, setOfferDismissed] = useState(false);
  const { settings } = state;
  const table = settings.table_name.trim();
  const columns = model?.tables[table]?.columns;
  const known = !!columns;
  const templateId = state.templateId ?? null;
  const template = templates.templates?.find((t) => t.id === templateId);
  const disabled = settings.exclude_table;
  const style = STATUS_STYLE[review.status];

  const set = (patch: Partial<SheetState>) => onChange({ ...state, ...patch });
  const setSettings = (patch: Partial<ImportSettings>, extra: Partial<SheetState> = {}) =>
    set({ settings: { ...settings, ...patch }, ...extra });
  const pick = (i: number, column: string) => {
    const targets = [...state.targets];
    targets[i] = column;
    set({ targets, excludeColumns: state.excludeColumns.filter((x) => x !== i) });
  };
  const leaveOut = (indexes: number[]) =>
    set({ excludeColumns: [...new Set([...state.excludeColumns, ...indexes])] });
  const toggleColumn = (i: number) =>
    set({
      excludeColumns: state.excludeColumns.includes(i)
        ? state.excludeColumns.filter((x) => x !== i)
        : [...state.excludeColumns, i],
    });
  const toggleRow = (r: number) =>
    set({
      excludeRows: state.excludeRows.includes(r)
        ? state.excludeRows.filter((x) => x !== r)
        : [...state.excludeRows, r],
    });
  const dismiss = (key: string) => set({ dismissed: [...(state.dismissed ?? []), key] });
  const setTable = (name: string) =>
    setSettings({ table_name: name }, { guessed: { ...state.guessed, table: false } });
  const setHeaderRows = (value: string) =>
    setSettings({ n_header_rows: value }, { guessed: { ...state.guessed, headerRows: false } });

  const softIndexes = result.inColumnNames
    .map((_, i) => i)
    .filter((i) => {
      const kind = result.matches[i];
      return (
        !result.skippedColumns.has(i) && kind && SOFT_MATCHES.has(kind) && result.outColumnNames[i]
      );
    });
  const acceptAll = () => {
    const targets = [...state.targets];
    for (const i of softIndexes) targets[i] = result.outColumnNames[i];
    set({ targets });
  };
  const unmatched = result.inColumnNames
    .map((_, i) => i)
    .filter((i) => {
      if (result.skippedColumns.has(i)) return false;
      const out = result.outColumnNames[i];
      return !out || !columns?.[out];
    });

  const loadTemplate = (value: string) => {
    if (value === "") {
      onChange({
        ...initialState({ ...sheet, tableName: "", nHeaderRows: "" }, model),
        templateId: null,
      });
      return;
    }
    const picked = templates.templates?.find((t) => String(t.id) === value);
    if (picked)
      onChange({ ...applyTemplate(sheet.rows, picked.settings, model), templateId: picked.id });
  };
  const offer =
    !templateId && !offerDismissed
      ? matchTemplate(templates.templates, result.inColumnNames)
      : null;

  const submitDialog = async () => {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      const current = templateSettings(state, result);
      if (dialog.kind === "create") {
        const made = await templates.create(dialog.name.trim(), current);
        set({ templateId: made.id });
      } else if (dialog.kind === "save" && template) {
        await templates.save(template.id, current);
      } else if (dialog.kind === "rename" && template) {
        await templates.rename(template.id, dialog.name.trim());
      } else if (dialog.kind === "delete" && template) {
        await templates.remove(template.id);
        set({ templateId: null });
      }
      setDialog(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  // Items per input column, for the column list's flags and filter.
  const byColumn = new Map<number, ReviewItem[]>();
  for (const item of review.items)
    if (item.column !== undefined)
      byColumn.set(item.column, [...(byColumn.get(item.column) ?? []), item]);
  const positions = result.inColumnNames.map((_, i) => i);
  const activeFilter: Filter = filter ?? "attention";
  // A row the contributor just changed stays listed until the filter changes,
  // so fixing it does not pull it out from under the pointer.
  const listed = positions.filter(
    (i) =>
      touched.includes(i) ||
      (activeFilter === "attention"
        ? byColumn.has(i)
        : activeFilter === "unmatched"
          ? unmatched.includes(i)
          : true),
  );
  const dataRowIndexes: number[] = [];
  for (let r = result.nHeaderRows; r < sheet.rows.length; r++) dataRowIndexes.push(r);
  const samples = (i: number) => {
    const values: string[] = [];
    for (const r of dataRowIndexes) {
      const value = sheet.rows[r]?.[i]?.trim();
      if (value && !values.includes(value)) values.push(value);
      if (values.length === 3) break;
    }
    return values;
  };
  const nDataRows = dataRowIndexes.length;
  const nMapped = positions.filter(
    (i) =>
      !result.skippedColumns.has(i) &&
      result.outColumnNames[i] &&
      columns?.[result.outColumnNames[i] as string],
  ).length;
  const shownItems = showAll ? review.items : review.items.slice(0, ATTENTION_SHOWN);

  const tableSelect = (className?: string) => (
    <select
      aria-label="Table"
      className={cx(
        selectClass,
        className,
        !disabled && result.errors.tableName.length > 0 && "border-red-400",
      )}
      value={known ? table : ""}
      disabled={disabled}
      onChange={(event) => setTable(event.target.value)}
    >
      <option value="">{table && !known ? `${table} (unrecognized)` : "Select a table"}</option>
      {tablesInOrder(model).map((name) => (
        <option key={name} value={name}>
          {model?.tables[name].label ? `${model.tables[name].label} (${name})` : name}
        </option>
      ))}
    </select>
  );

  const itemActions = (item: ReviewItem) => {
    const i = item.column;
    const looksRight =
      item.severity === "review" ? (
        <Button size="sm" variant="ghost" onClick={() => dismiss(item.key)}>
          Looks right
        </Button>
      ) : null;
    if (item.topic === "table")
      return (
        <>
          {tableSelect("py-1 text-[12px]")}
          {looksRight}
        </>
      );
    if (item.topic === "headerRows")
      return (
        <>
          <div className="w-16">
            <Input
              aria-label="Header rows"
              className="py-1 text-[12px]"
              value={settings.n_header_rows}
              onChange={(event) => setHeaderRows(event.target.value)}
            />
          </div>
          {looksRight}
        </>
      );
    if (i === undefined) return looksRight;
    const out = result.outColumnNames[i] ?? "";
    return (
      <>
        {item.key.startsWith("match:") && (
          <Button size="sm" variant="secondary" onClick={() => pick(i, out)}>
            Accept
          </Button>
        )}
        {known && (
          <div className="w-44">
            <ColumnPicker
              value={out}
              listId={listId}
              known={(name) => !!columns?.[name]}
              onPick={(column) => pick(i, column)}
              label={`Data model column for ${result.inColumnNames[i]}`}
              invalid={item.severity === "fix"}
            />
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={() => leaveOut([i])}>
          Leave out
        </Button>
        {item.topic !== "column" && looksRight}
      </>
    );
  };

  return (
    <section
      id={anchor}
      className={cx("mt-3 scroll-mt-4 rounded-md border border-l-4 border-gray-200", style.edge)}
    >
      {/* Header: always visible. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[13px]"
      >
        <Icon name={open ? "caret-down" : "caret-right"} className="text-gray-500" />
        <Badge variant={style.badge}>{style.label}</Badge>
        <span className="font-semibold text-gray-900">{title}</span>
        {!disabled && (
          <span className="text-gray-600">
            → {known ? table : <em>no table</em>}
            {known && (
              <>
                {" · "}
                {result.nRows.toLocaleString()} {result.nRows === 1 ? "row" : "rows"} · {nMapped} of{" "}
                {positions.length} columns
              </>
            )}
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          {review.nFix > 0 && <Badge variant="danger">{review.nFix} to fix</Badge>}
          {review.nReview > 0 && <Badge variant="warning">{review.nReview} to review</Badge>}
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-200 px-3 pb-3">
          {/* Settings. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!settings.exclude_table}
                onChange={() => setSettings({ exclude_table: !settings.exclude_table })}
              />
              <span className="font-semibold text-gray-700">Import</span>
            </label>
            <div className="flex min-w-56 flex-1 items-center gap-1.5">
              <span aria-hidden className="shrink-0 font-semibold text-gray-700">
                Table
              </span>
              {tableSelect("min-w-0 flex-1")}
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor={headerRowsId} className="shrink-0 font-semibold text-gray-700">
                Header rows
              </label>
              <Input
                id={headerRowsId}
                className={cx(
                  "py-1.5",
                  !disabled && result.errors.nHeaderRows.length > 0 && "border-red-400",
                )}
                style={{ width: "4.5rem" }}
                value={settings.n_header_rows}
                placeholder="None"
                disabled={disabled}
                onChange={(event) => setHeaderRows(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="shrink-0 font-semibold text-gray-700">Template</span>
              <select
                aria-label="Import template"
                className={cx(selectClass, "max-w-56")}
                value={templateId ?? ""}
                onChange={(event) => loadTemplate(event.target.value)}
              >
                <option value="">{templateId ? "Clear template" : "None"}</option>
                {(templates.templates ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {template && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: "save", name: template.name })}
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: "rename", name: template.name })}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog({ kind: "delete", name: template.name })}
                  >
                    Delete
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDialog({ kind: "create", name: "" })}
              >
                Save as new…
              </Button>
            </div>
          </div>

          {offer && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-node-soft px-3 py-2 text-[13px]">
              <Icon name="info" />
              <span>
                Your template <strong>{offer.template.name}</strong> covers {offer.matched} of{" "}
                {offer.total} columns in this sheet.
              </span>
              <Button size="sm" onClick={() => loadTemplate(String(offer.template.id))}>
                Apply it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOfferDismissed(true)}>
                No thanks
              </Button>
            </div>
          )}

          {disabled ? (
            <p className="mt-3 text-[13px] text-gray-500">This sheet will not be imported.</p>
          ) : (
            <>
              {/* What needs the contributor. */}
              {review.items.length > 0 && (
                <div className="mt-3">
                  <h4 className="mb-1 text-[13px] font-semibold text-gray-800">
                    Needs your attention
                  </h4>
                  <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                    {shownItems.map((item) => (
                      <li
                        key={item.key}
                        className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[13px]"
                      >
                        <Icon
                          name={item.severity === "fix" ? "times-circle" : "warning"}
                          className={item.severity === "fix" ? "text-red-600" : "text-amber-600"}
                        />
                        <span className="min-w-60 flex-1 text-gray-800">{item.message}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {itemActions(item)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {review.items.length > ATTENTION_SHOWN && (
                    <button
                      type="button"
                      className="mt-1 text-[12px] text-node-ink underline"
                      onClick={() => setShowAll(!showAll)}
                    >
                      {showAll ? "Show fewer" : `Show all ${review.items.length}`}
                    </button>
                  )}
                </div>
              )}

              {/* Bulk actions. */}
              {(softIndexes.length > 0 || unmatched.length > 0 || sameHeaders > 0) && known && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {softIndexes.length > 0 && (
                    <Button size="sm" variant="secondary" onClick={acceptAll}>
                      Accept {softIndexes.length} suggested{" "}
                      {softIndexes.length === 1 ? "match" : "matches"}
                    </Button>
                  )}
                  {unmatched.length > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => leaveOut(unmatched)}>
                      Leave out {unmatched.length} unmatched{" "}
                      {unmatched.length === 1 ? "column" : "columns"}
                    </Button>
                  )}
                  {sameHeaders > 0 && (
                    <Button size="sm" variant="secondary" onClick={onApplyToSameHeaders}>
                      Use these settings for {sameHeaders} other{" "}
                      {sameHeaders === 1 ? "sheet" : "sheets"} with the same headers
                    </Button>
                  )}
                </div>
              )}

              {/* Columns / preview. */}
              <div className="mt-4 flex items-end gap-4 border-b border-gray-200 text-[13px]">
                {(["columns", "preview"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cx(
                      "-mb-px border-b-2 px-1 pb-1.5 font-semibold",
                      tab === t ? "border-node text-node-ink" : "border-transparent text-gray-500",
                    )}
                  >
                    {t === "columns"
                      ? `Columns (${positions.length})`
                      : `Preview rows (${nDataRows.toLocaleString()})`}
                  </button>
                ))}
                {tab === "columns" && (
                  <span className="ml-auto flex gap-1 pb-1">
                    {(
                      [
                        ["attention", `Needs attention (${byColumn.size})`],
                        ["unmatched", `Unmatched (${unmatched.length})`],
                        ["all", `All (${positions.length})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setFilter(key)}
                        className={cx(
                          "rounded-full px-2 py-0.5 text-[12px]",
                          activeFilter === key
                            ? "bg-node-soft text-node-ink-strong"
                            : "text-gray-600 hover:bg-gray-100",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                )}
              </div>

              {known && (
                <datalist id={listId}>
                  {columnsInOrder(model, table).map((column) => (
                    <option key={column} value={column}>
                      {columns?.[column]?.label}
                    </option>
                  ))}
                </datalist>
              )}

              {tab === "columns" ? (
                <div className="mt-2 overflow-x-auto">
                  {listed.length === 0 ? (
                    <p className="px-1 py-2 text-[13px] text-gray-500">
                      {activeFilter === "attention"
                        ? "No column needs attention. "
                        : "No unmatched columns. "}
                      <button
                        type="button"
                        className="text-node-ink underline"
                        onClick={() => setFilter("all")}
                      >
                        Show all {positions.length} columns
                      </button>
                    </p>
                  ) : (
                    <table className="min-w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="w-6 px-1.5 py-1 font-normal">
                            <span className="sr-only">Import</span>
                          </th>
                          <th className="px-1.5 py-1 font-normal">In the file</th>
                          <th className="px-1.5 py-1 font-normal">Sample values</th>
                          <th className="px-1.5 py-1 font-normal">Into</th>
                          <th className="px-1.5 py-1 font-normal">Match</th>
                        </tr>
                      </thead>
                      <tbody>
                        {listed.map((i) => {
                          const off = result.skippedColumns.has(i);
                          const out = result.outColumnNames[i] ?? "";
                          const kind = result.matches[i];
                          const issues = byColumn.get(i) ?? [];
                          const worst = issues.some((x) => x.severity === "fix")
                            ? "fix"
                            : issues.length
                              ? "review"
                              : null;
                          const def = out ? columns?.[out] : undefined;
                          return (
                            <tr
                              key={i}
                              className={cx("border-t border-gray-100", off && "text-gray-400")}
                            >
                              <td className="px-1.5 py-1">
                                <input
                                  type="checkbox"
                                  aria-label={`Import ${result.inColumnNames[i]}`}
                                  checked={!off}
                                  disabled={result.downloadOnly.has(i)}
                                  title={
                                    result.downloadOnly.has(i)
                                      ? "A download-only column: never imported."
                                      : undefined
                                  }
                                  onChange={() => {
                                    touch(i);
                                    toggleColumn(i);
                                  }}
                                />
                              </td>
                              <td className="whitespace-nowrap px-1.5 py-1 font-semibold">
                                {result.inColumnNames[i]}
                              </td>
                              <td
                                className="max-w-64 truncate px-1.5 py-1 text-gray-500"
                                title={samples(i).join(" · ")}
                              >
                                {samples(i).join(" · ")}
                              </td>
                              <td className="px-1.5 py-1" title={def?.description}>
                                <ColumnPicker
                                  value={out}
                                  listId={listId}
                                  known={(name) => !!columns?.[name]}
                                  onPick={(column) => {
                                    touch(i);
                                    pick(i, column);
                                  }}
                                  label={`Data model column for ${result.inColumnNames[i]}`}
                                  disabled={off}
                                  invalid={!off && worst === "fix"}
                                />
                              </td>
                              <td className="whitespace-nowrap px-1.5 py-1">
                                {result.downloadOnly.has(i) ? (
                                  <Badge variant="muted">download only</Badge>
                                ) : off ? (
                                  <Badge variant="muted">left out</Badge>
                                ) : kind ? (
                                  <Badge
                                    variant={
                                      SOFT_MATCHES.has(kind)
                                        ? "warning"
                                        : kind === "manual"
                                          ? "node"
                                          : "default"
                                    }
                                  >
                                    {MATCH_LABELS[kind]}
                                  </Badge>
                                ) : (
                                  <Badge variant="danger">no match</Badge>
                                )}
                                {worst && (
                                  <span
                                    title={issues.map((x) => x.message).join("\n")}
                                    className="ml-1"
                                  >
                                    <Icon
                                      name={worst === "fix" ? "times-circle" : "warning"}
                                      className={
                                        worst === "fix" ? "text-red-600" : "text-amber-600"
                                      }
                                    />
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="min-w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className="border border-gray-200 px-1.5 py-1" />
                        {positions.map((i) => (
                          <th
                            key={i}
                            className="whitespace-nowrap border border-gray-200 px-1.5 py-1 text-left font-semibold"
                          >
                            <span
                              className={
                                result.skippedColumns.has(i)
                                  ? "text-gray-400 line-through"
                                  : "text-node-ink"
                              }
                            >
                              {result.skippedColumns.has(i)
                                ? result.inColumnNames[i]
                                : (result.outColumnNames[i] ?? result.inColumnNames[i])}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.slice(0, result.nHeaderRows).map((row, r) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: header rows are positional
                        <tr key={r} className="bg-gray-50 text-gray-400 italic">
                          <td className="border border-gray-200 px-1.5 py-0.5 text-right">
                            {r + 1}
                          </td>
                          {positions.map((i) => (
                            <td
                              key={i}
                              className="whitespace-nowrap border border-gray-200 px-1.5 py-0.5"
                            >
                              {row[i]}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {dataRowIndexes.slice(0, previewRows).map((r) => {
                        const off = result.skippedRows.has(r);
                        return (
                          <tr key={r} className={cx(off && "text-gray-400")}>
                            <td className="border border-gray-200 px-1.5 py-0.5 text-right">
                              <label className="flex items-center justify-end gap-1">
                                <input
                                  type="checkbox"
                                  checked={!off}
                                  onChange={() => toggleRow(r)}
                                />
                                {r + 1}
                              </label>
                            </td>
                            {positions.map((i) => (
                              <td
                                key={i}
                                className={cx(
                                  "max-w-60 truncate whitespace-nowrap border border-gray-200 px-1.5 py-0.5",
                                  result.skippedColumns.has(i) && "text-gray-400",
                                )}
                              >
                                {sheet.rows[r][i]}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {nDataRows > previewRows && (
                    <button
                      type="button"
                      className="mt-1 text-[12px] text-node-ink underline"
                      onClick={() => setPreviewRows(previewRows + 50)}
                    >
                      Show more rows ({(nDataRows - previewRows).toLocaleString()} more)
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={
          dialog?.kind === "create"
            ? "Save As New Import Template"
            : dialog?.kind === "rename"
              ? "Rename Import Template"
              : dialog?.kind === "delete"
                ? "Delete Import Template"
                : "Save Import Template"
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={dialog?.kind === "delete" ? "danger" : "primary"}
              disabled={
                busy ||
                ((dialog?.kind === "create" || dialog?.kind === "rename") && !dialog.name.trim())
              }
              onClick={submitDialog}
            >
              {dialog?.kind === "delete" ? "Delete" : dialog?.kind === "rename" ? "Rename" : "Save"}
            </Button>
          </>
        }
      >
        {dialog?.kind === "create" || dialog?.kind === "rename" ? (
          <div className="block text-[13px]">
            <label htmlFor={templateNameId} className="mb-1 block font-semibold text-gray-700">
              Template name
            </label>
            <Input
              id={templateNameId}
              autoFocus
              value={dialog.name}
              onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && dialog.name.trim()) submitDialog();
              }}
            />
          </div>
        ) : dialog?.kind === "delete" ? (
          <p className="text-[13px]">Delete the import template "{dialog.name}"?</p>
        ) : (
          <p className="text-[13px]">
            Replace the settings saved in "{dialog?.name}" with this table's settings?
          </p>
        )}
        <p className="mt-2 text-[12px] text-gray-500">
          Templates keep the table name, header rows, column choices and excluded columns for your
          next upload of a file laid out like this one.
        </p>
        {dialogError && <p className="mt-2 text-[13px] text-red-700">{dialogError}</p>}
      </Modal>
    </section>
  );
}
