// The Plots view's data: the level's matching records' columns (the plugin's
// options name them), fetched as rows through GET /search/{table}/values and
// turned into plottable records as the GEOMAGIA site's plot_data.py does.
import type { NodeConfig } from "@/lib/types";

export interface MethodFamily {
  name: string;
  methods: string[];
}

/** The backend plugin's options (frontend_config), with the level's table. */
export interface SeriesOptions {
  base_level: string | null;
  table: string | null;
  age: string;
  age_minus: string | null;
  age_plus: string | null;
  age_error_type: string | null;
  age_sigmas: string | null;
  age_label: string;
  age_unit: string;
  intensity: string | null;
  intensity_error: string | null;
  intensity_unit: string;
  vadm: string | null;
  vadm_error: string | null;
  declination: string | null;
  inclination: string | null;
  alpha95: string | null;
  latitude: string | null;
  color_by: string | null;
  hover: string[];
  export_name: string;
  name_search: string | null;
  name_search_label: string;
  radius_search: boolean;
}

export function seriesOptions(config: NodeConfig): SeriesOptions | null {
  const raw = config.plugins["geomag-series"] as Partial<SeriesOptions> | undefined;
  if (!raw?.base_level || !raw.table) return null;
  return raw as SeriesOptions;
}

export interface SearchValues {
  total: number;
  fields: string[];
  rows: (number | string | null)[][];
  truncated?: boolean;
}

/** One plotted record (the site's `prepare_plot_data` record). */
export interface SeriesRecord {
  index: number;
  contribution?: string;
  age: number;
  /** Age errors toward older / younger ages, null when not reported. */
  ageMinus: number | null;
  agePlus: number | null;
  ba: number | null;
  sigmaBa: number | null;
  vadm: number | null;
  sigmaVadm: number | null;
  /** Declination as −180..180. */
  decl: number | null;
  incl: number | null;
  alpha95: number | null;
  group: string;
  ageErrorType: string | null;
  sigmas: number | null;
  /** The `hover` columns' values, in order. */
  hover: (string | null)[];
}

export interface ColorGroup {
  key: string;
  name: string;
  color: string;
}

export type Component = "ba" | "vadm" | "decl" | "incl";

export interface SeriesData {
  records: SeriesRecord[];
  groups: ColorGroup[];
  counts: Record<Component, number>;
  /** Records left out for an unknown age. */
  omitted: number;
  /** The ages' extent with their error bars, null without records. */
  ageRange: [number, number] | null;
}

/** The site's colour for a record without a colour id. */
export const UNKNOWN_COLOR = "#718096";
/** Earth's reference radius for the VADM (m), as GEOMAGIA's. */
const VADM_EARTH_RADIUS_M = 6_371_200;

/** A stable 32-bit number for a colour value (FNV-1a over its code points). */
export function colorHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash;
}

/** A colour value's hue (its hash the golden angle apart, stable across
 * searches) and one of three lightnesses, as the GEOMAGIA site's region
 * colours (which use the region's id where this uses its name's hash). */
export function groupColor(value: string | null): string {
  if (value === null || value === "") return UNKNOWN_COLOR;
  const id = colorHash(value);
  const hue = (id * 137.508) % 360;
  const lightness = 38 + (id % 3) * 6;
  return `hsl(${hue.toFixed(2)}, 65%, ${lightness}%)`;
}

/** VADM and its error (10²² A·m²) from an intensity (µT) at a site latitude. */
export function vadmOf(
  intensity: number | null,
  error: number | null,
  latitude: number | null,
): [number | null, number | null] {
  if (intensity === null || intensity < 0 || latitude === null || Math.abs(latitude) > 90) {
    return [null, null];
  }
  const s = Math.sin((latitude * Math.PI) / 180);
  const factor = (10 * VADM_EARTH_RADIUS_M ** 3) / 1e22 / Math.sqrt(1 + 3 * s * s);
  return [intensity * factor, error !== null && error >= 0 ? error * factor : null];
}

/** A declination as −180..180 (350 → −10), as the site's signed_declination;
 * outside ±360 (the legacy 999 for none) it is none. */
export function signedDeclination(value: number | null): number | null {
  if (value === null || value < -360 || value > 360) return null;
  return value > 180 ? Number((value - 360).toFixed(10)) : value;
}

const asNumber = (value: unknown, min?: number, max?: number): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
};
const asText = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);

/** A column of the level's table, or a summary path as it is. */
export const fieldPath = (table: string, column: string) =>
  column.startsWith("summary.") ? column : `summary.${table}.${column}`;

export const CONTRIBUTION_FIELD = "summary.contribution.id";

/** The fields the view fetches, in order (duplicates once). */
export function valueFields(options: SeriesOptions): string[] {
  const table = options.table ?? "";
  const columns = [
    options.age,
    options.age_minus,
    options.age_plus,
    options.age_error_type,
    options.age_sigmas,
    options.intensity,
    options.intensity_error,
    options.vadm,
    options.vadm_error,
    options.declination,
    options.inclination,
    options.alpha95,
    options.latitude,
    options.color_by,
    ...options.hover,
  ].filter((c): c is string => !!c);
  return [...new Set([CONTRIBUTION_FIELD, ...columns.map((c) => fieldPath(table, c))])];
}

/** The plottable records: a known age and an intensity, declination or
 * inclination; coloured by the colour id. */
export function seriesFrom(page: SearchValues, options: SeriesOptions): SeriesData {
  const table = options.table ?? "";
  const at = new Map(page.fields.map((field, i) => [field, i]));
  const reader = (column: string | null) => {
    const i = column ? at.get(fieldPath(table, column)) : undefined;
    return (row: (number | string | null)[]) => (i === undefined ? null : row[i]);
  };
  const read = {
    contribution: reader(CONTRIBUTION_FIELD),
    age: reader(options.age),
    ageMinus: reader(options.age_minus),
    agePlus: reader(options.age_plus),
    ageErrorType: reader(options.age_error_type),
    sigmas: reader(options.age_sigmas),
    ba: reader(options.intensity),
    sigmaBa: reader(options.intensity_error),
    vadm: reader(options.vadm),
    sigmaVadm: reader(options.vadm_error),
    decl: reader(options.declination),
    incl: reader(options.inclination),
    alpha95: reader(options.alpha95),
    lat: reader(options.latitude),
    colorBy: reader(options.color_by),
  };
  const hover = options.hover.map((column) => reader(column));
  const records: SeriesRecord[] = [];
  const groups = new Map<string, ColorGroup>();
  const counts: Record<Component, number> = { ba: 0, vadm: 0, decl: 0, incl: 0 };
  let omitted = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const row of page.rows) {
    const age = asNumber(read.age(row));
    if (age === null || age === -50000) {
      omitted++;
      continue;
    }
    const ba = asNumber(read.ba(row), 0);
    const sigmaBa = asNumber(read.sigmaBa(row), 0);
    const decl = signedDeclination(asNumber(read.decl(row)));
    const incl = asNumber(read.incl(row), -90, 90);
    if (ba === null && decl === null && incl === null) continue;
    const [vadm, sigmaVadm] = options.vadm
      ? [asNumber(read.vadm(row), 0), asNumber(read.sigmaVadm(row), 0)]
      : vadmOf(ba, sigmaBa, asNumber(read.lat(row), -90, 90));
    const ageMinus = asNumber(read.ageMinus(row), 0);
    const agePlus = asNumber(read.agePlus(row), 0);
    const colorValue = options.color_by ? asText(read.colorBy(row)) : null;
    const key = options.color_by ? (colorValue === null ? "unknown" : `=${colorValue}`) : "all";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: colorValue ?? (options.color_by ? "Unspecified region" : "Records"),
        color: options.color_by ? groupColor(colorValue) : "",
      });
    }
    const sigmas = asNumber(read.sigmas(row));
    records.push({
      index: records.length,
      contribution: asText(read.contribution(row)) ?? undefined,
      age,
      ageMinus,
      agePlus,
      ba,
      sigmaBa,
      vadm,
      sigmaVadm,
      decl,
      incl,
      alpha95: asNumber(read.alpha95(row), 0, 180),
      group: key,
      ageErrorType: asText(read.ageErrorType(row)),
      sigmas: sigmas !== null && sigmas > 0 ? sigmas : null,
      hover: hover.map((get) => asText(get(row))),
    });
    lo = Math.min(lo, age - (ageMinus ?? 0));
    hi = Math.max(hi, age + (agePlus ?? 0));
    if (ba !== null) counts.ba++;
    if (vadm !== null) counts.vadm++;
    if (decl !== null) counts.decl++;
    if (incl !== null) counts.incl++;
  }
  records.sort((a, b) => a.age - b.age);
  records.forEach((record, i) => {
    record.index = i;
  });
  return {
    records,
    groups: [...groups.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
    counts,
    omitted,
    ageRange: records.length > 0 ? [lo, hi] : null,
  };
}

/** A pressed-at stamp for export file names, as the site's (YYYY-MM-DD_HH-MM). */
export function timestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}`;
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A stored (uncompressed) zip of the files: PNGs are compressed already
 * (PKWARE APPNOTE 4.3.7, 4.3.12, 4.3.16), as the site's export. */
export function zipArchive(files: ZipFile[], now = new Date()): Blob {
  const dosDate =
    ((Math.min(2107, Math.max(1980, now.getFullYear())) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5);
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, file.data.length, true);
    header.setUint32(22, file.data.length, true);
    header.setUint16(26, name.length, true);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const central = new DataView(entry.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, file.data.length, true);
    central.setUint32(24, file.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(local, file.data);
    directory.push(entry);
    offset += local.length + file.data.length;
    directorySize += entry.length;
  }
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, files.length, true);
  footer.setUint16(10, files.length, true);
  footer.setUint32(12, directorySize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end] as BlobPart[], { type: "application/zip" });
}

/** The search behind an export, as the site's params.txt (JSON). */
export function paramsFile(
  config: NodeConfig,
  options: SeriesOptions,
  search: Record<string, unknown>,
  data: SeriesData,
  pressedAt: string,
): ZipFile {
  const criteria = Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== ""),
  );
  const text = JSON.stringify(
    {
      repository: config.key,
      level: options.base_level,
      url: typeof window === "undefined" ? undefined : window.location.href,
      exported: pressedAt,
      search: criteria,
      records: data.records.length,
      measurements: {
        intensity: data.counts.ba,
        vadm: data.counts.vadm,
        declination: data.counts.decl,
        inclination: data.counts.incl,
      },
      omitted_unknown_age: data.omitted,
    },
    null,
    2,
  );
  return { name: "params.txt", data: new TextEncoder().encode(`${text}\n`) };
}

/** Save a blob as a download. */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
