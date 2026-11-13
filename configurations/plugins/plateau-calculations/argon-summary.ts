/**
 * The contribution's age plots across its specimens: their ages together,
 * against their samples' section (elevation, height, depth), and their J
 * values against irradiation position. Ages share the specimens' unit, or Ma
 * when they differ.
 */
import type { DatedItem, XYPoint } from "./argon-charts";
import { type ArgonData, type Sample, type Specimen, toMa } from "./argon-data";

/** A contribution-wide plot. */
export type SummaryPlot =
  | {
      key: string;
      kind: "ages";
      title: string;
      where: string;
      items: DatedItem[];
      unit: string;
    }
  | {
      key: string;
      kind: "xy";
      title: string;
      where: string;
      points: XYPoint[];
      xLabel: string;
      yLabel: string;
      reverseY?: boolean;
      caption: string;
    };

/** The unit dated items share: their own when they agree, else Ma. */
export function commonUnit(units: (string | null)[]): string {
  const set = new Set(units.map((u) => u ?? "Ma"));
  return set.size === 1 ? [...set][0] : "Ma";
}

/** An age and its σ in `unit`. */
export function inUnit(
  age: number,
  sigma: number | null,
  from: string | null,
  unit: string,
): { age: number; sigma: number | null } {
  const factor = toMa(from) / toMa(unit);
  return { age: age * factor, sigma: sigma != null ? sigma * factor : null };
}

const datedUnit = (specimens: Specimen[]) =>
  commonUnit(specimens.filter((s) => s.age != null).map((s) => s.age_unit));

/** Every specimen's preferred age, in `unit`. */
export function specimenAges(specimens: Specimen[], unit = datedUnit(specimens)): DatedItem[] {
  return specimens
    .filter((s) => s.age != null)
    .map((s) => ({
      name: s.specimen,
      ...inUnit(s.age as number, s.age_sigma, s.age_unit, unit),
    }));
}

const SECTIONS: {
  column: keyof Pick<Sample, "elevation" | "height" | "core_depth" | "composite_depth">;
  title: string;
  yLabel: string;
  reverseY?: boolean;
}[] = [
  { column: "elevation", title: "Age vs. elevation", yLabel: "Elevation (m)" },
  { column: "height", title: "Age vs. stratigraphic height", yLabel: "Height (m)" },
  { column: "core_depth", title: "Age vs. core depth", yLabel: "Core depth (m)", reverseY: true },
  {
    column: "composite_depth",
    title: "Age vs. composite depth",
    yLabel: "Composite depth (m)",
    reverseY: true,
  },
];

/** A specimen's place in the section: its sample's. */
function sectionPoints(
  data: ArgonData,
  column: (typeof SECTIONS)[number]["column"],
  unit: string,
): XYPoint[] {
  const samples = new Map(data.samples.map((s) => [s.sample, s]));
  return data.specimens.flatMap((s) => {
    const sample = s.sample ? samples.get(s.sample) : undefined;
    const y = sample?.[column];
    if (s.age == null || y == null || !sample) return [];
    const { age, sigma } = inUnit(s.age, s.age_sigma, s.age_unit, unit);
    return [
      {
        name: `${s.specimen} (sample ${sample.sample})`,
        x: age,
        xSigma: sigma,
        y,
        ySigma: column === "height" ? sample.height_sigma : null,
      },
    ];
  });
}

/** J against position, per irradiation: the numbered position, else the
 * height in the can, else the positions in order. Flux monitors are filled,
 * the specimens they calibrate hollow. */
function irradiationPlots(specimens: Specimen[]): SummaryPlot[] {
  const groups = new Map<string, Specimen[]>();
  for (const s of specimens) {
    if (s.j_value == null) continue;
    if (s.irrad_position == null && s.irrad_z == null) continue;
    const name = s.irrad_name ?? "";
    groups.set(name, [...(groups.get(name) ?? []), s]);
  }
  return [...groups.entries()].map(([name, group]) => {
    const numbered = group.every(
      (s) => s.irrad_position != null && Number.isFinite(Number(s.irrad_position)),
    );
    const heights = group.every((s) => s.irrad_z != null);
    const order = [...new Set(group.map((s) => s.irrad_position ?? ""))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const xOf = (s: Specimen) =>
      numbered
        ? Number(s.irrad_position)
        : heights
          ? (s.irrad_z as number)
          : order.indexOf(s.irrad_position ?? "") + 1;
    const xLabel = numbered
      ? "Irradiation position"
      : heights
        ? "Height in the irradiation can"
        : "Irradiation position (in order)";
    return {
      key: `j:${name}`,
      kind: "xy" as const,
      title: name ? `J vs. position, ${name}` : "J vs. irradiation position",
      where: `${group.length} specimen${group.length === 1 ? "" : "s"}`,
      points: group.map((s) => ({
        name: `${s.specimen}${s.irrad_position ? ` (position ${s.irrad_position})` : ""}${s.is_flux_monitor ? ", flux monitor" : ""}`,
        x: xOf(s),
        y: s.j_value as number,
        ySigma: s.j_value_sigma,
        hollow: s.is_flux_monitor === false,
      })),
      xLabel,
      yLabel: "J",
      caption:
        "Contributed J values with their 1σ; filled = flux monitors, hollow = specimens they calibrate.",
    };
  });
}

/** The contribution's plots that have something to draw. */
export function summaryPlots(data: ArgonData): SummaryPlot[] {
  const plots: SummaryPlot[] = [];
  const unit = datedUnit(data.specimens);
  const ages = specimenAges(data.specimens, unit);
  if (ages.length > 0)
    plots.push({
      key: "ages",
      kind: "ages",
      title: "Specimen ages",
      where: `${ages.length} specimen${ages.length === 1 ? "" : "s"}`,
      items: ages,
      unit,
    });
  for (const section of SECTIONS) {
    const points = sectionPoints(data, section.column, unit);
    if (points.length > 0)
      plots.push({
        key: section.column,
        kind: "xy",
        title: section.title,
        where: `${points.length} specimen${points.length === 1 ? "" : "s"}`,
        points,
        xLabel: `Age (${unit})`,
        yLabel: section.yLabel,
        reverseY: section.reverseY,
        caption:
          "Each specimen's preferred age (±1σ) at its sample's place in the section." +
          (section.reverseY ? " Depth increases downward." : ""),
      });
  }
  plots.push(...irradiationPlots(data.specimens));
  return plots;
}
