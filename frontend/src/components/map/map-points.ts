import { MERCATOR_LAT } from "./basemap";
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
// level, singular) head its tooltip. bounds: [west, south, east, north] of a
// row's box, with east past 180 when the box crosses the antimeridian;
// lat/lon is then the box's centre. count: on a large search's map, a point
// is one location's records in one contribution, not a record. value: the
// number it is colored by (a location's records' mean), and its text for the
// tooltip (`valueText`). contribution: the record's contribution, when id
// is something else. body: the planetary body it is on, when not Earth.
export type MapPoint = {
  id: string;
  contribution?: string;
  name: string;
  label: string;
  color: string;
  lat: number;
  lon: number;
  bounds?: [number, number, number, number];
  count?: number;
  value?: number;
  valueText?: string;
  body?: Exclude<Body, "earth">;
};

/** A point as GET /search/{table}/points returns it. */
export type ApiMapPoint = {
  id?: string | number;
  name?: string;
  lat: number;
  lon: number;
  bounds?: [number, number, number, number];
  count?: number;
  value?: number;
  body?: string;
};

const toLat = (lat: number) => (Math.abs(lat) <= 90 ? lat : Number.NaN);
const toLon = (value: number) => {
  const lon = value > 180 ? value - 360 : value;
  return Math.abs(lon) <= 180 ? lon : Number.NaN;
};

/** A search doc's position: its box's centre when the row has a box. A
 * location's records are named by their number ("12 sites"; `plural`). */
export const toMapPoint = (
  point: ApiMapPoint,
  label: string,
  color: string,
  plural = `${label}s`,
): MapPoint | null => {
  const id = point.id == null ? "" : String(point.id);
  const count = point.count;
  const name =
    point.name ??
    (count !== undefined
      ? `${count.toLocaleString()} ${count === 1 ? label : plural}`
      : `Contribution ${id}`);
  const base = {
    id,
    name,
    label,
    color,
    ...(count !== undefined && { count }),
    ...(point.value != null && { value: point.value }),
    ...(isBody(point.body) && point.body !== "earth" && { body: point.body }),
  };
  if (point.bounds) {
    const [lonW, latS, lonE, latN] = point.bounds;
    const [south, north] = [toLat(latS), toLat(latN)];
    let [west, east] = [toLon(lonW), toLon(lonE)];
    if (![south, north, west, east].some(Number.isNaN) && (south !== north || west !== east)) {
      // A box whose west is east of its east crosses the antimeridian.
      if (west > east) east += 360;
      // MapLibre can't draw areas past Web Mercator's limit. Boxes of any
      // other size are drawn, so that a typo in a coordinate shows as a huge box.
      if (Math.max(-south, north) < MERCATOR_LAT && south <= north) {
        const lon = (west + east) / 2;
        return {
          ...base,
          lat: (south + north) / 2,
          lon: lon > 180 ? lon - 360 : lon,
          bounds: [west, south, east, north],
        };
      }
    }
  }
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
const contributionOf = ({ name, id, contribution = id }: MapPoint) =>
  name === `Contribution ${contribution}` ? "" : ` in contribution ${escapeHtml(contribution)}`;
/** Records a point stands for: one, or a location's count. */
export const recordsOf = (p: MapPoint) => p.count ?? 1;

const valueLine = (p: MapPoint, separator: string) =>
  p.valueText ? `${separator}${escapeHtml(p.valueText)}` : "";

// Tooltip HTML for the records at one spot. With several, their names are
// links (data-id) that the map opens on click; a location's records name
// their number and contribution. A colored point gives its value.
export const markerTooltip = (members: MapPoint[]) => {
  const [first] = members;
  if (members.length === 1) {
    return first.count !== undefined
      ? `<b>${escapeHtml(first.name)}</b><br/>At one location${contributionOf(first)}${valueLine(first, "<br/>")}`
      : `<b>${escapeHtml(first.name)}</b><br/>${escapeHtml(capitalize(first.label))}${contributionOf(first)}${valueLine(first, "<br/>")}`;
  }
  const link = (m: MapPoint) =>
    `<a data-id="${escapeHtml(m.id)}" style="cursor:pointer;color:${m.color};text-decoration:underline">${escapeHtml(m.name)}</a>${m.count !== undefined ? contributionOf(m) : ""}${valueLine(m, ": ")}`;
  const more =
    members.length > MAX_TOOLTIP_IDS
      ? `<br/>and ${(members.length - MAX_TOOLTIP_IDS).toLocaleString()} more`
      : "";
  const records = members.reduce((sum, m) => sum + recordsOf(m), 0);
  return `<b>${records.toLocaleString()} records</b><br/>At one location:<br/>${members.slice(0, MAX_TOOLTIP_IDS).map(link).join("<br/>")}${more}`;
};

// Geospatial filter area: [west, south, east, north] in degrees, with east
// past 180 when it crosses the antimeridian (as MapPoint bounds).
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
// The smallest area around the points (boxes included), with a margin. Its
// longitudes leave out the widest gap between the points' longitudes, so
// points either side of the antimeridian get an area across it.
export const areaAround = (points: MapPoint[]): Area | null => {
  const corners = points.flatMap((p) =>
    p.bounds
      ? [
          [p.bounds[0], p.bounds[1]],
          [p.bounds[2], p.bounds[3]],
        ]
      : [[p.lon, p.lat]],
  );
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
