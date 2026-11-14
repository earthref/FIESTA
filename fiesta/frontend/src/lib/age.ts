// Ages as text, one way everywhere (tiles, poles, legends). The backend puts
// every age in years BP (node YAML `search.unit_conversions`, see
// fiesta.domain.summarize): a doc's `summary._interval.<name>` block holds its
// rows' intervals; this shows them scaled as the legacy result card did, to
// Ga / Ma / ka by magnitude, and below 1 ka as calendar years AD / BC.

import type { SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";

/** A doc's `summary._interval.<name>` (years BP). */
export interface AgeInterval {
  range?: { gte?: number; lte?: number }[];
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

/** The unit for ages up to `largest` years BP: undefined = calendar years. */
function scaleFor(largest: number): Scale | undefined {
  return SCALES.find((scale) => Math.abs(largest) >= scale.divisor);
}

/** numeral "0[.]0[00]": up to three decimals, no trailing zeros (as legacy). */
function trim(value: number): string {
  const rounded = Number(value.toFixed(3));
  return String(rounded === 0 ? 0 : rounded);
}

/** Years BP as a calendar year: 450 -> "1500 AD", 2449 -> "500 BC". */
function calendar(ybp: number): { year: string; era: "AD" | "BC" } {
  return ybp >= 1949.5
    ? { year: trim(ybp - 1949), era: "BC" }
    : { year: trim(1950 - ybp), era: "AD" };
}

function calendarRange(older: number, younger: number): string {
  const from = calendar(older);
  const to = calendar(younger);
  if (from.year === to.year && from.era === to.era) return `${from.year} ${from.era}`;
  return from.era === to.era
    ? `${from.year} – ${to.year} ${to.era}`
    : `${from.year} ${from.era} – ${to.year} ${to.era}`;
}

/** One age in years BP: "12.3 Ma", "1500 AD". */
export function formatYbp(ybp: number): string {
  const scale = scaleFor(ybp);
  if (!scale) {
    const { year, era } = calendar(ybp);
    return `${year} ${era}`;
  }
  return `${trim(ybp / scale.divisor)} ${scale.unit}`;
}

/** A range in years BP (young..old): "10 – 15 Ma", "1450 – 1620 AD". */
export function formatYbpRange(young: number, old: number): string {
  const scale = scaleFor(Math.max(Math.abs(young), Math.abs(old)));
  if (!scale) return calendarRange(old, young);
  const a = trim(young / scale.divisor);
  const b = trim(old / scale.divisor);
  return a === b ? `${a} ${scale.unit}` : `${a} – ${b} ${scale.unit}`;
}

/** Older than `ybp`: "> 10 Ma", "before 1500 AD". */
function olderThan(ybp: number): string {
  return scaleFor(ybp) ? `> ${formatYbp(ybp)}` : `before ${formatYbp(ybp)}`;
}

/** Younger than `ybp`: "< 15 Ma", "after 1500 AD". */
function youngerThan(ybp: number): string {
  return scaleFor(ybp) ? `< ${formatYbp(ybp)}` : `after ${formatYbp(ybp)}`;
}

/** One row's age, whatever of value / sigma / low / high it has:
 * "12.3 ± 0.4 Ma", "10 – 15 Ma", "12.3 Ma (10 – 15 Ma)", "> 10 Ma". */
function formatDetail(detail: NonNullable<AgeInterval["detail"]>): string | undefined {
  const { value, sigma, low, high } = detail;
  const bounds =
    low !== undefined && high !== undefined
      ? formatYbpRange(low, high)
      : low !== undefined
        ? olderThan(low)
        : high !== undefined
          ? youngerThan(high)
          : undefined;
  if (value === undefined) return bounds;
  let main: string;
  if (sigma !== undefined) {
    const scale = scaleFor(Math.abs(value) + sigma);
    main = scale
      ? `${trim(value / scale.divisor)} ± ${trim(sigma / scale.divisor)} ${scale.unit}`
      : (() => {
          const { year, era } = calendar(value);
          return `${year} ± ${trim(sigma)} ${era}`;
        })();
  } else {
    main = formatYbp(value);
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
    if (interval.open_high && !interval.open_low) return olderThan(min);
    if (interval.open_low && !interval.open_high) return youngerThan(max);
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
