// The search page's filter sidebar controls, driven by the node YAML's
// `search.filters` (config.filters): facet buckets render in search.tsx
// (FacetSection, they need the aggregations); the numeric range and bounding
// box controls live here. Each filter names the search levels and result views
// it applies to (empty = everywhere), so the sidebar changes with the active
// level tab and sub-tab (legacy: the Poles view shows Age / A95 / Geospatial
// instead of the buckets).

import type { NodeConfig, SearchFilter } from "../lib/types";
import { facetTitle } from "../lib/utils";
import { type Area, formatArea } from "./map/map-points";

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

const rangeInputClass =
  "w-20 min-w-0 rounded-sm border border-gray-300 px-1.5 py-1 text-[12px] " +
  "placeholder:text-[#AAAAAA] focus:border-node focus:outline-hidden";

/** Legacy `styles.filter`: each block padded, 1px #D4D4D5 divider. */
const blockStyle = { padding: "0.25em 1em 0.5em", borderBottom: "1px solid #D4D4D5" };

export function RangeFilter({
  filter,
  ranges,
  setRanges,
}: {
  filter: SearchFilter;
  ranges: string[];
  setRanges: (ranges: string[]) => void;
}) {
  const field = filter.field ?? "";
  const scale = filter.scale || 1;
  const stored = ranges.map(parseRange).find((entry) => entry.field === field);
  // Convert stored (field units) <-> displayed (filter units).
  const toDisplay = (v: string) => (v === "" || scale === 1 ? v : String(Number(v) / scale));
  const toStore = (v: string) => (v === "" || scale === 1 ? v : String(Number(v) * scale));
  const current = { gte: toDisplay(stored?.gte ?? ""), lte: toDisplay(stored?.lte ?? "") };
  const label = filterLabel(filter);

  const update = (gte: string, lte: string) => {
    const others = ranges.filter((entry) => parseRange(entry).field !== field);
    if (gte === "" && lte === "") setRanges(others);
    else setRanges([...others, `${field}:${toStore(gte)}:${toStore(lte)}`]);
  };

  return (
    <div style={blockStyle}>
      <div className="mb-1 text-[13px] font-bold">{label}</div>
      <div className="flex items-center gap-1">
        <label className="sr-only" htmlFor={`range-${field}-gte`}>
          {label} minimum
        </label>
        <input
          id={`range-${field}-gte`}
          type="number"
          placeholder={filter.min !== null ? String(filter.min) : "min"}
          min={filter.min ?? undefined}
          max={filter.max ?? undefined}
          value={current.gte}
          onChange={(event) => update(event.target.value, current.lte)}
          className={rangeInputClass}
        />
        <span className="text-[12px] text-gray-500">to</span>
        <label className="sr-only" htmlFor={`range-${field}-lte`}>
          {label} maximum
        </label>
        <input
          id={`range-${field}-lte`}
          type="number"
          placeholder={filter.max !== null ? String(filter.max) : "max"}
          min={filter.min ?? undefined}
          max={filter.max ?? undefined}
          value={current.lte}
          onChange={(event) => update(current.gte, event.target.value)}
          className={rangeInputClass}
        />
        {filter.unit && <span className="text-[12px] text-gray-500">{filter.unit}</span>}
      </div>
    </div>
  );
}

export function BboxFilter({
  filter,
  bbox,
  setBbox,
}: {
  filter: SearchFilter;
  bbox?: string;
  setBbox: (bbox: string | undefined) => void;
}) {
  // bbox = "minLon,minLat,maxLon,maxLat"
  const parts = (bbox ?? ",,,").split(",");
  const [minLon, minLat, maxLon, maxLat] = [
    parts[0] ?? "",
    parts[1] ?? "",
    parts[2] ?? "",
    parts[3] ?? "",
  ];

  const update = (next: [string, string, string, string]) => {
    if (next.every((value) => value === "")) setBbox(undefined);
    else setBbox(next.join(","));
  };

  const field = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
  ) => (
    <label className="flex items-center gap-1 text-[12px] text-gray-600">
      <span className="w-14">{label}</span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={rangeInputClass}
      />
    </label>
  );

  return (
    <div style={blockStyle}>
      <div className="mb-1 text-[13px] font-bold">{filterLabel(filter)}</div>
      <div className="grid gap-1">
        {field("Min Lat", minLat, (v) => update([minLon, v, maxLon, maxLat]), "-90")}
        {field("Max Lat", maxLat, (v) => update([minLon, minLat, maxLon, v]), "90")}
        {field("Min Lon", minLon, (v) => update([v, minLat, maxLon, maxLat]), "-180")}
        {field("Max Lon", maxLon, (v) => update([minLon, minLat, v, maxLat]), "180")}
      </div>
    </div>
  );
}

/**
 * The Geospatial filter (every level with positions): the Map tab's area.
 * Checking it opens the Map at this level with an area around the search's
 * records (or over the view when unfiltered), as on osu-mgr.org; unchecking
 * removes it. With an area, its extent and a link back to the map.
 */
export function GeospatialFilter({
  area,
  onRequest,
  onShow,
  onRemove,
}: {
  area: Area | null;
  onRequest: () => void;
  onShow: () => void;
  onRemove: () => void;
}) {
  const extent = area ? formatArea(area) : null;
  return (
    <div style={blockStyle} className="text-[13px]">
      <div className="mb-1 pt-[0.5em] font-bold">Geospatial</div>
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          type="checkbox"
          checked={!!area}
          onChange={() => (area ? onRemove() : onRequest())}
          className="h-[17px] w-[17px] cursor-pointer rounded-sm border-gray-300 accent-node"
        />
        <span className={area ? "font-bold" : undefined}>Filter by area on the map</span>
      </label>
      {extent && (
        <div className="mt-1 whitespace-normal pl-[22px] text-[12px] text-gray-600">
          <div>Latitude: {extent.latitude}</div>
          <div>Longitude: {extent.longitude}</div>
          <button
            type="button"
            onClick={onShow}
            className="mt-0.5 cursor-pointer text-node hover:underline"
          >
            Show on the map
          </button>
        </div>
      )}
    </div>
  );
}
