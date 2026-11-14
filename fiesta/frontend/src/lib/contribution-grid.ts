/**
 * The grid editor's model of a contribution file: the tab-delimited text
 * format `fiesta.domain.parse` reads (one `tab delimited\t<table>` block per
 * table, blocks separated by a line of `>`s), parsed into tables of rows and
 * written back. Parsing follows the server's rules exactly (blank rows are
 * skipped, cells trimmed, one table's blocks concatenated), so a row's index
 * here is the 1-based `row` of the server's validation issues minus one.
 *
 * Light client checks (types, bounds, required, controlled vocabularies)
 * mirror `fiesta.domain.validate` for cells edited since the last saved
 * revision; everything else shows the server's validation of that revision.
 */
import type { DataModelColumn, DataModelTable, Vocabulary } from "./types";

export const TABLE_SEPARATOR = ">>>>>>>>>>";
const DELIMITERS = new Set(["tab", "tab delimited"]);
const LIST_TYPES = new Set(["List", "Matrix", "Dictionary"]);

export interface GridRow {
  /** Stable for the editing session: edits, issues and undo follow the row, not its index. */
  id: number;
  cells: Record<string, string>;
}

export interface GridTable {
  name: string;
  /** Column order as the file has it; new columns are appended. */
  columns: string[];
  rows: GridRow[];
}

export type GridDoc = GridTable[];

export class GridParseError extends Error {
  constructor(
    public line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

let lastRowId = 0;
export const newRowId = () => ++lastRowId;

/** A value as the format can hold it: no tabs or line breaks, trimmed. */
export const cleanValue = (value: string) => value.replace(/[\t\r\n]+/g, " ").trim();

/** `parse_text` in the browser (same rows, same errors). */
export function parseContribution(text: string): GridDoc {
  const lines = text.replace(/^﻿+/, "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: [number, string[]][] = [];
  let start = 0;
  let current: string[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith(">>>")) {
      blocks.push([start, current]);
      current = [];
      start = i + 1;
    } else current.push(line);
  });
  blocks.push([start, current]);

  const doc: GridDoc = [];
  for (const [blockStart, block] of blocks) {
    let first = blockStart;
    while (block.length && !block[0].trim()) {
      block.shift();
      first += 1;
    }
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (!block.length) continue;
    const header = block[0].split("\t");
    if (header.length < 2) {
      throw new GridParseError(first + 1, `expected "tab delimited\\t<table>", got "${block[0]}"`);
    }
    const name = header[1].trim();
    if (!DELIMITERS.has(header[0].trim().toLowerCase())) {
      throw new GridParseError(first + 1, `unknown delimiter "${header[0]}"; expected "tab"`);
    }
    if (block.length < 2) {
      throw new GridParseError(first + 1, `table "${name}" has no column header row`);
    }
    const columns = block[1].split("\t").map((c, i) => c.trim() || `_unnamed_${i + 1}`);
    let table = doc.find((t) => t.name === name);
    if (!table) {
      table = { name, columns: [], rows: [] };
      doc.push(table);
    }
    for (const column of columns) if (!table.columns.includes(column)) table.columns.push(column);
    block.slice(2).forEach((line, offset) => {
      if (!line.trim()) return;
      const cells = line.split("\t");
      if (cells.length > columns.length) {
        throw new GridParseError(
          first + 3 + offset,
          `row has ${cells.length} cells but ${columns.length} columns`,
        );
      }
      const row: Record<string, string> = {};
      cells.forEach((cell, i) => {
        const value = cell.trim();
        if (value !== "") row[columns[i]] = value;
      });
      if (Object.keys(row).length) table.rows.push({ id: newRowId(), cells: row });
    });
  }
  return doc;
}

const hasValues = (row: GridRow) => Object.values(row.cells).some((v) => v !== "");

/**
 * Text for a new revision: tables and columns keep the file's order (a
 * table or column the grid added goes after them, in data model order),
 * and empty rows, columns and tables are left out, as the parser would.
 */
export function serializeContribution(
  doc: GridDoc,
  modelTables: Record<string, DataModelTable> = {},
): string {
  const chunks: string[] = [];
  for (const table of doc) {
    const rows = table.rows.filter(hasValues);
    if (!rows.length) continue;
    const present = new Set<string>();
    for (const row of rows) for (const [k, v] of Object.entries(row.cells)) if (v) present.add(k);
    const columns = table.columns.filter((c) => present.has(c));
    const model = orderedColumns(modelTables[table.name]);
    for (const c of model) if (present.has(c) && !columns.includes(c)) columns.push(c);
    for (const c of [...present].sort()) if (!columns.includes(c)) columns.push(c);
    const lines = [`tab delimited\t${table.name}`, columns.join("\t")];
    for (const row of rows)
      lines.push(columns.map((c) => cleanValue(row.cells[c] ?? "")).join("\t"));
    chunks.push(lines.join("\n"));
  }
  return chunks.length ? `${chunks.join(`\n${TABLE_SEPARATOR}\n`)}\n` : "";
}

// --- the data model's validation DSL -----------------------------------------------------------

/** `name(args)` calls of a column's `validations`, e.g. cv("lithology") -> ["cv", ["lithology"]]. */
export function validationCalls(column?: DataModelColumn): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  for (const validation of column?.validations ?? []) {
    const match = /^(\w+)\((.*)\)$/.exec(validation.trim());
    if (!match) continue;
    const args = match[2]
      ? match[2].split(",").map((a) => a.trim().replace(/^["']|["']$/g, ""))
      : [];
    calls.set(match[1], args);
  }
  return calls;
}

export const isListColumn = (column?: DataModelColumn) => LIST_TYPES.has(column?.type ?? "");
export const isRequired = (column?: DataModelColumn) => validationCalls(column).has("required");
/** downloadOnly() columns are written by the system (ids), never typed. */
export const isReadOnly = (column?: DataModelColumn) => validationCalls(column).has("downloadOnly");

export function splitValues(column: DataModelColumn | undefined, value: string): string[] {
  if (!value) return [];
  if (!isListColumn(column)) return [value];
  return value
    .split(":")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A data model table's columns in position order. */
export function orderedColumns(table?: DataModelTable): string[] {
  if (!table) return [];
  return Object.entries(table.columns)
    .map(([name, column], i) => ({ name, position: column.position ?? i, i }))
    .sort((a, b) => a.position - b.position || a.i - b.i)
    .map((c) => c.name);
}

/** A vocabulary with a membership set; `upper` compares upper-cased (plugin lists). */
export interface IndexedVocabulary extends Vocabulary {
  name: string;
  set: Set<string>;
  upper: boolean;
  /** cv lists are errors; sv lists and type() lists are suggestions only. */
  controlled: boolean;
}

export type VocabularyLookup = (name: string, kind: "cv" | "sv") => IndexedVocabulary | undefined;

/** The list a column's pulldown offers: cv(), then sv(), then a type() a vocabulary is named for. */
export function columnVocabulary(
  column: DataModelColumn | undefined,
  lookup: VocabularyLookup,
): IndexedVocabulary | undefined {
  const calls = validationCalls(column);
  const cv = calls.get("cv")?.[0];
  if (cv) return lookup(cv, "cv");
  const sv = calls.get("sv")?.[0];
  if (sv) return lookup(sv, "sv");
  const type = calls.get("type")?.[0];
  const typed = type ? lookup(type, "cv") : undefined;
  return typed ? { ...typed, controlled: false } : undefined;
}

/** `in("samples.sample")`: the column takes values of another table's column. */
export function columnReference(column?: DataModelColumn): [string, string] | undefined {
  const target = validationCalls(column).get("in")?.[0];
  const [table, name] = target?.split(".") ?? [];
  return table && name ? [table, name] : undefined;
}

const NUMBER_WORDS = /^[+-]?(inf|infinity|nan)$/i;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** A number as Python prints a float (the validator's wording). */
const pyFloat = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

function asNumber(value: string): number | null {
  const v = value.trim();
  if (!v || /^0x/i.test(v)) return null;
  if (NUMBER_WORDS.test(v)) return Number.NaN;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * The validator's errors for one edited cell (same wording). Not a port of
 * the validator: cross-row checks (unique, requiredIf, ...) wait for the
 * server's validation of the saved revision.
 */
export function checkCell(
  name: string,
  column: DataModelColumn | undefined,
  value: string,
  rowHasValues: boolean,
  lookup: VocabularyLookup,
): string[] {
  if (!column) return value ? [`unrecognized column '${name}'`] : [];
  const calls = validationCalls(column);
  if (!value)
    return calls.has("required") && rowHasValues ? [`missing required value for '${name}'`] : [];
  const type = column.type ?? "String";
  if (type === "Integer" && !/^\s*[+-]?\d+\s*$/.test(value))
    return [`expected an integer, got '${value}'`];
  if (type === "Number" && asNumber(value) === null) return [`expected a number, got '${value}'`];
  if (type === "Timestamp" && !TIMESTAMP.test(value)) {
    return [`expected an ISO 8601 timestamp, got '${value}'`];
  }
  const errors: string[] = [];
  const number = asNumber(value);
  const min = calls.get("min")?.[0];
  const max = calls.get("max")?.[0];
  if (number !== null && min !== undefined && asNumber(min) !== null && number < Number(min)) {
    errors.push(`${pyFloat(number)} is below the minimum ${pyFloat(Number(min))}`);
  }
  if (number !== null && max !== undefined && asNumber(max) !== null && number > Number(max)) {
    errors.push(`${pyFloat(number)} is above the maximum ${pyFloat(Number(max))}`);
  }
  const cv = calls.get("cv")?.[0];
  const vocabulary = cv ? lookup(cv, "cv") : undefined;
  if (cv && vocabulary) {
    for (const v of splitValues(column, value)) {
      if (!vocabulary.set.has(vocabulary.upper ? v.toUpperCase() : v)) {
        errors.push(`'${v}' is not in the controlled vocabulary '${cv}'`);
      }
    }
  }
  return errors;
}

/** Index served vocabularies (controlled, plugin-supplied, suggested) for lookups. */
export function indexVocabularies(
  controlled: Record<string, Vocabulary> = {},
  plugins: Record<string, Vocabulary & { case_insensitive?: boolean }> = {},
  suggested: Record<string, Vocabulary> = {},
): VocabularyLookup {
  const cache = new Map<string, IndexedVocabulary | undefined>();
  const index = (
    name: string,
    vocabulary: (Vocabulary & { case_insensitive?: boolean }) | undefined,
    controlledList: boolean,
  ) => {
    if (!vocabulary) return undefined;
    const upper = !!vocabulary.case_insensitive;
    const items = vocabulary.items ?? [];
    return {
      ...vocabulary,
      items,
      name,
      upper,
      controlled: controlledList,
      set: new Set(items.map((i) => (upper ? String(i.item).toUpperCase() : String(i.item)))),
    };
  };
  return (name, kind) => {
    const key = `${kind}:${name}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        kind === "cv"
          ? index(name, controlled[name] ?? plugins[name], true)
          : index(name, suggested[name], false),
      );
    }
    return cache.get(key);
  };
}
