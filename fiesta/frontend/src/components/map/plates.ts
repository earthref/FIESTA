import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "../../lib/base";
import { isLasso } from "./lasso";

/**
 * Earth's present-day tectonic plates (Bird 2003, PB2002), from the API's
 * /basemap/plates (fiesta/backend/fiesta/plates.py): every map's plate
 * boundaries (its Plates toggle) and the Geospatial filter's plate list.
 */

export type Plate = {
  code: string;
  name: string;
  /** Its boundary as [lon, lat] polylines. */
  lines: [number, number][][];
  /** Its polygons as served (split at the antimeridian, closed over a pole),
   * for the Geospatial filter's map to fill and pick. */
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
};
export type Plates = {
  /** By name. */
  plates: Plate[];
  /** Every plate's boundary (each one shared by two plates drawn twice). */
  lines: [number, number][][];
};

export const PLATES_URL = apiUrl("/basemap/plates");
export const PLATE_COLOR = "#990000";

const EDGE = 1e-6;
/** An edge the polygons gained to split at the antimeridian or close over a
 * pole (both ends on ±180° or on ±90°): not a plate boundary. */
const added = ([lon1, lat1]: number[], [lon2, lat2]: number[]) =>
  (Math.abs(Math.abs(lon1) - 180) < EDGE && Math.abs(Math.abs(lon2) - 180) < EDGE) ||
  (Math.abs(Math.abs(lat1) - 90) < EDGE && Math.abs(Math.abs(lat2) - 90) < EDGE);

/** A ring's boundary, as the runs of edges between the added ones. */
const boundaryRuns = (ring: number[][]): [number, number][][] => {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 1; i < ring.length; i++) {
    if (added(ring[i - 1], ring[i])) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    if (run.length === 0) run.push([ring[i - 1][0], ring[i - 1][1]]);
    run.push([ring[i][0], ring[i][1]]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
};

export const readPlates = (geojson: GeoJSON.FeatureCollection): Plates => {
  const plates: Plate[] = [];
  const lines: [number, number][][] = [];
  for (const { properties, geometry } of geojson.features) {
    if (geometry.type !== "MultiPolygon" && geometry.type !== "Polygon") continue;
    const plate: Plate = {
      code: String(properties?.code),
      name: String(properties?.name),
      lines: [],
      geometry,
    };
    plates.push(plate);
    const polygons =
      geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
    for (const rings of polygons) for (const ring of rings) plate.lines.push(...boundaryRuns(ring));
    lines.push(...plate.lines);
  }
  plates.sort((a, b) => a.name.localeCompare(b.name));
  return { plates, lines };
};

// Loaded once per page, the first time a map or the filter asks; always
// checked with the API (`no-cache`: a 304 while unchanged), so a copy the
// browser kept from before the plates changed is never drawn.
let plates: Promise<Plates | null> | null = null;
export const loadPlates = () =>
  (plates ||= fetch(PLATES_URL, { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((geojson) => (geojson ? readPlates(geojson) : null))
    .catch(() => null));

/** The plates, for a component (the Geospatial filter's list and chips). */
export const usePlates = (enabled = true) =>
  useQuery({
    queryKey: ["plates"],
    queryFn: async () => {
      const loaded = await loadPlates();
      if (!loaded) throw new Error("The plate list could not be loaded");
      return loaded;
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * The `plate_block` vocabulary's cratons, blocks and terranes (Hasterok et al.
 * 2022), from /basemap/provinces: the Geospatial filter offers them beside the
 * plates, under the same `plate=` param, by their lower-case codes
 * ("kaapvaal-craton"). Read like the plates; `name` is the vocabulary term.
 */
export const PROVINCES_URL = apiUrl("/basemap/provinces");

let provinces: Promise<Plates | null> | null = null;
export const loadProvinces = () =>
  (provinces ||= fetch(PROVINCES_URL, { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((geojson) => (geojson ? readPlates(geojson) : null))
    .catch(() => null));

/** The provinces, for the Geospatial filter's list, chips and outlines. */
export const useProvinces = (enabled = true) =>
  useQuery({
    queryKey: ["provinces"],
    queryFn: async () => {
      const loaded = await loadProvinces();
      if (!loaded) throw new Error("The province list could not be loaded");
      return loaded;
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

const DEGREES = 180 / Math.PI;

/**
 * Where to centre a map on an outline: the mean of its boundary on the sphere
 * (each edge's midpoint weighted by its length, as unit vectors), so an
 * outline across the antimeridian is centred on it and one around a pole
 * (Antarctica) on the pole. Null for no boundary.
 */
export const outlineCenter = (lines: [number, number][][]): { lon: number; lat: number } | null => {
  const vector = ([lon, lat]: [number, number]) => {
    const [l, p] = [lon / DEGREES, lat / DEGREES];
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  };
  let [x, y, z] = [0, 0, 0];
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [vector(line[i - 1]), vector(line[i])];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      x += (a[0] + b[0]) * length;
      y += (a[1] + b[1]) * length;
      z += (a[2] + b[2]) * length;
    }
  }
  const r = Math.hypot(x, y, z);
  if (!(r > 1e-12)) return null;
  return { lon: Math.atan2(y, x) * DEGREES, lat: Math.asin(z / r) * DEGREES };
};

/** A province's code (a lower-case slug), not a plate's (two letters) or a
 * lasso's (lasso.ts). */
export const isProvince = (code: string) => !isLasso(code) && code.includes("-");
/** A plate's code (two letters). */
export const isPlate = (code: string) => !isLasso(code) && !isProvince(code);

/** A filter chip's label for a plate ("Pacific plate"), a province (its
 * vocabulary term, "Kaapvaal Craton") or a lasso; the code until the lists
 * load. */
export const regionLabel = (code: string, plates?: Plates, provinces?: Plates) =>
  isLasso(code)
    ? "Lasso area"
    : isProvince(code)
      ? (provinces?.plates.find((province) => province.code === code)?.name ?? code)
      : `${plates?.plates.find((plate) => plate.code === code)?.name ?? code} plate`;

/** The `plates` search param ("PA,EU,kaapvaal-craton,lasso:…") as codes:
 * plates upper-cased, provinces lower-cased, lassos as they are. */
export const parsePlates = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((code) => code.trim())
    .map((code) =>
      isLasso(code) ? code : isProvince(code) ? code.toLowerCase() : code.toUpperCase(),
    )
    .filter(Boolean);

// --- Labels -----------------------------------------------------------------

const MAX_LABEL_LAT = 80;
const GRID = 16;

/** Even-odd ray casting along the latitude (rings within ±180°). */
const inRing = (lon: number, lat: number, ring: number[][]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[j];
    if (y1 > lat !== y2 > lat && lon < x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
  }
  return inside;
};
const inPolygons = (lon: number, lat: number, polygons: number[][][][]) =>
  polygons.some(
    ([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)),
  );

/** The squared distance (in degrees, scaled by the cosine of the latitude
 * across) from a position to the nearest boundary, across the antimeridian. */
const boundaryDistance = (lon: number, lat: number, lines: [number, number][][]) => {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const ax = ((((line[i - 1][0] - lon + 180) % 360) + 360) % 360) - 180;
      const bx = ax + ((((line[i][0] - line[i - 1][0] + 180) % 360) + 360) % 360) - 180;
      const [px, py, qx, qy] = [ax * k, line[i - 1][1] - lat, bx * k, line[i][1] - lat];
      const [dx, dy] = [qx - px, qy - py];
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(px * dx + py * dy) / length)) : 0;
      const [x, y] = [px + t * dx, py + t * dy];
      best = Math.min(best, x * x + y * y);
    }
  }
  return best;
};

const labels = new WeakMap<Plate, [number, number] | null>();

/**
 * Where to write a plate's or province's name: the point inside it farthest
 * from its boundary (the edges its polygons gained at the antimeridian and
 * over a pole aren't boundaries, so the Pacific's lands mid-ocean), searched
 * on a grid over each polygon and refined around the best; within ±80°,
 * where the maps' fills reach. Null for an outline with no room inside.
 */
export const labelPoint = (plate: Plate): [number, number] | null => {
  const known = labels.get(plate);
  if (known !== undefined) return known;
  const polygons =
    plate.geometry.type === "MultiPolygon"
      ? plate.geometry.coordinates
      : [plate.geometry.coordinates];
  // The best so far (none while d < 0).
  const best = { lon: 0, lat: 0, d: -1 };
  const consider = (lon: number, lat: number) => {
    if (Math.abs(lat) > MAX_LABEL_LAT || !inPolygons(lon, lat, polygons)) return;
    const d = boundaryDistance(lon, lat, plate.lines);
    if (d > best.d) Object.assign(best, { lon, lat, d });
  };
  const cells: number[] = [];
  for (const [outer] of polygons) {
    const lons = outer.map(([lon]) => lon);
    const lats = outer.map(([, lat]) => Math.max(-MAX_LABEL_LAT, Math.min(MAX_LABEL_LAT, lat)));
    const [west, east, south, north] = [
      Math.min(...lons),
      Math.max(...lons),
      Math.min(...lats),
      Math.max(...lats),
    ];
    const [w, h] = [(east - west) / GRID, (north - south) / GRID];
    cells.push(Math.max(w, h));
    for (let i = 0; i < GRID; i++)
      for (let j = 0; j < GRID; j++) consider(west + (i + 0.5) * w, south + (j + 0.5) * h);
  }
  // Refined around the best, at an eighth of the largest cell.
  if (best.d >= 0) {
    const [lon, lat] = [best.lon, best.lat];
    const step = Math.max(...cells) / 8;
    for (let i = -4; i <= 4; i++)
      for (let j = -4; j <= 4; j++) consider(lon + i * step, lat + j * step);
  }
  const point: [number, number] | null = best.d >= 0 ? [best.lon, best.lat] : null;
  labels.set(plate, point);
  return point;
};

/**
 * A list's outlines for the Geospatial filter's map to fill, outline, pick
 * (`shapes`: each one's polygons and its boundary, by `code`, with whether
 * it's `selected`) and name (`labels`, at labelPoint).
 */
export const regionFeatures = (list: Plates, selected: string[]) => {
  const shapes: GeoJSON.Feature[] = [];
  const names: GeoJSON.Feature[] = [];
  for (const plate of list.plates) {
    const properties = {
      code: plate.code,
      name: plate.name,
      selected: selected.includes(plate.code),
    };
    shapes.push({ type: "Feature", properties, geometry: plate.geometry });
    shapes.push({
      type: "Feature",
      properties,
      geometry: { type: "MultiLineString", coordinates: plate.lines },
    });
    const at = labelPoint(plate);
    if (at)
      names.push({ type: "Feature", properties, geometry: { type: "Point", coordinates: at } });
  }
  return {
    shapes: { type: "FeatureCollection", features: shapes } as GeoJSON.FeatureCollection,
    labels: { type: "FeatureCollection", features: names } as GeoJSON.FeatureCollection,
  };
};
export type RegionFeatures = ReturnType<typeof regionFeatures>;
