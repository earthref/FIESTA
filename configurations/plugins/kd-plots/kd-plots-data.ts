// The Kd plots' data: the search's Kd rows (GET /search/<table>/values), each
// with its plotted value and error interval, grouped into patterns (a
// contribution's rows sharing the pattern columns: one line on a plot) and
// colour groups.
import type { NodeConfig } from "@/lib/types";
import { type ElementInfo, elementOf } from "./kd-plots-elements";

export interface KdPlotsOptions {
  table: string;
  levels: string[];
  element: string;
  kd: string;
  kd_sigma: string;
  kd_low: string;
  kd_high: string;
  pattern_columns: string[];
  labels: Record<string, string>;
}

const cache = new WeakMap<NodeConfig, KdPlotsOptions>();

/** The plugin's options from the node config; one object per config, so it
 * can be a memo's dependency. */
export function kdPlotsOptions(config: NodeConfig): KdPlotsOptions {
  const cached = cache.get(config);
  if (cached) return cached;
  const options = parseOptions(config);
  cache.set(config, options);
  return options;
}

function parseOptions(config: NodeConfig): KdPlotsOptions {
  const raw = (config.plugins["kd-plots"] ?? {}) as Partial<KdPlotsOptions>;
  const pattern = Array.isArray(raw.pattern_columns)
    ? raw.pattern_columns.map(String)
    : ["minerals", "rock_types", "kd_definition", "kd_types"];
  return {
    table: raw.table ?? "kds",
    levels: Array.isArray(raw.levels) ? raw.levels.map(String) : [],
    element: raw.element ?? "element",
    kd: raw.kd ?? "kd",
    kd_sigma: raw.kd_sigma ?? "kd_sigma",
    kd_low: raw.kd_low ?? "kd_low",
    kd_high: raw.kd_high ?? "kd_high",
    pattern_columns: pattern,
    labels: raw.labels ?? {},
  };
}

export interface SearchValues {
  total: number;
  fields: string[];
  rows: (number | string | null)[][];
  truncated?: boolean;
}

/** The summary fields a plot reads, in `rowsFrom`'s order. */
export function valueFields(o: KdPlotsOptions): string[] {
  const own = [o.element, o.kd, o.kd_sigma, o.kd_low, o.kd_high, "row_id", ...o.pattern_columns];
  return [
    ...own.map((c) => `summary.${o.table}.${c}`),
    "summary.contribution.id",
    "summary.contribution._reference.citation",
  ];
}

export interface KdRow {
  /** Its index in `rows`. */
  index: number;
  element: ElementInfo;
  /** The plotted Kd: the Kd, else the geometric mean of its range (the
   * range's middle on a log axis), else the range's one end. */
  value: number;
  /** The value is a range's middle or end, not a Kd. */
  fromRange: boolean;
  /** The error interval: Kd ± σ, else the range; absent ends are open. */
  lo?: number;
  hi?: number;
  kd?: number;
  sigma?: number;
  low?: number;
  high?: number;
  contribution: string;
  citation?: string;
  /** The pattern columns' values ("" when not given). */
  attrs: Record<string, string>;
  pattern: number;
}

export interface Pattern {
  index: number;
  contribution: string;
  citation?: string;
  attrs: Record<string, string>;
  /** Its rows in row order, at most one per element. */
  rows: KdRow[];
  /** 1, 2, …: a pattern that repeats an element is split, by occurrence. */
  part: number;
}

export interface KdData {
  rows: KdRow[];
  patterns: Pattern[];
  /** Rows with no positive Kd or range, or no known element. */
  skipped: { noValue: number; unknown: Map<string, number> };
  total: number;
  truncated: boolean;
}

const positive = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const nonNegative = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function kdDataFrom(page: SearchValues, o: KdPlotsOptions): KdData {
  const at = new Map(page.fields.map((f, i) => [f, i]));
  const col = (row: SearchValues["rows"][number], c: string) => row[at.get(c) ?? -1];
  const own = (c: string) => `summary.${o.table}.${c}`;
  const rows: KdRow[] = [];
  const unknown = new Map<string, number>();
  let noValue = 0;
  const ordered = page.rows
    .map((row) => ({ row, id: Number(col(row, own("row_id"))) }))
    .sort((a, b) => (Number.isFinite(a.id) && Number.isFinite(b.id) ? a.id - b.id : 0));
  for (const { row } of ordered) {
    const symbol = text(col(row, own(o.element)));
    const element = elementOf(symbol);
    if (!element) {
      if (symbol) unknown.set(symbol, (unknown.get(symbol) ?? 0) + 1);
      else noValue++;
      continue;
    }
    const kd = positive(col(row, own(o.kd)));
    const sigma = nonNegative(col(row, own(o.kd_sigma)));
    const low = positive(col(row, own(o.kd_low)));
    const high = positive(col(row, own(o.kd_high)));
    const value = kd ?? (low && high ? Math.sqrt(low * high) : (low ?? high));
    if (value === undefined) {
      noValue++;
      continue;
    }
    let lo: number | undefined;
    let hi: number | undefined;
    if (kd !== undefined && sigma !== undefined && sigma > 0) {
      lo = kd - sigma > 0 ? kd - sigma : undefined;
      hi = kd + sigma;
    } else if (low !== undefined || high !== undefined) {
      lo = low;
      hi = high;
    }
    const attrs: Record<string, string> = {};
    for (const c of o.pattern_columns) attrs[c] = text(col(row, own(c)));
    rows.push({
      index: rows.length,
      element,
      value,
      fromRange: kd === undefined,
      lo,
      hi,
      kd,
      sigma,
      low,
      high,
      contribution: text(col(row, "summary.contribution.id")),
      citation: text(col(row, "summary.contribution._reference.citation")) || undefined,
      attrs,
      pattern: -1,
    });
  }
  // Patterns: a contribution's rows that share the pattern columns (case
  // aside: "clinopyroxene" is "Clinopyroxene"), split where an element repeats.
  const patterns: Pattern[] = [];
  const byKey = new Map<string, Pattern[]>();
  for (const row of rows) {
    const key = [
      row.contribution,
      ...o.pattern_columns.map((c) => row.attrs[c].toLowerCase()),
    ].join("\u0000");
    const parts = byKey.get(key) ?? [];
    byKey.set(key, parts);
    let target = parts.find((p) => !p.rows.some((r) => r.element === row.element));
    if (!target) {
      target = {
        index: patterns.length,
        contribution: row.contribution,
        citation: row.citation,
        attrs: row.attrs,
        rows: [],
        part: parts.length + 1,
      };
      parts.push(target);
      patterns.push(target);
    }
    target.rows.push(row);
    row.pattern = target.index;
  }
  return {
    rows,
    patterns,
    skipped: { noValue, unknown },
    total: page.total,
    truncated: Boolean(page.truncated),
  };
}

// --- Colour groups -------------------------------------------------------------------

/** "contribution", or a pattern column. */
export type ColorBy = string;

// The categorical slots every FIESTA scatter uses (rock-mag): three stay
// distinguishable to colour-blind readers when every pair can touch, as on a
// spider diagram; the rest fold into a neutral "Other".
export const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a"];
export const OTHER_COLOR = "#9a9a96";
export const OTHER = "Other";

export interface Group {
  name: string;
  color: string;
  /** Patterns in the group. */
  patterns: number;
}

/** A pattern's value for a colour choice, case-folded for grouping. */
function groupKey(p: Pattern, by: ColorBy): string {
  if (by === "contribution") return p.contribution;
  return (p.attrs[by] ?? "").toLowerCase();
}

/**
 * The colour groups: the three values of `by` with the most patterns, then
 * "Other" (unnamed values too). Returns the groups and each pattern's group
 * index. A group is named by its most common spelling, a contribution by
 * its citation.
 */
export function groupPatterns(patterns: Pattern[], by: ColorBy): { groups: Group[]; of: number[] } {
  const counts = new Map<string, number>();
  const spellings = new Map<string, Map<string, number>>();
  for (const p of patterns) {
    const key = groupKey(p, by);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const label =
      by === "contribution"
        ? `${p.citation ?? "Contribution"} (${p.contribution})`
        : (p.attrs[by] ?? key);
    const spelled = spellings.get(key) ?? new Map<string, number>();
    spelled.set(label, (spelled.get(label) ?? 0) + 1);
    spellings.set(key, spelled);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SLOTS.length)
    .map(([key]) => key);
  const groups: Group[] = top.map((key, i) => {
    const spelled = [...(spellings.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    return { name: spelled[0]?.[0] ?? key, color: SLOTS[i], patterns: 0 };
  });
  const other: Group = { name: OTHER, color: OTHER_COLOR, patterns: 0 };
  const of = patterns.map((p) => {
    const i = top.indexOf(groupKey(p, by));
    (i >= 0 ? groups[i] : other).patterns++;
    return i >= 0 ? i : SLOTS.length;
  });
  // "Other" keeps index 3 (absent groups leave holes) so `of` stays valid.
  while (groups.length < SLOTS.length) groups.push({ name: "", color: OTHER_COLOR, patterns: 0 });
  groups.push(other);
  return { groups, of };
}
