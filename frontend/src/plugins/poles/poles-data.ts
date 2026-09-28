import type { SearchResult } from "../../lib/types";
import { getPath } from "../../lib/utils";

export interface Pole {
  lat: number;
  lon: number;
  alpha95?: number;
  /** The confidence oval's semi-axes (degrees): dp along the great circle
   * from the site to the pole, dm across it. */
  dp?: number;
  dm?: number;
  /** The site the pole was calculated from ([lat, lon]), for the oval's orientation. */
  site?: [number, number];
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

/** A location row's position: its lat/lon, or the middle of its box. */
function siteOf(row: Record<string, unknown> | undefined): [number, number] | undefined {
  if (!row) return undefined;
  const [lat, lon] = [firstNumber(row.lat), firstNumber(row.lon)];
  if (lat !== undefined && lon !== undefined) return [lat, normalizeLon(lon)];
  const [s, n, w, e] = ["lat_s", "lat_n", "lon_w", "lon_e"].map((k) => firstNumber(row[k]));
  if (s === undefined || n === undefined || w === undefined || e === undefined) return undefined;
  const west = normalizeLon(w);
  let east = normalizeLon(e);
  if (east < west) east += 360;
  return [(s + n) / 2, normalizeLon((west + east) / 2)];
}

export function polesFromHits(hits: SearchResult[]): Pole[] {
  const poles: Pole[] = [];
  for (const hit of hits) {
    const block = poleBlockOf(hit);
    const row = getPath(hit, "summary.locations") as Record<string, unknown> | undefined;
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
      alpha95: firstNumber(block?.pole_alpha95 ?? row?.pole_alpha95),
      dp: firstNumber(row?.pole_dp),
      dm: firstNumber(row?.pole_dm),
      site: siteOf(row),
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

/**
 * A dp/dm confidence oval around a pole: semi-axis dp (degrees) along the
 * great circle from the pole toward its site, dm across it. Each point is
 * the ellipse's radius in that direction, walked out from the pole along
 * the great circle at that bearing. Closed ring of [lon, lat] pairs.
 */
export function ovalPoints(
  [poleLat, poleLon]: [number, number],
  [siteLat, siteLon]: [number, number],
  dp: number,
  dm: number,
): [number, number][] {
  const rad = Math.PI / 180;
  const phi = poleLat * rad;
  const lambda = poleLon * rad;
  const phiS = siteLat * rad;
  const dLon = (siteLon - poleLon) * rad;
  // Initial bearing from the pole to the site.
  const bearing = Math.atan2(
    Math.sin(dLon) * Math.cos(phiS),
    Math.cos(phi) * Math.sin(phiS) - Math.sin(phi) * Math.cos(phiS) * Math.cos(dLon),
  );
  const n = Math.max(24, Math.round(10 + 50 * Math.max(dp, dm)));
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const [a, b] = [dp * Math.cos(t), dm * Math.sin(t)];
    const r = Math.hypot(a, b) * rad;
    const theta = bearing + Math.atan2(b, a);
    const lat = Math.asin(
      Math.sin(phi) * Math.cos(r) + Math.cos(phi) * Math.sin(r) * Math.cos(theta),
    );
    const lon =
      lambda +
      Math.atan2(
        Math.sin(theta) * Math.sin(r) * Math.cos(phi),
        Math.cos(r) - Math.sin(phi) * Math.sin(lat),
      );
    pts.push([normalizeLon(lon / rad), lat / rad]);
  }
  if (pts.length > 0) pts.push(pts[0]);
  return pts;
}

/** A pole's uncertainty outline: its a95 circle, else its dp/dm oval. */
export function uncertaintyRing(pole: Pole): [number, number][] | null {
  if (pole.alpha95 !== undefined && pole.alpha95 > 0)
    return ellipsePoints(pole.lat, pole.lon, pole.alpha95);
  if (pole.dp && pole.dm && pole.dp > 0 && pole.dm > 0 && pole.site)
    return ovalPoints([pole.lat, pole.lon], pole.site, pole.dp, pole.dm);
  return null;
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
