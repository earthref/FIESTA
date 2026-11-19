/**
 * The upload page's Step 2 overview: what in a sheet's import the
 * contributor must fix before uploading, and what the importer decided on
 * its own that is worth a look (a guessed table or header row, columns
 * matched by label or an old name, values outside a column's type or range,
 * required columns missing or blank). Everything is read from the data
 * model, so every node gets the same review.
 */
import type { MatchKind, SheetImport, SheetState } from "./importer";
import type { DataModel, DataModelColumn, ImportTemplate } from "./types";

export type Severity = "fix" | "review";

export type ReviewTopic = "table" | "headerRows" | "column" | "values" | "required" | "data";

export interface ReviewItem {
  /** Stable across re-renders: dismissing an item records its key. */
  key: string;
  severity: Severity;
  topic: ReviewTopic;
  message: string;
  /** The input column the item is about. */
  column?: number;
  /** The data-model column it was matched to (accepting it keeps it). */
  target?: string;
}

export type SheetStatus = "fix" | "review" | "ready" | "skipped";

export interface SheetReview {
  status: SheetStatus;
  items: ReviewItem[];
  nFix: number;
  nReview: number;
  /** Rows the value checks read (all of them, up to `maxRows`). */
  nChecked: number;
}

export const MATCH_LABELS: Record<MatchKind, string> = {
  manual: "picked",
  name: "exact name",
  label: "by label",
  alias: "older name",
  loose: "loose match",
  remembered: "remembered",
};

/** Why a suggested column was picked, for the attention list. */
const MATCH_REASONS: Record<MatchKind, string> = {
  manual: "as you picked",
  name: "by its name",
  label: "by its label",
  alias: "by its name in an older data model",
  loose: "by a loose match (ignoring case, spacing and units)",
  remembered: "as you picked in an earlier upload",
};

/** Matches the contributor should glance at (the others are exact). */
export const SOFT_MATCHES = new Set<MatchKind>(["label", "alias", "loose", "remembered"]);

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

const quote = (values: string[]) => values.map((v) => `"${v}"`).join(", ");

/** A `min(…)` / `max(…)` validation's bound, if numeric. */
function bound(column: DataModelColumn, which: "min" | "max"): number | undefined {
  for (const v of column.validations ?? []) {
    const m = v
      .trim()
      .match(new RegExp(`^${which}\\(\\s*["']?(-?[\\d.]+(?:e-?\\d+)?)["']?\\s*\\)$`));
    if (m) return Number(m[1]);
  }
  return undefined;
}

const isRequired = (column: DataModelColumn | undefined) =>
  !!column?.validations?.some((v) => v.trim() === "required()");

/** Read a cell as a number the way a contributor writes one. */
function asNumber(value: string): number | null {
  const n = Number(value.replace(/^\+/, ""));
  return Number.isFinite(n) ? n : null;
}

export function reviewSheet(
  rows: string[][],
  state: SheetState,
  result: SheetImport,
  model: DataModel | null,
  maxRows = 5000,
): SheetReview {
  if (state.settings.exclude_table)
    return { status: "skipped", items: [], nFix: 0, nReview: 0, nChecked: 0 };
  const dismissed = new Set(state.dismissed ?? []);
  const items: ReviewItem[] = [];
  const add = (item: ReviewItem) => {
    if (item.severity === "fix" || !dismissed.has(item.key)) items.push(item);
  };
  const table = state.settings.table_name.trim();
  const columns = model?.tables[table]?.columns;

  for (const message of result.errors.tableName)
    add({ key: "table", severity: "fix", topic: "table", message });
  for (const message of result.errors.nHeaderRows)
    add({ key: "header-rows", severity: "fix", topic: "headerRows", message });
  for (const message of result.errors.data)
    add({ key: `data:${message}`, severity: "fix", topic: "data", message });

  if (columns && state.guessed?.table)
    add({
      key: `table-guess:${table}`,
      severity: "review",
      topic: "table",
      message: `No sheet or block name names a table, so the ${table} table was chosen because most column headers belong to it.`,
    });
  if (
    state.guessed?.headerRows &&
    result.nHeaderRows > 0 &&
    result.errors.nHeaderRows.length === 0
  ) {
    const header = rows[result.nHeaderRows - 1] ?? [];
    add({
      key: `header-rows:${result.nHeaderRows}`,
      severity: "review",
      topic: "headerRows",
      message: `The column headers were taken from row ${result.nHeaderRows} (${quote(
        header.filter(Boolean).slice(0, 3),
      )}${header.filter(Boolean).length > 3 ? ", …" : ""}).`,
    });
  }

  // Per input column: what blocks it, and how it was matched.
  const counts = new Map<string, number>();
  result.outColumnNames.forEach((out, i) => {
    if (out && !result.skippedColumns.has(i)) counts.set(out, (counts.get(out) ?? 0) + 1);
  });
  if (columns) {
    result.inColumnNames.forEach((name, i) => {
      if (result.skippedColumns.has(i)) return;
      const out = result.outColumnNames[i];
      if (!out)
        add({
          key: `unmapped:${i}`,
          severity: "fix",
          topic: "column",
          column: i,
          message: `"${name}" matches no ${table} column: pick one or leave it out.`,
        });
      else if (!columns[out])
        add({
          key: `unknown:${i}`,
          severity: "fix",
          topic: "column",
          column: i,
          message: `"${name}" is set to "${out}", which is not a ${table} column.`,
        });
      else if ((counts.get(out) ?? 0) > 1)
        add({
          key: `duplicate:${i}`,
          severity: "fix",
          topic: "column",
          column: i,
          target: out,
          message: `"${name}" and another column both go into ${out}: change one or leave one out.`,
        });
      const kind = result.matches[i];
      if (out && columns[out] && kind && SOFT_MATCHES.has(kind))
        add({
          key: `match:${i}:${out}`,
          severity: "review",
          topic: "column",
          column: i,
          target: out,
          message: `"${name}" goes into ${out}${
            columns[out].label ? ` (${columns[out].label})` : ""
          }, ${MATCH_REASONS[kind]}.`,
        });
    });
  }

  // Values against each mapped column's type and range, and required columns.
  let nChecked = 0;
  if (columns) {
    const dataRows: number[] = [];
    for (let r = result.nHeaderRows; r < rows.length && dataRows.length < maxRows; r++)
      if (!result.skippedRows.has(r)) dataRows.push(r);
    nChecked = dataRows.length;
    const ofRows = result.nRows > nChecked ? ` of the first ${nChecked.toLocaleString()} rows` : "";
    result.inColumnNames.forEach((name, i) => {
      const out = result.outColumnNames[i];
      const def = out ? columns[out] : undefined;
      if (!out || !def || result.skippedColumns.has(i) || (counts.get(out) ?? 0) > 1) return;
      const numeric = def.type === "Number" || def.type === "Integer";
      const min = bound(def, "min");
      const max = bound(def, "max");
      const bad: string[] = [];
      const low: string[] = [];
      const high: string[] = [];
      let nBad = 0;
      let nLow = 0;
      let nHigh = 0;
      let nBlank = 0;
      for (const r of dataRows) {
        const value = (rows[r][i] ?? "").trim();
        if (!value) {
          nBlank++;
          continue;
        }
        if (!numeric && min === undefined && max === undefined) continue;
        const n = asNumber(value);
        if (n === null || (def.type === "Integer" && !Number.isInteger(n))) {
          if (numeric) {
            nBad++;
            if (bad.length < 3 && !bad.includes(value)) bad.push(value);
          }
          continue;
        }
        if (min !== undefined && n < min) {
          nLow++;
          if (low.length < 3) low.push(value);
        }
        if (max !== undefined && n > max) {
          nHigh++;
          if (high.length < 3) high.push(value);
        }
      }
      const what = `${out}${def.unit && def.unit !== "Custom" ? ` (${def.unit})` : ""}`;
      if (nBad)
        add({
          key: `values:${i}:${out}:type`,
          severity: "review",
          topic: "values",
          column: i,
          target: out,
          message: `${plural(nBad, "value")}${ofRows} in "${name}" ${nBad === 1 ? "is" : "are"} not ${
            def.type === "Integer" ? "a whole number" : "a number"
          } for ${what}: ${quote(bad)}.`,
        });
      if (nLow)
        add({
          key: `values:${i}:${out}:min`,
          severity: "review",
          topic: "values",
          column: i,
          target: out,
          message: `${plural(nLow, "value")}${ofRows} in "${name}" ${nLow === 1 ? "is" : "are"} below ${what}'s minimum of ${min}: ${quote(low)}.`,
        });
      if (nHigh)
        add({
          key: `values:${i}:${out}:max`,
          severity: "review",
          topic: "values",
          column: i,
          target: out,
          message: `${plural(nHigh, "value")}${ofRows} in "${name}" ${nHigh === 1 ? "is" : "are"} above ${what}'s maximum of ${max}: ${quote(high)}.`,
        });
      if (isRequired(def) && nBlank > 0)
        add({
          key: `values:${i}:${out}:blank`,
          severity: "review",
          topic: "required",
          column: i,
          target: out,
          message: `${out} is required, but ${nBlank === nChecked ? "every" : plural(nBlank, "row")}${
            nBlank === nChecked ? " row" : ofRows
          } leaves "${name}" blank.`,
        });
    });
    const mapped = new Set(
      result.outColumnNames.filter((out, i) => out && !result.skippedColumns.has(i)),
    );
    const missing = Object.entries(columns)
      .filter(([column, def]) => isRequired(def) && !mapped.has(column))
      .sort(([, a], [, b]) => (a.position ?? 0) - (b.position ?? 0))
      .map(([column]) => column);
    if (missing.length && result.nErrors === 0)
      add({
        key: `required:${table}:${missing.join(",")}`,
        severity: "review",
        topic: "required",
        message: `${table} requires ${missing.length === 1 ? "a column" : "columns"} this sheet does not have: ${missing.join(", ")}. Validation will ask for ${missing.length === 1 ? "it" : "them"} unless the contribution already has ${missing.length === 1 ? "it" : "them"}.`,
      });
  }

  // What blocks the upload first, each group in sheet order.
  items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fix" ? -1 : 1));
  const nFix = items.filter((item) => item.severity === "fix").length;
  const nReview = items.length - nFix;
  return {
    status: nFix > 0 || result.nErrors > 0 ? "fix" : nReview > 0 ? "review" : "ready",
    items,
    nFix: Math.max(nFix, result.nErrors > 0 ? 1 : 0),
    nReview,
    nChecked,
  };
}

/** The saved template whose column map covers most of a sheet's headers
 * (at least 80% of them, and at least two), for an "apply it?" offer. */
export function matchTemplate(
  templates: ImportTemplate[] | undefined,
  headers: string[],
): { template: ImportTemplate; matched: number; total: number } | null {
  const names = headers.filter((h) => !/^Column \d+$/.test(h));
  if (!templates?.length || names.length < 2) return null;
  let best: { template: ImportTemplate; matched: number; total: number } | null = null;
  for (const template of templates) {
    const known = new Set([
      ...Object.keys(template.settings.column_map ?? {}),
      ...(template.settings.exclude_column_names ?? []),
    ]);
    const matched = names.filter((n) => known.has(n)).length;
    if (matched * 5 >= names.length * 4 && (!best || matched > best.matched))
      best = { template, matched, total: names.length };
  }
  return best;
}

// --- Remembered column choices (per browser, per node) ---

const memoryKey = (node: string) => `fiesta:import-columns:${node}`;

/** The header -> column choices this browser remembers for a node. */
export function loadColumnHints(node: string): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(memoryKey(node));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Remember the columns a contributor picked by hand (or accepted) in an
 * upload, so the next upload suggests them. */
export function rememberColumns(
  node: string,
  picks: { table: string; header: string; column: string }[],
): void {
  if (!picks.length) return;
  try {
    const hints = loadColumnHints(node);
    for (const { table, header, column } of picks) {
      const key = header.trim().toLowerCase();
      if (!key || key === column.toLowerCase()) continue;
      hints[table] = { ...(hints[table] ?? {}), [key]: column };
    }
    localStorage.setItem(memoryKey(node), JSON.stringify(hints));
  } catch {
    // Storage is a convenience: a private window simply forgets.
  }
}
