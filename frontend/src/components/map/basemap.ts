// The maps' basemap (ported from osu-mgr.org's search map): Esri Ocean, whose Web Mercator tiles stop at ±85.05°.
// Past that, polar-caps.ts draws the polar caps (POLAR_CAPS).
export const BASEMAP_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}";
// Open-ocean tiles stop at zoom 10 (deeper levels are "Map data not yet
// available"); past it, tiles are over-zoomed.
export const BASEMAP_MAXZOOM = 10;
export const BASEMAP_ATTRIBUTION =
  "Esri, GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org, and other contributors";
// Esri's labels for it (water bodies, undersea features, depths, places and
// boundaries): transparent tiles drawn over it, which the maps can turn off.
// Past the cap's edge, POLAR_LABELS.
export const LABEL_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}";
export const LABEL_MAXZOOM = 13;

export const MERCATOR_LAT = 85.0511287798;
export type Pole = "north" | "south";

// A cache of 256-pixel tiles ({z}/{y}/{x}) in an ellipsoidal polar
// stereographic projection with scale factor k0 at the pole, in the ArcGIS
// layout: level 0 is one tile whose top-left corner is origin, and each level
// halves the resolution (metres per pixel). Levels below minLevel are too
// coarse to be worth drawing. Tiles fade in before the cap's edge unless
// sharpEdge, as labels would show twice where they fade.
// generalise is for basemaps whose own tiles
// smooth out relief when zoomed out: the cap is blended (by weight) with a
// blurred copy of itself (a mipmap bias), fully below pixelsPerDegree[0] at
// its edge and not at all past pixelsPerDegree[1].
export type PolarTiles = {
  url: string;
  lon0: number;
  k0: number;
  falseEasting: number;
  falseNorthing: number;
  origin: [number, number];
  resolution: number;
  minLevel: number;
  maxLevel: number;
  sharpEdge?: boolean;
  generalise?: { bias: number; weight: number; pixelsPerDegree: [number, number] };
};
// colors: [map zoom, colour] steps, each from its zoom until the next's.
export type PolarCap = { tiles: PolarTiles } | { colors: [number, string][] };

// Esri's Arctic polar stereographic (EPSG:5936) tile grid, whose basemap and
// labels also stop at level 10 (~230 m). Level 6 is the four tiles around the
// pole, ~300 pixels across the cap.
const ARCTIC = "https://services.arcgisonline.com/arcgis/rest/services/Polar";
const ARCTIC_GRID = {
  lon0: -150,
  k0: 0.994,
  falseEasting: 2000000,
  falseNorthing: 2000000,
  origin: [-28567784.109255, 32567784.109255] as [number, number],
  resolution: 238810.813354,
  minLevel: 6,
  maxLevel: 10,
};

export const POLAR_CAPS: Partial<Record<Pole, PolarCap>> = {
  // The same basemap in Esri's Arctic polar stereographic.
  north: {
    tiles: {
      ...ARCTIC_GRID,
      url: `${ARCTIC}/Arctic_Ocean_Base/MapServer/tile/{z}/{y}/{x}`,
      // Zoomed out, the Arctic tiles still draw ridges that the Mercator
      // ones have smoothed away.
      generalise: { bias: 4, weight: 0.9, pixelsPerDegree: [15, 60] },
    },
  },
  // Esri has no Antarctic ocean basemap, but this one is one off-white south
  // of ~78°S, which its tiles change at zooms 1 and 5 (map zooms 0 and 4,
  // with 256-pixel tiles).
  south: {
    colors: [
      [-Infinity, "#f6f5f0"],
      [0, "#e9e8e4"],
      [4, "#f1f0eb"],
    ],
  },
};
// The labels past the cap's edge: Esri's for its Arctic basemap.
export const POLAR_LABELS: Partial<Record<Pole, PolarCap>> = {
  north: {
    tiles: {
      ...ARCTIC_GRID,
      url: `${ARCTIC}/Arctic_Ocean_Reference/MapServer/tile/{z}/{y}/{x}`,
      sharpEdge: true,
    },
  },
};

// The basemap as low-resolution plate carrée images for the result
// thumbnails (components/map-thumbnail.tsx): Esri's export of the whole world,
// which is blank past Web Mercator's limit, and of its Arctic version over the
// POLAR_ROWS at the top. The API fetches and caches them
// (backend/fiesta/apps/routers/basemap.py, whose sizes must match these).
export const THUMBNAIL_WIDTH = 1024;
export const THUMBNAIL_HEIGHT = 512;
export const THUMBNAIL_POLAR_ROWS = Math.ceil(((90 - MERCATOR_LAT) / 180) * THUMBNAIL_HEIGHT);
