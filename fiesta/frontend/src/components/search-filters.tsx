// The search page's filter sidebar, driven by the node YAML's `search.filters`
// (config.filters): facet buckets, numeric ranges (a number column's
// `summary._num.<column>`, or a plugin's field), the `numeric` picker of any
// other number column (each picked range a chip of its own), the `exists`
// picker of columns with or without data per table and the bounding box, plus
// the Geospatial area on levels with positions. Each filter names the search
// levels and result views it applies to (empty = everywhere), so the sidebar
// changes with the active level tab and sub-tab (legacy: the Poles view shows
// Age / A95 / Geospatial instead of the buckets).
//
// The sidebar lists the filters (FilterEntry), each with its applied values as
// removable chips; choosing one opens its modal (filter-modals.tsx), which has
// the room for long lists, distributions and a map (2026-11-10).

import type { ReactNode } from "react";
import type { NodeConfig, SearchFilter } from "../lib/types";
import { cx, facetTitle, formatNumber } from "../lib/utils";
import { Icon } from "./ui/icon";
import { Spinner } from "./ui/spinner";

/** The filters shown for a level + result view. */
export function applicableFilters(
  config: NodeConfig | undefined,
  levelName: string | undefined,
  viewName: string | undefined,
): SearchFilter[] {
  if (!config || !levelName) return [];
  return (config.filters ?? []).filter(
    (filter) =>
      (filter.levels.length === 0 || filter.levels.includes(levelName)) &&
      (filter.views.length === 0 || (!!viewName && filter.views.includes(viewName))),
  );
}

export function filterLabel(filter: SearchFilter): string {
  return filter.label ?? (filter.field ? facetTitle(filter.field) : filter.type);
}

/** Split "field:gte:lte" from the right (field may contain dots, never colons). */
export function parseRange(entry: string): { field: string; gte: string; lte: string } {
  const parts = entry.split(":");
  const lte = parts.pop() ?? "";
  const gte = parts.pop() ?? "";
  return { field: parts.join(":"), gte, lte };
}

/** A number column's document path (its records' values as numbers). */
export const NUMBER_PREFIX = "summary._num.";

/** The `ranges` entries that belong to the given filters: their range
 * filters' fields, and with a `numeric` filter any number column's. */
export function rangesFor(ranges: string[], filters: SearchFilter[]): string[] {
  const fields = new Set(filters.filter((f) => f.type === "range").map((f) => f.field));
  const numeric = filters.some((f) => f.type === "numeric");
  return ranges.filter((entry) => {
    const { field } = parseRange(entry);
    return fields.has(field) || (numeric && field.startsWith(NUMBER_PREFIX));
  });
}

/** The ranges a `numeric` filter's picker set: number columns' that no range
 * filter shown beside it has. */
export function pickedRanges(ranges: string[], filters: SearchFilter[]): string[] {
  const fields = new Set(filters.filter((f) => f.type === "range").map((f) => f.field));
  return ranges.filter((entry) => {
    const { field } = parseRange(entry);
    return field.startsWith(NUMBER_PREFIX) && !fields.has(field);
  });
}

/** The with/without data filter's "any table" tab (summary._has._any). */
export const ANY_TABLE = "_any";

/** A with/without data entry (the `has` param): "<table>:<column>" a value
 * in that column, "!<table>:<column>" the table but not that column. */
export type HasEntry = { table: string; column: string; without: boolean };

export function parseHas(entry: string): HasEntry {
  const without = entry.startsWith("!");
  const [table = "", ...rest] = (without ? entry.slice(1) : entry).split(":");
  return { table, column: rest.join(":"), without };
}

export function formatHas({ table, column, without }: HasEntry): string {
  return `${without ? "!" : ""}${table}:${column}`;
}

/** The `has` entries on the tables a search table's docs record (its
 * `exists_tables`); the others don't apply there. */
export function hasFor(has: string[], tables: string[] | undefined): string[] {
  const offered = new Set(tables ?? []);
  return has.filter((entry) => offered.has(parseHas(entry).table));
}

/** An applied value: its text and a button that removes it. */
export function Chip({
  label,
  title,
  onRemove,
}: {
  label: ReactNode;
  title?: string;
  onRemove: () => void;
}) {
  const name = title ?? (typeof label === "string" ? label : "filter");
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-start gap-1 whitespace-normal rounded-sm bg-node-soft px-1.5 py-0.5 text-[12px] font-bold text-node-ink"
    >
      <span className="min-w-0 break-words">{label}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        className="mt-[1px] shrink-0 cursor-pointer rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        <Icon name="close" style={{ width: "0.9em", height: "0.9em" }} />
      </button>
    </span>
  );
}

export type FilterChip = { key: string; label: ReactNode; title?: string; onRemove: () => void };

/**
 * One filter in the sidebar (legacy `styles.filter` block: padded, a 1px
 * divider): its name, which opens its modal, how many of the matches have a
 * value for it (`count`, the most it can match; a spinner while it loads,
 * none when it could not be counted),
 * and its applied values. At zero it is disabled, unless values are applied.
 */
export function FilterEntry({
  label,
  count,
  chips,
  onOpen,
}: {
  label: string;
  count?: number | null;
  chips: FilterChip[];
  onOpen: () => void;
}) {
  const active = chips.length > 0;
  const disabled = count === 0 && !active;
  return (
    <div
      className="text-[13px]"
      style={{ padding: "0.25em 1em 0.5em", borderBottom: "1px solid var(--er-edge)" }}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-haspopup="dialog"
        title={disabled ? `No records to filter by ${label}` : `Filter by ${label}`}
        className={cx(
          "flex w-full items-center gap-1 pt-[0.5em] text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
          disabled ? "cursor-default text-ink-faint" : "cursor-pointer hover:text-node-ink",
        )}
        style={{ marginBottom: active ? "0.35em" : "0.1em" }}
      >
        <span className="grow whitespace-normal font-bold">{label}</span>
        {active && (
          <span className="rounded-full bg-node px-[0.45em] text-[10px] font-bold leading-[1.5] text-white">
            {chips.length}
            <span className="sr-only"> applied</span>
          </span>
        )}
        {count !== null && (
          <span className="inline-flex min-w-[2.2em] shrink-0 items-center justify-center rounded-full border border-edge px-[0.45em] text-[10px] font-bold leading-[1.5] text-ink-faint">
            {count === undefined ? (
              <Spinner size="xs" />
            ) : (
              <>
                {formatNumber(count)}
                <span className="sr-only"> records</span>
              </>
            )}
          </span>
        )}
        <Icon
          name="filter"
          className={cx("shrink-0", active ? "text-node-ink" : "text-ink-faint")}
          style={{ width: "0.85em", height: "0.85em" }}
        />
      </button>
      {active && (
        <div className="flex flex-wrap gap-1">
          {chips.map((chip) => (
            <Chip key={chip.key} label={chip.label} title={chip.title} onRemove={chip.onRemove} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A filter whose few choices fit the sidebar itself, so it opens no modal:
 * its name over a compact checkbox per choice. At most one is checked
 * (checking one unchecks the others; unchecking it clears the filter).
 */
export function FilterChoices<T extends string>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: { value: T; label: string; title?: string }[];
  value: T | undefined;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <fieldset
      className="m-0 min-w-0 border-0 text-[13px]"
      style={{ padding: "0.75em 1em 0.5em", borderBottom: "1px solid var(--er-edge)" }}
    >
      {/* Floated: a legend otherwise sits on the fieldset's (absent) border. */}
      <legend className="float-left w-full whitespace-normal p-0 font-bold">{label}</legend>
      {choices.map((choice) => (
        <label
          key={choice.value}
          title={choice.title}
          className="clear-left flex cursor-pointer items-center gap-1.5 pt-[0.35em] hover:text-node-ink"
        >
          <input
            type="checkbox"
            checked={value === choice.value}
            onChange={(event) => onChange(event.target.checked ? choice.value : undefined)}
            className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-node"
          />
          <span className="whitespace-normal">{choice.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
