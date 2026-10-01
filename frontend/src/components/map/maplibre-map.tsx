import maplibregl from "maplibre-gl";
import { type FC, useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  MERCATOR_LAT,
  PLACE_LABEL_STYLE,
  UNDERSEA_ATTRIBUTION,
  UNDERSEA_FEATURES,
} from "./basemap";
import type { Body } from "./bodies";
import { BODY_BASEMAPS, registerBodyProtocols } from "./body-basemaps";
import { createLinesLayer, type LinesLayer, type MapLine } from "./lines-layer";
import {
  type Area,
  colocatedIndex,
  type MapPoint,
  type Mode,
  markerTooltip,
  pointKey,
  sphericalCentroid,
} from "./map-points";
import { createPolarCapsLayer } from "./polar-caps";

// MapLibre has only Web Mercator and globe projections, so the flat view is
// Mercator (to ±85°). On the globe, the polar caps past ±85° are drawn by a
// custom layer (see polar-caps.ts).
// The pole views' globe (vertical-perspective) doesn't turn into the Mercator
// map when zoomed in as 'globe' does, from zoom 10: there the zoom varies with
// the distance from the pole (see polarCamera).
const VIEWS: Record<
  Mode,
  {
    projection: "globe" | "mercator" | "vertical-perspective";
    center: [number, number];
    zoom: number;
  }
> = {
  globe: { projection: "globe", center: [-150, 20], zoom: 1.6 },
  flat: { projection: "mercator", center: [0, 20], zoom: 0.8 },
  north: { projection: "vertical-perspective", center: [0, 90], zoom: -1.5 },
  south: { projection: "vertical-perspective", center: [0, -90], zoom: -1.5 },
};
// The pole views show the globe as from far above the pole, a flat picture
// that dragging slides across the screen and zooming scales. MapLibre can't
// shift its picture past the canvas's edges, so instead its camera moves:
// with a narrow field of view (POLE_FOV) it is effectively orthographic, and
// moving it sideways while it looks down the polar axis slides the picture
// without changing the angle it shows the globe at. MapLibre's camera looks at
// its centre from the local vertical tilted by its pitch, so it is centred on
// the point under the middle of the screen and pitched by that point's angle
// from the pole, toward the pole, then rolled to keep the picture's
// orientation. A pole view is kept as a PolarView:
// - offset: the middle of the screen from the pole, in globe radii along the
//   screen's axes (x right, y down);
// - radius: the globe's radius in pixels;
// - orientation: the screen angle (anticlockwise from straight down) at which
//   longitude 0 leaves the pole. Longitude lon leaves it at orientation +
//   SIGN * lon, as longitudes run anticlockwise around the north pole seen
//   from above it, and clockwise around the south.
type PolarView = { offset: [number, number]; radius: number; orientation: number };
const SIGN: Partial<Record<Mode, number>> = { north: 1, south: -1 };
// MapLibre's globe is sized by the cosine of its centre's latitude, which the
// middle of the screen may not reach at the pole itself.
const MIN_OFFSET = 1e-6;
// Past this (80° from the pole) the tilt nears the horizon, so the camera
// stops there and the rest of the offset shifts the picture instead (see
// polarCamera). The middle of the screen can go half the screen further.
const MAX_OFFSET = Math.sin((80 * Math.PI) / 180);
type Size = { width: number; height: number };
const maxPolarOffset = (radius: number, { width, height }: Size) =>
  MAX_OFFSET + Math.min(width, height) / 2 / radius;
// The globe's radius in the pole views: to start with, in container heights,
// and its limits, in pixels.
const POLE_RADIUS = 0.45;
const MIN_POLE_RADIUS = 50;
const MAX_POLE_RADIUS = 1e8;
// Wheel movement that doubles or halves the globe in the pole views.
const WHEEL_PIXELS_PER_DOUBLING = 250;
// In degrees (MapLibre's default is ~37). The screen then spans at most 1° as
// seen from the camera, so the picture is flat to the eye; much narrower, and
// MapLibre leaves out tiles at the screen's edges.
const POLE_FOV = 1;
const DEGREES = 180 / Math.PI;
const polarCamera = (sign: number, { offset, radius, orientation }: PolarView) => {
  let [x, y] = offset;
  let r = Math.hypot(x, y);
  if (r < MIN_OFFSET) [x, y, r] = [0, MIN_OFFSET, MIN_OFFSET];
  const camera = Math.min(r, MAX_OFFSET);
  // The screen angle from the pole to the middle of the screen, as orientation.
  const angle = Math.atan2(x, y) * DEGREES;
  // Past MAX_OFFSET, how far the point the camera looks at is short of the
  // middle of the screen, in pixels: padding moves it off the middle by that.
  const [shiftX, shiftY] = [((r - camera) * radius * x) / r, ((r - camera) * radius * y) / r];
  // The camera is tilted toward the pole, which is then straight down the
  // screen until rolled round to the opposite side from the middle.
  return {
    center: [sign * (angle - orientation), sign * Math.acos(camera) * DEGREES] as [number, number],
    // MapLibre's globe radius is 512 * 2^zoom / (2π cos(latitude)), and here
    // cos(latitude) is camera.
    zoom: Math.log2((radius * 2 * Math.PI * camera) / 512),
    pitch: Math.asin(camera) * DEGREES,
    bearing: sign > 0 ? 180 : 0,
    roll: angle + 180,
    padding: {
      left: Math.max(-2 * shiftX, 0),
      right: Math.max(2 * shiftX, 0),
      top: Math.max(-2 * shiftY, 0),
      bottom: Math.max(2 * shiftY, 0),
    },
  };
};
// Globe views keep their centre off the poles; the pole views need it there.
const polarConstrain = (lngLat: maplibregl.LngLat, zoom: number) => {
  const limit = Math.acos(MIN_OFFSET) * DEGREES;
  return {
    center: new maplibregl.LngLat(lngLat.lng, Math.min(Math.max(lngLat.lat, -limit), limit)),
    zoom,
  };
};
// The Mercator view's centre stays clear of its top and bottom edges.
const MAX_FLAT_CENTER_LAT = 70;
// Hit tolerance around the pointer, in pixels.
const HIT_PX = 4;
const HIT_LAYERS = ["points"];
// MapLibre's GeoJSON tiles are Web Mercator, which moves points past ±85.05°
// to its edge. On the globe those are HTML markers instead, styled like the
// circles; the flat map has nowhere else to put them.
const isPolar = (p: MapPoint) => Math.abs(p.lat) > MERCATOR_LAT;
const MARKER_STYLE =
  "width:8px;height:8px;border-radius:50%;border:1px solid #ffffff;box-sizing:border-box;cursor:pointer";
const TOOLTIP_CLASS =
  "absolute z-10 hidden whitespace-nowrap bg-white rounded border border-gray-300 shadow px-2.5 py-1.5 text-sm text-gray-700 leading-snug";
const wrap180 = (degrees: number) => (((degrees % 360) + 540) % 360) - 180;

// Where a view looks to show the points' centre of mass: in the globe and
// Mercator views, their centre; in the pole views, with the pole still
// centred, the orientation that puts the centre of mass of the points in that
// hemisphere straight below it.
const focusCenter = (mode: "globe" | "flat", points: MapPoint[]): [number, number] | null => {
  const centroid = sphericalCentroid(points);
  if (!centroid) return null;
  const [lon, lat] = centroid;
  return [
    lon,
    mode === "flat" ? Math.min(Math.max(lat, -MAX_FLAT_CENTER_LAT), MAX_FLAT_CENTER_LAT) : lat,
  ];
};
const focusOrientation = (sign: number, points: MapPoint[]): number | null => {
  const centroid = sphericalCentroid(points.filter((p) => p.lat * sign > 0));
  return centroid ? wrap180(-sign * centroid[0]) : null;
};

// The geospatial filter area: drawn in the node's colour, with handles at
// its corners to resize it; dragging its outline moves it.
const areaColor = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--node-color").trim() || "#800080";
// Records outside the filters, shown for context: dark grey, which stands out
// on both the ocean and the land.
const CONTEXT_COLOR = "#374151";
const areaHandleStyle = () =>
  `width:12px;height:12px;background:#ffffff;border:2px solid ${areaColor()};box-sizing:border-box`;
const AREA_MIN_DEGREES = 0.01;
// How near the outline (in pixels, either side) a drag moves the area: about
// a corner handle's width. Each edge is sampled this many times to find it,
// as it curves on the globe.
const AREA_GRAB_PX = 8;
const OUTLINE_SAMPLES = 24;
const distanceToSegment = (x: number, y: number, a: maplibregl.Point, b: maplibregl.Point) => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const t =
    dx || dy
      ? Math.min(Math.max(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy), 0), 1)
      : 0;
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
};
// Corner handles: the area's [longitude, latitude] indexes (west 0, south 1,
// east 2, north 3) at the north-west, north-east, south-east and south-west.
const AREA_CORNERS: [number, number][] = [
  [0, 3],
  [2, 3],
  [2, 1],
  [0, 1],
];
// The area as a polygon to fill and a line to outline it: MapLibre cuts
// polygons into tiles, and outlining one would also outline the cuts.
const areaFeatures = ([west, south, east, north]: Area): GeoJSON.Feature[] => {
  // MapLibre can't draw past Web Mercator's limit.
  const [s, n] = [Math.max(south, -MERCATOR_LAT), Math.min(north, MERCATOR_LAT)];
  const ring = [
    [west, s],
    [east, s],
    [east, n],
    [west, n],
    [west, s],
  ];
  return [
    { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } },
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring } },
  ];
};
// A longitude as the copy of it nearest another.
const unwrapLon = (lon: number, near: number) => lon + 360 * Math.round((near - lon) / 360);

// Fitting the view to the points (the fit prop): the margin around them, and
// the closest it zooms, so that one record still shows its surroundings. Points
// spread over a small area zoom past that until the spread spans a quarter of
// the map's width or height, but never closer than FIT_CLOSE_ZOOM.
const FIT_PADDING = 30;
const FIT_MAX_ZOOM = 6;
const FIT_CLOSE_ZOOM = 15;
const fitZoom = (full: number, quarter: number, spread: boolean) =>
  Math.min(full, spread ? Math.max(FIT_MAX_ZOOM, Math.min(quarter, FIT_CLOSE_ZOOM)) : FIT_MAX_ZOOM);
// The points' extent, with longitudes taken near their centre of mass so
// that it can cross the antimeridian.
const pointsExtent = (points: MapPoint[]): [[number, number], [number, number]] | null => {
  const centroid = sphericalCentroid(points);
  if (!centroid) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  points.forEach(({ lon, lat }) => {
    const near = unwrapLon(lon, centroid[0]);
    [west, south, east, north] = [
      Math.min(west, near),
      Math.min(south, lat),
      Math.max(east, near),
      Math.max(north, lat),
    ];
  });
  return [
    [west, south],
    [east, north],
  ];
};

// On the globe, the camera centred on the points' centre of mass that fits
// them. MapLibre's cameraForBounds works in Web Mercator, which
// leaves out points past ±85°; this places them as seen straight down on the
// globe (x across, y up, in globe radii), and sizes the globe so they fit.
const globeFitCamera = (points: MapPoint[], width: number, height: number) => {
  const centroid = sphericalCentroid(points);
  if (!centroid) return null;
  const rad = Math.PI / 180;
  const [lon0, lat0] = [centroid[0], Math.max(Math.min(centroid[1], MERCATOR_LAT), -MERCATOR_LAT)];
  let [maxX, maxY, farSide] = [0, 0, false];
  points.forEach(({ lon, lat }) => {
    const [dLon, phi, phi0] = [(lon - lon0) * rad, lat * rad, lat0 * rad];
    if (Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLon) < 0)
      farSide = true;
    maxX = Math.max(maxX, Math.abs(Math.cos(phi) * Math.sin(dLon)));
    maxY = Math.max(
      maxY,
      Math.abs(Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLon)),
    );
  });
  // The zoom that fits the points in a box of that half-size: from the globe's
  // radius in pixels (the whole globe if points are on its far side), since
  // MapLibre's globe radius is 512 * 2^zoom / (2π cos(latitude)).
  const zoomFor = (halfWidth: number, halfHeight: number) => {
    const radius = farSide
      ? Math.min(halfWidth, halfHeight)
      : Math.min(halfWidth / (maxX || 1e-9), halfHeight / (maxY || 1e-9));
    return Math.log2((radius * 2 * Math.PI * Math.cos(lat0 * rad)) / 512);
  };
  const zoom = fitZoom(
    zoomFor(width / 2 - FIT_PADDING, height / 2 - FIT_PADDING),
    zoomFor(width / 8, height / 8),
    Math.max(maxX, maxY) > 1e-9,
  );
  return { center: [lon0, lat0] as [number, number], zoom };
};

// The basemap's labels, on unless turned off with the button under the zoom
// buttons; remembered in this browser for every map.
const LABELS_KEY = "map-labels";
const labelsOn = () => {
  try {
    return localStorage.getItem(LABELS_KEY) !== "off";
  } catch {
    return true;
  }
};
// The labels (see PLACE_LABEL_STYLE), loaded once per page: Positron's layers
// for places, water bodies and boundaries (roads and airports left out), with
// its fonts, and the undersea features.
type Labels = {
  glyphs: string;
  source: maplibregl.SourceSpecification;
  layers: maplibregl.LayerSpecification[];
  undersea: GeoJSON.Feature[];
};
const PLACE_SOURCE_LAYERS = ["place", "water_name", "boundary"];
let labels: Promise<Labels | null> | null = null;
const loadLabels = () =>
  (labels ||= Promise.all([
    fetch(PLACE_LABEL_STYLE)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
    fetch(UNDERSEA_FEATURES)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ]).then(
    ([style, undersea]) =>
      style && {
        glyphs: style.glyphs,
        source: style.sources.openmaptiles,
        layers: style.layers.filter(
          (layer: any) =>
            layer.source === "openmaptiles" && PLACE_SOURCE_LAYERS.includes(layer["source-layer"]),
        ),
        undersea: undersea?.features || [],
      },
  ));
// Names in English where the tiles have it, else in the local script.
const ENGLISH_NAME = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]];
// Positron's water names are small and pale. Oceans are left to OCEAN_NAMES,
// as the tiles only name some.
const WATER_NAME = {
  filter: ["==", ["index-of", "Ocean", ENGLISH_NAME], -1],
  layout: {
    "text-field": ENGLISH_NAME,
    "text-size": ["match", ["get", "class"], "sea", 12, 11],
    "text-letter-spacing": 0.15,
    "text-max-width": 6,
  },
  paint: {
    "text-color": "#2c5282",
    "text-halo-color": "rgba(255,255,255,0.7)",
    "text-halo-width": 1,
  },
};
// Place names are quieter than the water's: grey, partly transparent, and in
// English only (Positron adds the local script on a second line).
const PLACE_NAME = {
  filter: null,
  layout: { "text-field": ENGLISH_NAME },
  paint: {
    "text-color": "#6b7280",
    "text-opacity": 0.85,
    "text-halo-color": "rgba(255,255,255,0.6)",
    "text-halo-width": 1,
  },
};
// OpenFreeMap's tiles name seas, bays and straits but not the oceans, which are
// labelled here until zoomed in past them.
const OCEAN_NAMES: [string, number, number][] = [
  ["North Pacific Ocean", -160, 28],
  ["South Pacific Ocean", -125, -30],
  ["North Atlantic Ocean", -40, 32],
  ["South Atlantic Ocean", -15, -25],
  ["Indian Ocean", 80, -20],
  ["Arctic Ocean", -150, 82],
  ["Southern Ocean", 60, -62],
  ["Southern Ocean", -120, -64],
];
const OCEAN_MAXZOOM = 5;
const oceanLabels = (visibility: "visible" | "none"): maplibregl.SymbolLayerSpecification => ({
  id: "labels:oceans",
  type: "symbol",
  source: "labels:oceans",
  maxzoom: OCEAN_MAXZOOM,
  layout: {
    "text-field": ["get", "name"],
    "text-font": ["Noto Sans Italic"],
    "text-size": 15,
    "text-letter-spacing": 0.2,
    "text-max-width": 6,
    visibility,
  },
  paint: WATER_NAME.paint,
});
// Undersea feature names, from these zooms by kind (areas are the largest
// features): ~11, 16 and 45 pixels per degree of latitude, which is how the
// ones past Web Mercator's limit are shown (see polarLabel).
const UNDERSEA_MINZOOM: Record<string, number> = { area: 3, line: 3.5, point: 5 };
const UNDERSEA_COLOR = "#1f3f66";
type SymbolLayer = maplibregl.SymbolLayerSpecification;
const UNDERSEA_LAYOUT: NonNullable<SymbolLayer["layout"]> = {
  "text-field": ["get", "name"],
  "text-font": ["Noto Sans Italic"],
  "text-size": 11,
  "text-max-width": 8,
};
const UNDERSEA_PAINT: NonNullable<SymbolLayer["paint"]> = {
  "text-color": UNDERSEA_COLOR,
  "text-halo-color": "rgba(255,255,255,0.75)",
  "text-halo-width": 1,
};
const underseaLayers = (visibility: "visible" | "none") =>
  Object.entries(UNDERSEA_MINZOOM).map(
    ([kind, minzoom]): SymbolLayer => ({
      id: `labels:undersea-${kind}`,
      type: "symbol",
      source: "labels:undersea",
      minzoom,
      filter: ["==", ["get", "kind"], kind],
      layout: {
        ...UNDERSEA_LAYOUT,
        ...(kind === "line" && { "symbol-placement": "line", "text-max-angle": 30 }),
        visibility,
      },
      paint: UNDERSEA_PAINT,
    }),
  );
// Where a feature's label goes: a line's middle vertex, or its point.
const labelPoint = ({ geometry }: GeoJSON.Feature): [number, number] | null => {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  if (geometry.type === "MultiPoint") return geometry.coordinates[0] as [number, number];
  const line =
    geometry.type === "LineString"
      ? geometry.coordinates
      : geometry.type === "MultiLineString"
        ? geometry.coordinates[0]
        : null;
  return line?.length ? (line[Math.floor(line.length / 2)] as [number, number]) : null;
};
const POLAR_LABEL_STYLE =
  `font:italic 11px 'Noto Sans',sans-serif;color:${UNDERSEA_COLOR};white-space:nowrap;pointer-events:none;` +
  "text-shadow:0 0 2px rgba(255,255,255,0.9),0 0 2px rgba(255,255,255,0.9)";
const labelsControl = (initial: boolean, onChange: (on: boolean) => void): maplibregl.IControl => {
  const container = document.createElement("div");
  return {
    onAdd() {
      container.className = "maplibregl-ctrl maplibregl-ctrl-group";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Aa";
      let on = initial;
      const show = () => {
        button.title = on ? "Hide labels" : "Show labels";
        button.setAttribute("aria-pressed", String(on));
        button.style.cssText = `font:bold 12px/29px sans-serif;color:#333;opacity:${on ? 1 : 0.45};text-decoration:${on ? "none" : "line-through"}`;
      };
      show();
      button.onclick = () => {
        on = !on;
        show();
        onChange(on);
      };
      container.appendChild(button);
      return container;
    },
    onRemove() {
      container.remove();
    },
  };
};

// The box behind the records' labels (labelPoints), like the tooltip: white,
// with a grey border, rounded corners and a slight shadow. Drawn at twice the
// size it shows at; MapLibre stretches its middle to fit each label.
const labelBox = (): [ImageData, Parameters<maplibregl.Map["addImage"]>[2]] => {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  const rounded = (x: number, y: number, width: number, height: number, radius: number) => {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
  };
  rounded(1, 2, 22, 21, 5);
  context.fillStyle = "rgba(0,0,0,0.12)";
  context.fill();
  rounded(1, 1, 22, 21, 5);
  context.fillStyle = "#ffffff";
  context.fill();
  context.strokeStyle = "#d1d5db";
  context.lineWidth = 2;
  context.stroke();
  return [
    context.getImageData(0, 0, size, size),
    { pixelRatio: 2, stretchX: [[8, 16]], stretchY: [[8, 16]], content: [6, 5, 18, 18] },
  ];
};

type Feature = GeoJSON.Feature<GeoJSON.Geometry, { key: string; color: string; name?: string }>;
const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features,
});
const pointFeature = (p: MapPoint): Feature => ({
  type: "Feature",
  properties: { key: pointKey(p), color: p.color, name: p.name },
  geometry: { type: "Point", coordinates: [p.lon, p.lat] },
});

/**
 * Esri Ocean map of records' positions, on a globe, a Mercator map or a globe
 * over either pole. The view starts, and moves whenever the points change,
 * centred on the points (see focusCenter). Clicking a record opens it.
 */
const MapLibreMap: FC<{
  mode: Mode;
  // The planetary body the map is of (its basemap); the points are its.
  body?: Body;
  points: MapPoint[];
  onSelect?: (id: string) => void;
  // Instead of the view's default zoom.
  zoom?: number;
  // In the globe and Mercator views, fit the view to the points instead of
  // centring it on them at a fixed zoom.
  fit?: boolean;
  // Labels each record with its name, beside its marker (where they don't
  // collide), rather than only in its tooltip.
  labelPoints?: boolean;
  // The geospatial filter area, which can be moved and resized on the map;
  // onAreaChange gets it when a drag ends, or, without one, when asked for
  // (requestViewArea) over the middle of the view.
  area?: Area | null;
  onAreaChange?: (area: Area) => void;
  requestViewArea?: boolean;
  // Zooms (when it changes) so this area fills about the middle quarter of the
  // view, outside the pole views.
  zoomTo?: Area | null;
  // The view re-centres on the points when they next change after this does,
  // so that editing the area doesn't move it. By default it re-centres
  // whenever the points change.
  focusKey?: unknown;
  // Records drawn in grey under the others, for context: those a filter
  // leaves out. They can't be hovered or clicked.
  context?: MapPoint[];
  // Lines under the points (plate boundaries, uncertainty ellipses), drawn
  // past Web Mercator's limit too (see lines-layer.ts).
  lines?: MapLine[];
  // The points' circle radius in pixels, instead of 3.
  pointRadius?: number;
}> = ({
  mode,
  body = "earth",
  points,
  onSelect,
  zoom,
  fit,
  labelPoints,
  area,
  onAreaChange,
  requestViewArea,
  zoomTo,
  focusKey,
  context,
  lines,
  pointRadius = 3,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const pointsRef = useRef({ points, index: colocatedIndex(points) });
  // Plots the latest points once the style has loaded.
  const setPointsRef = useRef<(() => void) | null>(null);
  const focusKeyRef = useRef<unknown>(focusKey ?? points);
  focusKeyRef.current = focusKey ?? points;
  const areaRef = useRef({ area: area ?? null, onAreaChange, requestViewArea });
  areaRef.current = { area: area ?? null, onAreaChange, requestViewArea };
  // Shows the latest area (or adds the one asked for) once the style has loaded.
  const syncAreaRef = useRef<(() => void) | null>(null);
  // The latest area to zoom to, and zooms to it once the style has loaded.
  const zoomToRef = useRef(zoomTo ?? null);
  zoomToRef.current = zoomTo ?? null;
  const zoomToAreaRef = useRef<(() => void) | null>(null);
  const contextRef = useRef(context || []);
  contextRef.current = context || [];
  // Plots the latest context points once the style has loaded.
  const setContextRef = useRef<(() => void) | null>(null);
  const linesRef = useRef(lines || []);
  linesRef.current = lines || [];
  // The lines' layer, once the style has loaded.
  const linesLayerRef = useRef<LinesLayer | null>(null);

  // Before the map's rebuild below, which opens on these points (a new body's).
  useEffect(() => {
    pointsRef.current = { points, index: colocatedIndex(points) };
    setPointsRef.current?.();
  }, [points]);

  // The map is rebuilt per mode and body; everything else reaches it through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the mode or body changes
  useEffect(() => {
    if (!containerRef.current || !tooltipRef.current) return;
    const view = VIEWS[mode];
    const basemap = BODY_BASEMAPS[body];
    registerBodyProtocols();
    const globe = view.projection !== "mercator";
    const sign = SIGN[mode];
    // A body's raster labels, but not over a pole, where its zoom-0 tiles'
    // names would be stretched across the whole view.
    const bodyLabels = sign ? undefined : basemap.labels;
    const { points: initialPoints } = pointsRef.current;
    // The focus key the view was last centred for.
    let focused: unknown = null;
    let camera: maplibregl.CameraOptions;
    let polar: PolarView | null = null;
    if (sign) {
      const orientation = focusOrientation(sign, initialPoints);
      if (orientation !== null) focused = focusKeyRef.current;
      polar = {
        offset: [0, 0],
        radius: POLE_RADIUS * containerRef.current.clientHeight,
        orientation: orientation ?? 0,
      };
      camera = polarCamera(sign, polar);
    } else {
      const center = focusCenter(mode as "globe" | "flat", initialPoints);
      if (center) focused = focusKeyRef.current;
      camera = { center: center ?? view.center, zoom: zoom ?? view.zoom };
    }
    const map = new maplibregl.Map({
      container: containerRef.current,
      ...camera,
      attributionControl: { compact: true },
      // The pole views are moved only by the handlers below: MapLibre's own
      // would keep the centre off the pole.
      ...(sign && {
        maxPitch: 85,
        transformConstrain: polarConstrain,
        dragPan: false,
        dragRotate: false,
        touchPitch: false,
        keyboard: false,
        boxZoom: false,
        doubleClickZoom: false,
        scrollZoom: false,
        touchZoomRotate: false,
      }),
      style: {
        version: 8,
        projection: { type: view.projection },
        sources: {
          basemap: {
            type: "raster",
            tiles: [basemap.tiles],
            tileSize: 256,
            maxzoom: basemap.maxzoom,
            attribution: basemap.attribution,
          },
          ...(bodyLabels && {
            "basemap-labels": {
              type: "raster",
              tiles: [bodyLabels],
              tileSize: 256,
              maxzoom: basemap.labelsMaxzoom ?? basemap.maxzoom,
            },
          }),
          points: { type: "geojson", data: collection([]) },
          area: { type: "geojson", data: collection([]) },
          context: { type: "geojson", data: collection([]) },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#000000" } },
          { id: "basemap", type: "raster", source: "basemap" },
          ...(bodyLabels
            ? [
                {
                  id: "basemap-labels",
                  type: "raster" as const,
                  source: "basemap-labels",
                  layout: { visibility: labelsOn() ? ("visible" as const) : ("none" as const) },
                },
              ]
            : []),
          {
            id: "context-points",
            type: "circle",
            source: "context",
            paint: {
              "circle-radius": 2.5,
              "circle-color": CONTEXT_COLOR,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 0.75,
              "circle-opacity": 0.85,
            },
          },
          {
            id: "area-fill",
            type: "fill",
            source: "area",
            filter: ["==", ["geometry-type"], "Polygon"],
            paint: { "fill-color": areaColor(), "fill-opacity": 0.08 },
          },
          {
            id: "area-edge",
            type: "line",
            source: "area",
            filter: ["==", ["geometry-type"], "LineString"],
            paint: { "line-color": areaColor(), "line-width": 2, "line-dasharray": [3, 2] },
          },
          {
            id: "points",
            type: "circle",
            source: "points",
            paint: {
              "circle-radius": pointRadius,
              "circle-color": ["get", "color"],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
            },
          },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // The attribution starts as just its (i) button. MapLibre opens it the
    // first time it collapses it to the button (once sources have credits);
    // after that only clicks, and map drags, change it.
    const attribution = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
    const attributionObserver = new MutationObserver(() => {
      if (!attribution?.classList.contains("maplibregl-compact")) return;
      attribution.classList.remove("maplibregl-compact-show");
      attributionObserver.disconnect();
    });
    if (attribution)
      attributionObserver.observe(attribution, { attributes: true, attributeFilter: ["class"] });
    // The labels' layers (added once they load). Undersea features past Web
    // Mercator's limit would be drawn at its edge, so on the globe they're HTML
    // labels instead, shown from the same scale as the others of their kind.
    // A body's own labels are its basemap's; Earth's are loaded (addLabels).
    let labelLayers: string[] = bodyLabels ? ["basemap-labels"] : [];
    let showLabels = labelsOn();
    let polarLabels: {
      element: HTMLElement;
      lngLat: [number, number];
      minPixelsPerDegree: number;
      marker: maplibregl.Marker;
    }[] = [];
    let removed = false;
    const showPolarLabels = () =>
      polarLabels.forEach(({ element, lngLat: [lon, lat], minPixelsPerDegree }) => {
        const pixelsPerDegree = map
          .project([lon, lat])
          .dist(map.project([lon, lat - Math.sign(lat)]));
        element.style.display = showLabels && pixelsPerDegree >= minPixelsPerDegree ? "" : "none";
      });
    map.on("move", showPolarLabels);
    map.addControl(
      labelsControl(showLabels, (on) => {
        try {
          localStorage.setItem(LABELS_KEY, on ? "on" : "off");
        } catch {
          /* not remembered */
        }
        showLabels = on;
        for (const id of labelLayers) {
          map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
        }
        showPolarLabels();
      }),
      "top-right",
    );
    const addLabels = (loaded: Labels | null) => {
      if (!loaded || removed) return;
      map.setGlyphs(loaded.glyphs);
      if (body === "earth") addEarthLabels(loaded);
      // The records' names, over everything (and not turned off with the
      // basemap's labels), on a white box like the tooltip's.
      if (labelPoints) {
        map.addImage("point-label-box", ...labelBox());
        map.addLayer({
          id: "point-labels",
          type: "symbol",
          source: "points",
          layout: {
            "text-field": ["get", "name"],
            "text-font": ["Noto Sans Regular"],
            "text-size": 11,
            "text-anchor": "left",
            "text-offset": [0.9, 0],
            "icon-image": "point-label-box",
            "icon-text-fit": "both",
            "icon-text-fit-padding": [2, 5, 2, 5],
          },
          paint: { "text-color": "#374151" },
        });
      }
    };
    // Earth's place, water and undersea feature names (the Positron style's
    // glyphs also draw the records' names on every body).
    const addEarthLabels = (loaded: Labels) => {
      map.addSource("labels:places", loaded.source);
      const visibility = showLabels ? "visible" : "none";
      const isPolar = (feature: GeoJSON.Feature) =>
        Math.abs(labelPoint(feature)?.[1] ?? 0) > MERCATOR_LAT;
      map.addSource("labels:undersea", {
        type: "geojson",
        data: collection(loaded.undersea.filter((feature) => !isPolar(feature))),
        attribution: UNDERSEA_ATTRIBUTION,
      });
      map.addSource("labels:oceans", {
        type: "geojson",
        data: collection(
          OCEAN_NAMES.map(([name, lon, lat]) => ({
            type: "Feature",
            properties: { name },
            geometry: { type: "Point", coordinates: [lon, lat] },
          })),
        ),
      });
      // Undersea names under the places'.
      const layers = [
        oceanLabels(visibility),
        ...underseaLayers(visibility),
        ...loaded.layers.map((layer) => {
          const restyle = { water_name: WATER_NAME, place: PLACE_NAME }[
            (layer as any)["source-layer"] as string
          ];
          return {
            ...layer,
            id: `labels:${layer.id}`,
            source: "labels:places",
            ...(restyle?.filter && {
              filter: ["all", (layer as any).filter ?? true, restyle.filter],
            }),
            layout: { ...(layer as any).layout, ...restyle?.layout, visibility },
            paint: { ...(layer as any).paint, ...restyle?.paint },
          } as maplibregl.LayerSpecification;
        }),
      ];
      for (const layer of layers) map.addLayer(layer, "context-points");
      labelLayers = layers.map((layer) => layer.id);
      if (globe) {
        polarLabels = loaded.undersea.filter(isPolar).flatMap((feature) => {
          const lngLat = labelPoint(feature);
          if (!lngLat) return [];
          const element = document.createElement("div");
          element.style.cssText = POLAR_LABEL_STYLE;
          element.textContent = feature.properties?.name;
          const marker = new maplibregl.Marker({ element, opacityWhenCovered: "0" })
            .setLngLat(lngLat)
            .addTo(map);
          const minPixelsPerDegree = (512 * 2 ** UNDERSEA_MINZOOM[feature.properties?.kind]) / 360;
          return [{ element, lngLat, minPixelsPerDegree, marker }];
        });
        showPolarLabels();
      }
    };
    if (sign) map.setVerticalFieldOfView(POLE_FOV);
    // The camera that fits the points, if asked for.
    const fitCamera = (points: MapPoint[]) => {
      // Not until the container has its size (a modal may still be laying out).
      if (
        !fit ||
        sign ||
        map.transform.width <= 4 * FIT_PADDING ||
        map.transform.height <= 4 * FIT_PADDING
      )
        return undefined;
      if (globe)
        return globeFitCamera(points, map.transform.width, map.transform.height) ?? undefined;
      const extent = pointsExtent(points);
      const full = extent && map.cameraForBounds(extent, { padding: FIT_PADDING });
      if (!extent || full?.zoom === undefined) return undefined;
      // Fitted in the middle quarter of the map, for a small spread.
      const [x, y] = [(3 * map.transform.width) / 8, (3 * map.transform.height) / 8];
      const quarter = map.cameraForBounds(extent, {
        padding: { top: y, bottom: y, left: x, right: x },
      });
      const [[west, south], [east, north]] = extent;
      return {
        ...full,
        zoom: fitZoom(
          full.zoom,
          quarter?.zoom ?? full.zoom,
          Math.max(east - west, north - south) > 1e-9,
        ),
      };
    };
    // Re-fitted as the container resizes, until the map is moved by hand.
    let autoFit = Boolean(fit);
    const refit = () => {
      const camera = autoFit ? fitCamera(pointsRef.current.points) : undefined;
      if (camera) map.jumpTo(camera);
    };
    refit();
    map.on("movestart", (e) => {
      if (e.originalEvent) autoFit = false;
    });

    const tooltip = createTooltip(tooltipRef.current);
    let markers: maplibregl.Marker[] = [];
    // The map's mousemove sees the pointer over a marker as over no record.
    let overMarker = false;

    const setPoints = () => {
      const { points, index } = pointsRef.current;
      const plotted = globe ? points.filter((p) => !isPolar(p)) : points;
      (map.getSource("points") as maplibregl.GeoJSONSource).setData(
        collection(plotted.map(pointFeature)),
      );
      for (const marker of markers) marker.remove();
      markers = [];
      overMarker = false;
      if (globe) {
        // One marker per spot and type, as index groups them.
        index.forEach((members) => {
          const { lat, lon, color, id } = members[0];
          if (!isPolar(members[0])) return;
          const element = document.createElement("div");
          const size = 2 * pointRadius + 2;
          element.style.cssText = `${MARKER_STYLE};width:${size}px;height:${size}px;background:${color}`;
          // Hidden behind the globe, but still under the pointer there.
          const hidden = () => map.transform.isLocationOccluded(new maplibregl.LngLat(lon, lat));
          element.addEventListener("mouseenter", () => {
            if (hidden()) return;
            overMarker = true;
            const { x, y } = map.project([lon, lat]);
            tooltip.show(markerTooltip(members), x, y);
          });
          element.addEventListener("mouseleave", () => {
            overMarker = false;
            tooltip.scheduleHide();
          });
          element.addEventListener("click", () => {
            if (!hidden() && members.length === 1) onSelectRef.current?.(id);
          });
          markers.push(
            new maplibregl.Marker({ element, opacityWhenCovered: "0" })
              .setLngLat([lon, lat])
              .addTo(map),
          );
        });
      }
      if (points.length && focusKeyRef.current !== focused) {
        focused = focusKeyRef.current;
        if (sign) {
          const orientation = focusOrientation(sign, points);
          if (orientation !== null) animatePolar({ offset: [0, 0], orientation });
        } else {
          const fitted = fitCamera(points);
          const center = focusCenter(mode as "globe" | "flat", points);
          autoFit = Boolean(fit);
          if (fitted) map.easeTo({ ...fitted, duration: 800 });
          else if (center) map.easeTo({ center, duration: 800 });
        }
      }
    };

    // Context points past Web Mercator's limit would be drawn at its edge, and
    // aren't worth markers of their own.
    const setContext = () => {
      const plotted = contextRef.current.filter((p) => !isPolar(p));
      (map.getSource("context") as maplibregl.GeoJSONSource).setData(
        collection(plotted.map(pointFeature)),
      );
    };

    // Points (and the view on them) that arrived while the style was loading.
    // (isStyleLoaded() is also false while tiles load, so it can't gate these.)
    map.on("load", () => {
      if (globe) {
        map.addLayer(createPolarCapsLayer("polar-caps", basemap.caps), "context-points");
      }
      loadLabels().then(addLabels);
      setPointsRef.current = setPoints;
      setPoints();
      syncAreaRef.current = syncArea;
      zoomToAreaRef.current = zoomToArea;
      zoomToArea();
      syncArea();
      setContextRef.current = setContext;
      setContext();
      const linesLayer = createLinesLayer("lines", !globe);
      linesLayer.setLines(linesRef.current);
      map.addLayer(linesLayer, "context-points");
      linesLayerRef.current = linesLayer;
    });

    // Geospatial filter area. Dragging a corner handle resizes it, and dragging
    // its outline moves it; onAreaChange gets the result when the drag ends.
    let shown: Area | null = null;
    let dragging = false;
    // In the Mercator view, handles sit within its limit: the poles project
    // off the map (to NaN at the south pole).
    const handleLat = (lat: number) =>
      globe ? lat : Math.min(Math.max(lat, -MERCATOR_LAT), MERCATOR_LAT);
    const drawArea = (skip?: maplibregl.Marker) => {
      (map.getSource("area") as maplibregl.GeoJSONSource).setData(
        collection(shown ? areaFeatures(shown) : []),
      );
      handles.forEach((handle, corner) => {
        if (!shown) {
          handle.remove();
          return;
        }
        if (handle === skip) return;
        handle.setLngLat([
          shown[AREA_CORNERS[corner][0]],
          handleLat(shown[AREA_CORNERS[corner][1]]),
        ]);
        if (!handle.getElement().isConnected) handle.addTo(map);
      });
    };
    const commitArea = () => {
      dragging = false;
      drawArea();
      if (!shown) return;
      // Stored with its west edge within ±180.
      const shift = shown[0] >= 180 ? -360 : shown[0] < -180 ? 360 : 0;
      shown = [shown[0] + shift, shown[1], shown[2] + shift, shown[3]];
      areaRef.current.onAreaChange?.(shown);
    };
    const resize = (handle: maplibregl.Marker) => {
      if (!shown) return;
      const { lng, lat } = handle.getLngLat();
      const [west, south, east, north] = shown;
      const [lonIndex, latIndex] = AREA_CORNERS[handles.indexOf(handle)];
      const next = [...shown] as Area;
      const lon = unwrapLon(lng, shown[lonIndex]);
      // A Mercator handle still at the limit leaves an edge beyond it where it is.
      const edgeLat =
        !globe &&
        Math.abs(lat) > MERCATOR_LAT - 1e-3 &&
        lat * shown[latIndex] > 0 &&
        Math.abs(shown[latIndex]) > MERCATOR_LAT
          ? shown[latIndex]
          : lat;
      // Edges stop short of crossing the opposite ones.
      next[lonIndex] =
        lonIndex === 0
          ? Math.min(lon, east - AREA_MIN_DEGREES)
          : Math.max(lon, west + AREA_MIN_DEGREES);
      next[latIndex] =
        latIndex === 1
          ? Math.min(Math.max(edgeLat, -90), north - AREA_MIN_DEGREES)
          : Math.max(Math.min(edgeLat, 90), south + AREA_MIN_DEGREES);
      if (next[2] - next[0] > 360) next[lonIndex] = lonIndex === 0 ? next[2] - 360 : next[0] + 360;
      shown = next;
      drawArea(handle);
    };
    const handles = AREA_CORNERS.map(() => {
      const element = document.createElement("div");
      element.dataset.areaHandle = "";
      element.style.cssText = `${areaHandleStyle()};cursor:nwse-resize`;
      const handle = new maplibregl.Marker({ element, draggable: true, opacityWhenCovered: "0" });
      handle.on("dragstart", () => {
        dragging = true;
      });
      handle.on("drag", () => resize(handle));
      handle.on("dragend", () => {
        resize(handle);
        commitArea();
      });
      return handle;
    });
    // Whether a point on the canvas is within AREA_GRAB_PX of the outline as
    // drawn (clipped at Web Mercator's limit), where it's in view.
    const onOutline = (x: number, y: number) => {
      if (!shown) return false;
      const [west, south, east, north] = shown;
      const [s, n] = [Math.max(south, -MERCATOR_LAT), Math.min(north, MERCATOR_LAT)];
      const edges = [
        [west, n, east, n],
        [east, n, east, s],
        [east, s, west, s],
        [west, s, west, n],
      ];
      return edges.some(([lon0, lat0, lon1, lat1]) => {
        let previous: maplibregl.Point | null = null;
        for (let i = 0; i <= OUTLINE_SAMPLES; i++) {
          const [lon, lat] = [
            lon0 + ((lon1 - lon0) * i) / OUTLINE_SAMPLES,
            lat0 + ((lat1 - lat0) * i) / OUTLINE_SAMPLES,
          ];
          const point =
            globe && map.transform.isLocationOccluded(new maplibregl.LngLat(lon, lat))
              ? null
              : map.project([lon, lat]);
          if (point && previous && distanceToSegment(x, y, previous, point) <= AREA_GRAB_PX)
            return true;
          previous = point;
        }
        return false;
      });
    };
    // Dragging the outline: caught before MapLibre's handlers and the pole
    // views' (preventDefault stops the mouse events that would follow).
    const container = map.getContainer();
    let moving: { pointerId: number; start: maplibregl.LngLat; area: Area } | null = null;
    const canvasPoint = (e: PointerEvent): [number, number] => {
      const rect = map.getCanvas().getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    const onMoveStart = (e: PointerEvent) => {
      if (!shown || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as HTMLElement).closest(".maplibregl-control-container, [data-area-handle]"))
        return;
      const point = canvasPoint(e);
      if (!onOutline(...point)) return;
      e.stopPropagation();
      e.preventDefault();
      moving = { pointerId: e.pointerId, start: map.unproject(point), area: shown };
      dragging = true;
      container.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (moving?.pointerId !== e.pointerId) return;
      e.stopPropagation();
      const { lng, lat } = map.unproject(canvasPoint(e));
      const [west, south, east, north] = moving.area;
      const dLon = unwrapLon(lng, moving.start.lng) - moving.start.lng;
      const dLat = Math.min(Math.max(lat - moving.start.lat, -90 - south), 90 - north);
      shown = [west + dLon, south + dLat, east + dLon, north + dLat];
      drawArea();
    };
    const onMoveEnd = (e: PointerEvent) => {
      if (moving?.pointerId !== e.pointerId) return;
      e.stopPropagation();
      moving = null;
      commitArea();
    };
    // Touches start MapLibre's gestures with their own events.
    const onTouchStart = (e: TouchEvent) => {
      if (moving) e.stopPropagation();
    };
    container.addEventListener("pointerdown", onMoveStart, true);
    container.addEventListener("pointermove", onMove, true);
    container.addEventListener("pointerup", onMoveEnd, true);
    container.addEventListener("pointercancel", onMoveEnd, true);
    container.addEventListener("touchstart", onTouchStart, true);

    // The middle quarter of the view (half its width and height), for an
    // unfiltered search's area: over what's in view, with its handles easy to
    // reach. Its outline is sampled, as it curves on the globe, and a pole
    // within it takes in every longitude.
    const viewArea = (): Area => {
      const { width, height } = map.transform;
      const [x0, y0, x1, y1] = [width / 4, height / 4, (width * 3) / 4, (height * 3) / 4];
      const middle = map.unproject([width / 2, height / 2]);
      const samples = [0, 1, 2, 3, 4, 5, 6, 7, 8]
        .flatMap((i) => {
          const t = i / 8;
          return [
            [x0 + (x1 - x0) * t, y0],
            [x0 + (x1 - x0) * t, y1],
            [x0, y0 + (y1 - y0) * t],
            [x1, y0 + (y1 - y0) * t],
          ];
        })
        .map((point) => map.unproject(point as [number, number]));
      const lons = samples.map(({ lng }) => unwrapLon(lng, middle.lng));
      const lats = samples.map(({ lat }) => lat);
      let [west, south, east, north] = [
        Math.min(...lons),
        Math.min(...lats),
        Math.max(...lons),
        Math.max(...lats),
      ];
      const poleInView = (lat: number) => {
        if (!globe || map.transform.isLocationOccluded(new maplibregl.LngLat(0, lat))) return false;
        const { x, y } = map.project([0, lat]);
        return x >= x0 && x <= x1 && y >= y0 && y <= y1;
      };
      if (poleInView(90)) north = 90;
      if (poleInView(-90)) south = -90;
      if (east - west >= 360 || poleInView(90) || poleInView(-90)) [west, east] = [-180, 180];
      return [west, Math.max(south, -90), east, Math.min(north, 90)];
    };
    // Zooms so zoomTo fills the middle quarter of the view: padded by a quarter
    // of the view on each side (and within Web Mercator's limit, which
    // cameraForBounds works in). Each area once.
    let zoomedTo: Area | null = null;
    const zoomToArea = () => {
      const target = zoomToRef.current;
      if (!target || target === zoomedTo || sign) return;
      zoomedTo = target;
      const [west, south, east, north] = target;
      const { width, height } = map.transform;
      const camera = map.cameraForBounds(
        [
          [west, Math.max(south, -MERCATOR_LAT)],
          [east, Math.min(north, MERCATOR_LAT)],
        ],
        { padding: { top: height / 4, bottom: height / 4, left: width / 4, right: width / 4 } },
      );
      if (camera) map.easeTo({ ...camera, duration: 800 });
    };
    const syncArea = () => {
      if (dragging) return;
      const { area, requestViewArea } = areaRef.current;
      if (!area && requestViewArea) {
        // Once the view has settled (it may be moving to the points).
        if (map.isMoving()) return void map.once("moveend", syncArea);
        shown = viewArea();
        drawArea();
        areaRef.current.onAreaChange?.(shown);
        return;
      }
      shown = area;
      drawArea();
    };

    // Pole views: a drag (of the mouse, or one or two fingers) slides the globe
    // with the pointer, and the wheel, a pinch or the zoom buttons resize it
    // about the middle of the screen.
    const setPolar = (next: PolarView) => {
      const [x, y] = next.offset;
      const [r, max] = [Math.hypot(x, y), maxPolarOffset(next.radius, map.transform)];
      polar = r > max ? { ...next, offset: [(x * max) / r, (y * max) / r] } : next;
      map.jumpTo(polarCamera(sign!, polar));
    };
    let animation = 0;
    const animatePolar = (target: Partial<PolarView>, duration = 800) => {
      cancelAnimationFrame(animation);
      const start = polar!;
      const [offset, orientation, radius] = [
        target.offset ?? start.offset,
        target.orientation ?? start.orientation,
        target.radius ?? start.radius,
      ];
      const turn = wrap180(orientation - start.orientation);
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - t0) / duration, 1);
        const e = t * (2 - t);
        setPolar({
          offset: [
            start.offset[0] + (offset[0] - start.offset[0]) * e,
            start.offset[1] + (offset[1] - start.offset[1]) * e,
          ],
          orientation: start.orientation + turn * e,
          radius: start.radius * (radius / start.radius) ** e,
        });
        if (t < 1) animation = requestAnimationFrame(step);
      };
      animation = requestAnimationFrame(step);
    };
    const polarRadius = (radius: number) =>
      Math.min(Math.max(radius, MIN_POLE_RADIUS), MAX_POLE_RADIUS);
    // Pointers down on the map, and their centre and spread.
    const pointers = new Map<number, { x: number; y: number }>();
    const gesture = () => {
      const [a, b] = [...pointers.values()];
      return b
        ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) }
        : { ...a, spread: 0 };
    };
    // Markers and the canvas are both in the canvas container.
    const surface = map.getCanvasContainer();
    const onPointerDown = (e: PointerEvent) => {
      if ((e.pointerType === "mouse" && e.button !== 0) || pointers.size >= 2) return;
      // The area's handles drag themselves.
      if ((e.target as HTMLElement).closest("[data-area-handle]")) return;
      cancelAnimationFrame(animation);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      surface.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || !polar) return;
      const before = gesture();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = gesture();
      const radius =
        before.spread && after.spread
          ? polarRadius((polar.radius * after.spread) / before.spread)
          : polar.radius;
      const [dx, dy] = [after.x - before.x, after.y - before.y];
      setPolar({
        ...polar,
        offset: [polar.offset[0] - dx / radius, polar.offset[1] - dy / radius],
        radius,
      });
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      if (!polar) return;
      e.preventDefault();
      cancelAnimationFrame(animation);
      const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
      setPolar({
        ...polar,
        radius: polarRadius(polar.radius * 2 ** (-pixels / WHEEL_PIXELS_PER_DOUBLING)),
      });
    };
    if (sign) {
      surface.addEventListener("pointerdown", onPointerDown);
      surface.addEventListener("pointermove", onPointerMove);
      surface.addEventListener("pointerup", onPointerUp);
      surface.addEventListener("pointercancel", onPointerUp);
      surface.addEventListener("wheel", onWheel, { passive: false });
      // For the zoom buttons.
      map.zoomIn = () => {
        animatePolar({ radius: polarRadius(polar!.radius * 2) }, 300);
        return map;
      };
      map.zoomOut = () => {
        animatePolar({ radius: polarRadius(polar!.radius / 2) }, 300);
        return map;
      };
    }

    const canvas = map.getCanvas();
    // The records under the pointer: the topmost one and any others of its
    // type at the same spot.
    const hitTest = (e: maplibregl.MapMouseEvent) => {
      const { x, y } = e.point;
      const features = map.queryRenderedFeatures(
        [
          [x - HIT_PX, y - HIT_PX],
          [x + HIT_PX, y + HIT_PX],
        ],
        { layers: HIT_LAYERS },
      );
      const key = features[0]?.properties?.key;
      return key ? pointsRef.current.index.get(key) : undefined;
    };
    map.on("mousemove", (e) => {
      if (overMarker) return;
      const members = hitTest(e);
      canvas.style.cursor = members ? "pointer" : onOutline(e.point.x, e.point.y) ? "move" : "";
      if (members) tooltip.show(markerTooltip(members), e.point.x, e.point.y);
      else tooltip.scheduleHide();
    });
    map.on("movestart", tooltip.hide);
    // Several records at one spot are opened from the tooltip's links.
    map.on("click", (e) => {
      const members = hitTest(e);
      if (members?.length === 1) onSelectRef.current?.(members[0].id);
    });

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            map.resize();
            refit();
          })
        : null;
    observer?.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(animation);
      observer?.disconnect();
      tooltip.dispose();
      setPointsRef.current = null;
      syncAreaRef.current = null;
      setContextRef.current = null;
      linesLayerRef.current = null;
      removed = true;
      attributionObserver.disconnect();
      for (const { marker } of polarLabels) marker.remove();
      for (const marker of markers) marker.remove();
      for (const handle of handles) handle.remove();
      container.removeEventListener("pointerdown", onMoveStart, true);
      container.removeEventListener("pointermove", onMove, true);
      container.removeEventListener("pointerup", onMoveEnd, true);
      container.removeEventListener("pointercancel", onMoveEnd, true);
      container.removeEventListener("touchstart", onTouchStart, true);
      map.remove();
    };
  }, [mode, body]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the area by value; the sync reads it from areaRef
  useEffect(() => {
    syncAreaRef.current?.();
  }, [area?.join(), requestViewArea]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the area by value; the zoom reads it from zoomToRef
  useEffect(() => {
    zoomToAreaRef.current?.();
  }, [zoomTo?.join()]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: context reaches the map through contextRef
  useEffect(() => {
    setContextRef.current?.();
  }, [context]);

  useEffect(() => {
    linesLayerRef.current?.setLines(lines || []);
  }, [lines]);

  return (
    <div className="relative w-full h-full bg-black">
      {/* Inline: maplibre-gl.css makes its container position: relative. */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tooltip's record links are a pointer shortcut; each record is also on the Summaries tab */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: as above */}
      <div
        ref={tooltipRef}
        className={TOOLTIP_CLASS}
        // Record links in the tooltip.
        onClick={(e) => {
          const id = (e.target as HTMLElement).closest("[data-id]")?.getAttribute("data-id");
          if (id) onSelectRef.current?.(id);
        }}
      />
    </div>
  );
};

// Hover tooltip in a div over the map, kept open while the pointer is on it
// so its record links can be clicked.
const createTooltip = (el: HTMLDivElement) => {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    el.style.display = "none";
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 300);
  };
  el.onmouseenter = () => clearTimeout(hideTimer);
  el.onmouseleave = scheduleHide;
  return {
    show: (html: string, x: number, y: number) => {
      clearTimeout(hideTimer);
      el.innerHTML = html;
      el.style.left = `${x + 14}px`;
      el.style.top = `${y + 14}px`;
      el.style.display = "block";
    },
    hide,
    scheduleHide,
    dispose: () => clearTimeout(hideTimer),
  };
};

export default MapLibreMap;
