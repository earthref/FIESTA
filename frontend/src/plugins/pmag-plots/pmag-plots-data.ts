// Types of the pmag-plots API (backend/fiesta/plugins/pmag_plots.py) and the
// geometry the plots share.

export type PlotType = "eqarea" | "zijd" | "demag" | "arai" | "deremag" | "hyst";
/** The API's data kinds; several plot types draw from one. */
export type Kind = "demag" | "eqarea" | "arai" | "hyst";

/** Each plot type's tab (key, label) and the data it draws. */
export const PLOTS: Record<PlotType, { key: string; label: string; kind: Kind }> = {
  eqarea: { key: "equal-area", label: "Equal Area", kind: "eqarea" },
  zijd: { key: "zijderveld", label: "Zijderveld", kind: "demag" },
  demag: { key: "demagnetization", label: "Demagnetization", kind: "demag" },
  arai: { key: "arai", label: "Arai", kind: "arai" },
  deremag: {
    key: "deremagnetization",
    label: "Deremagnetization",
    kind: "arai",
  },
  hyst: { key: "hysteresis", label: "Hysteresis", kind: "hyst" },
};

/** Coordinate systems: specimen, geographic, tilt-corrected. */
export type Coord = "s" | "g" | "t";
export const COORDS: Coord[] = ["g", "t", "s"];
export const COORD_LABELS: Record<Coord, string> = {
  s: "Specimen",
  g: "Geographic",
  t: "Tilt-corrected",
};

export interface Where {
  specimen: string;
  sample: string;
  site: string;
  location: string;
}

export type StepKind = "NRM" | "AF" | "T" | "MW" | "LT";

export interface Fit {
  coord: Coord;
  type: "line" | "plane" | "mean";
  dec: number;
  inc: number;
  min: number | null;
  max: number | null;
  comp: string;
  mad: number | null;
}

export interface Directions {
  dec: number[];
  inc: number[];
}

export interface DemagSpecimen extends Where {
  unit: string;
  steps: Directions & {
    kind: StepKind[];
    value: (number | null)[];
    m: number[];
    bad: number[];
  };
  geo?: Directions;
  tilt?: Directions;
  fits: Fit[];
}

export interface Direction {
  name: string;
  dec: number;
  inc: number;
  a95?: number;
  plane?: boolean;
  comp?: string;
}

export interface FisherMean {
  dec: number;
  inc: number;
  n: number;
  r: number;
  k?: number;
  a95?: number;
}

export interface DirectionSet {
  dirs: Direction[];
  mean?: FisherMean;
}

export interface EqAreaGroup {
  level: "Sites" | "Samples" | "Specimens";
  group_level: "location" | "site";
  name: string;
  sets: Partial<Record<Coord, DirectionSet>>;
}

export interface AraiSpecimen extends Where {
  unit: string;
  nrm0: number;
  lab_field: number | null;
  steps: {
    t: number[];
    x: number[];
    y: number[];
    order: ("NRM" | "ZI" | "IZ")[];
  };
  ptrm_checks: { t: number[]; t_from: number[]; x: number[]; y: number[] };
  tail_checks: { t: number[]; x: number[]; y: number[] };
  fit?: {
    min: number | null;
    max: number | null;
    int_abs: number | null;
    n?: number;
    b?: number;
    x_mean?: number;
    y_mean?: number;
    /** |b|·Blab times the published interpretation's correction factors. */
    int_calc?: number;
    corrections?: Partial<Record<"aniso" | "cooling_rate" | "nlt" | "arm", number>>;
  } | null;
}

export interface HystLoop extends Where {
  experiment: string;
  unit: string;
  field: number[];
  m: number[];
}

export interface PlotData {
  demag: { specimens: DemagSpecimen[] };
  eqarea: { plots: EqAreaGroup[] };
  arai: { specimens: AraiSpecimen[] };
  hyst: { loops: HystLoop[] };
}

// --- geometry ------------------------------------------------------------------------------

const RAD = Math.PI / 180;
type Vec = [number, number, number];

/** North, east, down components (pmag.dir2cart). */
export function dir2cart(dec: number, inc: number, m = 1): Vec {
  return [
    m * Math.cos(dec * RAD) * Math.cos(inc * RAD),
    m * Math.sin(dec * RAD) * Math.cos(inc * RAD),
    m * Math.sin(inc * RAD),
  ];
}

export function cart2dir([x, y, z]: Vec): [number, number] {
  const r = Math.hypot(x, y, z) || 1;
  return [(((Math.atan2(y, x) / RAD) % 360) + 360) % 360, Math.asin(z / r) / RAD];
}

/** Lambert equal-area position (pmag.dimap): radius 1 on the horizontal, 0 at
 * the vertical; upper-hemisphere directions plot at their own azimuth (drawn
 * open), as PmagPy's equal-area plots do. North is up. */
export function equalArea(dec: number, inc: number): [number, number] {
  const r = Math.sqrt(1 - Math.abs(Math.sin(inc * RAD)));
  return [r * Math.sin(dec * RAD), r * Math.cos(dec * RAD)];
}

const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec): Vec => {
  const n = Math.hypot(...a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** A small circle of `radius`° about a direction (90° gives the great circle
 * of a plane from its pole), as runs of projected points on one hemisphere. */
export function circleRuns(
  dec: number,
  inc: number,
  radius: number,
): { lower: boolean; points: [number, number][] }[] {
  const m = dir2cart(dec, inc);
  const u = unit(cross(m, Math.abs(m[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const v = cross(m, u);
  const [c, s] = [Math.cos(radius * RAD), Math.sin(radius * RAD)];
  const runs: { lower: boolean; points: [number, number][] }[] = [];
  for (let k = 0; k <= 180; k++) {
    const t = (k * 2 * Math.PI) / 180;
    const p: Vec = [0, 1, 2].map(
      (i) => c * m[i] + s * (Math.cos(t) * u[i] + Math.sin(t) * v[i]),
    ) as Vec;
    const [d, i] = cart2dir(p);
    const lower = i >= 0;
    const point = equalArea(d, i);
    const last = runs[runs.length - 1];
    if (last && last.lower === lower) last.points.push(point);
    else {
      // Start the new run where the last ended, so the circle stays joined.
      runs.push({
        lower,
        points: last ? [last.points[last.points.length - 1], point] : [point],
      });
    }
  }
  return runs;
}

// --- labels --------------------------------------------------------------------------------

export const nf = (value: number) =>
  Math.abs(value) >= 1e4 || (Math.abs(value) < 1e-2 && value !== 0)
    ? value.toExponential(2)
    : Number(value.toPrecision(3)).toString();

export function stepLabel(kind: StepKind, value: number | null): string {
  if (kind === "NRM") return "NRM";
  if (value === null) return kind;
  if (kind === "AF") return `${nf(value)} mT`;
  if (kind === "MW") return `${nf(value)} W`;
  return `${nf(value)} °C`;
}

/** A specimen's step directions in a coordinate system, if it has them. */
export function directionsIn(specimen: DemagSpecimen, coord: Coord): Directions | undefined {
  if (coord === "s") return specimen.steps;
  return coord === "g" ? specimen.geo : specimen.tilt;
}

export function whereOf(item: Where): string {
  return [item.sample, item.site, item.location]
    .filter((name, index, names) => name && names.indexOf(name) === index)
    .join(" · ");
}
