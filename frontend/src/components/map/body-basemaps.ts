import maplibregl from "maplibre-gl";
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_MAXZOOM,
  BASEMAP_TILES,
  MERCATOR_LAT,
  POLAR_CAPS,
  type PolarCap,
  type Pole,
} from "./basemap";
import type { Body } from "./bodies";

// A body's basemap on the maps (bodies.ts): raster tiles in Web Mercator
// ({z}/{x}/{y}), drawn to maxzoom and over-zoomed past it; optional raster
// labels over them, which the maps' Labels button turns off (Earth's are
// vector labels, see maplibre-map.tsx); and its polar caps past Web
// Mercator's limit. (Its thumbnail image is components/map-thumbnail.tsx's.)
export type BodyBasemap = {
  tiles: string;
  maxzoom: number;
  attribution: string;
  labels?: string;
  labelsMaxzoom?: number;
  caps: Partial<Record<Pole, PolarCap>>;
};

// OpenPlanetaryMap's basemaps (CARTO named maps, whose layers are picked by
// index: the Moon's 1 is imagery, 2-3 its names; Mars's 5 its names).
const OPM = "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named";
const OPM_MAXZOOM = 8;
const OPM_ATTRIBUTION = "OpenPlanetaryMap";
// NASA's Solar System Treks tiles are equirectangular (EQUIRECT_PROTOCOL
// reprojects them): {level}/{row}/{column}, level 0 two tiles of 180°.
const TREK = "https://trek.nasa.gov/tiles";
const EQUIRECT_PROTOCOL = "equirect";

export const BODY_BASEMAPS: Record<Body, BodyBasemap> = {
  earth: {
    tiles: BASEMAP_TILES,
    maxzoom: BASEMAP_MAXZOOM,
    attribution: BASEMAP_ATTRIBUTION,
    caps: POLAR_CAPS,
  },
  // LRO WAC albedo, hillshaded, with the names of maria, craters and landing sites.
  moon: {
    tiles: `${OPM}/opm-moon-basemap-v0-1/1/{z}/{x}/{y}.png`,
    maxzoom: OPM_MAXZOOM,
    attribution: `${OPM_ATTRIBUTION}, NASA/GSFC/Arizona State University (LRO WAC)`,
    labels: `${OPM}/opm-moon-basemap-v0-1/2,3/{z}/{x}/{y}.png`,
    labelsMaxzoom: OPM_MAXZOOM,
    // The highlands' grey, past ±85.05°.
    caps: {
      north: { colors: [[-Infinity, "#8e8e8e"]] },
      south: { colors: [[-Infinity, "#858585"]] },
    },
  },
  // The Viking MDIM 2.1 colour mosaic (232 m), with OpenPlanetaryMap's names.
  mars: {
    tiles: equirectTiles(
      `${TREK}/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg`,
      7,
    ),
    maxzoom: 8,
    attribution: "NASA/JPL-Caltech/USGS (Viking MDIM 2.1, Solar System Treks), OpenPlanetaryMap",
    labels: `${OPM}/opm-mars-basemap-v0-2/5/{z}/{x}/{y}.png`,
    labelsMaxzoom: OPM_MAXZOOM,
    // The polar ice.
    caps: {
      north: { colors: [[-Infinity, "#e6e1da"]] },
      south: { colors: [[-Infinity, "#ddd6cd"]] },
    },
  },
};

// --- Equirectangular tiles as Web Mercator ones ---------------------------

const TILE = 256;

/** A raster source URL for equirectangular tiles (`{z}/{y}/{x}` in `template`,
 * level 0 two tiles of 180°, to `maxLevel`), drawn as Web Mercator ones. */
function equirectTiles(template: string, maxLevel: number) {
  return `${EQUIRECT_PROTOCOL}://${maxLevel}/{z}/{x}/{y}/${encodeURIComponent(template)}`;
}

// Source tiles shared by neighbouring map tiles (the least recently asked for
// are dropped past MAX_SOURCE_TILES).
const MAX_SOURCE_TILES = 64;
const sourceTiles = new Map<string, Promise<ImageBitmap>>();
function sourceTile(url: string): Promise<ImageBitmap> {
  const cached = sourceTiles.get(url);
  if (cached) {
    sourceTiles.delete(url);
    sourceTiles.set(url, cached);
    return cached;
  }
  const loading = fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response.blob();
    })
    .then((blob) => createImageBitmap(blob));
  loading.catch(() => sourceTiles.delete(url));
  sourceTiles.set(url, loading);
  if (sourceTiles.size > MAX_SOURCE_TILES) {
    sourceTiles.delete(sourceTiles.keys().next().value as string);
  }
  return loading;
}

const mercatorLat = (fraction: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * fraction))) * 180) / Math.PI;

/** A Web Mercator tile drawn from the equirectangular tiles under it, at the
 * level whose resolution matches its own at the equator: the source's rows
 * are copied one output row at a time (longitude is linear in both). */
async function equirectTile(url: string): Promise<{ data: ArrayBuffer }> {
  const [maxLevel, z, x, y, template] = url.slice(`${EQUIRECT_PROTOCOL}://`.length).split("/");
  const [zoom, column, row] = [Number(z), Number(x), Number(y)];
  const level = Math.max(0, Math.min(zoom - 1, Number(maxLevel)));
  const source = decodeURIComponent(template);
  const degrees = 180 / 2 ** level; // per source tile
  const n = 2 ** zoom;
  const west = (column / n) * 360 - 180;
  const east = ((column + 1) / n) * 360 - 180;
  const north = Math.min(mercatorLat(row / n), MERCATOR_LAT);
  const south = Math.max(mercatorLat((row + 1) / n), -MERCATOR_LAT);
  const [first, last] = [
    Math.floor((west + 180) / degrees),
    Math.min(Math.ceil((east + 180) / degrees), 2 ** (level + 1)) - 1,
  ];
  const [top, bottom] = [
    Math.floor((90 - north) / degrees),
    Math.min(Math.ceil((90 - south) / degrees), 2 ** level) - 1,
  ];
  const tiles = [];
  for (let r = top; r <= bottom; r++) {
    for (let c = first; c <= last; c++) {
      const tileUrl = source
        .replace("{z}", String(level))
        .replace("{y}", String(r))
        .replace("{x}", String(c));
      tiles.push(sourceTile(tileUrl).then((image) => ({ image, r, c })));
    }
  }
  const mosaic = new OffscreenCanvas((last - first + 1) * TILE, (bottom - top + 1) * TILE);
  const mosaicContext = mosaic.getContext("2d");
  const out = new OffscreenCanvas(TILE, TILE);
  const context = out.getContext("2d");
  if (!mosaicContext || !context) throw new Error("no 2d canvas");
  for (const { image, r, c } of await Promise.all(tiles)) {
    mosaicContext.drawImage(image, (c - first) * TILE, (r - top) * TILE, TILE, TILE);
  }
  const perDegree = TILE / degrees;
  const sourceX = (west + 180 - first * degrees) * perDegree;
  const sourceWidth = (east - west) * perDegree;
  for (let outRow = 0; outRow < TILE; outRow++) {
    const lat = mercatorLat((row + (outRow + 0.5) / TILE) / n);
    const sourceY = Math.min(
      Math.max(Math.floor((90 - lat - top * degrees) * perDegree), 0),
      mosaic.height - 1,
    );
    context.drawImage(mosaic, sourceX, sourceY, sourceWidth, 1, 0, outRow, TILE, 1);
  }
  const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return { data: await blob.arrayBuffer() };
}

let registered = false;
/** Lets the maps' raster sources use equirectangular tiles (once per page). */
export function registerBodyProtocols() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol(EQUIRECT_PROTOCOL, (params) => equirectTile(params.url));
}
