// The geologic time scale for an age filter's shortcuts (a range filter with
// `timescale: true`): the ICS International Chronostratigraphic Chart
// v2023/09 (stratigraphy.org), its boundaries in Ma and its CGMW colors
// (drawn as pastels of them).
// Ranks are eon, era, period and epoch; the Carboniferous's row-4 units are
// its subperiods and the Precambrian has no epochs.

export type TimescaleRank = "Eon" | "Era" | "Period" | "Epoch";
export const TIMESCALE_RANKS: TimescaleRank[] = ["Eon", "Era", "Period", "Epoch"];

export interface TimescaleUnit {
  name: string;
  rank: TimescaleRank;
  /** Younger and older boundaries in Ma, each with its ± uncertainty. */
  min: number;
  minSigma?: number;
  max: number;
  maxSigma?: number;
  /** The color it draws in: a pastel of its CGMW color. */
  color: string;
  /** Its CGMW (ICS chart) color. */
  cgmw: string;
}

// [name, younger, older, color, younger σ, older σ]
type Row = [string, number, number, string, number?, number?];
const rows: Record<TimescaleRank, Row[]> = {
  Eon: [
    ["Phanerozoic", 0, 538.8, "#9AD9DD", undefined, 0.2],
    ["Proterozoic", 538.8, 2500, "#F73563", 0.2],
    ["Archean", 2500, 4031, "#F0047F", undefined, 3],
    ["Hadean", 4031, 4567, "#AE027E", 3],
  ],
  Era: [
    ["Cenozoic", 0, 66, "#F2F91D"],
    ["Mesozoic", 66, 251.902, "#67C5CA", undefined, 0.024],
    ["Paleozoic", 251.902, 538.8, "#99C08D", 0.024, 0.2],
    ["Neoproterozoic", 538.8, 1000, "#FEB342", 0.2],
    ["Mesoproterozoic", 1000, 1600, "#FDB462"],
    ["Paleoproterozoic", 1600, 2500, "#F74370"],
    ["Neoarchean", 2500, 2800, "#F99BC1"],
    ["Mesoarchean", 2800, 3200, "#F768A9"],
    ["Paleoarchean", 3200, 3600, "#F4449F"],
    ["Eoarchean", 3600, 4031, "#DA037F", undefined, 3],
  ],
  Period: [
    ["Quaternary", 0, 2.58, "#F9F97F"],
    ["Neogene", 2.58, 23.03, "#FFE619"],
    ["Paleogene", 23.03, 66, "#FD9A52"],
    ["Cretaceous", 66, 145, "#7FC64E"],
    ["Jurassic", 145, 201.4, "#34B2C9", undefined, 0.2],
    ["Triassic", 201.4, 251.902, "#812B92", 0.2, 0.024],
    ["Permian", 251.902, 298.9, "#F04028", 0.024, 0.15],
    ["Carboniferous", 298.9, 358.9, "#67A599", 0.15, 0.4],
    ["Devonian", 358.9, 419.2, "#CB8C37", 0.4, 3.2],
    ["Silurian", 419.2, 443.8, "#B3E1B6", 3.2, 1.5],
    ["Ordovician", 443.8, 485.4, "#009270", 1.5, 1.9],
    ["Cambrian", 485.4, 538.8, "#7FA056", 1.9, 0.2],
    ["Ediacaran", 538.8, 635, "#FED96A", 0.2],
    ["Cryogenian", 635, 720, "#FECC5C"],
    ["Tonian", 720, 1000, "#FEBF4E"],
    ["Stenian", 1000, 1200, "#FED99A"],
    ["Ectasian", 1200, 1400, "#FDCC8A"],
    ["Calymmian", 1400, 1600, "#FDC07A"],
    ["Statherian", 1600, 1800, "#F875A7"],
    ["Orosirian", 1800, 2050, "#F76898"],
    ["Rhyacian", 2050, 2300, "#F75B89"],
    ["Siderian", 2300, 2500, "#F74F7C"],
  ],
  Epoch: [
    ["Holocene", 0, 0.0117, "#FEF2E0"],
    ["Pleistocene", 0.0117, 2.58, "#FFF2AE"],
    ["Pliocene", 2.58, 5.333, "#FFFF99"],
    ["Miocene", 5.333, 23.03, "#FFFF00"],
    ["Oligocene", 23.03, 33.9, "#FEC07A"],
    ["Eocene", 33.9, 56, "#FDB46C"],
    ["Paleocene", 56, 66, "#FDA75F"],
    ["Upper Cretaceous", 66, 100.5, "#A6D84A"],
    ["Lower Cretaceous", 100.5, 145, "#8CCD57"],
    ["Upper Jurassic", 145, 161.5, "#B3E3EE", undefined, 1],
    ["Middle Jurassic", 161.5, 174.7, "#80CFD8", 1, 0.8],
    ["Lower Jurassic", 174.7, 201.4, "#42AED0", 0.8, 0.2],
    ["Upper Triassic", 201.4, 237, "#BD8CC3", 0.2],
    ["Middle Triassic", 237, 247.2, "#B168B1"],
    ["Lower Triassic", 247.2, 251.902, "#983999", undefined, 0.024],
    ["Lopingian", 251.902, 259.51, "#FBA794", 0.024, 0.21],
    ["Guadalupian", 259.51, 273.01, "#FB745C", 0.21, 0.14],
    ["Cisuralian", 273.01, 298.9, "#EF5845", 0.14, 0.15],
    ["Pennsylvanian", 298.9, 323.2, "#99C2B5", 0.15, 0.4],
    ["Mississippian", 323.2, 358.9, "#678F66", 0.4, 0.4],
    ["Upper Devonian", 358.9, 382.7, "#F1E19D", 0.4, 1.6],
    ["Middle Devonian", 382.7, 393.3, "#F1C868", 1.6, 1.2],
    ["Lower Devonian", 393.3, 419.2, "#E5AC4D", 1.2, 3.2],
    ["Pridoli", 419.2, 423, "#E6F5E1", 3.2, 2.3],
    ["Ludlow", 423, 427.4, "#BFE6CF", 2.3, 0.5],
    ["Wenlock", 427.4, 433.4, "#B3E1C2", 0.5, 0.8],
    ["Llandovery", 433.4, 443.8, "#99D7B3", 0.8, 1.5],
    ["Upper Ordovician", 443.8, 458.4, "#7FCA93", 1.5, 0.9],
    ["Middle Ordovician", 458.4, 470, "#4DB47E", 0.9, 1.4],
    ["Lower Ordovician", 470, 485.4, "#1A9D6F", 1.4, 1.9],
    ["Furongian", 485.4, 497, "#B3E095", 1.9],
    ["Miaolingian", 497, 509, "#A6CF86"],
    ["Cambrian Series 2", 509, 521, "#99C078"],
    ["Terreneuvian", 521, 538.8, "#8CB06C", undefined, 0.2],
  ],
};

/** A color blended toward white: a pastel of the same hue ("#F73563" -> "#FBA4B9"
 * at 0.55), so a unit keeps its CGMW color, softened. */
export function pastel(hex: string, amount = 0.55): string {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

// Units draw in pastels of their CGMW colors (`cgmw` keeps the chart's own).
export const TIMESCALE: TimescaleUnit[] = TIMESCALE_RANKS.flatMap((rank) =>
  rows[rank].map(([name, min, max, color, minSigma, maxSigma]) => ({
    name,
    rank,
    min,
    max,
    color: pastel(color),
    cgmw: color,
    minSigma,
    maxSigma,
  })),
);

/** The name a cell has room for: "Upper Cretaceous" -> "Upper". */
export const cellLabel = (unit: TimescaleUnit) =>
  /^(Upper|Middle|Lower) /.test(unit.name)
    ? unit.name.split(" ")[0]
    : unit.name.replace("Cambrian ", "");

/** Black or white text, whichever reads better on a unit's color. */
export function textOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.25 ? "#1f2937" : "#ffffff";
}
