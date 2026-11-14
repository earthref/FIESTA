/**
 * The upload page's import step, browser half (legacy MagIC
 * upload_contribution.jsx `parse` / `xlsSheetToArray` and
 * common/components/data_importer.jsx). Files become sheets of string cells;
 * each sheet's settings map it to a data-model table and columns; the ready
 * sheets become contribution text (one block per sheet) that
 * POST /private/contributions/{id}/import normalises and merges.
 */
import type { DataModel, ExcelTemplate, ImportFormat, ImportSettings } from "./types";

/** One table-shaped piece of a file: a spreadsheet sheet, a block of the
 * node's text format, or a whole delimited file. */
export interface Sheet {
  /** The sheet or block name shown above its importer. */
  label: string;
  rows: string[][];
  /** The table name the file suggests (sheet name, block header). */
  tableName: string;
  /** The header-row count the file suggests ("" for none). */
  nHeaderRows: string;
}

const FORMAT_LABELS: Record<ImportFormat, string> = {
  fiesta: "Text File",
  tsv: "Tab Delimited Text File",
  csv: "Comma Delimited Text File",
  excel: "Excel File",
};

/** The file-type override menu's label for a format (`key`: the node's key,
 * so its multi-table text reads "MagIC Text File"). */
export function formatLabel(format: ImportFormat, key: string): string {
  return format === "fiesta" ? `${key} ${FORMAT_LABELS.fiesta}` : FORMAT_LABELS[format];
}

export const FORMATS: ImportFormat[] = ["fiesta", "tsv", "csv", "excel"];

// CRLF, or any single line break (the legacy reader's set).
const LINE_BREAK = /\r\n|[\n\v\f\r\x85\u2028\u2029]/;
const BLOCK_HEADER = /^tab( delimited)?\s*?\t(.+?)\s*$/i;

export function decodeText(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** A file's format from its name and first line: spreadsheets by extension,
 * the node's multi-table text by its `tab delimited\t<table>` first line,
 * then CSV by extension, else tab-delimited. */
export function guessFormat(name: string, bytes: ArrayBuffer): ImportFormat {
  if (/\.(xlsx?|xlsm|xlsb|ods)$/i.test(name)) return "excel";
  const head = decodeText(bytes.slice(0, 4096));
  const first = head.split(LINE_BREAK).find((line) => line.trim() !== "") ?? "";
  if (BLOCK_HEADER.test(first)) return "fiesta";
  return /\.csv$/i.test(name) ? "csv" : "tsv";
}

/** Legacy `guessHeaderRows`: the first row (of 100) whose first cell names a
 * table in the singular ("site" for sites) ends the header; else one row. */
export function guessHeaderRows(rows: string[][], model: DataModel | null): string {
  const tables = new Set(Object.keys(model?.tables ?? {}));
  const index = rows
    .slice(0, 100)
    .findIndex((row) => row[0] !== undefined && tables.has(`${row[0].toLowerCase()}s`));
  return index >= 0 ? String(index + 1) : "1";
}

/** The node's multi-table text: one sheet per `>>>`-separated block, whose
 * first two rows (the `tab delimited` line and the column names) are header. */
export function readBlocks(text: string): Sheet[] {
  const blocks: string[][] = [[]];
  for (const line of text.split(LINE_BREAK)) {
    // The backend's separator rule (fiesta.domain.parse): a line of `>>>`.
    if (line.startsWith(">>>")) blocks.push([]);
    else if (line.replace(/\t+$/, "").trim() !== "") blocks[blocks.length - 1].push(line);
  }
  return blocks
    .filter((lines) => lines.length > 0)
    .map((lines, i) => {
      const tableName = lines[0].match(BLOCK_HEADER)?.[2] ?? "";
      const rows = lines.map((line) => line.replace(/\t+$/, "").split("\t"));
      return { label: tableName || `Table ${i + 1}`, rows, tableName, nHeaderRows: "2" };
    });
}

export function readDelimited(text: string, delimiter: "\t" | ","): string[][] {
  if (delimiter === "\t") {
    return text
      .split(LINE_BREAK)
      .filter((line) => line.trim() !== "")
      .map((line) => line.split("\t"));
  }
  // RFC 4180: quoted fields may hold commas, line breaks and doubled quotes.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** A1-style address -> zero-based [row, column]. */
export function decodeCell(address: string): [number, number] {
  const match = address.match(/^([A-Z]+)(\d+)$/);
  if (!match) return [-1, -1];
  let column = 0;
  for (const ch of match[1]) column = column * 26 + (ch.charCodeAt(0) - 64);
  return [Number(match[2]) - 1, column - 1];
}

/** The cells of a sheet as rows of trimmed strings (legacy
 * `xlsSheetToArray`), minus the leading rows and columns of the first
 * Excel template whose marker cells all match. `cells` maps A1 addresses to
 * the cell's raw value. */
export function sheetRows(
  cells: Record<string, unknown>,
  templates: ExcelTemplate[],
): { rows: string[][]; template: ExcelTemplate | null } {
  const text = (address: string) => {
    const value = cells[address];
    return value === undefined || value === null ? "" : String(value);
  };
  const template =
    templates.find((t) =>
      Object.entries(t.markers).every(([cell, pattern]) => new RegExp(pattern).test(text(cell))),
    ) ?? null;
  const skipRows = template?.skip_rows ?? 0;
  const skipColumns = template?.skip_columns ?? 0;
  const rows: string[][] = [];
  for (const [address, value] of Object.entries(cells)) {
    const [r, c] = decodeCell(address);
    if (r < skipRows || c < skipColumns) continue;
    if (!rows[r - skipRows]) rows[r - skipRows] = [];
    rows[r - skipRows][c - skipColumns] =
      value === undefined || value === null ? "" : String(value).trim();
  }
  const width = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  return {
    rows: Array.from(rows, (row) => Array.from({ length: width }, (_, i) => row?.[i] ?? "")),
    template,
  };
}

/** Read a spreadsheet with SheetJS (loaded on first use). */
export async function readWorkbook(
  bytes: ArrayBuffer,
  templates: ExcelTemplate[],
): Promise<Sheet[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(new Uint8Array(bytes), { type: "array", dense: false });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name] as Record<string, { v?: unknown }>;
    const cells: Record<string, unknown> = {};
    for (const [address, cell] of Object.entries(sheet)) {
      if (!address.startsWith("!")) cells[address] = cell?.v;
    }
    const { rows, template } = sheetRows(cells, templates);
    return { label: name, rows, tableName: name.trim(), nHeaderRows: template ? "1" : "" };
  });
}

/** Every sheet of a file read as `format`. A sheet's `nHeaderRows` of ""
 * here means "guess it from the data model" (see `guessHeaderRows`). */
export async function readSheets(
  bytes: ArrayBuffer,
  format: ImportFormat,
  templates: ExcelTemplate[],
): Promise<Sheet[]> {
  if (format === "excel") return readWorkbook(bytes, templates);
  const text = decodeText(bytes);
  if (format === "fiesta") return readBlocks(text);
  const rows = readDelimited(text, format === "csv" ? "," : "\t");
  return [{ label: "", rows, tableName: "", nHeaderRows: "" }];
}

// --- One sheet's import (legacy DataImporter.componentWillUpdate) ---

/** A sheet's importer state: its settings plus the columns and rows the
 * contributor picked. `targets[i]`: the data-model column chosen for input
 * column i (undefined: the suggestion; "": none). */
export interface SheetState {
  settings: ImportSettings;
  targets: (string | undefined)[];
  excludeColumns: number[];
  excludeRows: number[];
}

export interface SheetErrors {
  data: string[];
  nHeaderRows: string[];
  tableName: string[];
  columnNames: string[];
}

export interface SheetImport {
  nHeaderRows: number;
  inColumnNames: string[];
  /** The data-model column each input column imports into (undefined: none). */
  outColumnNames: (string | undefined)[];
  /** Input columns not imported: excluded, or into a download-only column. */
  skippedColumns: Set<number>;
  downloadOnly: Set<number>;
  /** Rows not imported: excluded, or empty. */
  skippedRows: Set<number>;
  errors: SheetErrors;
  nErrors: number;
  /** Rows and columns that would be imported. */
  nRows: number;
  nColumns: number;
}

export function initialState(sheet: Sheet, model: DataModel | null): SheetState {
  return {
    settings: {
      table_name: sheet.tableName,
      n_header_rows: sheet.nHeaderRows || guessHeaderRows(sheet.rows, model),
      column_map: {},
      exclude_column_names: [],
      exclude_table: false,
    },
    targets: [],
    excludeColumns: [],
    excludeRows: [],
  };
}

function isDownloadOnly(column: { validations?: string[] } | undefined): boolean {
  return !!column?.validations?.some((v) => /^downloadOnly\(\)$/.test(v.trim()));
}

/** The data-model column an input header names, by column name or label,
 * ignoring case (legacy suggester). */
export function suggestColumn(
  header: string,
  columns: Record<string, { label?: string }>,
): string | undefined {
  const wanted = header.trim().toLowerCase();
  if (!wanted) return undefined;
  let byLabel: string | undefined;
  for (const [name, column] of Object.entries(columns)) {
    if (name.toLowerCase() === wanted) return name;
    if (!byLabel && column.label?.toLowerCase() === wanted) byLabel = name;
  }
  return byLabel;
}

export function computeSheet(
  rows: string[][],
  state: SheetState,
  model: DataModel | null,
): SheetImport {
  const { settings } = state;
  const errors: SheetErrors = { data: [], nHeaderRows: [], tableName: [], columnNames: [] };
  const raw = settings.n_header_rows.trim();
  const label = '"Number of Header Rows" must be empty (for no header) or';
  if (raw !== "" && !/^-?\d+$/.test(raw)) errors.nHeaderRows.push(`${label} an integer.`);
  else if (raw !== "" && Number(raw) < 0)
    errors.nHeaderRows.push(`${label} greater than or equal to 0.`);
  else if (raw !== "" && rows.length > 0 && Number(raw) > rows.length)
    errors.nHeaderRows.push(
      `${label} less than or equal to ${rows.length} (the number of rows in the dataset).`,
    );
  const nHeaderRows = errors.nHeaderRows.length || raw === "" ? 0 : Number(raw);

  const table = settings.table_name.trim();
  const columns = (table && model?.tables[table]?.columns) || undefined;
  if (!table) errors.tableName.push('"Table Name" must be selected.');
  else if (!columns) errors.tableName.push(`Table name "${table}" is not recognized.`);

  const width = rows.reduce(
    (max, row, i) => (i >= nHeaderRows ? Math.max(max, row.length) : max),
    0,
  );
  const header = nHeaderRows > 0 ? (rows[nHeaderRows - 1] ?? []) : [];
  const inColumnNames = Array.from({ length: width }, (_, i) =>
    header[i]?.trim() ? header[i].trim() : `Column ${i + 1}`,
  );

  const excluded = new Set(state.excludeColumns);
  const downloadOnly = new Set<number>();
  const outColumnNames = inColumnNames.map((name, i) => {
    const picked = state.targets[i];
    if (picked !== undefined) return picked || undefined;
    return columns ? suggestColumn(name, columns) : undefined;
  });
  outColumnNames.forEach((out, i) => {
    if (columns && out && isDownloadOnly(columns[out])) downloadOnly.add(i);
  });
  const skippedColumns = new Set([...excluded, ...downloadOnly]);

  const counts = new Map<string, number>();
  outColumnNames.forEach((out, i) => {
    if (out && !skippedColumns.has(i)) counts.set(out, (counts.get(out) ?? 0) + 1);
  });
  if (columns) {
    outColumnNames.forEach((out, i) => {
      if (skippedColumns.has(i)) return;
      const where = `in column number ${i + 1} for table name "${table}".`;
      if (out && !columns[out])
        errors.columnNames.push(`Selected column name "${out}" is unrecognized ${where}`);
      else if (!out)
        errors.columnNames.push(`Column name "${inColumnNames[i]}" is unrecognized ${where}`);
      if (out && (counts.get(out) ?? 0) > 1)
        errors.columnNames.push(
          `Column name "${inColumnNames[i]}" in column number ${i + 1} and another column are ` +
            `both importing into the "${table}.${out}" data model column. Either exclude the ` +
            "duplicate columns or change their import column.",
        );
    });
  }

  const skippedRows = new Set(state.excludeRows);
  rows.forEach((row, i) => {
    if (i >= nHeaderRows && row.every((cell) => !cell?.trim())) skippedRows.add(i);
  });
  let nRows = 0;
  for (let i = nHeaderRows; i < rows.length; i++) if (!skippedRows.has(i)) nRows++;
  const nColumns = width - [...skippedColumns].filter((i) => i < width).length;
  if (nColumns <= 0) errors.data.push("There are no columns to import.");
  else if (nRows <= 0) errors.data.push("There are no rows to import.");

  if (settings.exclude_table) {
    return {
      nHeaderRows,
      inColumnNames,
      outColumnNames,
      skippedColumns,
      downloadOnly,
      skippedRows,
      errors: {
        data: [table ? `Skipping table "${table}".` : "Skipping this table."],
        nHeaderRows: [],
        tableName: [],
        columnNames: [],
      },
      nErrors: 0,
      nRows: 0,
      nColumns: 0,
    };
  }
  const nErrors =
    errors.data.length +
    errors.nHeaderRows.length +
    errors.tableName.length +
    errors.columnNames.length;
  return {
    nHeaderRows,
    inColumnNames,
    outColumnNames,
    skippedColumns,
    downloadOnly,
    skippedRows,
    errors,
    nErrors,
    nRows,
    nColumns,
  };
}

/** The settings an import template saves for a sheet: the column map by
 * input header (with the suggestions taken), and the excluded headers. */
export function templateSettings(state: SheetState, result: SheetImport): ImportSettings {
  const columnMap: Record<string, string | null> = {};
  result.inColumnNames.forEach((name, i) => {
    columnMap[name] = result.outColumnNames[i] ?? null;
  });
  return {
    ...state.settings,
    column_map: columnMap,
    exclude_column_names: state.excludeColumns
      .map((i) => result.inColumnNames[i])
      .filter((n): n is string => !!n),
  };
}

/** Apply a template's settings to a sheet (legacy: the column map by input
 * header, excluded columns by header; rows are picked again). The header
 * names come from the template's own header-row count. */
export function applyTemplate(
  rows: string[][],
  settings: ImportSettings,
  model: DataModel | null,
): SheetState {
  const state: SheetState = {
    settings: { ...settings },
    targets: [],
    excludeColumns: [],
    excludeRows: [],
  };
  const { inColumnNames } = computeSheet(rows, state, model);
  state.targets = inColumnNames.map((name) =>
    name in settings.column_map ? (settings.column_map[name] ?? "") : undefined,
  );
  state.excludeColumns = settings.exclude_column_names
    .map((name) => inColumnNames.indexOf(name))
    .filter((i) => i >= 0);
  return state;
}

const clean = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();

/** A ready sheet as one block of contribution text, or null when it is
 * skipped or still has errors. */
export function sheetBlock(
  rows: string[][],
  state: SheetState,
  result: SheetImport,
): string | null {
  if (state.settings.exclude_table || result.nErrors > 0) return null;
  const keep = result.inColumnNames.map((_, i) => i).filter((i) => !result.skippedColumns.has(i));
  const lines = [
    `tab delimited\t${state.settings.table_name.trim()}`,
    keep.map((i) => result.outColumnNames[i] as string).join("\t"),
  ];
  for (let r = result.nHeaderRows; r < rows.length; r++) {
    if (result.skippedRows.has(r)) continue;
    lines.push(keep.map((i) => clean(rows[r][i] ?? "")).join("\t"));
  }
  return lines.join("\n");
}

/** Tables brought from more than one sheet that the node allows from one
 * only (MagIC: measurements). */
export function singleSourceErrors(tables: string[], singleSource: string[]): string[] {
  return singleSource
    .filter((table) => tables.filter((t) => t === table).length > 1)
    .map(
      (table) =>
        `There is more than one ${table} table in this upload. Please combine them before uploading.`,
    );
}
