import type { MapColorOption } from "../../lib/types";
import type { MapPoint } from "./map-points";

// Coloring the search map's markers by a number (node YAML `map_colors`).

// Low to high: yellow through red to purple, the poles view's yellow -> red
// carried on, which all stand out against the ocean basemap's blues.
export const RAMP = ["#ffe600", "#ffa600", "#f2542d", "#c2185b", "#6a1b9a"];
// A record without a value (distinct from the dark grey outside an area).
export const NO_VALUE_COLOR = "#9ca3af";

// The ramp spans these quantiles of the values, so that a few outliers (or a
// -9999 meaning "unknown") don't squash every other color into one end.
const LOW_QUANTILE = 0.02;
const HIGH_QUANTILE = 0.98;

/** A ramp over [low, high] of the values (log10 of them for a log option). */
export type ColorScale = { option: MapColorOption; low: number; high: number };

const position = (option: MapColorOption, value: number) =>
  option.log ? (value > 0 ? Math.log10(value) : Number.NaN) : value;

/** The scale over the points' values, or null with none to color. */
export const colorScale = (option: MapColorOption, points: MapPoint[]): ColorScale | null => {
  const values = points
    .map((p) => (p.value === undefined ? Number.NaN : position(option, p.value)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const at = (q: number) => values[Math.round(q * (values.length - 1))];
  return { option, low: at(LOW_QUANTILE), high: at(HIGH_QUANTILE) };
};

const hex = (color: string) => [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));

/** A value's color on the scale, or null for a value it can't place (≤ 0 on
 * a log scale). Values past the ends take the end colors. */
export const colorOf = (scale: ColorScale, value: number): string | null => {
  const x = position(scale.option, value);
  if (!Number.isFinite(x)) return null;
  const span = scale.high - scale.low;
  const t = span > 0 ? Math.min(Math.max((x - scale.low) / span, 0), 1) : 0.5;
  const i = Math.min(Math.floor(t * (RAMP.length - 1)), RAMP.length - 2);
  const f = t * (RAMP.length - 1) - i;
  const [a, b] = [hex(RAMP[i]), hex(RAMP[i + 1])];
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
};

/** A number to about three significant digits, whole numbers whole (a year
 * stays 2014), and very large or small ones in exponent form. */
export const formatNumber = (value: number) => {
  const size = Math.abs(value);
  if (size >= 1e6 || (size > 0 && size < 1e-3)) return value.toExponential(2);
  return String(Number(value.toPrecision(Math.max(3, Math.floor(Math.log10(size)) + 1))));
};

/** A stored value in the option's display unit, with the unit. */
export const formatValue = (option: MapColorOption, value: number) =>
  `${formatNumber(value / option.scale)}${option.unit ? ` ${option.unit}` : ""}`;

/** The scale's value at `t` (0 to 1 along the ramp), as stored. */
export const valueAt = (scale: ColorScale, t: number) => {
  const x = scale.low + (scale.high - scale.low) * t;
  return scale.option.log ? 10 ** x : x;
};

/** The points colored on the scale, with their value's text for the tooltip;
 * those without a color first, so the colored ones are drawn over them. */
export const colorPoints = (points: MapPoint[], scale: ColorScale | null): MapPoint[] => {
  if (!scale) return points.map((p) => ({ ...p, color: NO_VALUE_COLOR }));
  const { label } = scale.option;
  const colored = points.map((p) => {
    const color = p.value === undefined ? null : colorOf(scale, p.value);
    if (color === null || p.value === undefined) return { ...p, color: NO_VALUE_COLOR };
    const mean = p.count !== undefined && p.count > 1 ? "mean " : "";
    return { ...p, color, valueText: `${label}: ${mean}${formatValue(scale.option, p.value)}` };
  });
  return [
    ...colored.filter((p) => p.color === NO_VALUE_COLOR),
    ...colored.filter((p) => p.color !== NO_VALUE_COLOR),
  ];
};
