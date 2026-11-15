// Field Models view data: the plugin config, the catalogue and curve
// responses (plugin.py), the search's site rows and measurements, and the
// model-data export in GEOMAGIA's text layout.
import type { NodeConfig } from "@/lib/types";

export interface FieldColumns {
  latitude: string;
  longitude: string;
  age: string;
  age_minus: string;
  age_plus: string;
  intensity: string;
  intensity_error: string;
  vadm: string;
  vadm_error: string;
  declination: string;
  inclination: string;
  region: string;
  locality: string;
  record: string;
  age_error_type: string;
  sigmas: string;
}

export interface FieldModelsConfig {
  view?: string;
  base_level?: string;
  table?: string;
  columns: FieldColumns;
  defaults: {
    models: string[];
    latitude: number;
    longitude: number;
    altitude: number;
    start_year: number;
    end_year: number;
    step: number;
  };
}

export function fieldModelsConfig(config: NodeConfig): FieldModelsConfig | null {
  const raw = config.plugins["field-models"] as unknown as FieldModelsConfig | undefined;
  return raw?.base_level ? raw : null;
}

export interface CoefficientMetadata {
  citation: string;
  label: string;
  dataset: string;
  doi?: string | null;
  terms: string;
  source_url: string;
  interpolated_epochs: boolean;
  coefficient_note: string;
  temporal_interpolation: string;
  coefficient_sha256: string;
  ensemble_count: number;
  ensemble_kind?: string | null;
  uncertainty_definition?: string | null;
}

export interface CatalogModel extends CoefficientMetadata {
  name: string;
  start: number;
  end: number;
  degree: number;
  has_uncertainty: boolean;
  file_uncertainty: boolean;
}

export interface Catalog {
  installed: boolean;
  groups: { label: string; models: string[] }[];
  models: Record<string, CatalogModel>;
  unavailable: Record<string, string>;
  generated?: string | null;
  limits: { points_per_curve: number; curves: number; points: number };
}

type Values = (number | null)[];

export interface Ensemble {
  count: number;
  kind: string;
  member_ids: string[];
  intensity: Values[];
  decl: Values[];
  incl: Values[];
}

export interface Series {
  model: string;
  years: number[];
  coefficient_metadata: CoefficientMetadata;
  intensity: Values;
  decl: Values;
  incl: Values;
  uncertainty: Values | null;
  decl_uncertainty: Values | null;
  incl_uncertainty: Values | null;
  vadm: Values;
  vadm_uncertainty: Values | null;
  latitude: number;
  longitude: number;
  altitude: number;
  location_components: string[] | null;
  ensemble?: Ensemble | null;
}

export type LocationGroup = "intensity" | "direction";

export interface CurveRequest {
  models: string[];
  location_source: "manual" | "database";
  latitude?: number;
  longitude?: number;
  altitude: number;
  sites: (number | null)[][];
  use_median: boolean;
  start_year: number;
  end_year: number;
  step: number;
  include_members?: boolean;
}

export interface CurveResult {
  series: Series[];
  latitude: number;
  longitude: number;
  altitude: number;
  start_year: number;
  end_year: number;
  step: number;
  location_source: "manual" | "database";
  location_count: number;
  use_median?: boolean;
  component_location_counts?: Record<LocationGroup, number>;
  plot_location_counts?: Record<LocationGroup, number>;
  median_locations?: Record<LocationGroup, { latitude: number; longitude: number } | null>;
  site_groups?: Record<LocationGroup, [number, number][]>;
  /** Client side: the request that produced it. */
  request: CurveRequest;
  /** Client side: set once ensemble SDs (and members) are merged in. */
  ensembleUncertainty?: boolean;
  ensembleMembers?: boolean;
  uncertainty_definition?: string;
}

export interface EnsembleResponse {
  series: (Pick<
    Series,
    | "model"
    | "latitude"
    | "longitude"
    | "altitude"
    | "years"
    | "uncertainty"
    | "decl_uncertainty"
    | "incl_uncertainty"
    | "vadm_uncertainty"
  > & { ensemble: Ensemble | null })[];
  uncertainty_definition: string;
}

/** Merge ensemble SDs (and members) into the mean curves, matching by model
 * and location as GEOMAGIA's loadEnsembles does. */
export function mergeEnsembles(
  result: CurveResult,
  response: EnsembleResponse,
  members: boolean,
): CurveResult {
  const series = result.series.map((curve) => {
    const row = response.series.find(
      (r) =>
        r.model === curve.model &&
        r.latitude === curve.latitude &&
        r.longitude === curve.longitude &&
        r.altitude === curve.altitude,
    );
    if (!row) return curve;
    if (JSON.stringify(row.years) !== JSON.stringify(curve.years)) {
      throw new Error("Ensemble and mean prediction years do not agree.");
    }
    return {
      ...curve,
      uncertainty: row.uncertainty,
      decl_uncertainty: row.decl_uncertainty,
      incl_uncertainty: row.incl_uncertainty,
      vadm_uncertainty: row.vadm_uncertainty,
      ensemble: row.ensemble ?? curve.ensemble ?? null,
    };
  });
  return {
    ...result,
    series,
    ensembleUncertainty: true,
    ensembleMembers: members || result.ensembleMembers,
    uncertainty_definition: response.uncertainty_definition,
  };
}

// --- Search rows ---------------------------------------------------------------------

export interface Measurement {
  age: number;
  ageMinus: number | null;
  agePlus: number | null;
  intensity: number | null;
  intensityError: number | null;
  vadm: number | null;
  vadmError: number | null;
  decl: number | null;
  incl: number | null;
  latitude: number | null;
  region: string;
  locality: string;
  record: string;
  ageErrorType: string;
  sigmas: string;
  citation: string;
}

const CONTRIBUTION_FIELDS = ["summary.contribution.citation"];

/** The values-endpoint fields the view reads, in a fixed order. */
export function valueFields(table: string, c: FieldColumns): string[] {
  const keys: (keyof FieldColumns)[] = [
    "latitude",
    "longitude",
    "intensity",
    "declination",
    "inclination",
    "age",
    "age_minus",
    "age_plus",
    "intensity_error",
    "vadm",
    "vadm_error",
    "region",
    "locality",
    "record",
    "age_error_type",
    "sigmas",
  ];
  return [...keys.map((k) => `summary.${table}.${c[k]}`), ...CONTRIBUTION_FIELDS];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string {
  return value === null || value === undefined || value === "" ? "Not reported" : String(value);
}

/** Distinct [lat, lon, intensity, declination, inclination] rows: what the
 * backend classifies into intensity and direction site locations. */
export function siteRows(rows: (number | string | null)[][]): (number | null)[][] {
  const seen = new Set<string>();
  const out: (number | null)[][] = [];
  for (const row of rows) {
    const values = row.slice(0, 5).map(num);
    const key = values.join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(values);
    }
  }
  return out;
}

/** Records with a known age and an intensity, declination or inclination
 * (GEOMAGIA's plot data), declinations signed to -180..180. */
export function measurements(rows: (number | string | null)[][]): Measurement[] {
  const out: Measurement[] = [];
  for (const row of rows) {
    const age = num(row[5]);
    if (age === null || age === -50000) continue;
    const intensity = num(row[2]);
    let decl = num(row[3]);
    if (decl !== null && (decl < -360 || decl > 360)) decl = null;
    if (decl !== null && decl > 180) decl -= 360;
    let incl = num(row[4]);
    if (incl !== null && (incl < -90 || incl > 90)) incl = null;
    const valid = intensity !== null && intensity >= 0 ? intensity : null;
    if (valid === null && decl === null && incl === null) continue;
    out.push({
      age,
      ageMinus: num(row[6]),
      agePlus: num(row[7]),
      intensity: valid,
      intensityError: num(row[8]),
      vadm: valid === null ? null : num(row[9]),
      vadmError: num(row[10]),
      decl,
      incl,
      latitude: num(row[0]),
      region: text(row[11]),
      locality: text(row[12]),
      record: text(row[13]),
      ageErrorType: text(row[14]),
      sigmas: text(row[15]),
      citation: text(row[16]),
    });
  }
  out.sort((a, b) => a.age - b.age);
  return out;
}

/** Region colours: GEOMAGIA's golden-angle hues, by the region's rank. */
export function regionColors(records: Measurement[]): Map<string, string> {
  const names = [...new Set(records.map((r) => r.region))].sort((a, b) => a.localeCompare(b));
  return new Map(
    names.map((name, i) =>
      name === "Not reported"
        ? [name, "#718096"]
        : [name, `hsl(${(i * 137.508) % 360}, 65%, ${38 + (i % 3) * 6}%)`],
    ),
  );
}

/** The search's age window from its range filter on the age column. */
export function ageWindow(
  ranges: string[],
  table: string,
  c: FieldColumns,
): [number | null, number | null] {
  const fields = [`summary._num.${c.age}`, `summary.${table}.${c.age}`];
  for (const r of ranges) {
    const [field, gte, lte] = r.split(":");
    if (fields.includes(field)) return [num(gte), num(lte)];
  }
  return [null, null];
}

// --- Quantities -----------------------------------------------------------------------

export function gad(latitude: number): number {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return Number.NaN;
  const phi = (latitude * Math.PI) / 180;
  return (Math.atan2(2 * Math.sin(phi), Math.cos(phi)) * 180) / Math.PI;
}

export function deltaInclination(incl: number | null, latitude: number | null): number | null {
  if (incl === null || latitude === null) return null;
  const value = incl - gad(latitude);
  return Number.isFinite(value) ? value : null;
}

// --- Exports ----------------------------------------------------------------------------

export function timestamp(date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

const fixed = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isFinite(value)
    ? (Object.is(value, -0) ? 0 : value).toFixed(2).padStart(10)
    : "NaN".padStart(10);

const lon360 = (lon: number) => ((lon % 360) + 360) % 360;

export interface ExportFile {
  name: string;
  data: string | Uint8Array;
}

/** GEOMAGIA's model-data export: per model (and, for search locations, per
 * component group) `# AGE SITE_LAT SITE_LON INCL DECL INT EI ED EF` and the
 * ΔI companion, locations.tsv, ensemble members when shown,
 * parameters.json and a README. */
export function predictionFiles(
  result: CurveResult,
  stamp: string,
  options: {
    prefix: string;
    site: string;
    showEnsemble: boolean;
    inclinationMode: "incl" | "delta_incl";
    intensityMode: "intensity" | "vadm";
    hidden: string[];
  },
): ExportFile[] {
  const files: ExportFile[] = [];
  const { prefix, site } = options;
  for (const model of [...new Set(result.series.map((s) => s.model))]) {
    const groups: (LocationGroup | null)[] =
      result.location_source === "database" ? ["intensity", "direction"] : [null];
    for (const group of groups) {
      const series = result.series.filter(
        (s) => s.model === model && (!group || s.location_components?.includes(group)),
      );
      if (!series.length) continue;
      const lines = [
        `#   ${model}  predictions from ${site}`,
        "# AGE SITE_LAT SITE_LON INCL DECL INT EI ED EF",
      ];
      if (series[0].coefficient_metadata.interpolated_epochs) {
        lines.splice(1, 0, `# ${series[0].coefficient_metadata.coefficient_note}`);
      }
      for (const curve of series) {
        curve.years.forEach((year, i) => {
          lines.push(
            [
              year,
              curve.latitude,
              lon360(curve.longitude),
              curve.incl[i],
              curve.decl[i],
              curve.intensity[i],
              curve.incl_uncertainty?.[i],
              curve.decl_uncertainty?.[i],
              curve.uncertainty?.[i],
            ]
              .map(fixed)
              .join(" "),
          );
        });
      }
      const tag = group ? `_${group}` : "";
      files.push({ name: `${prefix}_${model}${tag}_${stamp}.txt`, data: `${lines.join("\n")}\n` });
      const anomalies = [
        "# Delta inclination relative to GAD at each prediction latitude; degrees",
        "# AGE SITE_LAT SITE_LON I_GAD DELTA_INCL",
      ];
      for (const curve of series) {
        curve.years.forEach((year, i) => {
          anomalies.push(
            [
              year,
              curve.latitude,
              lon360(curve.longitude),
              gad(curve.latitude),
              deltaInclination(curve.incl[i], curve.latitude),
            ]
              .map(fixed)
              .join(" "),
          );
        });
      }
      files.push({
        name: `${prefix}_${model}${tag}_delta_incl_${stamp}.txt`,
        data: `${anomalies.join("\n")}\n`,
      });
    }
  }
  const locations = ["MODEL\tGROUP\tSITE_LAT\tSITE_LON\tALTITUDE_KM"];
  for (const curve of result.series) {
    locations.push(
      [
        curve.model,
        (curve.location_components ?? ["manual"]).join(";"),
        curve.latitude,
        lon360(curve.longitude),
        curve.altitude,
      ].join("\t"),
    );
  }
  files.push({ name: "locations.tsv", data: `${locations.join("\n")}\n` });
  if (options.showEnsemble) {
    result.series.forEach((curve, index) => {
      if (!curve.ensemble) return;
      const lines = [
        "# Supplied joint ensemble predictions; members retained across dates.",
        "# MEMBER AGE SITE_LAT SITE_LON INCL DECL INT",
      ];
      curve.ensemble.member_ids.forEach((member, j) => {
        curve.years.forEach((year, i) => {
          const values = [
            year,
            curve.latitude,
            lon360(curve.longitude),
            curve.ensemble?.incl[j][i],
            curve.ensemble?.decl[j][i],
            curve.ensemble?.intensity[j][i],
          ];
          lines.push(`${member} ${values.map(fixed).join(" ")}`);
        });
      });
      files.push({
        name: `${prefix}_${curve.model}_ensemble_location_${index + 1}_${stamp}.txt`,
        data: `${lines.join("\n")}\n`,
      });
    });
  }
  const models = Object.fromEntries(result.series.map((s) => [s.model, s.coefficient_metadata]));
  files.push({
    name: "parameters.json",
    data: `${JSON.stringify(
      {
        models: result.request.models,
        latitude: result.location_source === "manual" ? result.latitude : undefined,
        longitude: result.location_source === "manual" ? result.longitude : undefined,
        altitude: result.altitude,
        start_year: result.start_year,
        end_year: result.end_year,
        step: result.step,
        location_source: result.location_source,
        use_median: Boolean(result.use_median),
        median_locations: result.median_locations,
        component_location_counts: result.component_location_counts,
        intensity_display: options.intensityMode,
        inclination_display: options.inclinationMode,
        show_ensemble: options.showEnsemble,
        hidden_curves: options.hidden,
        uncertainty_definition: result.uncertainty_definition,
        coefficient_models: models,
        delta_inclination_definition:
          "I - atan2(2 sin(latitude), cos(latitude)); degrees, observation/prediction latitude",
      },
      null,
      2,
    )}\n`,
  });
  const citations = Object.values(models).map(
    (m) =>
      `- ${m.label}: ${m.citation}${m.doi ? ` https://doi.org/${m.doi}` : ""} (terms: ${m.terms}; source: ${m.source_url})`,
  );
  files.push({
    name: "README.txt",
    data: `${[
      `${site} field model predictions`,
      `Exported: ${stamp} (local time)`,
      "AGE: signed calendar year (negative BCE; positive CE).",
      "SITE_LAT: geographic/geodetic latitude in degrees; SITE_LON: degrees east, 0 to <360.",
      "INCL / DECL: inclination / signed declination in degrees. INT: total intensity in microtesla (uT).",
      "EI / ED / EF: supplied model uncertainties, or pointwise ensemble sample standard deviations (ddof=1), in degrees/degrees/uT. See parameters.json for each model's provenance.",
      "NaN means no supplied model uncertainty; it does not mean zero uncertainty. Confidence levels are not rescaled.",
      "Numbers in prediction files are rounded to two decimal places, following the GEOMAGIA text format.",
      "Each file contains all calculated locations for that model and component group, ordered by location then year.",
      "Search mode separates intensity and direction location files; all nine predictions are retained at each location.",
      "Median mode exports only the calculated component medians. locations.tsv records the exact locations and altitude.",
      "Manual altitude is in km; search locations use sea level. Only each model's supported dates are included.",
      "Data export uses the calculated selection, including models hidden in the legend.",
      "When Show ensemble is enabled, companion ensemble files include every supplied member at every calculated location/date.",
      "Companion delta_incl files contain I_GAD and DELTA_INCL in degrees, using each prediction latitude.",
      "",
      "Models (cite them when you use these predictions):",
      ...citations,
    ].join("\n")}\n`,
  });
  return files;
}

// --- A stored (uncompressed) zip ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive of the files, stored without compression. */
export function zip(files: ExportFile[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], {
    type: "application/zip",
  });
}

export function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function dataUrlBytes(uri: string): Uint8Array {
  const binary = atob(uri.split(",")[1]);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
