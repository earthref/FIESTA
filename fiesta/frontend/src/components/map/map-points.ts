import { singularize } from "../../lib/utils";
import { type Body, isBody } from "./bodies";

// Records plotted on the maps, and their tooltips. Ported from the
// osu-mgr.org search map (components/search/map-points.ts).

export type Mode = "globe" | "flat" | "north" | "south";
export const MODES: [Mode, string][] = [
  ["globe", "Globe"],
  ["flat", "Mercator"],
  ["north", "North Pole"],
  ["south", "South Pole"],
];

// id: what clicking it opens (its contribution); name and label (its search
// level, singular) head its tooltip. count: on a large search's map, a point
// is one location's records in one contribution, not a record. value: the
// number it is colored by (a location's records' mean), and its text for the
// tooltip (`valueText`). contribution: the record's contribution, when id
// is something else. body: the planetary body it is on, when not Earth.
// parents: the rows above it (a sample's site, then location), each with its
// level's label. byline: its contribution's date and contributor, for a
// contribution's own point. source: its contribution, to end the tooltip
// with on a search's map (not one contribution's).
export type MapPoint = {
  id: string;
  contribution?: string;
  name: string;
  label: string;
  color: string;
  lat: number;
  lon: number;
  count?: number;
  value?: number;
  valueText?: string;
  body?: Exclude<Body, "earth">;
  parents?: { label: string; name: string }[];
  byline?: string;
  source?: { citation: string; byline: string };
};

/** A point as GET /search/{table}/points returns it. */
export type ApiMapPoint = {
  id?: string | number;
  name?: string;
  lat: number;
  lon: number;
  count?: number;
  value?: number;
  body?: string;
  parents?: { table: string; name: string }[];
};

/** A contribution as GET /search/{table}/points labels its points'. */
export type ApiMapContribution = { citation?: string; contributor?: string; timestamp?: string };

/** What a map's tooltips say beyond a point's own name. contributions: the
 * points response's, by id. levelLabel: a hierarchy level's singular name.
 * table: the points' level. withSource: end each tooltip with its record's
 * contribution (a search's map, where they differ). */
export type MapPointContext = {
  table: string;
  contributions?: Record<string, ApiMapContribution>;
  levelLabel?: (table: string) => string;
  withSource?: boolean;
};

// moment "LL", as the search results date a contribution: July 7, 2026.
const formatDate = (value: string | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : "";
};
const bylineOf = ({ contributor, timestamp }: ApiMapContribution) =>
  [formatDate(timestamp), contributor && `by ${contributor}`].filter(Boolean).join(" ");

const toLat = (lat: number) => (Math.abs(lat) <= 90 ? lat : Number.NaN);
const toLon = (value: number) => {
  const lon = value > 180 ? value - 360 : value;
  return Math.abs(lon) <= 180 ? lon : Number.NaN;
};

/** A search doc's position (one of them, for a doc with several). A
 * location's records are named by their number ("12 sites"; `plural`). */
export const toMapPoint = (
  point: ApiMapPoint,
  label: string,
  color: string,
  plural = `${label}s`,
  context?: MapPointContext,
): MapPoint | null => {
  const id = point.id == null ? "" : String(point.id);
  const count = point.count;
  const contribution = context?.contributions?.[id];
  const citation = contribution?.citation || `Contribution ${id}`;
  const ownPoint = context?.table === "contribution";
  const name =
    point.name ??
    (count !== undefined ? `${count.toLocaleString()} ${count === 1 ? label : plural}` : citation);
  const levelLabel = context?.levelLabel ?? ((table: string) => singularize(table));
  // Nearest first: a sample's site, then its location.
  const parents = (point.parents ?? [])
    .map((parent) => ({ label: levelLabel(parent.table), name: parent.name }))
    .reverse();
  const byline = contribution ? bylineOf(contribution) : "";
  const base = {
    id,
    name,
    label,
    color,
    ...(count !== undefined && { count }),
    ...(point.value != null && { value: point.value }),
    ...(isBody(point.body) && point.body !== "earth" && { body: point.body }),
    ...(parents.length > 0 && { parents }),
    ...(ownPoint && { byline }),
    ...(!ownPoint && context?.withSource && contribution && { source: { citation, byline } }),
  };
  const [lat, lon] = [toLat(point.lat), toLon(point.lon)];
  return Number.isNaN(lat) || Number.isNaN(lon) ? null : { ...base, lat, lon };
};

// Spherical mean of the points (average of their unit vectors), so records
// straddling the antimeridian centre on themselves rather than the far side
// of the globe. Returns [lon, lat], or null for no points.
export const sphericalCentroid = (points: MapPoint[]): [number, number] | null => {
  if (!points.length) return null;
  const rad = Math.PI / 180;
  let [x, y, z] = [0, 0, 0];
  for (const p of points) {
    x += Math.cos(p.lat * rad) * Math.cos(p.lon * rad);
    y += Math.cos(p.lat * rad) * Math.sin(p.lon * rad);
    z += Math.sin(p.lat * rad);
  }
  return [Math.atan2(y, x) / rad, Math.atan2(z, Math.hypot(x, y)) / rad];
};

// Records at one spot (to ~10 m), which share a marker.
export const pointKey = (p: MapPoint) => `${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
export const colocatedIndex = (points: MapPoint[]) => {
  const index = new Map<string, MapPoint[]>();
  for (const p of points) {
    const key = pointKey(p);
    const group = index.get(key);
    if (group) group.push(p);
    else index.set(key, [p]);
  }
  return index;
};

const MAX_TOOLTIP_IDS = 12;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
// A point whose own contribution isn't its id (a plugin's, e.g. a pole) and
// that carries no `source` names it by number.
const contributionOf = ({ id, contribution }: MapPoint) =>
  contribution && contribution !== id ? ` in contribution ${escapeHtml(contribution)}` : "";
/** Records a point stands for: one, or a location's count. */
export const recordsOf = (p: MapPoint) => p.count ?? 1;

const valueLine = (p: MapPoint, separator: string) =>
  p.valueText ? `${separator}${escapeHtml(p.valueText)}` : "";
// "Site <b>S1</b>", then "Location <b>L1</b>" on the next line.
const namedLine = (label: string, name: string) =>
  `${escapeHtml(capitalize(label))} <b>${escapeHtml(name)}</b>`;
const parentLines = (p: MapPoint) =>
  (p.parents ?? []).map((parent) => `<br/>${namedLine(parent.label, parent.name)}`).join("");
// A search map's record ends with its contribution: citation, date and
// contributor, set apart from the record's own lines.
const sourceBlock = ({ citation, byline }: NonNullable<MapPoint["source"]>) =>
  `<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(127,127,127,0.35)">${escapeHtml(citation)}${byline ? `<br/>${escapeHtml(byline)}` : ""}</div>`;
const sourceOf = (p: MapPoint) => (p.source ? sourceBlock(p.source) : contributionOf(p));

// Tooltip HTML for the records at one spot. A contribution's own point is its
// citation, date and contributor; a record is its level and name, the rows
// above it, and (on a search's map) its contribution. With several, their
// names are links (data-id) that the map opens on click; a location's
// records name their number. A colored point gives its value.
export const markerTooltip = (members: MapPoint[]) => {
  const [first] = members;
  if (members.length === 1) {
    const value = valueLine(first, "<br/>");
    if (first.count !== undefined) {
      return `<b>${escapeHtml(first.name)}</b><br/>At one location${parentLines(first)}${value}${sourceOf(first)}`;
    }
    if (first.byline !== undefined) {
      const byline = first.byline ? `<br/>${escapeHtml(first.byline)}` : "";
      return `<b>${escapeHtml(first.name)}</b>${byline}${value}`;
    }
    // A plugin's point (a pole) is its name over its label ("pole, 12 Ma").
    if (first.contribution !== undefined) {
      return `<b>${escapeHtml(first.name)}</b><br/>${escapeHtml(capitalize(first.label))}${contributionOf(first)}${value}`;
    }
    return `${namedLine(first.label, first.name)}${parentLines(first)}${value}${sourceOf(first)}`;
  }
  // One contribution's records share its block, at the end; records from
  // several each name theirs.
  // Contributions' own points each give their date and contributor.
  const sources = new Set(members.map((m) => (m.source ? m.id : undefined)));
  const shared = sources.size === 1 ? first.source : undefined;
  const link = (m: MapPoint) =>
    `<a data-id="${escapeHtml(m.id)}" style="cursor:pointer;color:${m.color};text-decoration:underline">${escapeHtml(m.name)}</a>${
      m.byline
        ? `, ${escapeHtml(m.byline)}`
        : shared
          ? ""
          : m.source
            ? ` in ${escapeHtml(m.source.citation)}`
            : contributionOf(m)
    }${valueLine(m, ": ")}`;
  const more =
    members.length > MAX_TOOLTIP_IDS
      ? `<br/>and ${(members.length - MAX_TOOLTIP_IDS).toLocaleString()} more`
      : "";
  const records = members.reduce((sum, m) => sum + recordsOf(m), 0);
  return `<b>${records.toLocaleString()} records</b><br/>At one location:<br/>${members.slice(0, MAX_TOOLTIP_IDS).map(link).join("<br/>")}${more}${shared ? sourceBlock(shared) : ""}`;
};

// Geospatial filter area: [west, south, east, north] in degrees, with east
// past 180 when it crosses the antimeridian.
export type Area = [number, number, number, number];

const formatLat = (lat: number) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? "S" : "N"}`;
const formatLon = (lon: number) => {
  const wrapped = ((lon + 540) % 360) - 180;
  return Math.abs(wrapped) === 180
    ? "180.00°"
    : `${Math.abs(wrapped).toFixed(2)}°${wrapped < 0 ? "W" : "E"}`;
};
/** An Area's extent as text: "10.00°S to 5.00°N" and "170.00°E to 170.00°W". */
export const formatArea = ([west, south, east, north]: Area) => ({
  latitude: `${formatLat(south)} to ${formatLat(north)}`,
  // As added over a pole view, an area can go all the way round.
  longitude: east - west >= 360 ? "All longitudes" : `${formatLon(west)} to ${formatLon(east)}`,
});

/** The `area` search param ("w,s,e,n") as an Area, or null. */
export const parseArea = (value: string | undefined): Area | null => {
  const parts = (value ?? "").split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? (parts as Area) : null;
};

/** An Area as the API's `bbox` (minLon,minLat,maxLon,maxLat, each within
 * ±180; a min east of the max crosses the antimeridian). */
export const areaToBbox = ([west, south, east, north]: Area): string => {
  if (east - west >= 360) return `-180,${south},180,${north}`;
  const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const max = wrap(east) === -180 ? 180 : wrap(east);
  return [wrap(west), south, max, north].map((v) => +v.toFixed(4)).join(",");
};

export const WHOLE_GLOBE: Area = [-180, -90, 180, 90];
// Margin around areaAround's points, as a share of the area's size (with a
// minimum), so the outermost points aren't on its edge.
const AREA_MARGIN = 0.02;
const AREA_MIN_MARGIN = 0.1;
// The smallest area around the points, with a margin. Its longitudes leave
// out the widest gap between the points' longitudes, so points either side
// of the antimeridian get an area across it.
export const areaAround = (points: MapPoint[]): Area | null => {
  const corners = points.map((p) => [p.lon, p.lat]);
  if (!corners.length) return null;
  const lats = corners.map(([, lat]) => lat);
  const lons = [...new Set(corners.map(([lon]) => ((lon + 540) % 360) - 180))].sort(
    (a, b) => a - b,
  );
  // The gap after each longitude, the last one wrapping round to the first.
  let [widest, after] = [-1, 0];
  for (const [i, lon] of lons.entries()) {
    const gap = (i + 1 < lons.length ? lons[i + 1] : lons[0] + 360) - lon;
    if (gap > widest) [widest, after] = [gap, i];
  }
  let [west, east] =
    after === lons.length - 1 ? [lons[0], lons[after]] : [lons[after + 1], lons[after] + 360];
  let [south, north] = [Math.min(...lats), Math.max(...lats)];
  const lonMargin = Math.max((east - west) * AREA_MARGIN, AREA_MIN_MARGIN);
  const latMargin = Math.max((north - south) * AREA_MARGIN, AREA_MIN_MARGIN);
  [west, east] =
    east - west + 2 * lonMargin >= 360 ? [-180, 180] : [west - lonMargin, east + lonMargin];
  [south, north] = [Math.max(south - latMargin, -90), Math.min(north + latMargin, 90)];
  return [west, south, east, north];
};
