// echarts options for each PmagPy plot type, drawn as PmagPy draws them
// (pmagplotlib: plot_eq/plot_di, plot_zij, plot_mag, plot_arai, plot_np, plot_hys).

import type { EChartsOption } from "../../components/echart";
import {
  type AraiSpecimen,
  type Coord,
  circleRuns,
  type DemagSpecimen,
  type Direction,
  type DirectionSet,
  dir2cart,
  directionsIn,
  equalArea,
  type HystLoop,
  nf,
  stepLabel,
} from "./pmag-plots-data";

export interface Size {
  width: number;
  height: number;
}

const TEXT = "#52514e";
const GRID_LINE = "#ebeae6";
const NET = "#8a8984";
const RED = "#d62728";
const BLUE = "#1f77b4";
const GREEN = "#2ca02c";
const PURPLE = "#9467bd";
const BAD = "#9a9a95";

type Point = {
  value: (number | string)[];
  tip?: string;
  itemStyle?: object;
  symbol?: string;
};

const tooltip = {
  trigger: "item",
  confine: true,
  textStyle: { fontSize: 12 },
  formatter: (params: { data?: Point }) => params.data?.tip ?? "",
};

const hidden = { show: false };

/** A square plot area centered in the chart, for plots that need equal axes. */
function squareGrid({ width, height }: Size, pad = 22) {
  const side = Math.max(80, Math.min(width - 2 * pad, height - 2 * pad));
  return {
    width: side,
    height: side,
    left: (width - side) / 2,
    top: (height - side) / 2,
  };
}

function textMarks(marks: { text: string; at: [number, number]; position: string }[]) {
  return marks.map(({ text, at, position }) => ({
    type: "scatter",
    silent: true,
    symbolSize: 0,
    data: [{ value: at, name: text }],
    label: {
      show: true,
      formatter: "{b}",
      color: TEXT,
      fontSize: 11,
      position,
    },
    tooltip: { show: false },
  }));
}

// --- equal area ----------------------------------------------------------------------------

const RIM = Array.from({ length: 181 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 180;
  return [Math.sin(a), Math.cos(a)];
});

/** The net: its rim, 10° ticks on the rim and the axes, and a center cross. */
function netSeries() {
  const ticks: (number[] | string)[] = [];
  for (let az = 0; az < 360; az += 10) {
    const [x, y] = equalArea(az, 0);
    ticks.push([x, y], [x * 0.96, y * 0.96], "-");
  }
  for (const az of [0, 90, 180, 270])
    for (let inc = 10; inc < 90; inc += 10) {
      const [x, y] = equalArea(az, inc);
      const [dx, dy] = [
        0.02 * Math.cos((az * Math.PI) / 180),
        -0.02 * Math.sin((az * Math.PI) / 180),
      ];
      ticks.push([x - dx, y - dy], [x + dx, y + dy], "-");
    }
  const line = (data: unknown[], width = 1) => ({
    type: "line",
    data,
    silent: true,
    symbol: "none",
    lineStyle: { color: NET, width },
    tooltip: { show: false },
  });
  return [
    line(RIM),
    line(ticks, 0.8),
    line([[-0.03, 0], [0.03, 0], "-", [0, -0.03], [0, 0.03]]),
    ...textMarks([{ text: "N", at: [0, 1.02], position: "top" }]),
  ];
}

function netOption(size: Size, series: unknown[]): EChartsOption {
  const axis = {
    type: "value",
    min: -1.02,
    max: 1.02,
    axisLine: hidden,
    axisTick: hidden,
    axisLabel: hidden,
    splitLine: hidden,
  };
  return {
    animation: false,
    grid: squareGrid(size),
    xAxis: axis,
    yAxis: axis,
    tooltip,
    series: [...netSeries(), ...series],
  } as EChartsOption;
}

const dirTip = (title: string, dec: number, inc: number, extra: string[] = []) =>
  [`<b>${escapeHtml(title)}</b>`, `Dec ${nf(dec)}°, Inc ${nf(inc)}°`, ...extra].join("<br/>");

/** Points on the net: lower hemisphere filled, upper open (pmagplotlib.plot_di). */
function directionPoints(
  name: string,
  points: { dec: number; inc: number; tip: string; bad?: boolean }[],
  color: string,
  symbol = "circle",
  symbolSize = 7,
) {
  return {
    type: "scatter",
    name,
    symbol,
    symbolSize,
    z: 3,
    data: points.map(({ dec, inc, tip, bad }) => ({
      value: equalArea(dec, inc),
      tip,
      ...(bad && { symbol: "diamond" }),
      itemStyle:
        inc >= 0
          ? { color: bad ? BAD : color, borderColor: "#fff", borderWidth: 0.5 }
          : { color: "#fff", borderColor: bad ? BAD : color, borderWidth: 1.5 },
    })),
  };
}

/** A circle about a direction: solid on the lower hemisphere, dashed on the upper. */
function circleSeries(dec: number, inc: number, radius: number, color: string, width = 1) {
  return circleRuns(dec, inc, radius).map((run) => ({
    type: "line",
    data: run.points,
    silent: true,
    symbol: "none",
    lineStyle: { color, width, type: run.lower ? "solid" : "dashed" },
    tooltip: { show: false },
  }));
}

function meanSeries(mean: NonNullable<DirectionSet["mean"]>, title = "Fisher mean") {
  const extra = [
    `N ${mean.n}`,
    ...(mean.a95 !== undefined ? [`α95 ${nf(mean.a95)}°`] : []),
    ...(mean.k !== undefined ? [`k ${nf(mean.k)}`] : []),
  ];
  return [
    ...(mean.a95 !== undefined ? circleSeries(mean.dec, mean.inc, mean.a95, RED, 1.5) : []),
    directionPoints(
      title,
      [
        {
          dec: mean.dec,
          inc: mean.inc,
          tip: dirTip(title, mean.dec, mean.inc, extra),
        },
      ],
      RED,
      "triangle",
      12,
    ),
  ];
}

/** Interpreted directions of a site, sample or specimen group. */
export function directionSetOption(size: Size, set: DirectionSet): EChartsOption {
  const lines = set.dirs.filter((d) => !d.plane);
  const planes = set.dirs.filter((d) => d.plane);
  const tip = (d: Direction) =>
    dirTip(d.name, d.dec, d.inc, [
      ...(d.comp ? [escapeHtml(d.comp)] : []),
      ...(d.a95 !== undefined ? [`α95 ${nf(d.a95)}°`] : []),
    ]);
  return netOption(size, [
    ...planes.flatMap((d) => circleSeries(d.dec, d.inc, 90, PURPLE)),
    directionPoints(
      "Directions",
      lines.map((d) => ({ dec: d.dec, inc: d.inc, tip: tip(d) })),
      BLUE,
      "circle",
      size.width > 400 ? 8 : 6,
    ),
    ...(set.mean ? meanSeries(set.mean) : []),
  ]);
}

/** A specimen's demagnetization steps on the net, joined in order, with its
 * interpretations in this coordinate system (pmagplotlib.plot_eq in zeq_magic). */
export function stepsNetOption(size: Size, specimen: DemagSpecimen, coord: Coord): EChartsOption {
  const dirs = directionsIn(specimen, coord);
  if (!dirs) return netOption(size, []);
  const { steps } = specimen;
  const points = dirs.dec.map((dec, i) => ({
    dec,
    inc: dirs.inc[i],
    bad: steps.bad[i] === 1,
    tip: dirTip(stepLabel(steps.kind[i], steps.value[i]), dec, dirs.inc[i], [
      `M ${nf(steps.m[i])} ${specimen.unit}`,
      ...(steps.bad[i] ? ["Flagged bad"] : []),
    ]),
  }));
  const fits = specimen.fits.filter((fit) => fit.coord === coord);
  return netOption(size, [
    {
      type: "line",
      data: points.map((p) => equalArea(p.dec, p.inc)),
      silent: true,
      symbol: "none",
      lineStyle: { color: NET, width: 1 },
      tooltip: { show: false },
    },
    // Fits first, so the steps they summarize stay on top.
    ...fits.flatMap((fit): unknown[] =>
      fit.type === "plane"
        ? circleSeries(fit.dec, fit.inc, 90, PURPLE, 1.5)
        : [
            directionPoints(
              fit.comp || "Fit",
              [
                {
                  dec: fit.dec,
                  inc: fit.inc,
                  tip: dirTip(fitTitle(fit), fit.dec, fit.inc),
                },
              ],
              RED,
              "diamond",
              14,
            ),
          ],
    ),
    directionPoints("Steps", points, BLUE, "circle", size.width > 400 ? 8 : 6),
  ]);
}

export function fitTitle(fit: DemagSpecimen["fits"][number]): string {
  const kind = {
    line: "Best-fit line",
    plane: "Best-fit plane",
    mean: "Fisher mean",
  }[fit.type];
  return `${fit.comp ? `${fit.comp}: ` : ""}${kind}`;
}

// --- Zijderveld ----------------------------------------------------------------------------

/** Orthogonal vector projections with North to the right (pmagplotlib.plot_zij):
 * horizontal (N, E) as filled red circles, vertical (N, Down) as open blue
 * squares, East and Down plotted downwards; best-fit lines dashed. */
export function zijderveldOption(
  size: Size,
  specimen: DemagSpecimen,
  coord: Coord,
  large: boolean,
): EChartsOption {
  const dirs = directionsIn(specimen, coord) ?? specimen.steps;
  const { steps } = specimen;
  const vectors = dirs.dec.map((dec, i) => dir2cart(dec, dirs.inc[i], steps.m[i]));
  const xs = [0, ...vectors.map((v) => v[0])];
  const ys = [0, ...vectors.flatMap((v) => [-v[1], -v[2]])];
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const span = Math.max(x1 - x0, y1 - y0) * 1.12 || 1;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const range = {
    x: [cx - span / 2, cx + span / 2],
    y: [cy - span / 2, cy + span / 2],
  };

  const tip = (i: number, projection: string) =>
    [
      `<b>${escapeHtml(stepLabel(steps.kind[i], steps.value[i]))}</b> · ${projection}`,
      `Dec ${nf(dirs.dec[i])}°, Inc ${nf(dirs.inc[i])}°`,
      `M ${nf(steps.m[i])} ${escapeHtml(specimen.unit)}`,
      ...(steps.bad[i] ? ["Flagged bad"] : []),
    ].join("<br/>");
  const projection = (
    name: string,
    pick: (v: number[]) => number,
    color: string,
    symbol: string,
    filled: boolean,
  ) => ({
    type: "line",
    name,
    symbol,
    symbolSize: large ? 8 : 6,
    z: 3,
    lineStyle: { color, width: 1 },
    itemStyle: filled
      ? { color, borderColor: "#fff", borderWidth: 0.5 }
      : { color: "#fff", borderColor: color, borderWidth: 1.5 },
    data: vectors.map((v, i) => ({
      value: [v[0], pick(v)],
      tip: tip(i, name),
      ...(steps.bad[i] && {
        symbol: "diamond",
        itemStyle: { color: BAD, borderColor: BAD },
      }),
    })),
  });

  const fitLines = specimen.fits
    .filter((fit) => fit.coord === coord && fit.type === "line")
    .flatMap((fit) => {
      const chosen = vectors.filter((_, i) => {
        const value = steps.value[i];
        return (
          !steps.bad[i] &&
          value !== null &&
          (fit.min === null || value >= fit.min - 1e-6) &&
          (fit.max === null || value <= fit.max + 1e-6)
        );
      });
      if (chosen.length < 2) return [];
      const c = [0, 1, 2].map((k) => chosen.reduce((sum, v) => sum + v[k], 0) / chosen.length);
      const d = dir2cart(fit.dec, fit.inc, span);
      const ends = [-1, 1].map((sign) => c.map((value, k) => value + sign * d[k]));
      return [
        { pick: (v: number[]) => -v[1], color: RED },
        { pick: (v: number[]) => -v[2], color: BLUE },
      ].map(({ pick, color }) => ({
        type: "line",
        silent: true,
        symbol: "none",
        data: ends.map((v) => [v[0], pick(v)]),
        lineStyle: { color, width: 1, type: "dashed", opacity: 0.8 },
        tooltip: { show: false },
      }));
    });

  const axis = (min: number, max: number) => ({
    type: "value",
    min,
    max,
    axisLine: { onZero: true, lineStyle: { color: NET } },
    axisTick: hidden,
    axisLabel: hidden,
    splitLine: hidden,
  });
  return {
    animation: false,
    grid: squareGrid(size, 26),
    xAxis: axis(range.x[0], range.x[1]),
    yAxis: axis(range.y[0], range.y[1]),
    tooltip,
    series: [
      ...fitLines,
      projection("Horizontal (N, E)", (v) => -v[1], RED, "circle", true),
      projection("Vertical (N, Down)", (v) => -v[2], BLUE, "rect", false),
      ...textMarks([
        { text: "N", at: [range.x[1], 0], position: "right" },
        { text: "W, Up", at: [0, range.y[1]], position: "top" },
        { text: "E, Down", at: [0, range.y[0]], position: "bottom" },
      ]),
    ],
  } as EChartsOption;
}

// --- x/y plots -----------------------------------------------------------------------------

function xyAxis(name: string, extra: object = {}) {
  return {
    type: "value",
    name,
    nameLocation: "middle",
    nameGap: 26,
    nameTextStyle: { color: TEXT, fontSize: 11 },
    axisLabel: { color: TEXT, fontSize: 10, formatter: (v: number) => nf(v) },
    axisLine: { lineStyle: { color: NET } },
    splitLine: { lineStyle: { color: GRID_LINE } },
    ...extra,
  };
}

function xyOption(x: object, y: object, series: unknown[]): EChartsOption {
  return {
    animation: false,
    grid: { left: 52, right: 16, top: 16, bottom: 42 },
    xAxis: x,
    yAxis: { ...y, nameGap: 40 },
    tooltip,
    series,
  } as EChartsOption;
}

/** The step kind a demagnetization plot's x axis shows: the specimen's most
 * common besides the NRM. */
function mainKind(specimen: DemagSpecimen) {
  const counts = new Map<string, number>();
  for (const kind of specimen.steps.kind)
    if (kind !== "NRM") counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "AF";
}

/** Intensity over the maximum against the treatment (pmagplotlib.plot_mag). */
export function demagOption(_size: Size, specimen: DemagSpecimen, large: boolean): EChartsOption {
  const kind = mainKind(specimen);
  const { steps } = specimen;
  const index = steps.kind.flatMap((k, i) =>
    (k === kind || k === "NRM") && steps.value[i] !== null ? [i] : [],
  );
  const max = Math.max(...index.map((i) => steps.m[i])) || 1;
  const unit = kind === "AF" ? "mT" : kind === "MW" ? "W" : "°C";
  return xyOption(
    xyAxis(`Treatment (${unit})`, { min: 0 }),
    xyAxis(`M / Mmax (Mmax ${nf(max)} ${specimen.unit})`, { min: 0 }),
    [
      {
        type: "line",
        symbolSize: large ? 8 : 6,
        lineStyle: { color: RED, width: 1.2 },
        itemStyle: { color: RED, borderColor: "#fff", borderWidth: 0.5 },
        data: index.map((i) => ({
          value: [steps.value[i] ?? 0, steps.m[i] / max],
          tip: [
            `<b>${escapeHtml(stepLabel(steps.kind[i], steps.value[i]))}</b>`,
            `M ${nf(steps.m[i])} ${escapeHtml(specimen.unit)} (${nf(steps.m[i] / max)} of max)`,
            ...(steps.bad[i] ? ["Flagged bad"] : []),
          ].join("<br/>"),
          ...(steps.bad[i] && { symbol: "diamond", itemStyle: { color: BAD } }),
        })),
      },
    ],
  );
}

/** NRM remaining against pTRM gained, both over the NRM (pmagplotlib.plot_arai):
 * ZI steps red circles, IZ steps blue squares, pTRM checks green triangles
 * (joined to the step they follow and the step they repeat), tail checks
 * purple squares; the published interpretation's fit dashed. */
export function araiOption(_size: Size, specimen: AraiSpecimen, large: boolean): EChartsOption {
  const { steps, ptrm_checks: checks, tail_checks: tails, fit } = specimen;
  const at = new Map(steps.t.map((t, i) => [t, [steps.x[i], steps.y[i]]]));
  const stepTip = (i: number) =>
    [
      `<b>${steps.order[i] === "NRM" ? "NRM" : `${nf(steps.t[i])} °C`}</b>${steps.order[i] !== "NRM" ? ` · ${steps.order[i]}` : ""}`,
      `pTRM gained ${nf(steps.x[i])}`,
      `NRM remaining ${nf(steps.y[i])}`,
    ].join("<br/>");
  const stepPoints = (order: "ZI" | "IZ", color: string, symbol: string, filled: boolean) => ({
    type: "scatter",
    name: order,
    symbol,
    symbolSize: large ? 9 : 7,
    z: 3,
    itemStyle: filled
      ? { color, borderColor: "#fff", borderWidth: 0.5 }
      : { color: "#fff", borderColor: color, borderWidth: 1.5 },
    label: large
      ? {
          show: true,
          position: "right",
          fontSize: 10,
          color: TEXT,
          formatter: (p: { data: { t: number } }) => nf(p.data.t),
        }
      : undefined,
    data: steps.t.flatMap((t, i) =>
      (steps.order[i] === "IZ") === (order === "IZ")
        ? [{ value: [steps.x[i], steps.y[i]], t, tip: stepTip(i) }]
        : [],
    ),
  });
  const checkLines: (number[] | string)[] = [];
  checks.t.forEach((t, i) => {
    const from = at.get(checks.t_from[i]);
    const original = at.get(t);
    if (from) checkLines.push(from, [checks.x[i], checks.y[i]]);
    if (original) checkLines.push([checks.x[i], original[1]]);
    checkLines.push("-");
  });
  const series: unknown[] = [
    {
      type: "line",
      data: steps.x.map((x, i) => [x, steps.y[i]]),
      silent: true,
      symbol: "none",
      lineStyle: { color: NET, width: 1 },
      tooltip: { show: false },
    },
    {
      type: "line",
      data: checkLines,
      silent: true,
      symbol: "none",
      lineStyle: { color: GREEN, width: 1 },
      tooltip: { show: false },
    },
    stepPoints("ZI", RED, "circle", true),
    stepPoints("IZ", BLUE, "rect", false),
    {
      type: "scatter",
      name: "pTRM checks",
      symbol: "triangle",
      symbolSize: large ? 10 : 8,
      z: 4,
      itemStyle: { color: "#fff", borderColor: GREEN, borderWidth: 1.5 },
      data: checks.t.map((t, i) => ({
        value: [checks.x[i], checks.y[i]],
        tip: `<b>pTRM check at ${nf(t)} °C</b><br/>after ${nf(checks.t_from[i])} °C<br/>pTRM ${nf(checks.x[i])}`,
      })),
    },
    {
      type: "scatter",
      name: "Tail checks",
      symbol: "rect",
      symbolSize: large ? 8 : 6,
      z: 4,
      itemStyle: { color: PURPLE },
      data: tails.t.map((t, i) => ({
        value: [tails.x[i], tails.y[i]],
        tip: `<b>pTRM tail check at ${nf(t)} °C</b><br/>NRM remaining ${nf(tails.y[i])}`,
      })),
    },
  ];
  if (fit?.b !== undefined && fit.x_mean !== undefined && fit.y_mean !== undefined) {
    const { b, x_mean: xm, y_mean: ym } = fit;
    const chosen = steps.x.filter(
      (_, i) =>
        (fit.min === null || steps.t[i] >= fit.min - 0.5) &&
        (fit.max === null || steps.t[i] <= fit.max + 0.5),
    );
    const [lo, hi] = [Math.min(...chosen), Math.max(...chosen)];
    const pad = (hi - lo) * 0.08;
    series.unshift({
      type: "line",
      data: [lo - pad, hi + pad].map((x) => [x, ym + b * (x - xm)]),
      silent: true,
      symbol: "none",
      lineStyle: { color: "#333", width: 1.5, type: "dashed" },
      tooltip: { show: false },
    });
  }
  return xyOption(
    xyAxis("pTRM gained / NRM₀", { min: 0 }),
    xyAxis("NRM remaining / NRM₀", { min: 0 }),
    series,
  );
}

/** NRM lost and pTRM gained against temperature (pmagplotlib.plot_np). */
export function deremagOption(_size: Size, specimen: AraiSpecimen, large: boolean): EChartsOption {
  const { steps } = specimen;
  const curve = (name: string, values: number[], color: string, symbol: string) => ({
    type: "line",
    name,
    symbol,
    symbolSize: large ? 8 : 6,
    lineStyle: { color, width: 1.2 },
    itemStyle: { color, borderColor: "#fff", borderWidth: 0.5 },
    data: steps.t.map((t, i) => ({
      value: [t, values[i]],
      tip: `<b>${steps.order[i] === "NRM" ? "NRM" : `${nf(t)} °C`}</b><br/>${name} ${nf(values[i])}`,
    })),
  });
  return xyOption(xyAxis("Temperature (°C)", { min: 0 }), xyAxis("Fraction of NRM₀", { min: 0 }), [
    curve("NRM remaining", steps.y, RED, "circle"),
    curve("pTRM gained", steps.x, BLUE, "rect"),
  ]);
}

/** Moment against applied field, with lines through the origin (pmagplotlib.plot_hys). */
export function hysteresisOption(_size: Size, loop: HystLoop, large: boolean): EChartsOption {
  const [f0, f1] = [Math.min(...loop.field), Math.max(...loop.field)];
  const [m0, m1] = [Math.min(...loop.m), Math.max(...loop.m)];
  return xyOption(xyAxis("Field (mT)"), xyAxis(`M (${loop.unit})`), [
    {
      type: "line",
      data: [[f0, 0], [f1, 0], "-", [0, m0], [0, m1]],
      silent: true,
      symbol: "none",
      lineStyle: { color: NET, width: 1 },
      tooltip: { show: false },
    },
    {
      type: "line",
      symbol: "circle",
      symbolSize: large ? 3 : 2,
      lineStyle: { color: BLUE, width: 1 },
      itemStyle: { color: BLUE },
      large: loop.field.length > 5000,
      data: loop.field.map((field, i) => ({
        value: [field, loop.m[i]],
        tip: `${nf(field)} mT<br/>M ${nf(loop.m[i])} ${escapeHtml(loop.unit)}`,
      })),
    },
  ]);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
