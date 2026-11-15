// Global field maps: the 37 x 72 grid (plugin.py /global) on a Mollweide
// canvas with contours, coastlines, graticule, sites and a colour bar
// (GEOMAGIA's mollweide.js, field-contours.js and global-maps.js drawMap).
import { COASTLINES as coastlines } from "./coastlines";

export interface GlobalFrame {
  model: string;
  year: number;
  nlat: number;
  nlon: number;
  coefficient_metadata: { interpolated_epochs: boolean };
  latitudes: number[];
  longitudes: number[];
  intensity: number[];
  decl: number[];
  incl: number[];
  delta_incl: number[];
  radial: number[];
  intensity_acceleration: number[];
  radial_acceleration: number[];
}

export type FieldKey =
  | "intensity"
  | "radial"
  | "intensity_acceleration"
  | "radial_acceleration"
  | "decl"
  | "incl"
  | "delta_incl";

export const FIELDS: {
  key: FieldKey;
  name: string;
  unit: string;
  group: "intensity" | "direction";
}[] = [
  { key: "intensity", name: "Surface intensity", unit: "µT", group: "intensity" },
  { key: "radial", name: "CMB radial field (positive outward)", unit: "mT", group: "intensity" },
  {
    key: "intensity_acceleration",
    name: "Surface intensity secular acceleration",
    unit: "nT/yr²",
    group: "intensity",
  },
  {
    key: "radial_acceleration",
    name: "CMB radial secular acceleration (outward)",
    unit: "nT/yr²",
    group: "intensity",
  },
  { key: "decl", name: "Surface declination", unit: "°", group: "direction" },
  { key: "incl", name: "Surface inclination", unit: "°", group: "direction" },
  { key: "delta_incl", name: "Surface ΔI relative to GAD", unit: "°", group: "direction" },
];

export const fieldInfo = (key: FieldKey) => FIELDS.find((f) => f.key === key) ?? FIELDS[0];
export const isAcceleration = (key: FieldKey) => key.endsWith("_acceleration");
export const isSigned = (key: FieldKey) => key === "radial" || isAcceleration(key);

// --- Mollweide --------------------------------------------------------------------------

const RAD = Math.PI / 180;

/** Unit Mollweide coordinates: x in -1..1 (times 2 for the ellipse), y in -1..1. */
export function project(latitude: number, longitude: number): [number, number] {
  const phi = latitude * RAD;
  let theta = phi;
  if (Math.abs(latitude) === 90) theta = (Math.sign(phi) * Math.PI) / 2;
  else
    for (let i = 0; i < 30; i++) {
      const delta =
        (2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(phi)) / (2 + 2 * Math.cos(2 * theta));
      theta -= delta;
      if (Math.abs(delta) < 1e-12) break;
    }
  return [(longitude / 180) * Math.cos(theta), Math.sin(theta)];
}

export function inverse(x: number, y: number): [number, number] | null {
  if (x * x + y * y > 1 + 1e-12 || Math.abs(y) > 1) return null;
  const theta = Math.asin(y);
  const cosine = Math.cos(theta);
  return [
    Math.asin(Math.max(-1, Math.min(1, (2 * theta + Math.sin(2 * theta)) / Math.PI))) / RAD,
    Math.abs(cosine) < 1e-12 ? 0 : (180 * x) / cosine,
  ];
}

interface Weights {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

function weights(frame: GlobalFrame, latitude: number, longitude: number): Weights {
  const row = Math.max(0, Math.min(frame.nlat - 1, ((latitude + 90) / 180) * (frame.nlat - 1)));
  const col = (((((longitude + 180) / 360) * frame.nlon) % frame.nlon) + frame.nlon) % frame.nlon;
  const lower = Math.min(frame.nlat - 2, Math.floor(row));
  const left = Math.floor(col);
  return {
    a: lower * frame.nlon + left,
    b: lower * frame.nlon + ((left + 1) % frame.nlon),
    tx: col - left,
    ty: row - lower,
  };
}

function interpolate(values: ArrayLike<number>, nlon: number, w: Weights): number {
  return (
    ((1 - w.tx) * values[w.a] + w.tx * values[w.b]) * (1 - w.ty) +
    ((1 - w.tx) * values[w.a + nlon] + w.tx * values[w.b + nlon]) * w.ty
  );
}

/** The field at a point: bilinear, declination through its sine and cosine. */
export function sample(
  frame: GlobalFrame,
  key: FieldKey,
  latitude: number,
  longitude: number,
): number {
  const w = weights(frame, latitude, longitude);
  if (key !== "decl") return interpolate(frame[key], frame.nlon, w);
  const sine = interpolate(
    frame.decl.map((v) => Math.sin(v * RAD)),
    frame.nlon,
    w,
  );
  const cosine = interpolate(
    frame.decl.map((v) => Math.cos(v * RAD)),
    frame.nlon,
    w,
  );
  return Math.atan2(sine, cosine) / RAD;
}

// --- Colours ----------------------------------------------------------------------------

export type ColorTable = [number, number, number][];

function colorTable(stops: string[]): ColorTable {
  const rgb = stops.map((c) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16)));
  return Array.from({ length: 256 }, (_, index) => {
    const scaled = (index / 255) * (rgb.length - 1);
    const left = Math.min(rgb.length - 2, Math.floor(scaled));
    const t = scaled - left;
    return rgb[left].map((v, ch) => Math.round(v * (1 - t) + rgb[left + 1][ch] * t)) as [
      number,
      number,
      number,
    ];
  });
}

const DIVERGING = colorTable([
  "#183b86",
  "#719dd2",
  "#d7e8f4",
  "#ffffff",
  "#f7d1b5",
  "#d76b45",
  "#8d1728",
]);
const RADIAL = colorTable([
  "#2d004b",
  "#542788",
  "#8073ac",
  "#b2abd2",
  "#d8daeb",
  "#f7f7f7",
  "#fee0b6",
  "#fdb863",
  "#e08214",
  "#b35806",
  "#7f3b08",
]);
export const PALETTES: Record<FieldKey, ColorTable> = {
  intensity: colorTable([
    "#000000",
    "#1111bb",
    "#0066ff",
    "#00eaff",
    "#4fff72",
    "#ffff00",
    "#ffb000",
    "#ff5000",
    "#ff134b",
    "#ff00d9",
  ]),
  radial: RADIAL,
  intensity_acceleration: RADIAL,
  radial_acceleration: RADIAL,
  decl: DIVERGING,
  incl: DIVERGING,
  delta_incl: DIVERGING,
};

/** GEOMAGIA's default colour limits for a field. */
export function defaultLimits(frame: GlobalFrame, key: FieldKey): [number, number] {
  const values = frame[key];
  if (key === "decl" || key === "delta_incl") return [-45, 45];
  if (key === "incl") return [-90, 90];
  if (isAcceleration(key)) {
    const magnitude = Math.max(...values.map(Math.abs));
    const step = magnitude > 0 ? 10 ** Math.floor(Math.log10(magnitude)) : 1;
    const bound = magnitude > 0 ? Math.ceil(magnitude / step) * step : 1;
    return [-bound, bound];
  }
  if (key === "radial") {
    const bound = Math.max(1, Math.ceil(Math.max(...values.map(Math.abs)) * 10) / 10);
    return [-bound, bound];
  }
  return [Math.floor(Math.min(...values) / 5) * 5, Math.ceil(Math.max(...values) / 5) * 5];
}

// --- Contours ---------------------------------------------------------------------------

export function contourLevels(
  key: FieldKey,
  minimum: number,
  maximum: number,
): { step: number; levels: number[] } {
  if (key === "decl") return { step: 5, levels: Array.from({ length: 17 }, (_, i) => -40 + i * 5) };
  if (key === "incl")
    return { step: 15, levels: Array.from({ length: 11 }, (_, i) => -75 + i * 15) };
  let step = key === "radial" ? 0.1 : 5;
  if (isAcceleration(key)) {
    const target = Math.max(1e-12, (maximum - minimum) / 12);
    const power = 10 ** Math.floor(Math.log10(target));
    step = ([1, 2, 5, 10].find((f) => f * power >= target) ?? 10) * power;
  }
  const levels: number[] = [];
  const first = (Math.floor(minimum / step) + 1) * step;
  for (let i = 0; i < 4096; i++) {
    const value = first + i * step;
    if (value >= maximum - step * 1e-9) break;
    const rounded = Number(value.toPrecision(12));
    if (
      rounded > minimum &&
      rounded < maximum &&
      (!levels.length || rounded > levels[levels.length - 1])
    )
      levels.push(rounded);
  }
  return { step: Number(step.toPrecision(12)), levels };
}

type Point = [number, number]; // lon, lat

/** Marching squares over the grid (declination by circular difference;
 * saddles by the bilinear asymptotic decider), as [lon, lat] segments. */
export function contourSegments(
  frame: GlobalFrame,
  key: FieldKey,
  levels: number[],
): [Point, Point][] {
  const values = frame[key];
  const lines: [Point, Point][] = [];
  const latStep = 180 / (frame.nlat - 1);
  const lonStep = 360 / frame.nlon;
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ];
  for (const level of levels) {
    const difference =
      key === "decl"
        ? values.map((v) => Math.sin((v - level) * RAD))
        : values.map((v) => v - level);
    const cosine = key === "decl" ? values.map((v) => Math.cos((v - level) * RAD)) : null;
    for (let row = 0; row < frame.nlat - 1; row++)
      for (let col = 0; col < frame.nlon; col++) {
        const next = (col + 1) % frame.nlon;
        const a = row * frame.nlon + col;
        const b = row * frame.nlon + next;
        const c = b + frame.nlon;
        const dIndex = a + frame.nlon;
        const d = [difference[a], difference[b], difference[c], difference[dIndex]];
        if (!d.every(Number.isFinite) || d.every((v) => v >= 0) || d.every((v) => v < 0)) continue;
        const indices = [a, b, c, dIndex];
        const lon = -180 + col * lonStep;
        const lat = -90 + row * latStep;
        const corners: Point[] = [
          [lon, lat],
          [lon + lonStep, lat],
          [lon + lonStep, lat + latStep],
          [lon, lat + latStep],
        ];
        const crossings = new Map<number, Point>();
        edges.forEach(([p, q], edge) => {
          if (d[p] >= 0 === d[q] >= 0) return;
          const t = d[p] / (d[p] - d[q]);
          if (cosine && cosine[indices[p]] * (1 - t) + cosine[indices[q]] * t <= 1e-10) return;
          crossings.set(edge, [
            corners[p][0] * (1 - t) + corners[q][0] * t,
            corners[p][1] * (1 - t) + corners[q][1] * t,
          ]);
        });
        if (crossings.size === 2) lines.push([...crossings.values()] as [Point, Point]);
        else if (crossings.size === 4) {
          const determinant = d[0] * d[2] - d[1] * d[3];
          const pairs =
            determinant >= 0
              ? [
                  [0, 1],
                  [2, 3],
                ]
              : [
                  [0, 3],
                  [1, 2],
                ];
          for (const [p, q] of pairs)
            lines.push([crossings.get(p) as Point, crossings.get(q) as Point]);
        }
      }
  }
  return lines;
}

// --- Drawing ------------------------------------------------------------------------------

export const CANVAS = { width: 1200, height: 760 };
const BOX = { x: 40, y: 75, width: 1120, height: 560 };

export interface MapColors {
  background: string;
  title: string;
  text: string;
  outline: string;
  coast: string;
}

export const LIGHT_MAP: MapColors = {
  background: "#ffffff",
  title: "#17365d",
  text: "#263447",
  outline: "#576575",
  coast: "#161616",
};

function point(latitude: number, longitude: number): [number, number] {
  const [x, y] = project(latitude, longitude);
  return [BOX.x + ((x + 1) * BOX.width) / 2, BOX.y + ((1 - y) * BOX.height) / 2];
}

function linesPath(lines: Point[][]): Path2D {
  const path = new Path2D();
  for (const coordinates of lines) {
    let previous: Point | null = null;
    for (const [lon, lat] of coordinates) {
      const [x, y] = point(lat, lon);
      if (!previous || Math.abs(lon - previous[0]) > 180) path.moveTo(x, y);
      else path.lineTo(x, y);
      previous = [lon, lat];
    }
  }
  return path;
}

let coastPath: Path2D | null = null;
let gridPath: Path2D | null = null;
const geometries = new Map<string, Weights[] | null[]>();

function gridWeights(frame: GlobalFrame, width: number, height: number): (Weights | null)[] {
  const id = `${frame.nlat}x${frame.nlon}:${width}`;
  const cached = geometries.get(id);
  if (cached) return cached;
  const out: (Weights | null)[] = new Array(width * height).fill(null);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      const c = inverse(((col + 0.5) / width) * 2 - 1, 1 - ((row + 0.5) / height) * 2);
      if (c) out[row * width + col] = weights(frame, c[0], c[1]);
    }
  geometries.set(id, out as Weights[]);
  return out;
}

const formatYear = (v: number) =>
  Number(v.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });

export interface DrawOptions {
  key: FieldKey;
  limits: [number, number];
  sites: [number, number][];
  colors: MapColors;
  fast?: boolean;
}

/** Paint one frame on a 1200 x 760 canvas; returns the contour step. */
export function drawMap(canvas: HTMLCanvasElement, frame: GlobalFrame, o: DrawOptions): number {
  const context = canvas.getContext("2d");
  if (!context) return 0;
  const { key } = o;
  const [low, high] = o.limits;
  const values = frame[key];
  const colours = PALETTES[key];
  const scale = o.fast ? 2 : 1;
  const width = BOX.width / scale;
  const height = BOX.height / scale;
  const g = gridWeights(frame, width, height);
  const raster = document.createElement("canvas");
  raster.width = width;
  raster.height = height;
  const rctx = raster.getContext("2d");
  if (!rctx) return 0;
  const image = rctx.createImageData(width, height);
  const sine = key === "decl" ? values.map((v) => Math.sin(v * RAD)) : null;
  const cosine = key === "decl" ? values.map((v) => Math.cos(v * RAD)) : null;
  const bg = hexRgb(o.colors.background);
  for (let i = 0; i < g.length; i++) {
    const offset = i * 4;
    const w = g[i];
    if (!w) {
      image.data[offset] = bg[0];
      image.data[offset + 1] = bg[1];
      image.data[offset + 2] = bg[2];
      image.data[offset + 3] = 255;
      continue;
    }
    const value =
      sine && cosine
        ? Math.atan2(interpolate(sine, frame.nlon, w), interpolate(cosine, frame.nlon, w)) / RAD
        : interpolate(values, frame.nlon, w);
    const rgb =
      colours[Math.max(0, Math.min(255, Math.round(((value - low) / (high - low)) * 255)))];
    image.data[offset] = rgb[0];
    image.data[offset + 1] = rgb[1];
    image.data[offset + 2] = rgb[2];
    image.data[offset + 3] = 255;
  }
  rctx.putImageData(image, 0, 0);
  context.fillStyle = o.colors.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.drawImage(raster, BOX.x, BOX.y, BOX.width, BOX.height);
  context.save();
  context.beginPath();
  context.ellipse(600, BOX.y + BOX.height / 2, BOX.width / 2, BOX.height / 2, 0, 0, Math.PI * 2);
  context.clip();
  const config = contourLevels(
    key,
    isAcceleration(key) ? low : Math.max(low, Math.min(...values)),
    isAcceleration(key) ? high : Math.min(high, Math.max(...values)),
  );
  const contour = new Path2D();
  for (const [start, end] of contourSegments(frame, key, config.levels)) {
    const steps = Math.max(Math.abs(start[1]), Math.abs(end[1])) > 75 ? 4 : 2;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const [x, y] = point(start[1] + f * (end[1] - start[1]), start[0] + f * (end[0] - start[0]));
      if (i === 0) contour.moveTo(x, y);
      else contour.lineTo(x, y);
    }
  }
  context.setLineDash([]);
  context.lineJoin = "round";
  context.lineCap = "round";
  if (key === "intensity" || isSigned(key)) {
    context.strokeStyle = "rgba(46,56,70,0.18)";
    context.lineWidth = 1.3;
    context.stroke(contour);
    context.strokeStyle = "rgba(255,255,255,0.56)";
    context.lineWidth = 0.65;
  } else {
    context.strokeStyle = "rgba(45,55,70,0.30)";
    context.lineWidth = 0.65;
  }
  context.stroke(contour);
  if (!gridPath) {
    const lines: Point[][] = [];
    for (const lat of [-60, -30, 0, 30, 60])
      lines.push(Array.from({ length: 181 }, (_, i) => [-180 + i * 2, lat]));
    for (const lon of [-120, -60, 0, 60, 120])
      lines.push(Array.from({ length: 91 }, (_, i) => [lon, -90 + i * 2]));
    gridPath = linesPath(lines);
  }
  context.strokeStyle = "rgba(0,0,0,0.4)";
  context.lineWidth = 0.7;
  context.setLineDash([2, 4]);
  context.stroke(gridPath);
  context.setLineDash([]);
  if (!coastPath) coastPath = linesPath(coastlines as Point[][]);
  context.strokeStyle = o.colors.coast;
  context.lineWidth = 0.8;
  context.stroke(coastPath);
  context.fillStyle = "black";
  context.strokeStyle = "white";
  context.lineWidth = 0.65;
  for (const [lat, lon] of o.sites) {
    const [x, y] = point(lat, lon);
    context.beginPath();
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
  context.strokeStyle = o.colors.outline;
  context.lineWidth = 1;
  context.beginPath();
  context.ellipse(600, BOX.y + BOX.height / 2, BOX.width / 2, BOX.height / 2, 0, 0, Math.PI * 2);
  context.stroke();
  const info = fieldInfo(key);
  context.fillStyle = o.colors.title;
  context.font = "bold 22px Arial";
  context.textAlign = "center";
  context.fillText(`${frame.model} · ${info.name} · Year ${formatYear(frame.year)}`, 600, 30);
  context.font = "16px Arial";
  context.fillText(
    (key.startsWith("radial") ? "Core–mantle boundary · r = 3,480 km" : "Earth's surface") +
      (frame.coefficient_metadata.interpolated_epochs ? " · cubic-interpolated epochs" : ""),
    600,
    56,
  );
  const left = 200;
  const top = 672;
  const barWidth = 800;
  for (let i = 0; i < 256; i++) {
    context.fillStyle = `rgb(${colours[i].join(",")})`;
    context.fillRect(left + (i / 256) * barWidth, top, barWidth / 256 + 1, 16);
  }
  context.strokeStyle = o.colors.outline;
  context.strokeRect(left, top, barWidth, 16);
  context.font = "16px Arial";
  context.fillStyle = o.colors.text;
  for (let i = 0; i <= 4; i++) {
    const value = low + ((high - low) * i) / 4;
    const label = isAcceleration(key)
      ? Number(value.toPrecision(4))
      : Number(value.toFixed(key === "radial" ? 3 : 2));
    context.fillText(String(label), left + (i / 4) * barWidth, 715);
  }
  context.fillText(
    `${info.name} (${info.unit}) · Contours every ${config.step} ${info.unit}`,
    600,
    744,
  );
  return config.step;
}

function hexRgb(color: string): [number, number, number] {
  if (color.startsWith("#") && color.length === 7) {
    return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  return [255, 255, 255];
}

/** The map point under canvas pixel (x, y), or null outside the ellipse. */
export function canvasToLatLon(x: number, y: number): [number, number] | null {
  return inverse(((x - BOX.x) / BOX.width) * 2 - 1, 1 - ((y - BOX.y) / BOX.height) * 2);
}
