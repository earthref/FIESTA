// The search page's filter sidebar, driven by the node YAML's `search.filters`
// (config.filters): facet buckets, numeric ranges and the bounding box, plus
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
import { cx, facetTitle } from "../lib/utils";
import { Icon } from "./ui/icon";

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

/** The `ranges` entries that belong to the given filters. */
export function rangesFor(ranges: string[], filters: SearchFilter[]): string[] {
  const fields = new Set(filters.filter((f) => f.type === "range").map((f) => f.field));
  return ranges.filter((entry) => fields.has(parseRange(entry).field));
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
 * divider): its name, which opens its modal, and its applied values.
 */
export function FilterEntry({
  label,
  chips,
  onOpen,
}: {
  label: string;
  chips: FilterChip[];
  onOpen: () => void;
}) {
  const active = chips.length > 0;
  return (
    <div
      className="text-[13px]"
      style={{ padding: "0.25em 1em 0.5em", borderBottom: "1px solid var(--er-edge)" }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        title={`Filter by ${label}`}
        className="flex w-full cursor-pointer items-center gap-1 pt-[0.5em] text-left hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        style={{ marginBottom: active ? "0.35em" : "0.1em" }}
      >
        <span className="grow whitespace-normal font-bold">{label}</span>
        {active && (
          <span className="rounded-full bg-node px-[0.45em] text-[10px] font-bold leading-[1.5] text-white">
            {chips.length}
            <span className="sr-only"> applied</span>
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
