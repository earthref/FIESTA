import { cx } from "../lib/utils";
import { Icon } from "./ui/icon";

/**
 * A summary grid column's filter icon (as on osu-mgr.org's result tables):
 * a count of its active filters; it opens the column's filter modal (its
 * facets' values, its text box, or the geospatial area) on the search page.
 */
export function ColumnFilterButton({
  label,
  active,
  onOpen,
}: {
  label: string;
  /** How many of the column's filters apply (the badge). */
  active: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Filter by ${label}`}
      aria-label={`Filter by ${label}${active ? ` (${active} applied)` : ""}`}
      aria-haspopup="dialog"
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 py-0.5 hover:bg-panel hover:text-node-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node",
        active ? "text-node-ink" : "text-ink-faint",
      )}
    >
      <Icon name="filter" style={{ width: "0.85em", height: "0.85em" }} />
      {active > 0 && (
        <span
          className="rounded-full bg-node px-[0.45em] text-[11px] font-bold leading-[1.5] text-white"
          aria-hidden="true"
        >
          {active}
        </span>
      )}
    </button>
  );
}
