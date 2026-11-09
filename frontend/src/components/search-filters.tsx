// The search page's filter sidebar controls, driven by the node YAML's
// `search.filters` (config.filters): facet buckets (FacetSection, given the
// search's aggregations by search.tsx), the numeric range and bounding box. Each filter names the search levels and result views
// it applies to (empty = everywhere), so the sidebar changes with the active
// level tab and sub-tab (legacy: the Poles view shows Age / A95 / Geospatial
// instead of the buckets).

import { useState } from "react";
import type { FacetBucket, NodeConfig, SearchFilter } from "../lib/types";
import { abbreviateNumber, cx, facetTitle, parseQueryTokens, titleCase } from "../lib/utils";
import { type Area, formatArea } from "./map/map-points";
import { Icon } from "./ui/icon";
import { Spinner } from "./ui/spinner";

const SEGMENT_BORDER = "rgba(34,36,38,.15)";

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

/**
 * Legacy `ui small labeled input`: white inputs joined to gray Semantic
 * labels ("to", the unit), outer corners rounded, inner ones square.
 */
const rangeInputClass =
  "min-w-[20px] flex-1 basis-0 border border-[rgba(34,36,38,0.15)] bg-white px-[0.75em] py-[0.45em] " +
  "text-[12px] text-[rgba(0,0,0,0.87)] placeholder:text-[#AAAAAA] focus:border-[#85B7D9] focus:outline-hidden";
const rangeLabelClass =
  "flex shrink-0 items-center bg-[#E8E8E8] px-[0.833em] text-[12px] font-bold text-[rgba(0,0,0,0.6)]";

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
      <div className="flex items-stretch">
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
          className={`${rangeInputClass} rounded-l-[0.2857rem]`}
        />
        <span className={rangeLabelClass}>to</span>
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
          className={`${rangeInputClass} ${filter.unit ? "" : "rounded-r-[0.2857rem]"}`}
        />
        {filter.unit && (
          <span className={`${rangeLabelClass} rounded-r-[0.2857rem]`}>{filter.unit}</span>
        )}
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
        className={`${rangeInputClass} rounded-[0.2857rem]`}
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

export function FilterRow({
  bucket,
  active,
  highlight,
  onToggle,
}: {
  bucket: FacetBucket;
  active: boolean;
  highlight?: string;
  onToggle: () => void;
}) {
  const label = bucket.key;
  const at = highlight ? label.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  return (
    <label className="flex cursor-pointer" style={{ marginBottom: "0.25em" }}>
      <span className="flex shrink-0 items-start" style={{ minWidth: 22, maxWidth: 22 }}>
        <input
          type="checkbox"
          checked={active}
          onChange={onToggle}
          className="mt-[1px] h-[17px] w-[17px] cursor-pointer rounded-sm border-gray-300 accent-node"
        />
      </span>
      <span
        className={cx("min-w-0 grow whitespace-normal break-words", active && "font-bold")}
        style={{ marginRight: "0.5em" }}
      >
        {at >= 0 && highlight ? (
          <>
            {label.slice(0, at)}
            <mark className="bg-yellow-200">{label.slice(at, at + highlight.length)}</mark>
            {label.slice(at + highlight.length)}
          </>
        ) : (
          label
        )}
      </span>
      <span
        className="inline-block shrink-0 self-start rounded-full border bg-white text-center font-bold"
        style={{
          borderColor: SEGMENT_BORDER,
          color: "rgba(0,0,0,.87)",
          fontSize: 11,
          lineHeight: "0.7em",
          padding: "0.5em",
          minWidth: "2em",
          minHeight: "2em",
        }}
      >
        {abbreviateNumber(bucket.doc_count)}
      </span>
    </label>
  );
}

/**
 * A facet's accordion (legacy SearchFiltersBuckets): its active values always
 * shown, the rest and a Find box when opened. The sidebar's facet filters and
 * the summary grid's column menus.
 */
export function FacetSection({
  facet,
  label,
  buckets,
  loading,
  q,
  onToggle,
  defaultOpen = false,
}: {
  facet: string;
  label?: string;
  buckets: FacetBucket[];
  loading: boolean;
  q: string;
  onToggle: (facet: string, value: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [find, setFind] = useState("");
  const title = label ?? facetTitle(facet);
  const itemsName = titleCase(facet);

  // Active values may come from another level and no longer be in the
  // buckets: the legacy component prepends them with a zero count.
  const activeKeys = parseQueryTokens(q)
    .tokens.filter(([field]) => field === facet)
    .map(([, value]) => value);
  const activeSet = new Set(activeKeys);
  const active = activeKeys.map(
    (key) => buckets.find((bucket) => bucket.key === key) ?? { key, doc_count: 0 },
  );
  const needle = find.trim().toLowerCase();
  const matched = needle
    ? buckets.filter(
        (bucket) => !activeSet.has(bucket.key) && bucket.key.toLowerCase().includes(needle),
      )
    : [];
  const matchedSet = new Set(matched.map((bucket) => bucket.key));
  const inactive = buckets.filter(
    (bucket) => !activeSet.has(bucket.key) && !matchedSet.has(bucket.key),
  );

  return (
    <div
      className="text-[13px]"
      style={{
        padding: "0.25em 1em 0.5em",
        borderBottom: "1px solid #D4D4D5",
        color: "rgba(0,0,0,.87)",
      }}
    >
      {/* Title: caret + bold name, then the active filters (always visible) */}
      <div style={{ padding: "0.5em 0 0", lineHeight: "1.4285em" }}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          style={{ marginBottom: "0.25em" }}
        >
          <span
            aria-hidden="true"
            className="inline-flex shrink-0 items-center justify-center"
            style={{ width: "1.25em", height: "1.25em", marginRight: "0.25rem" }}
          >
            <Icon
              name="caret-right"
              className={cx("transition-transform", open && "rotate-90")}
              style={{ width: "1.15em", height: "1.15em" }}
            />
          </span>
          <span className="grow whitespace-normal font-bold" style={{ marginRight: "0.5em" }}>
            {title}
          </span>
        </button>
        {active.map((bucket) => (
          <FilterRow
            key={bucket.key}
            bucket={bucket}
            active
            onToggle={() => onToggle(facet, bucket.key)}
          />
        ))}
      </div>
      {open && (
        <div style={{ paddingTop: 0 }}>
          <input
            type="text"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder={`Find ${itemsName}`}
            aria-label={`Find ${itemsName}`}
            className="w-full rounded-sm border border-gray-300 bg-white px-[0.8em] py-[0.5em] text-[13px] placeholder:text-[#AAAAAA] focus:border-node focus:outline-hidden"
            style={{ marginBottom: "0.25em" }}
          />
          {needle && matched.length === 0 && (
            <div className="text-center">
              <b>No Matches</b>
            </div>
          )}
          {matched.map((bucket) => (
            <FilterRow
              key={bucket.key}
              bucket={bucket}
              active={false}
              highlight={find.trim()}
              onToggle={() => onToggle(facet, bucket.key)}
            />
          ))}
          <hr
            style={{
              margin: "1em 0",
              border: 0,
              borderTop: `1px solid ${SEGMENT_BORDER}`,
              borderBottom: "1px solid rgba(255,255,255,.1)",
            }}
          />
          {loading && (
            <div className="text-center">
              <Spinner /> Loading ...
            </div>
          )}
          {!loading && inactive.length === 0 && (
            <div className="text-center">
              <b>No {itemsName}</b>
            </div>
          )}
          {inactive.map((bucket) => (
            <FilterRow
              key={bucket.key}
              bucket={bucket}
              active={false}
              onToggle={() => onToggle(facet, bucket.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
