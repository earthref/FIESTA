import type { Area } from "./map-points";

/** Where a search's positioned records are (the API's /search/{table}/extent). */
export type Extent = {
  total: number;
  /** [west, south, east, north]; west is east of east across the antimeridian. */
  bounds?: [number, number, number, number];
  /** [lon, lat]: where most of them are. */
  center?: [number, number];
};

/** The default area's largest side, in degrees. */
export const DEFAULT_AREA_DEGREES = 20;
// The margin around records that fit, a share of their span (with a minimum),
// so the outermost ones aren't on the area's edge.
const MARGIN = 0.02;
const MIN_MARGIN = 0.1;

/** Along one axis: around the records (with a margin) when that fits in
 * DEFAULT_AREA_DEGREES, else that many degrees around their middle when they
 * fit without the margin, else around `center`. */
const fit = (low: number, high: number, center: number): [number, number] => {
  const margin = Math.max((high - low) * MARGIN, MIN_MARGIN);
  if (high - low + 2 * margin <= DEFAULT_AREA_DEGREES) return [low - margin, high + margin];
  const middle = high - low <= DEFAULT_AREA_DEGREES ? (low + high) / 2 : center;
  return [middle - DEFAULT_AREA_DEGREES / 2, middle + DEFAULT_AREA_DEGREES / 2];
};

/**
 * The Geospatial filter's default area: around all of a search's positioned
 * records when they fit in DEFAULT_AREA_DEGREES each way, else (per axis) that
 * many degrees around where most of them are. Longitudes may run past 180
 * across the antimeridian, as an Area's do; null when no record has a position.
 */
export const defaultArea = (extent: Extent): Area | null => {
  if (!extent.bounds) return null;
  const [west, south, eastBound, north] = extent.bounds;
  const east = eastBound < west ? eastBound + 360 : eastBound;
  const [centerLon, centerLat] = extent.center ?? [(west + east) / 2, (south + north) / 2];
  // The centre's longitude taken near the records' (across the antimeridian too).
  const near = centerLon + 360 * Math.round(((west + east) / 2 - centerLon) / 360);
  let [w, e] = fit(west, east, near);
  let [s, n] = fit(south, north, centerLat);
  // Kept on the globe: moved off a pole, and west within [-180, 180).
  if (s < -90) [s, n] = [-90, n - (s + 90)];
  if (n > 90) [s, n] = [s - (n - 90), 90];
  const shift = 360 * Math.floor((w + 180) / 360);
  [w, e] = [w - shift, e - shift];
  return [w, Math.max(s, -90), e, Math.min(n, 90)];
};
