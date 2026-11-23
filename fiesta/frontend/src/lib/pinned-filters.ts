// The search sidebar's order: a node's pinned filters (YAML
// `search.pinned_filters`) first, then applied ones, then the most records.
import type { PinnedFilters } from "./types";

/** The filters pinned at the top of the sidebar on `level` and `view`: those
 * of the most specific rule that applies there (a rule's empty `levels` or
 * `views` means any). Naming views counts 2 and naming levels 1, so a
 * level + view rule beats a view rule, which beats a level rule, which beats a
 * catch-all; between equally specific rules the first wins. */
export function pinnedFilterNames(
  rules: PinnedFilters[] | undefined,
  level: string | undefined,
  view: string | undefined,
): string[] {
  let best: PinnedFilters | undefined;
  let bestScore = -1;
  for (const rule of rules ?? []) {
    const levels = rule.levels ?? [];
    const views = rule.views ?? [];
    if (levels.length > 0 && !(level && levels.includes(level))) continue;
    if (views.length > 0 && !(view && views.includes(view))) continue;
    const score = (views.length > 0 ? 2 : 0) + (levels.length > 0 ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best?.filters ?? [];
}

/** What ordering needs of a sidebar entry: its key, label, count (undefined
 * while loading, null uncounted) and applied values. */
export interface OrderableEntry {
  key: string;
  label: string;
  count: number | null | undefined;
  chips: readonly unknown[];
}

/** The sidebar's entries in order: the pinned ones first, in pin order (a pin
 * matches an entry's key or label, in any case; one matching none is
 * skipped), then the applied ones, then the rest by count, most first, the
 * configured order breaking ties. An entry no record has a value for is
 * hidden unless it is pinned or applied: a pinned filter with nothing to
 * pick shows (disabled) in its place. */
export function orderSidebarEntries<T extends OrderableEntry>(entries: T[], pinned: string[]): T[] {
  const pins = pinned.map((name) => name.trim().toLowerCase());
  const pinOf = (entry: T) => {
    const key = entry.key.toLowerCase();
    const label = entry.label.toLowerCase();
    const index = pins.findIndex((pin) => pin === key || pin === label);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return entries
    .map((entry, order) => ({ entry, order, pin: pinOf(entry), applied: entry.chips.length > 0 }))
    .filter(
      ({ entry, pin, applied }) => pin !== Number.POSITIVE_INFINITY || applied || entry.count !== 0,
    )
    .sort(
      (a, b) =>
        (a.pin === b.pin ? 0 : a.pin < b.pin ? -1 : 1) ||
        Number(b.applied) - Number(a.applied) ||
        (b.entry.count ?? -1) - (a.entry.count ?? -1) ||
        a.order - b.order,
    )
    .map(({ entry }) => entry);
}
