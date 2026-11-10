// The Rock Magnetism view's data: the `rock_mag` docs' numeric parameters
// (summary.rock_mag, derived by the backend `rock-mag` plugin: fields in mT,
// temperatures in °C), fetched as columns through GET /search/rock_mag/values.

export type ParamKey =
  | "mr_ms"
  | "bcr_bc"
  | "bc"
  | "bcr"
  | "ms"
  | "mr"
  | "chi_mass"
  | "chi_volume"
  | "chi_fd"
  | "tc"
  | "s_ratio"
  | "mdf"
  | "p"
  | "pj"
  | "t"
  | "l"
  | "f"
  | "v1_dec"
  | "v1_inc"
  | "v3_dec"
  | "v3_inc";

export interface Param {
  key: ParamKey;
  label: string;
  unit?: string;
  /** Spans orders of magnitude: plotted on a log axis by default. */
  log?: boolean;
}

/** The parameters offered in the distribution and explorer panels. */
export const PARAMS: Param[] = [
  { key: "mr_ms", label: "Mr/Ms" },
  { key: "bcr_bc", label: "Bcr/Bc" },
  { key: "bc", label: "Bc", unit: "mT", log: true },
  { key: "bcr", label: "Bcr", unit: "mT", log: true },
  { key: "ms", label: "Ms", unit: "Am²/kg", log: true },
  { key: "mr", label: "Mr", unit: "Am²/kg", log: true },
  { key: "chi_mass", label: "χ (mass)", unit: "m³/kg", log: true },
  { key: "chi_volume", label: "κ (volume)", unit: "SI", log: true },
  { key: "chi_fd", label: "χfd" },
  { key: "tc", label: "Critical temperature", unit: "°C" },
  { key: "s_ratio", label: "S-ratio" },
  { key: "mdf", label: "MDF", unit: "mT", log: true },
  { key: "p", label: "P (k1/k3)" },
  { key: "pj", label: "P′" },
  { key: "t", label: "T" },
  { key: "l", label: "L (k1/k2)" },
  { key: "f", label: "F (k2/k3)" },
];

export const paramOf = (key: ParamKey) => PARAMS.find((p) => p.key === key) as Param;
export const axisName = (p: Param) => (p.unit ? `${p.label} (${p.unit})` : p.label);

const NUMERIC: ParamKey[] = [...PARAMS.map((p) => p.key), "v1_dec", "v1_inc", "v3_dec", "v3_inc"];

// What a row holds besides the numbers, and the summary paths they come from.
const TEXT = {
  contribution: "summary.contribution.id",
  specimen: "summary.specimens.specimen",
  lithology: "summary._all.lithologies",
  geologicClass: "summary._all.geologic_classes",
  geologicType: "summary._all.geologic_types",
  tcType: "summary.specimens.critical_temp_type",
  anisoType: "summary.specimens.aniso_type",
} as const;
type TextKey = keyof typeof TEXT;

export const VALUE_FIELDS = [
  ...Object.values(TEXT),
  ...NUMERIC.map((key) => `summary.rock_mag.${key}`),
];

export type Specimen = { [K in ParamKey]?: number } & { [K in TextKey]?: string } & {
  /** Its index in the fetched rows. */
  index: number;
};

export interface SearchValues {
  total: number;
  fields: string[];
  rows: (number | string | null)[][];
  truncated?: boolean;
}

export function specimensFrom(page: SearchValues): Specimen[] {
  const position = new Map(page.fields.map((field, i) => [field, i]));
  const textAt = (Object.entries(TEXT) as [TextKey, string][]).map(
    ([key, field]) => [key, position.get(field)] as const,
  );
  const numberAt = NUMERIC.map((key) => [key, position.get(`summary.rock_mag.${key}`)] as const);
  return page.rows.map((row, index) => {
    const specimen: Specimen = { index };
    for (const [key, i] of textAt) {
      const value = i === undefined ? null : row[i];
      if (value !== null && value !== "") specimen[key] = String(value);
    }
    for (const [key, i] of numberAt) {
      const value = i === undefined ? null : Number(row[i]);
      if (value !== null && row[i as number] !== null && Number.isFinite(value))
        specimen[key] = value;
    }
    return specimen;
  });
}

// --- Colour groups -----------------------------------------------------------------

export type ColorBy = "none" | "lithology" | "geologicClass" | "geologicType" | "tcType";
export const COLOR_BY: [ColorBy, string][] = [
  ["none", "None"],
  ["lithology", "Lithology"],
  ["geologicClass", "Geologic class"],
  ["geologicType", "Geologic type"],
  ["tcType", "Transition type"],
];

// Categorical slots 1–3 (they stay distinguishable to colour-blind readers
// as a set on a scatter); every other group folds into a neutral "Other".
export const SLOTS = ["#2a78d6", "#eb6834", "#1baf7a"];
export const OTHER_COLOR = "#9a9a96";
export const MAX_GROUPS = SLOTS.length;

export interface Group {
  name: string;
  color: string;
  members: Specimen[];
}

/** The specimens in colour groups: the most common values of `by` (up to
 * three), then the rest as "Other" (and "Not given" folds in there too). */
export function groupSpecimens(specimens: Specimen[], by: ColorBy): Group[] {
  if (by === "none") return [{ name: "Specimens", color: SLOTS[0], members: specimens }];
  const counts = new Map<string, number>();
  for (const s of specimens) {
    const value = s[by];
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_GROUPS)
    .map(([name]) => name);
  const groups: Group[] = top.map((name, i) => ({ name, color: SLOTS[i], members: [] }));
  const other: Group = { name: "Other", color: OTHER_COLOR, members: [] };
  for (const s of specimens) {
    const i = top.indexOf(s[by] ?? "");
    (i >= 0 ? groups[i] : other).members.push(s);
  }
  return other.members.length ? [...groups, other] : groups;
}

// --- Science references --------------------------------------------------------------

/** Day et al. (1977) domain-state boundaries. */
export const DAY_BOUNDARIES = { mrMs: [0.05, 0.5], bcrBc: [1.5, 4] };

/** Theoretical Mr/Ms of non-interacting single-domain grains (Néel 1955;
 * Tauxe et al. 2002): uniaxial and cubic (magnetocrystalline, K1 < 0). */
export const SD_SQUARENESS = [
  { value: 0.5, label: "Uniaxial SD" },
  { value: 0.866, label: "Cubic SD" },
];

/** Characteristic transition temperatures (°C) of common magnetic minerals. */
export const TRANSITIONS = [
  { value: -153, label: "Verwey (magnetite)" },
  { value: -13, label: "Morin (hematite)" },
  { value: 120, label: "Goethite" },
  { value: 320, label: "Pyrrhotite" },
  { value: 580, label: "Magnetite" },
  { value: 675, label: "Hematite" },
];

/** A quantile of sorted values. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Lower-hemisphere equal-area (Schmidt) projection of an axis, in unit-circle
 * coordinates (x east, y north); axes are undirected, so an upward one is
 * plotted as its lower-hemisphere opposite. */
export function equalArea(dec: number, inc: number): [number, number] {
  let [d, i] = [dec, inc];
  if (i < 0) [d, i] = [d + 180, -i];
  const rad = Math.PI / 180;
  const r = Math.sqrt(1 - Math.sin(i * rad));
  return [r * Math.sin(d * rad), r * Math.cos(d * rad)];
}

// --- CSV -----------------------------------------------------------------------------

const CSV_COLUMNS: [string, (s: Specimen) => unknown][] = [
  ["contribution", (s) => s.contribution],
  ["specimen", (s) => s.specimen],
  ["lithology", (s) => s.lithology],
  ["geologic_class", (s) => s.geologicClass],
  ["geologic_type", (s) => s.geologicType],
  ...NUMERIC.map((key) => [key, (s: Specimen) => s[key]] as [string, (s: Specimen) => unknown]),
];

export function specimensCsv(specimens: Specimen[]): string {
  const cell = (value: unknown) => {
    if (value === undefined || value === null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    CSV_COLUMNS.map(([name]) => name).join(","),
    ...specimens.map((s) => CSV_COLUMNS.map(([, get]) => cell(get(s))).join(",")),
  ].join("\n");
}
