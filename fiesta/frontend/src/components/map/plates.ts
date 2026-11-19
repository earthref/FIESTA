import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "../../lib/base";

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
    const plate: Plate = {
      code: String(properties?.code),
      name: String(properties?.name),
      lines: [],
    };
    plates.push(plate);
    const polygons =
      geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : geometry.type === "Polygon"
          ? [geometry.coordinates]
          : [];
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

/** A province's code (a lower-case slug), not a plate's (two letters). */
export const isProvince = (code: string) => code.includes("-");

/** A filter chip's label for a plate ("Pacific plate") or a province (its
 * vocabulary term, "Kaapvaal Craton"); the code until the lists load. */
export const regionLabel = (code: string, plates?: Plates, provinces?: Plates) =>
  isProvince(code)
    ? (provinces?.plates.find((province) => province.code === code)?.name ?? code)
    : `${plates?.plates.find((plate) => plate.code === code)?.name ?? code} plate`;

/** The `plates` search param ("PA,EU,kaapvaal-craton") as codes: plates
 * upper-cased, provinces lower-cased. */
export const parsePlates = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((code) => code.trim())
    .map((code) => (isProvince(code) ? code.toLowerCase() : code.toUpperCase()))
    .filter(Boolean);
