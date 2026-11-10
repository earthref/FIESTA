// Types of the pmag-plots API (plugin.py, beside this file) and the plots'
// labels. PmagPy computes every position in the API; the plots only draw.

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

/** NRM, alternating field, thermal, microwave (energy, in J). */
export type StepKind = "NRM" | "AF" | "T" | "MW";

// --- geometry, as the API computes it (PmagPy) ---------------------------------------------

/** A position on the equal-area net (pmag.dimap): x east, y north, radius 1. */
export type XY = [number, number];

/** Part of a circle on one hemisphere: solid on the lower, dashed on the upper. */
export interface Run {
  lower: boolean;
  points: XY[];
}

/** The net as pmagplotlib.plot_net draws it: the rim and its tick strokes. */
export interface Net {
  rim: XY[];
  ticks: XY[][];
}

export interface Fit {
  coord: Coord;
  type: "line" | "plane" | "mean";
  dec: number;
  inc: number;
  min: number | null;
  max: number | null;
  comp: string;
  mad: number | null;
  /** A line's or mean's position on the net. */
  xy?: XY;
  /** A plane's great circle. */
  circle?: Run[];
  /** A line's Zijderveld line: two (north, east, down) ends, over the NRM. */
  zijd?: [number, number, number][];
}

/** A specimen's steps in one coordinate system. */
export interface StepCoords {
  dec: number[];
  inc: number[];
  /** Equal-area positions. */
  x: number[];
  y: number[];
  /** North, east and down components over the NRM (pmag.dir2cart). */
  n: number[];
  e: number[];
  d: number[];
}

export interface DemagSpecimen extends Where {
  unit: string;
  steps: {
    kind: StepKind[];
    value: (number | null)[];
    m: number[];
    bad: number[];
  };
  coords: Partial<Record<Coord, StepCoords>>;
  fits: Fit[];
}

export interface Direction {
  name: string;
  dec: number;
  inc: number;
  a95?: number;
  plane?: boolean;
  comp?: string;
  /** A line's position on the net, */
  xy?: XY;
  /** or a plane's great circle. */
  circle?: Run[];
}

export interface FisherMean {
  dec: number;
  inc: number;
  n: number;
  r: number;
  k?: number;
  a95?: number;
  xy: XY;
  /** The α95 circle. */
  circle?: Run[];
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
    /** pmag.int_pars over the interpretation's steps (three or more). */
    n?: number;
    b?: number;
    b_sigma?: number;
    f?: number;
    g?: number;
    q?: number;
    /** The fitted line's ends. */
    line?: XY[];
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
  demag: { net: Net; specimens: DemagSpecimen[] };
  eqarea: { net: Net; plots: EqAreaGroup[] };
  arai: { specimens: AraiSpecimen[] };
  hyst: { loops: HystLoop[] };
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
  if (kind === "MW") return `${nf(value)} J`;
  return `${nf(value)} °C`;
}

export function whereOf(item: Where): string {
  return [item.sample, item.site, item.location]
    .filter((name, index, names) => name && names.indexOf(name) === index)
    .join(" · ");
}
