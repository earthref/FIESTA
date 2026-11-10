import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_MAXZOOM,
  BASEMAP_TILES,
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
// index: the Moon's 1 is imagery, 2 elevation contours (not drawn), 3 its
// names).
const OPM = "https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named";
const OPM_MAXZOOM = 8;
const OPM_ATTRIBUTION = "OpenPlanetaryMap";

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
    labels: `${OPM}/opm-moon-basemap-v0-1/3/{z}/{x}/{y}.png`,
    labelsMaxzoom: OPM_MAXZOOM,
    // The highlands' grey, past ±85.05°.
    caps: {
      north: { colors: [[-Infinity, "#8e8e8e"]] },
      south: { colors: [[-Infinity, "#858585"]] },
    },
  },
};
