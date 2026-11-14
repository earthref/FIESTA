// Ages as text, one way everywhere (tiles, poles, legends). The backend puts
// every age in years BP (node YAML `search.unit_conversions`, see
// fiesta.domain.summarize): a doc's `summary._interval.<name>` block holds its
// rows' intervals; this shows them scaled as the legacy result card did, to
// Ga / Ma / ka by magnitude, and below 1 ka in years BP (present = 1950 CE, the
// Quaternary / radiocarbon convention; 2026-11-14, user decision: not legacy's
// calendar AD / BC, so one axis runs from Ga to the present; a year after 1950
// is negative). The contributed unit stays in the tooltip.

import type { SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";

/** A doc's `summary._interval.<name>` (years BP). */
export interface AgeInterval {
  range?: { gte?: number; lte?: number }[];
  /** The span shown: best estimates and stated bounds (no sigma windows). */
  min: number;
  max: number;
  /** The median best estimate: what the grid sorts and the map colors by. */
  mid: number;
  /** How many rows' intervals it holds. */
  n: number;
  open_low?: boolean;
  open_high?: boolean;
  /** With one row: its converted columns and its values as contributed. */
  detail?: {
    value?: number;
    sigma?: number;
    low?: number;
    high?: number;
    contributed?: string;
  };
}

/** A doc's interval block, or undefined. */
export function ageIntervalOf(hit: SearchResult, name = "age"): AgeInterval | undefined {
  const block = getPath(hit, `summary._interval.${name}`);
  if (!block || typeof block !== "object") return undefined;
  const interval = block as AgeInterval;
  return Number.isFinite(interval.min) && Number.isFinite(interval.max) ? interval : undefined;
}

interface Scale {
  divisor: number;
  unit: string;
}

const SCALES: Scale[] = [
  { divisor: 1e9, unit: "Ga" },
  { divisor: 1e6, unit: "Ma" },
  { divisor: 1e3, unit: "ka" },
];
const YEARS: Scale = { divisor: 1, unit: "yr BP" };

/** The unit for ages up to `largest` years BP. */
function scaleFor(largest: number): Scale {
  return SCALES.find((scale) => Math.abs(largest) >= scale.divisor) ?? YEARS;
}

/** numeral "0[.]0[00]": up to three decimals, no trailing zeros (as legacy). */
function trim(value: number): string {
  const rounded = Number(value.toFixed(3));
  return String(rounded === 0 ? 0 : rounded);
}

/** One age in years BP: "12.3 Ma", "450 yr BP". */
export function formatYbp(ybp: number): string {
  const scale = scaleFor(ybp);
  return `${trim(ybp / scale.divisor)} ${scale.unit}`;
}

/** A range in years BP (young..old): "10 – 15 Ma", "330 – 500 yr BP". */
export function formatYbpRange(young: number, old: number): string {
  const scale = scaleFor(Math.max(Math.abs(young), Math.abs(old)));
  const a = trim(young / scale.divisor);
  const b = trim(old / scale.divisor);
  return a === b ? `${a} ${scale.unit}` : `${a} – ${b} ${scale.unit}`;
}

/** One row's age, whatever of value / sigma / low / high it has:
 * "12.3 ± 0.4 Ma", "10 – 15 Ma", "12.3 Ma (10 – 15 Ma)", "> 10 Ma". */
function formatDetail(detail: NonNullable<AgeInterval["detail"]>): string | undefined {
  const { value, sigma, low, high } = detail;
  const bounds =
    low !== undefined && high !== undefined
      ? formatYbpRange(low, high)
      : low !== undefined
        ? `> ${formatYbp(low)}`
        : high !== undefined
          ? `< ${formatYbp(high)}`
          : undefined;
  if (value === undefined) return bounds;
  let main = formatYbp(value);
  if (sigma !== undefined) {
    const scale = scaleFor(Math.abs(value) + sigma);
    main = `${trim(value / scale.divisor)} ± ${trim(sigma / scale.divisor)} ${scale.unit}`;
  }
  return bounds ? `${main} (${bounds})` : main;
}

/** A doc's ages: one row's in full ("12.3 ± 0.4 Ma"), several as their span
 * ("0.5 – 12 Ma"); an only bound as "> 10 Ma" / "< 15 Ma". */
export function formatAgeInterval(interval: AgeInterval): string {
  if (interval.n === 1 && interval.detail) {
    const text = formatDetail(interval.detail);
    if (text) return text;
  }
  const { min, max } = interval;
  if (min === max) {
    if (interval.open_high && !interval.open_low) return `> ${formatYbp(min)}`;
    if (interval.open_low && !interval.open_high) return `< ${formatYbp(max)}`;
    return formatYbp(min);
  }
  return formatYbpRange(min, max);
}

/** The tooltip under a doc's age: its values as contributed, or how many
 * ages its span covers and their median. */
export function ageIntervalTitle(interval: AgeInterval): string {
  if (interval.n === 1) return interval.detail?.contributed ?? formatYbp(interval.mid);
  return `${interval.n} ages, median ${formatYbp(interval.mid)}`;
}
