/**
 * One sheet's import settings (legacy MagIC common/components/data_importer.jsx):
 * the import template, table name and header-row count above a preview whose
 * columns are included and mapped to data-model columns and whose rows are
 * included one by one. The parent owns the state; `computeSheet` derives
 * everything shown from it.
 */
import { useId, useState } from "react";
import {
  applyTemplate,
  computeSheet,
  initialState,
  type Sheet,
  type SheetImport,
  type SheetState,
  templateSettings,
} from "../lib/importer";
import type { DataModel, ImportSettings, ImportTemplate } from "../lib/types";
import { cx } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

const PREVIEW_ROWS = 6;

export interface TemplateActions {
  templates: ImportTemplate[] | undefined;
  create: (name: string, settings: ImportSettings) => Promise<ImportTemplate>;
  save: (id: number, settings: ImportSettings) => Promise<unknown>;
  rename: (id: number, name: string) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
}

type Dialog = { kind: "create" | "rename" | "delete" | "save"; name: string } | null;

const selectClass =
  "rounded-md border border-gray-300 bg-surface px-2 py-1.5 text-[13px] text-gray-900 focus:border-node focus:outline-hidden focus:ring-1 focus:ring-node disabled:opacity-60";

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

function ErrorList({ result }: { result: SheetImport }) {
  const all = [
    ...result.errors.data,
    ...result.errors.tableName,
    ...result.errors.nHeaderRows,
    ...result.errors.columnNames,
  ];
  if (all.length === 0) return null;
  const skipping = result.nErrors === 0;
  return (
    <details
      open={!skipping}
      className={cx(
        "mt-3 rounded-md px-3 py-2 text-[13px]",
        skipping ? "bg-gray-50 text-gray-600" : "bg-red-50 text-red-800",
      )}
    >
      <summary className="cursor-pointer font-semibold">
        {skipping ? all[0] : `${result.nErrors} import error${result.nErrors === 1 ? "" : "s"}`}
      </summary>
      {!skipping && (
        <ul className="mt-1 list-disc pl-5">
          {all.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function DataImporter({
  sheet,
  state,
  onChange,
  model,
  templates,
}: {
  sheet: Sheet;
  state: SheetState;
  onChange: (state: SheetState) => void;
  model: DataModel | null;
  templates: TemplateActions;
}) {
  const id = useId();
  const [previewRows, setPreviewRows] = useState(PREVIEW_ROWS);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const result = computeSheet(sheet.rows, state, model);
  const { settings } = state;
  const table = settings.table_name.trim();
  const known = !!model?.tables[table];
  const template = templates.templates?.find((t) => t.id === templateId);
  const disabled = settings.exclude_table;

  const set = (patch: Partial<SheetState>) => onChange({ ...state, ...patch });
  const setSettings = (patch: Partial<ImportSettings>) =>
    set({ settings: { ...settings, ...patch } });
  const toggle = (list: number[], i: number) =>
    list.includes(i) ? list.filter((x) => x !== i) : [...list, i];

  const loadTemplate = (value: string) => {
    if (value === "") {
      setTemplateId(null);
      onChange(initialState({ ...sheet, tableName: "", nHeaderRows: "" }, model));
      return;
    }
    const picked = templates.templates?.find((t) => String(t.id) === value);
    if (!picked) return;
    setTemplateId(picked.id);
    onChange(applyTemplate(sheet.rows, picked.settings, model));
  };

  const submitDialog = async () => {
    if (!dialog) return;
    setBusy(true);
    setDialogError(null);
    try {
      const current = templateSettings(state, result);
      if (dialog.kind === "create") {
        const made = await templates.create(dialog.name.trim(), current);
        setTemplateId(made.id);
      } else if (dialog.kind === "save" && template) {
        await templates.save(template.id, current);
      } else if (dialog.kind === "rename" && template) {
        await templates.rename(template.id, dialog.name.trim());
      } else if (dialog.kind === "delete" && template) {
        await templates.remove(template.id);
        setTemplateId(null);
      }
      setDialog(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dataRowIndexes: number[] = [];
  for (
    let r = result.nHeaderRows;
    r < sheet.rows.length && dataRowIndexes.length < previewRows;
    r++
  )
    dataRowIndexes.push(r);
  const nDataRows = Math.max(0, sheet.rows.length - result.nHeaderRows);
  // Column and header-row positions (keys: the table's cells are positional).
  const positions = result.inColumnNames.map((_, i) => i);
  const headerRowIndexes = sheet.rows.slice(0, result.nHeaderRows).map((_, r) => r);
  const headerRowsId = useId();
  const templateNameId = useId();

  return (
    <div className="mt-4 rounded-md border border-gray-200 p-3">
      {sheet.label && (
        <h4 className="mb-2 text-[13px] font-semibold text-gray-700">{sheet.label}</h4>
      )}
      <div className="grid gap-2 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)_minmax(0,4fr)]">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor={id}>
            Import template
          </label>
          <select
            id={id}
            className={cx(selectClass, "min-w-0 flex-1")}
            value={templateId ?? ""}
            onChange={(event) => loadTemplate(event.target.value)}
          >
            <option value="">
              {templateId ? "Clear Import Settings" : "Select to Load Template"}
            </option>
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
                variant="secondary"
                onClick={() => setDialog({ kind: "save", name: template.name })}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDialog({ kind: "rename", name: template.name })}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setDialog({ kind: "delete", name: template.name })}
              >
                Delete
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDialog({ kind: "create", name: "" })}
          >
            Save As New Template
          </Button>
        </div>
        <label className="flex items-center gap-1.5 text-[13px]">
          <span className="shrink-0 font-semibold text-gray-700">Table Name</span>
          <select
            className={cx(
              selectClass,
              "min-w-0 flex-1",
              !disabled && result.errors.tableName.length > 0 && "border-red-400",
            )}
            value={known ? table : ""}
            onChange={(event) => setSettings({ table_name: event.target.value })}
          >
            <option value="">
              {table && !known ? `${table} (unrecognized)` : "Select a table"}
            </option>
            {tablesInOrder(model).map((name) => (
              <option key={name} value={name}>
                {model?.tables[name].label ? `${model.tables[name].label} (${name})` : name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1.5 text-[13px]">
          <label htmlFor={headerRowsId} className="shrink-0 font-semibold text-gray-700">
            Header Rows
          </label>
          <Input
            id={headerRowsId}
            className={cx(
              "py-1.5",
              !disabled && result.errors.nHeaderRows.length > 0 && "border-red-400",
            )}
            value={settings.n_header_rows}
            placeholder="None"
            onChange={(event) => setSettings({ n_header_rows: event.target.value })}
          />
        </div>
      </div>

      <ErrorList result={result} />

      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-gray-50">
              <th className="border border-gray-200 px-1.5 py-1 text-left">
                <label
                  className="flex items-center gap-1"
                  title="Click to include or skip this table."
                >
                  <input
                    type="checkbox"
                    checked={!settings.exclude_table}
                    onChange={() => setSettings({ exclude_table: !settings.exclude_table })}
                  />
                  <span className="sr-only">Import this table</span>
                </label>
              </th>
              {positions.map((i) => {
                const name = result.inColumnNames[i];
                const off = result.skippedColumns.has(i);
                return (
                  <th
                    key={i}
                    className="whitespace-nowrap border border-gray-200 px-1.5 py-1 text-left font-semibold"
                  >
                    <label
                      className="flex items-center gap-1"
                      title={
                        result.downloadOnly.has(i)
                          ? "A download-only column: never imported."
                          : `Click to ${off ? "include" : "exclude"}.`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={disabled || result.downloadOnly.has(i)}
                        onChange={() => set({ excludeColumns: toggle(state.excludeColumns, i) })}
                      />
                      <span className={cx(!off && !disabled ? "text-node-ink" : "text-gray-400")}>
                        {name}
                      </span>
                    </label>
                  </th>
                );
              })}
            </tr>
            <tr>
              <th className="border border-gray-200 px-1.5 py-1 text-right font-normal text-gray-500">
                Into
              </th>
              {positions.map((i) => {
                const name = result.inColumnNames[i];
                const out = result.outColumnNames[i];
                const bad =
                  !disabled &&
                  known &&
                  !result.skippedColumns.has(i) &&
                  result.errors.columnNames.some((e) => e.includes(`column number ${i + 1} `));
                return (
                  <th key={i} className="border border-gray-200 px-1 py-1">
                    <select
                      aria-label={`Data model column for ${name}`}
                      className={cx(
                        selectClass,
                        "w-full min-w-28 py-1 text-[12px]",
                        bad && "border-red-400",
                      )}
                      disabled={disabled || !known || result.skippedColumns.has(i)}
                      value={out && model?.tables[table]?.columns[out] ? out : ""}
                      onChange={(event) => {
                        const targets = [...state.targets];
                        targets[i] = event.target.value;
                        set({ targets });
                      }}
                    >
                      <option value="">{out ? `${out} (unrecognized)` : "Select a column"}</option>
                      {known &&
                        columnsInOrder(model, table).map((column) => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                    </select>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {headerRowIndexes.map((r) => (
              <tr key={r} className="bg-gray-50 text-gray-400 italic">
                <td className="border border-gray-200 px-1.5 py-0.5 text-right">{r + 1}</td>
                {positions.map((i) => (
                  <td key={i} className="whitespace-nowrap border border-gray-200 px-1.5 py-0.5">
                    {sheet.rows[r][i]}
                  </td>
                ))}
              </tr>
            ))}
            {dataRowIndexes.map((r) => {
              const off = result.skippedRows.has(r);
              return (
                <tr key={r} className={cx(off && "text-gray-400")}>
                  <td className="border border-gray-200 px-1.5 py-0.5 text-right">
                    <label className="flex items-center justify-end gap-1">
                      <input
                        type="checkbox"
                        checked={!off}
                        disabled={disabled}
                        onChange={() => set({ excludeRows: toggle(state.excludeRows, r) })}
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
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <div className="flex flex-wrap gap-1.5">
          {previewRows < nDataRows && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPreviewRows(previewRows + PREVIEW_ROWS)}
            >
              Preview More Rows
            </Button>
          )}
          {previewRows > PREVIEW_ROWS && (
            <Button size="sm" variant="secondary" onClick={() => setPreviewRows(PREVIEW_ROWS)}>
              Preview Less Rows
            </Button>
          )}
          {previewRows < nDataRows ? (
            <Button size="sm" variant="secondary" onClick={() => setPreviewRows(nDataRows)}>
              Show All Rows
            </Button>
          ) : (
            <span className="self-center text-gray-500">All rows are displayed.</span>
          )}
        </div>
        <span className="text-gray-700">
          Importing <strong>{result.nRows.toLocaleString()}</strong>{" "}
          {result.nRows === 1 ? "row" : "rows"} with <strong>{result.nColumns}</strong>{" "}
          {result.nColumns === 1 ? "column" : "columns"}.
        </span>
      </div>

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
    </div>
  );
}
