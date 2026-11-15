// Element data for the Kd plots: atomic numbers (the atomic-number order),
// the spider diagrams' element orders, and for the Onuma diagram each
// element's assumed valence in silicate systems with its effective ionic
// radius (Å) from Shannon (1976), Acta Cryst. A32:751–767, in six-fold (VI)
// and eight-fold (VIII) coordination.
//
// The valence is the common one in silicate melts (Eu as Eu³⁺, so an Eu²⁺
// anomaly shows as a point off the 3+ curve; Fe and Mn as 2+; Sn as 4+; Cu as
// Cu⁺; Mo and W as 6+). Elements without a radius at a coordination (the
// small cations at VIII; volatiles, noble gases, platinum-group and other
// siderophile/chalcophile elements at both) are left off the Onuma diagram.

/** [symbol, atomic number, valence, radius VI, radius VIII]; null = none. */
type ElementRow = [string, number, number | null, number | null, number | null];

const ROWS: ElementRow[] = [
  ["H", 1, null, null, null],
  ["He", 2, null, null, null],
  ["Li", 3, 1, 0.76, 0.92],
  ["Be", 4, 2, 0.45, null],
  ["B", 5, 3, 0.27, null],
  ["C", 6, null, null, null],
  ["N", 7, null, null, null],
  ["O", 8, null, null, null],
  ["F", 9, null, null, null],
  ["Ne", 10, null, null, null],
  ["Na", 11, 1, 1.02, 1.18],
  ["Mg", 12, 2, 0.72, 0.89],
  ["Al", 13, 3, 0.535, null],
  ["Si", 14, 4, 0.4, null],
  ["P", 15, 5, 0.38, null],
  ["S", 16, null, null, null],
  ["Cl", 17, null, null, null],
  ["Ar", 18, null, null, null],
  ["K", 19, 1, 1.38, 1.51],
  ["Ca", 20, 2, 1.0, 1.12],
  ["Sc", 21, 3, 0.745, 0.87],
  ["Ti", 22, 4, 0.605, 0.74],
  ["V", 23, 3, 0.64, null],
  ["Cr", 24, 3, 0.615, null],
  ["Mn", 25, 2, 0.83, 0.96],
  ["Fe", 26, 2, 0.78, 0.92],
  ["Co", 27, 2, 0.745, 0.9],
  ["Ni", 28, 2, 0.69, null],
  ["Cu", 29, 1, 0.77, null],
  ["Zn", 30, 2, 0.74, 0.9],
  ["Ga", 31, 3, 0.62, null],
  ["Ge", 32, 4, 0.53, null],
  ["As", 33, 3, 0.58, null],
  ["Se", 34, null, null, null],
  ["Br", 35, null, null, null],
  ["Kr", 36, null, null, null],
  ["Rb", 37, 1, 1.52, 1.61],
  ["Sr", 38, 2, 1.18, 1.26],
  ["Y", 39, 3, 0.9, 1.019],
  ["Zr", 40, 4, 0.72, 0.84],
  ["Nb", 41, 5, 0.64, 0.74],
  ["Mo", 42, 6, 0.59, null],
  ["Tc", 43, null, null, null],
  ["Ru", 44, null, null, null],
  ["Rh", 45, null, null, null],
  ["Pd", 46, null, null, null],
  ["Ag", 47, 1, 1.15, 1.28],
  ["Cd", 48, 2, 0.95, 1.1],
  ["In", 49, 3, 0.8, 0.92],
  ["Sn", 50, 4, 0.69, 0.81],
  ["Sb", 51, 3, 0.76, null],
  ["Te", 52, null, null, null],
  ["I", 53, null, null, null],
  ["Xe", 54, null, null, null],
  ["Cs", 55, 1, 1.67, 1.74],
  ["Ba", 56, 2, 1.35, 1.42],
  ["La", 57, 3, 1.032, 1.16],
  ["Ce", 58, 3, 1.01, 1.143],
  ["Pr", 59, 3, 0.99, 1.126],
  ["Nd", 60, 3, 0.983, 1.109],
  ["Pm", 61, 3, 0.97, 1.093],
  ["Sm", 62, 3, 0.958, 1.079],
  ["Eu", 63, 3, 0.947, 1.066],
  ["Gd", 64, 3, 0.938, 1.053],
  ["Tb", 65, 3, 0.923, 1.04],
  ["Dy", 66, 3, 0.912, 1.027],
  ["Ho", 67, 3, 0.901, 1.015],
  ["Er", 68, 3, 0.89, 1.004],
  ["Tm", 69, 3, 0.88, 0.994],
  ["Yb", 70, 3, 0.868, 0.985],
  ["Lu", 71, 3, 0.861, 0.977],
  ["Hf", 72, 4, 0.71, 0.83],
  ["Ta", 73, 5, 0.64, 0.74],
  ["W", 74, 6, 0.6, null],
  ["Re", 75, null, null, null],
  ["Os", 76, null, null, null],
  ["Ir", 77, null, null, null],
  ["Pt", 78, null, null, null],
  ["Au", 79, null, null, null],
  ["Hg", 80, 2, 1.02, 1.14],
  ["Tl", 81, 1, 1.5, 1.59],
  ["Pb", 82, 2, 1.19, 1.29],
  ["Bi", 83, 3, 1.03, 1.17],
  ["Po", 84, null, null, null],
  ["Rn", 86, null, null, null],
  ["Ra", 88, null, null, null],
  ["Ac", 89, null, null, null],
  ["Th", 90, 4, 0.94, 1.05],
  ["Pa", 91, null, null, null],
  ["U", 92, 4, 0.89, 1.0],
];

export interface ElementInfo {
  symbol: string;
  number: number;
  valence: number | null;
  radius: { VI: number | null; VIII: number | null };
}

export type Coordination = "VI" | "VIII";

const ELEMENTS: ElementInfo[] = ROWS.map(([symbol, number, valence, vi, viii]) => ({
  symbol,
  number,
  valence,
  radius: { VI: vi, VIII: viii },
}));
const BY_LOWER = new Map(ELEMENTS.map((e) => [e.symbol.toLowerCase(), e]));

/** A column value's element: its symbol in any case ("Na", "NA", " na "). */
export function elementOf(value: string): ElementInfo | undefined {
  return BY_LOWER.get(value.trim().toLowerCase());
}

export type ElementOrder = "incompatible" | "ree" | "atomic";

/** The spider diagram's element orders: [key, menu label, fixed order or
 * null for every element present by atomic number]. */
export const ORDERS: [ElementOrder, string, string[] | null][] = [
  // Sun & McDonough (1989) primitive-mantle spider diagram, by decreasing
  // incompatibility in mantle melting.
  [
    "incompatible",
    "Incompatible elements",
    [
      "Cs",
      "Rb",
      "Ba",
      "Th",
      "U",
      "Nb",
      "Ta",
      "K",
      "La",
      "Ce",
      "Pb",
      "Pr",
      "Sr",
      "P",
      "Nd",
      "Zr",
      "Hf",
      "Sm",
      "Eu",
      "Ti",
      "Gd",
      "Tb",
      "Dy",
      "Y",
      "Ho",
      "Er",
      "Tm",
      "Yb",
      "Lu",
    ],
  ],
  [
    "ree",
    "Rare earth elements",
    ["La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu"],
  ],
  ["atomic", "All elements by atomic number", null],
];

/** The x axis of an order: its fixed elements, or those present by atomic number. */
export function axisElements(order: ElementOrder, present: Iterable<string>): string[] {
  const fixed = ORDERS.find(([key]) => key === order)?.[2];
  if (fixed) return fixed;
  return [...new Set(present)]
    .map((s) => elementOf(s))
    .filter((e): e is ElementInfo => e !== undefined)
    .sort((a, b) => a.number - b.number)
    .map((e) => e.symbol);
}
