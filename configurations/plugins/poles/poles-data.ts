import type { SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";

export interface Pole {
  lat: number;
  lon: number;
  /** The uncertainty outline (closed [lon, lat] ring) the backend computed
   * with PmagPy: the a95 circle, else the dp/dm ellipse. */
  ring?: [number, number][];
  /** The [lon, lat] VGPs of the sites averaged into it, when they have them. */
  vgps?: [number, number][];
  age?: number;
  ageUnit?: string;
  name: string;
  citation: string;
  contributionId?: string;
  poleId: string;
  /** Its hit's position in the search: the grid row it is. */
  index: number;
}

function firstNumber(value: unknown): number | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  const n = Number(candidate);
  return Number.isFinite(n) ? n : undefined;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

/** Normalize a longitude to -180..180. */
export function normalizeLon(lon: number): number {
  let result = lon % 360;
  if (result > 180) result -= 360;
  if (result < -180) result += 360;
  return result;
}

export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number): string {
  const normalized = normalizeLon(lon);
  return `${Math.abs(normalized).toFixed(1)}°${normalized >= 0 ? "E" : "W"}`;
}

/** Age label formatting (spec): ≥1e9 Ga, ≥1e6 Ma, ≥1e3 Ka, else years. */
export function formatAge(age: number): string {
  const abs = Math.abs(age);
  if (abs >= 1e9) return `${(age / 1e9).toFixed(2)} Ga`;
  if (abs >= 1e6) return `${(age / 1e6).toFixed(1)} Ma`;
  if (abs >= 1e3) return `${(age / 1e3).toFixed(0)} Ka`;
  return `${age} yr`;
}

/** The pole summary block: summary.poles (new backend) or summary.locations (legacy). */
export function poleBlockOf(hit: SearchResult): Record<string, unknown> | undefined {
  const poles = getPath(hit, "summary.poles");
  if (poles && typeof poles === "object") return poles as Record<string, unknown>;
  const locations = getPath(hit, "summary.locations");
  if (locations && typeof locations === "object") return locations as Record<string, unknown>;
  return undefined;
}

/**
 * A pole doc's uncertainty ring, `summary.poles._geometry.ring`: computed and
 * stored by the backend (PmagPy) when the doc was derived. Docs indexed before
 * that have none, and draw no outline until the index is rebuilt.
 */
function lonLatsOf(geometry: unknown, key: "ring" | "vgps"): [number, number][] {
  const list =
    geometry && typeof geometry === "object"
      ? (geometry as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (point): point is [number, number] =>
      Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]),
  );
}

function ringOf(geometry: unknown): [number, number][] | undefined {
  const points = lonLatsOf(geometry, "ring");
  return points.length > 1 ? points : undefined;
}

/** A pole doc's VGPs, `summary.poles._geometry.vgps` (also derived by the
 * backend; docs indexed before that have none). */
function vgpsOf(geometry: unknown): [number, number][] | undefined {
  const points = lonLatsOf(geometry, "vgps");
  return points.length > 0 ? points : undefined;
}

export function polesFromHits(hits: SearchResult[]): Pole[] {
  const poles: Pole[] = [];
  for (const [index, hit] of hits.entries()) {
    const block = poleBlockOf(hit);
    const lat = firstNumber(block?.pole_lat);
    const lonRaw = firstNumber(block?.pole_lon);
    if (lat === undefined || lonRaw === undefined) continue;

    const idValue = getPath(hit, "summary.contribution.id") ?? hit.id;
    const contributionId = idValue === undefined || idValue === null ? undefined : String(idValue);

    const reference = getPath(hit, "summary.contribution._reference");
    const refCitation =
      reference && typeof reference === "object"
        ? firstString((reference as Record<string, unknown>).citation)
        : typeof reference === "string" && reference
          ? reference
          : undefined;
    const citation =
      refCitation ?? (contributionId ? `Contribution ${contributionId}` : "Contribution");

    const name =
      firstString(block?.pole) ??
      firstString(block?.location) ??
      firstString(getPath(hit, "summary.locations.location")) ??
      "Pole";

    poles.push({
      lat,
      lon: normalizeLon(lonRaw),
      ring: ringOf(block?._geometry),
      vgps: vgpsOf(block?._geometry),
      age: firstNumber(block?.age ?? block?.pole_age),
      ageUnit: firstString(block?.age_unit),
      name,
      citation,
      contributionId,
      poleId: `${contributionId ?? "c"}-${name}-${index}`,
      index,
    });
  }
  return poles;
}

export interface AgeScale {
  minAge: number;
  maxAge: number;
  hasAges: boolean;
  /** young → old along the gradient; unknown → its own color. */
  color: (age: number | undefined) => string;
}

/** The poles plugin's `age_color` option (node YAML). */
export interface AgeColors {
  young: string;
  old: string;
  unknown: string;
  selected: string;
}

export const DEFAULT_AGE_COLORS: AgeColors = {
  young: "#ffff00",
  old: "#ff0000",
  unknown: "#000000",
  selected: "#800080",
};

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 0, 0];
};

/** Build the age → color mapping over the displayed poles (spec §Age coloring). */
export function makeAgeScale(poles: Pole[], colors: AgeColors = DEFAULT_AGE_COLORS): AgeScale {
  const ages = poles
    .map((pole) => pole.age)
    .filter((age): age is number => age !== undefined && Number.isFinite(age));
  const minAge = ages.length > 0 ? Math.min(...ages) : 0;
  const maxAge = ages.length > 0 ? Math.max(...ages) : 0;
  const range = maxAge - minAge;
  return {
    minAge,
    maxAge,
    hasAges: ages.length > 0,
    color: (age) => {
      if (age === undefined || !Number.isFinite(age)) return colors.unknown;
      const t = range > 0 ? (age - minAge) / range : 0.5;
      const [young, old] = [hexRgb(colors.young), hexRgb(colors.old)];
      const channel = (i: number) =>
        Math.round(young[i] + (old[i] - young[i]) * t)
          .toString(16)
          .padStart(2, "0");
      return `#${channel(0)}${channel(1)}${channel(2)}`;
    },
  };
}

/** A pole's uncertainty outline, ready to draw (the backend's ring), or null;
 * with `segments`, thinned to about that many (every k-th vertex, closed). */
export function uncertaintyRing(pole: Pole, segments?: number): [number, number][] | null {
  const ring = pole.ring;
  if (!ring) return null;
  const step = segments ? Math.ceil((ring.length - 1) / segments) : 1;
  if (step <= 1) return ring;
  const thinned = ring.filter((_, i) => i % step === 0);
  if (thinned[thinned.length - 1] !== ring[ring.length - 1]) thinned.push(ring[ring.length - 1]);
  return thinned;
}

/** Split a lon/lat ring wherever an adjacent-vertex jump exceeds 180° (date line). */
function splitAtDateLine(ring: [number, number][]): [number, number][][] {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    if (i > 0 && Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(ring[i]);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

/** GeoJSON FeatureCollection -> array of date-line-split [lon,lat] rings. */
export function boundaryRings(geojson: unknown): [number, number][][] {
  const rings: [number, number][][] = [];
  if (!geojson || typeof geojson !== "object") return rings;
  const features = (geojson as Record<string, unknown>).features;
  if (!Array.isArray(features)) return rings;

  const pushRing = (ring: unknown) => {
    if (!Array.isArray(ring)) return;
    const coords = ring
      .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2)
      .map((point) => [Number(point[0]), Number(point[1])] as [number, number])
      .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (coords.length > 1) {
      for (const segment of splitAtDateLine(coords)) rings.push(segment);
    }
  };

  for (const feature of features) {
    const geometry =
      feature && typeof feature === "object"
        ? ((feature as Record<string, unknown>).geometry as Record<string, unknown> | undefined)
        : undefined;
    if (!geometry) continue;
    const { type, coordinates } = geometry as { type?: string; coordinates?: unknown };
    if (type === "Polygon" && Array.isArray(coordinates)) {
      for (const ring of coordinates) pushRing(ring);
    } else if (type === "MultiPolygon" && Array.isArray(coordinates)) {
      for (const polygon of coordinates) {
        if (Array.isArray(polygon)) for (const ring of polygon) pushRing(ring);
      }
    } else if (type === "LineString") {
      pushRing(coordinates);
    } else if (type === "MultiLineString" && Array.isArray(coordinates)) {
      for (const line of coordinates) pushRing(line);
    }
  }
  return rings;
}
