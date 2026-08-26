import type { SearchResult } from "../../lib/types";
import { getPath } from "../../lib/utils";

export interface Pole {
  lat: number;
  lon: number;
  alpha95?: number;
  age?: number;
  ageUnit?: string;
  name: string;
  citation: string;
  contributionId?: string;
  poleId: string;
  /** The source search hit, for the detail card. */
  hit: SearchResult;
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

export function polesFromHits(hits: SearchResult[]): Pole[] {
  const poles: Pole[] = [];
  for (const hit of hits) {
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

    const name = firstString(block?.pole) ?? firstString(block?.location) ?? "Pole";

    poles.push({
      lat,
      lon: normalizeLon(lonRaw),
      alpha95: firstNumber(block?.pole_alpha95),
      age: firstNumber(block?.age ?? block?.pole_age),
      ageUnit: firstString(block?.age_unit),
      name,
      citation,
      contributionId,
      poleId: `${contributionId ?? "c"}-${name}-${poles.length}`,
      hit,
    });
  }
  return poles;
}

export interface AgeScale {
  minAge: number;
  maxAge: number;
  hasAges: boolean;
  /** young→yellow, old→red; unknown→black. */
  color: (age: number | undefined) => string;
}

/** Build the age → color mapping over the displayed poles (spec §Age coloring). */
export function makeAgeScale(poles: Pole[]): AgeScale {
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
      if (age === undefined || !Number.isFinite(age)) return "#000";
      const t = range > 0 ? (age - minAge) / range : 0.5;
      return `rgb(255, ${Math.round(255 * (1 - t))}, 0)`;
    },
  };
}

/**
 * a95 uncertainty ellipse (verbatim spec): small circle of angular radius
 * `alpha95` (degrees) around (lat, lon); numPoints = max(12, round(10+50·a95)).
 * Returns closed ring of [lon, lat] pairs.
 */
export function ellipsePoints(
  poleLat: number,
  poleLon: number,
  alpha95: number,
): [number, number][] {
  const rad = Math.PI / 180;
  const phi = poleLat * rad;
  const lambda = poleLon * rad;
  const r = alpha95 * rad;
  const n = Math.max(12, Math.round(10 + 50 * alpha95));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const lat = Math.asin(Math.sin(phi) * Math.cos(r) + Math.cos(phi) * Math.sin(r) * Math.cos(t));
    const lon =
      lambda +
      Math.atan2(
        Math.sin(t) * Math.sin(r) * Math.cos(phi),
        Math.cos(r) - Math.sin(phi) * Math.sin(lat),
      );
    pts.push([normalizeLon((lon * 180) / Math.PI), (lat * 180) / Math.PI]);
  }
  if (pts.length > 0) pts.push(pts[0]);
  return pts;
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
