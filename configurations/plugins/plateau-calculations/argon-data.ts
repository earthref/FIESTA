import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** [x, σx, y, σy, ρ] on an isochron (σ and ρ may be missing). */
export type IsochronPoint = [number, number | null, number, number | null, number | null];

export interface Step {
  measurement: string | null;
  sequence: number | null;
  temperature: number | null;
  temp_unit: string | null;
  age: number;
  age_sigma: number | null;
  ar39_start: number;
  ar39_end: number;
  normal: IsochronPoint | null;
  inverse: IsochronPoint | null;
  /** The companion spectra: contributed K/Ca, ⁴⁰Ar* (%) and ³⁸Ar(Cl)/³⁹Ar(K). */
  k_ca: number | null;
  k_ca_sigma: number | null;
  ar40_rad: number | null;
  cl_k: number | null;
}

export type AgeKind = "plateau" | "normal_isochron" | "inverse_isochron" | "total_fusion" | "other";

/** One experiments row: an age as the contributor calculated it. */
export interface ContributedAge {
  method: string | null;
  kind: AgeKind;
  preferred: boolean | null;
  age: number | null;
  age_sigma: number | null;
  age_unit: string | null;
  mswd: number | null;
  n: number | null;
  plateau_width: number | null;
  steps: string[];
  ar40_ar39: number | null;
  ar40_ar39_sigma: number | null;
  ar40_ar36: number | null;
  ar40_ar36_sigma: number | null;
  trapped_ar40_ar36: number | null;
}

export interface Experiment {
  experiment: string;
  specimen: string | null;
  steps: Step[];
  steps_without_age: number;
  /** The column that sized the steps on the ³⁹Ar axis; null = equal widths. */
  ar39_source: string | null;
  age_unit: string | null;
  ages: ContributedAge[];
}

export interface Specimen {
  specimen: string;
  sample: string | null;
  material: string | null;
  method: string | null;
  age: number | null;
  age_sigma: number | null;
  age_unit: string | null;
  experiments: string[];
  j_value: number | null;
  j_value_sigma: number | null;
  irrad_name: string | null;
  irrad_position: string | null;
  irrad_x: number | null;
  irrad_y: number | null;
  irrad_z: number | null;
  is_flux_monitor: boolean | null;
}

/** A sample's place in its section. */
export interface Sample {
  sample: string;
  location: string | null;
  elevation: number | null;
  height: number | null;
  height_sigma: number | null;
  core_depth: number | null;
  composite_depth: number | null;
}

export interface ArgonData {
  experiments: Experiment[];
  specimens: Specimen[];
  samples: Sample[];
}

/** The request for a contribution's argon data (shared by the tabs and the
 * Contribution Age Plots count, so it is fetched once). */
export function argonQuery(
  id: string,
  privateKey: string | undefined,
  only?: { experiment?: string; specimen?: string },
) {
  return {
    queryKey: ["plugin", "argon", id, privateKey, only?.experiment, only?.specimen] as const,
    queryFn: () =>
      api<ArgonData>(`/plugins/plateau-calculations/contributions/${id}`, {
        params: {
          private_key: privateKey || undefined,
          experiment: only?.experiment,
          specimen: only?.specimen,
        },
      }),
  };
}

/** A contribution's argon data, or one experiment's / one specimen's. */
export function useArgon(
  id: string,
  privateKey: string | undefined,
  only?: { experiment?: string; specimen?: string },
) {
  return useQuery({
    ...argonQuery(id, privateKey, only),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** The age a plot draws for its kind: the preferred one, else the first. */
export function ageOf(experiment: Experiment, kind: AgeKind): ContributedAge | undefined {
  const ages = experiment.ages.filter((age) => age.kind === kind);
  return ages.find((age) => age.preferred) ?? ages[0];
}

/** An experiment's age for comparing experiments: its preferred contributed
 * age, else its plateau, else the first with a value. */
export function experimentAge(experiment: Experiment): ContributedAge | undefined {
  const dated = experiment.ages.filter((age) => age.age != null);
  return (
    dated.find((age) => age.preferred) ?? dated.find((age) => age.kind === "plateau") ?? dated[0]
  );
}

/** Ages in different units on one axis: the factor to Ma (an unknown unit is
 * taken as Ma). */
export function toMa(unit: string | null | undefined): number {
  const text = (unit ?? "").trim().toLowerCase();
  if (text.startsWith("ga")) return 1000;
  if (text.startsWith("ka")) return 0.001;
  if (/^(a|y|yr|years?)\b/.test(text)) return 1e-6;
  return 1;
}

export function hasIsochron(experiment: Experiment, kind: "normal" | "inverse"): boolean {
  const age = ageOf(experiment, kind === "normal" ? "normal_isochron" : "inverse_isochron");
  return (
    experiment.steps.some((step) => step[kind]) || (age?.ar40_ar39 != null && age.ar40_ar36 != null)
  );
}

const fmt = (value: number, digits: number) => value.toFixed(digits);

/** "16.45 ± 0.11 Ma", with the age's own unit. */
export function ageText(age: number | null, sigma: number | null, unit: string | null): string {
  if (age == null) return "no age";
  const digits = Math.abs(age) >= 100 ? 2 : 3;
  return `${fmt(age, digits)}${sigma != null ? ` ± ${fmt(sigma, digits)}` : ""} ${unit ?? "Ma"}`;
}
