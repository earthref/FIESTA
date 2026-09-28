import maplibregl from "maplibre-gl";
import { type FC, useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_MAXZOOM,
  BASEMAP_TILES,
  LABEL_MAXZOOM,
  LABEL_TILES,
  MERCATOR_LAT,
  POLAR_CAPS,
  POLAR_LABELS,
} from "./basemap";
import {
  type Area,
  colocatedIndex,
  type MapPoint,
  type Mode,
  markerTooltip,
  pointKey,
  sphericalCentroid,
} from "./map-points";
import { createPolarCapsLayer, type PolarCapsLayer } from "./polar-caps";

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
const HIT_LAYERS = ["points", "boxes"];
// A record's box replaces its marker once both its sides are this long on
// screen (the marker's width); smaller, the marker shows where it is.
const BOX_MIN_PX = 8;
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
// its corners to resize it and in its middle to move it.
const areaColor = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--node-color").trim() || "#800080";
// Records outside the filters, shown for context.
const CONTEXT_COLOR = "#9ca3af";
const areaHandleStyle = () =>
  `width:12px;height:12px;background:#ffffff;border:2px solid ${areaColor()};box-sizing:border-box`;
const AREA_MIN_DEGREES = 0.01;
// Corner handles: the area's [longitude, latitude] indexes (west 0, south 1,
// east 2, north 3) at the north-west, north-east, south-east and south-west.
const AREA_CORNERS: [number, number][] = [
  [0, 3],
  [2, 3],
  [2, 1],
  [0, 1],
];
const areaFeature = ([west, south, east, north]: Area): GeoJSON.Feature => {
  // MapLibre can't draw past Web Mercator's limit.
  const [s, n] = [Math.max(south, -MERCATOR_LAT), Math.min(north, MERCATOR_LAT)];
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, s],
          [east, s],
          [east, n],
          [west, n],
          [west, s],
        ],
      ],
    },
  };
};
// A longitude as the copy of it nearest another.
const unwrapLon = (lon: number, near: number) => lon + 360 * Math.round((near - lon) / 360);

// Fitting the view to the points (the fit prop): the margin around them, and
// the closest it zooms, so that one record still shows its surroundings.
const FIT_PADDING = 30;
const FIT_MAX_ZOOM = 6;
// The points' extent, boxes included, with longitudes taken near their
// centre of mass so that it can cross the antimeridian.
const pointsExtent = (points: MapPoint[]): [[number, number], [number, number]] | null => {
  const centroid = sphericalCentroid(points);
  if (!centroid) return null;
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  points.forEach((p) => {
    const corners = p.bounds
      ? [
          [p.bounds[0], p.bounds[1]],
          [p.bounds[2], p.bounds[3]],
        ]
      : [[p.lon, p.lat]];
    corners.forEach(([lon, lat]) => {
      const near = unwrapLon(lon, centroid[0]);
      [west, south, east, north] = [
        Math.min(west, near),
        Math.min(south, lat),
        Math.max(east, near),
        Math.max(north, lat),
      ];
    });
  });
  return [
    [west, south],
    [east, north],
  ];
};

// On the globe, the camera centred on the points' centre of mass that fits
// them, boxes included. MapLibre's cameraForBounds works in Web Mercator, which
// leaves out points past ±85°; this places them as seen straight down on the
// globe (x across, y up, in globe radii), and sizes the globe so they fit.
const globeFitCamera = (points: MapPoint[], width: number, height: number) => {
  const centroid = sphericalCentroid(points);
  if (!centroid) return null;
  const rad = Math.PI / 180;
  const [lon0, lat0] = [centroid[0], Math.max(Math.min(centroid[1], MERCATOR_LAT), -MERCATOR_LAT)];
  let [maxX, maxY, farSide] = [0, 0, false];
  points.forEach((p) => {
    const corners = p.bounds
      ? [
          [p.bounds[0], p.bounds[1]],
          [p.bounds[2], p.bounds[1]],
          [p.bounds[2], p.bounds[3]],
          [p.bounds[0], p.bounds[3]],
        ]
      : [[p.lon, p.lat]];
    corners.forEach(([lon, lat]) => {
      const [dLon, phi, phi0] = [(lon - lon0) * rad, lat * rad, lat0 * rad];
      if (Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLon) < 0)
        farSide = true;
      maxX = Math.max(maxX, Math.abs(Math.cos(phi) * Math.sin(dLon)));
      maxY = Math.max(
        maxY,
        Math.abs(Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLon)),
      );
    });
  });
  // The globe's radius in pixels: the whole globe if points are on its far side.
  const [halfWidth, halfHeight] = [width / 2 - FIT_PADDING, height / 2 - FIT_PADDING];
  const radius = farSide
    ? Math.min(halfWidth, halfHeight)
    : Math.min(halfWidth / (maxX || 1e-9), halfHeight / (maxY || 1e-9));
  // MapLibre's globe radius is 512 * 2^zoom / (2π cos(latitude)).
  const zoom = Math.log2((radius * 2 * Math.PI * Math.cos(lat0 * rad)) / 512);
  return { center: [lon0, lat0] as [number, number], zoom: Math.min(zoom, FIT_MAX_ZOOM) };
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

type Feature = GeoJSON.Feature<GeoJSON.Geometry, { key: string; color: string }>;
const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features,
});
// Numbered, for the feature state that hides a marker inside its box.
const pointFeature = (p: MapPoint, id: number): Feature => ({
  type: "Feature",
  id,
  properties: { key: pointKey(p), color: p.color },
  geometry: { type: "Point", coordinates: [p.lon, p.lat] },
});
const boxFeature = (p: MapPoint): Feature => {
  const [west, south, east, north] = p.bounds!;
  return {
    type: "Feature",
    properties: { key: pointKey(p), color: p.color },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
};

/**
 * Esri Ocean map of records' positions, on a globe, a Mercator map or a globe
 * over either pole. Records with start and end positions are drawn as boxes
 * around them as well. The view starts, and moves whenever the points change,
 * centred on the points (see focusCenter). Clicking a record opens it.
 */
const MapLibreMap: FC<{
  mode: Mode;
  points: MapPoint[];
  onSelect?: (id: string) => void;
  // Instead of the view's default zoom.
  zoom?: number;
  // In the globe and Mercator views, fit the view to the points instead of
  // centring it on them at a fixed zoom.
  fit?: boolean;
  // The geospatial filter area, which can be moved and resized on the map;
  // onAreaChange gets it when a drag ends.
  area?: Area | null;
  onAreaChange?: (area: Area) => void;
  // Asks for an area over the middle of the view, when there is none.
  requestArea?: boolean;
  // The view re-centres on the points when they next change after this does,
  // so that editing the area doesn't move it. By default it re-centres
  // whenever the points change.
  focusKey?: unknown;
  // Records drawn in grey under the others, for context: those a filter
  // leaves out. They can't be hovered or clicked.
  context?: MapPoint[];
}> = ({
  mode,
  points,
  onSelect,
  zoom,
  fit,
  area,
  onAreaChange,
  requestArea,
  focusKey,
  context,
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
  const areaRef = useRef({ area: area ?? null, onAreaChange, requestArea });
  areaRef.current = { area: area ?? null, onAreaChange, requestArea };
  // Shows the latest area (or makes the one asked for) once the style has loaded.
  const syncAreaRef = useRef<(() => void) | null>(null);
  const contextRef = useRef(context || []);
  contextRef.current = context || [];
  // Plots the latest context points once the style has loaded.
  const setContextRef = useRef<(() => void) | null>(null);

  // The map is rebuilt per mode; everything else reaches it through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the mode changes
  useEffect(() => {
    if (!containerRef.current || !tooltipRef.current) return;
    const view = VIEWS[mode];
    const globe = view.projection !== "mercator";
    const sign = SIGN[mode];
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
            tiles: [BASEMAP_TILES],
            tileSize: 256,
            maxzoom: BASEMAP_MAXZOOM,
            attribution: BASEMAP_ATTRIBUTION,
          },
          labels: { type: "raster", tiles: [LABEL_TILES], tileSize: 256, maxzoom: LABEL_MAXZOOM },
          points: { type: "geojson", data: collection([]) },
          boxes: { type: "geojson", data: collection([]) },
          area: { type: "geojson", data: collection([]) },
          context: { type: "geojson", data: collection([]) },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#000000" } },
          { id: "basemap", type: "raster", source: "basemap" },
          {
            id: "labels",
            type: "raster",
            source: "labels",
            layout: { visibility: labelsOn() ? "visible" : "none" },
          },
          {
            id: "context-points",
            type: "circle",
            source: "context",
            paint: {
              "circle-radius": 2.5,
              "circle-color": CONTEXT_COLOR,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 0.5,
              "circle-opacity": 0.8,
            },
          },
          {
            id: "area-fill",
            type: "fill",
            source: "area",
            paint: { "fill-color": areaColor(), "fill-opacity": 0.08 },
          },
          {
            id: "area-edge",
            type: "line",
            source: "area",
            paint: { "line-color": areaColor(), "line-width": 2, "line-dasharray": [3, 2] },
          },
          {
            id: "boxes",
            type: "fill",
            source: "boxes",
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0.3 },
          },
          {
            id: "box-edges",
            type: "line",
            source: "boxes",
            paint: { "line-color": "#ffffff", "line-width": 1 },
          },
          {
            id: "points",
            type: "circle",
            source: "points",
            paint: {
              "circle-radius": 3,
              "circle-color": ["get", "color"],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 1,
              "circle-opacity": ["case", ["boolean", ["feature-state", "inBox"], false], 0, 1],
              "circle-stroke-opacity": [
                "case",
                ["boolean", ["feature-state", "inBox"], false],
                0,
                1,
              ],
            },
          },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    // The Arctic labels past the cap's edge, over the caps (added on load).
    let polarLabels: PolarCapsLayer | null = null;
    map.addControl(
      labelsControl(labelsOn(), (on) => {
        try {
          localStorage.setItem(LABELS_KEY, on ? "on" : "off");
        } catch {
          /* not remembered */
        }
        map.setLayoutProperty("labels", "visibility", on ? "visible" : "none");
        polarLabels?.setVisible(on);
      }),
      "top-right",
    );
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
      return extent
        ? map.cameraForBounds(extent, { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM })
        : undefined;
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
    // Records drawn with boxes (by their point feature's id), and whether the
    // box is big enough on screen to stand in for the marker.
    let boxed: { id: number; bounds: [number, number, number, number]; inBox: boolean }[] = [];
    const showBoxes = () => {
      boxed.forEach((box) => {
        const [west, south, east, north] = box.bounds;
        const [a, b] = [map.project([west, south]), map.project([east, north])];
        const inBox = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) >= BOX_MIN_PX;
        if (inBox === box.inBox) return;
        box.inBox = inBox;
        map.setFeatureState({ source: "points", id: box.id }, { inBox });
      });
    };
    let markers: maplibregl.Marker[] = [];
    // The map's mousemove sees the pointer over a marker as over no record.
    let overMarker = false;

    const setPoints = () => {
      const { points, index } = pointsRef.current;
      const plotted = globe ? points.filter((p) => !isPolar(p)) : points;
      (map.getSource("points") as maplibregl.GeoJSONSource).setData(
        collection(plotted.map(pointFeature)),
      );
      map.removeFeatureState({ source: "points" });
      boxed = plotted.flatMap((p, id) =>
        p.bounds ? [{ id, bounds: p.bounds, inBox: false }] : [],
      );
      showBoxes();
      (map.getSource("boxes") as maplibregl.GeoJSONSource).setData(
        collection(plotted.filter((p) => p.bounds).map(boxFeature)),
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
          element.style.cssText = `${MARKER_STYLE};background:${color}`;
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
        map.addLayer(createPolarCapsLayer("polar-caps", POLAR_CAPS), "labels");
        polarLabels = createPolarCapsLayer("polar-labels", POLAR_LABELS);
        polarLabels.setVisible(labelsOn());
        map.addLayer(polarLabels, "context-points");
      }
      setPointsRef.current = setPoints;
      setPoints();
      syncAreaRef.current = syncArea;
      syncArea();
      setContextRef.current = setContext;
      setContext();
    });

    // Geospatial filter area. Dragging a handle reshapes it on the map, and
    // onAreaChange gets the result when the drag ends.
    let shown: Area | null = null;
    let dragging = false;
    const drawArea = (skip?: maplibregl.Marker) => {
      (map.getSource("area") as maplibregl.GeoJSONSource).setData(
        collection(shown ? [areaFeature(shown)] : []),
      );
      handles.forEach((handle) => {
        if (!shown) {
          handle.remove();
          return;
        }
        if (handle === skip) return;
        const [west, south, east, north] = shown;
        const corner = handles.indexOf(handle);
        handle.setLngLat(
          corner < 4
            ? [shown[AREA_CORNERS[corner][0]], shown[AREA_CORNERS[corner][1]]]
            : [(west + east) / 2, (south + north) / 2],
        );
        if (!handle.getElement().isConnected) handle.addTo(map);
      });
    };
    const reshape = (handle: maplibregl.Marker) => {
      if (!shown) return;
      const { lng, lat } = handle.getLngLat();
      const [west, south, east, north] = shown;
      const corner = handles.indexOf(handle);
      if (corner < 4) {
        const [lonIndex, latIndex] = AREA_CORNERS[corner];
        const next = [...shown] as Area;
        const lon = unwrapLon(lng, shown[lonIndex]);
        // Edges stop short of crossing the opposite ones.
        next[lonIndex] =
          lonIndex === 0
            ? Math.min(lon, east - AREA_MIN_DEGREES)
            : Math.max(lon, west + AREA_MIN_DEGREES);
        next[latIndex] =
          latIndex === 1
            ? Math.min(Math.max(lat, -90), north - AREA_MIN_DEGREES)
            : Math.max(Math.min(lat, 90), south + AREA_MIN_DEGREES);
        if (next[2] - next[0] > 360)
          next[lonIndex] = lonIndex === 0 ? next[2] - 360 : next[0] + 360;
        shown = next;
      } else {
        const dLon = unwrapLon(lng, (west + east) / 2) - (west + east) / 2;
        const dLat = Math.min(Math.max(lat - (south + north) / 2, -90 - south), 90 - north);
        shown = [west + dLon, south + dLat, east + dLon, north + dLat];
      }
      drawArea(handle);
    };
    const handles = [...AREA_CORNERS.map(() => "nwse-resize"), "move"].map((cursor) => {
      const element = document.createElement("div");
      element.dataset.areaHandle = "";
      element.style.cssText = `${areaHandleStyle()};cursor:${cursor}${cursor === "move" ? ";border-radius:50%" : ""}`;
      const handle = new maplibregl.Marker({ element, draggable: true, opacityWhenCovered: "0" });
      handle.on("dragstart", () => {
        dragging = true;
      });
      handle.on("drag", () => reshape(handle));
      handle.on("dragend", () => {
        dragging = false;
        reshape(handle);
        drawArea();
        if (!shown) return;
        // Stored with its west edge within ±180.
        const shift = shown[0] >= 180 ? -360 : shown[0] < -180 ? 360 : 0;
        shown = [shown[0] + shift, shown[1], shown[2] + shift, shown[3]];
        areaRef.current.onAreaChange?.(shown);
      });
      return handle;
    });
    // An area about half the view across, around the ground in the middle of it.
    const viewArea = (): Area => {
      const { width, height } = map.transform;
      const middle = map.unproject([width / 2, height / 2]);
      const metresPerPixel = middle.distanceTo(map.unproject([width / 2, height / 2 + 50])) / 50;
      const half = Math.min((metresPerPixel * Math.min(width, height)) / 4 / 111195, 45);
      const [south, north] = [Math.max(middle.lat - half, -90), Math.min(middle.lat + half, 90)];
      const halfLon = Math.min(half / Math.max(Math.cos((middle.lat * Math.PI) / 180), 1e-6), 180);
      return [middle.lng - halfLon, south, middle.lng + halfLon, north];
    };
    const syncArea = () => {
      if (dragging) return;
      const { area, requestArea } = areaRef.current;
      if (!area && requestArea) {
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
      canvas.style.cursor = members ? "pointer" : "";
      if (members) tooltip.show(markerTooltip(members), e.point.x, e.point.y);
      else tooltip.scheduleHide();
    });
    map.on("movestart", tooltip.hide);
    map.on("moveend", showBoxes);
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
      for (const marker of markers) marker.remove();
      for (const handle of handles) handle.remove();
      map.remove();
    };
  }, [mode]);

  useEffect(() => {
    pointsRef.current = { points, index: colocatedIndex(points) };
    setPointsRef.current?.();
  }, [points]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the area by value; the sync reads it from areaRef
  useEffect(() => {
    syncAreaRef.current?.();
  }, [area?.join(), requestArea]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: context reaches the map through contextRef
  useEffect(() => {
    setContextRef.current?.();
  }, [context]);

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
