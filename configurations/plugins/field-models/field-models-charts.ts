// echarts options for the Field Models curves: intensity/VADM, declination
// and inclination/ΔI against year, with uncertainty bands, ensemble members
// and the search's measurements (GEOMAGIA model-plots.js, drawn in echarts).
import { LegendComponent, TitleComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsOption } from "@/components/echart";
import { plotColors } from "@/lib/plot-colors";
import {
  type CurveResult,
  deltaInclination,
  gad,
  type LocationGroup,
  type Measurement,
  type Series,
} from "./field-models-data";

// The curve charts' legends (models, regions) and the export figures' titles.
echarts.use([LegendComponent, TitleComponent]);

export type ComponentKey = "intensity" | "vadm" | "decl" | "incl" | "delta_incl";

export interface Component {
  key: ComponentKey;
  label: string;
  unit: string;
  error: "uncertainty" | "vadm_uncertainty" | "decl_uncertainty" | "incl_uncertainty";
  group: LocationGroup;
}

export const COMPONENTS: Record<ComponentKey, Component> = {
  intensity: {
    key: "intensity",
    label: "Intensity",
    unit: "µT",
    error: "uncertainty",
    group: "intensity",
  },
  vadm: {
    key: "vadm",
    label: "VADM",
    unit: "10²² A·m²",
    error: "vadm_uncertainty",
    group: "intensity",
  },
  decl: {
    key: "decl",
    label: "Declination",
    unit: "°",
    error: "decl_uncertainty",
    group: "direction",
  },
  incl: {
    key: "incl",
    label: "Inclination",
    unit: "°",
    error: "incl_uncertainty",
    group: "direction",
  },
  delta_incl: {
    key: "delta_incl",
    label: "ΔI",
    unit: "°",
    error: "incl_uncertainty",
    group: "direction",
  },
};

// GEOMAGIA's model palette, by the model's place in the catalogue.
export const PALETTE = [
  "#205d91",
  "#b34e24",
  "#347f50",
  "#8a5599",
  "#9c6d11",
  "#168188",
  "#b04369",
  "#596b35",
  "#4f60ad",
  "#966346",
  "#793d5a",
  "#497d9f",
  "#8c7843",
  "#795bb2",
  "#30766c",
  "#b06046",
  "#63636b",
];

export function modelColor(model: string, order: string[]): string {
  const index = order.indexOf(model);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
}

function modelValue(component: Component, series: Series, i: number): number | null {
  if (component.key === "delta_incl") return deltaInclination(series.incl[i], series.latitude);
  return series[component.key][i];
}

function dataValue(component: Component, row: Measurement): number | null {
  switch (component.key) {
    case "intensity":
      return row.intensity;
    case "vadm":
      return row.vadm;
    case "decl":
      return row.decl;
    case "incl":
      return row.incl;
    case "delta_incl":
      return deltaInclination(row.incl, row.latitude);
  }
}

function dataError(component: Component, row: Measurement): number | null {
  if (component.key === "intensity") return row.intensityError;
  if (component.key === "vadm") return row.vadmError;
  return null;
}

export function seriesFor(result: CurveResult, component: Component): Series[] {
  return result.series.filter(
    (s) => !s.location_components || s.location_components.includes(component.group),
  );
}

export function locationCount(result: CurveResult, component: Component): number {
  return result.plot_location_counts?.[component.group] ?? result.location_count ?? 1;
}

type Interval = [number, number];

/** The band's intervals at one year: declination splits across ±180 into
 * up to three tracks; inclination is clamped to ±90 (GEOMAGIA band()). */
function intervals(
  component: Component,
  series: Series,
  i: number,
  error: number,
): (Interval | null)[] {
  const center = modelValue(component, series, i);
  if (center === null) return [];
  const lower = center - error;
  const upper = center + error;
  if (component.key === "decl") {
    if (error >= 180) return [[-180, 180]];
    return [
      [Math.max(-180, lower), Math.min(180, upper)],
      lower < -180 ? [lower + 360, 180] : null,
      upper > 180 ? [-180, upper - 360] : null,
    ];
  }
  if (component.key === "incl") return [[Math.max(-90, lower), Math.min(90, upper)]];
  if (component.key === "delta_incl") {
    const reference = gad(series.latitude);
    const incl = series.incl[i];
    if (incl === null) return [];
    return [[Math.max(-90, incl - error) - reference, Math.min(90, incl + error) - reference]];
  }
  return [[lower, upper]];
}

type Segment = [number, number, number][]; // year, lower, upper

function bandSegments(component: Component, series: Series): Segment[] {
  const errors = series[component.error];
  if (!errors) return [];
  const out: Segment[] = [];
  const tracks: Segment[] = [[], [], []];
  const flush = (t: number) => {
    if (tracks[t].length) out.push(tracks[t]);
    tracks[t] = [];
  };
  series.years.forEach((year, i) => {
    if (component.key === "decl" && i > 0) {
      const a = series.decl[i];
      const b = series.decl[i - 1];
      if (a !== null && b !== null && Math.abs(a - b) > 180) [0, 1, 2].forEach(flush);
    }
    const error = errors[i];
    const parts =
      error !== null && Number.isFinite(error) && error >= 0
        ? intervals(component, series, i, error)
        : [];
    tracks.forEach((track, t) => {
      const part = parts[t];
      if (part) track.push([year, part[0], part[1]]);
      else flush(t);
    });
  });
  [0, 1, 2].forEach(flush);
  return out;
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((o) => Number.parseInt(hex.slice(o, o + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

const fmt = (v: unknown, digits = 2) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "Not reported";

export interface CurveChartOptions {
  result: CurveResult;
  component: Component;
  order: string[];
  hidden: Set<string>;
  measurements: Measurement[] | null;
  regionColors: Map<string, string>;
  showErrors: boolean;
  showEnsemble: boolean;
  cursorYear?: number | null;
  /** A figure for export: fixed light colours, larger type, a title. */
  exportTitle?: string;
}

/** One curve chart's echarts option. */
export function curveOption(
  o: CurveChartOptions,
  size: { width: number; height: number },
): EChartsOption {
  const { result, component, order, hidden } = o;
  const exporting = Boolean(o.exportTitle);
  const pc = exporting
    ? {
        text: "#171717",
        axis: "#202020",
        grid: "#dedede",
        surface: "#ffffff",
        tooltip: "#fff",
        tooltipLine: "#ccc",
        tooltipInk: "#333",
      }
    : plotColors();
  const font = exporting ? 18 : 12;
  const many = locationCount(result, component) > 1;
  const series: Record<string, unknown>[] = [];
  const legend: string[] = [];
  const models = [...new Set(seriesFor(result, component).map((s) => s.model))];
  for (const model of models) {
    const color = modelColor(model, order);
    const curves = seriesFor(result, component).filter((s) => s.model === model);
    legend.push(model);
    if (o.showErrors) {
      const segments = curves.flatMap((s) => bandSegments(component, s));
      if (segments.length) {
        series.push({
          name: model,
          type: "custom",
          itemStyle: { color },
          silent: true,
          z: 1,
          clip: true,
          data: segments.map((seg, i) => [
            Math.min(...seg.map((p) => p[0])),
            Math.min(...seg.map((p) => p[1])),
            Math.max(...seg.map((p) => p[0])),
            Math.max(...seg.map((p) => p[2])),
            i,
          ]),
          encode: { x: [0, 2], y: [1, 3] },
          renderItem: (
            params: { dataIndex: number },
            api: { coord: (v: number[]) => number[] },
          ) => {
            const seg = segments[params.dataIndex];
            const points = [
              ...seg.map((p) => api.coord([p[0], p[2]])),
              ...seg
                .slice()
                .reverse()
                .map((p) => api.coord([p[0], p[1]])),
            ];
            return {
              type: "polygon",
              shape: { points },
              style: { fill: rgba(color, many ? 0.04 : 0.16), stroke: "none" },
            };
          },
          tooltip: { show: false },
        });
      }
    }
    if (o.showEnsemble) {
      const data: (number | null)[][] = [];
      for (const s of curves) {
        if (!s.ensemble) continue;
        const source =
          component.key === "vadm"
            ? "intensity"
            : component.key === "delta_incl"
              ? "incl"
              : component.key;
        const factor =
          component.key === "vadm" && s.intensity[0] ? (s.vadm[0] ?? 0) / s.intensity[0] : 1;
        for (const values of s.ensemble[source as "intensity" | "decl" | "incl"]) {
          values.forEach((v, i) => {
            if (component.key === "decl" && i > 0) {
              const prev = values[i - 1];
              if (v !== null && prev !== null && Math.abs(v - prev) > 180)
                data.push([s.years[i], null]);
            }
            const y =
              v === null
                ? null
                : component.key === "delta_incl"
                  ? deltaInclination(v, s.latitude)
                  : v * factor;
            data.push([s.years[i], y]);
          });
          data.push([s.years[s.years.length - 1], null]);
        }
      }
      if (data.length) {
        series.push({
          name: model,
          type: "line",
          data,
          silent: true,
          symbol: "none",
          z: 2,
          connectNulls: false,
          lineStyle: { color, width: 0.8, opacity: 0.09 },
          itemStyle: { color },
          animation: false,
          large: true,
          tooltip: { show: false },
        });
      }
    }
    const data: (number | string | null)[][] = [];
    for (const s of curves) {
      const errors = s[component.error];
      s.years.forEach((year, i) => {
        if (component.key === "decl" && i > 0) {
          const a = s.decl[i];
          const b = s.decl[i - 1];
          if (a !== null && b !== null && Math.abs(a - b) > 180) data.push([year, null]);
        }
        data.push([
          year,
          modelValue(component, s, i),
          s.latitude,
          s.longitude,
          errors?.[i] ?? null,
        ]);
      });
      data.push([s.years[s.years.length - 1], null]);
    }
    series.push({
      name: model,
      type: "line",
      data,
      symbol: "none",
      z: 3,
      connectNulls: false,
      animation: false,
      lineStyle: {
        color,
        width: exporting ? Math.max(2, many ? 1.4 : 2.5) : many ? 1.4 : 2.5,
        opacity: many ? 0.65 : 1,
      },
      itemStyle: { color },
      emphasis: { disabled: true },
      tooltip: {
        formatter: (p: { data: (number | null)[]; seriesName: string }) => {
          const [year, value, lat, lon, error] = p.data;
          return [
            `<b>${p.seriesName}</b>`,
            `Year: ${fmt(year, 0)}`,
            `${component.label}: ${fmt(value)} ${component.unit}`,
            `Latitude: ${lat}°`,
            `Longitude: ${lon}°`,
            `Model uncertainty: ${error !== null && error !== undefined ? `± ${fmt(error)} ${component.unit}` : "Not reported"}`,
          ].join("<br>");
        },
      },
    });
  }
  // The search's measurements, coloured by region, with age and value error bars.
  if (o.measurements) {
    const byRegion = new Map<string, Measurement[]>();
    for (const row of o.measurements) {
      if (dataValue(component, row) === null) continue;
      if (!byRegion.has(row.region)) byRegion.set(row.region, []);
      byRegion.get(row.region)?.push(row);
    }
    for (const [region, rows] of [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const name = `Data — ${region}`;
      const color = o.regionColors.get(region) ?? "#718096";
      legend.push(name);
      series.push({
        name,
        type: "custom",
        itemStyle: { color },
        silent: true,
        z: 4,
        clip: true,
        data: rows.map((r) => {
          const y = dataValue(component, r) ?? 0;
          const e = dataError(component, r) ?? 0;
          return [r.age, y, r.age - (r.ageMinus ?? 0), r.age + (r.agePlus ?? 0), y - e, y + e];
        }),
        encode: { x: [2, 3], y: [4, 5] },
        renderItem: (
          params: { dataIndex: number },
          api: { value: (i: number) => number; coord: (v: number[]) => number[] },
        ) => {
          const [x, y, x0, x1, y0, y1] = [0, 1, 2, 3, 4, 5].map((i) => api.value(i));
          const children: Record<string, unknown>[] = [];
          const style = { stroke: color, lineWidth: exporting ? 1.8 : 0.8 };
          if (x1 > x0) {
            const [a, b] = [api.coord([x0, y]), api.coord([x1, y])];
            children.push({
              type: "line",
              shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
              style,
            });
          }
          if (y1 > y0) {
            const [a, b] = [api.coord([x, y0]), api.coord([x, y1])];
            children.push({
              type: "line",
              shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
              style,
            });
          }
          void params;
          return { type: "group", children };
        },
        tooltip: { show: false },
      });
      series.push({
        name,
        type: "scatter",
        z: 5,
        symbolSize: exporting ? 8 : 6,
        itemStyle: {
          color,
          opacity: exporting ? 1 : 0.85,
          borderColor: exporting ? "#202020" : undefined,
          borderWidth: exporting ? 0.8 : 0,
        },
        data: rows.map((r) => ({ value: [r.age, dataValue(component, r)], row: r })),
        tooltip: {
          formatter: (p: { data: { row: Measurement; value: number[] } }) => {
            const r = p.data.row;
            const err = dataError(component, r);
            return [
              `<b>${region}</b>`,
              `Age: ${fmt(r.age, 0)}`,
              `${component.label}: ${fmt(p.data.value[1])} ${component.unit}`,
              `Locality: ${r.locality}`,
              `Citation: ${r.citation}`,
              `Record: ${r.record}`,
              `Age error: −${r.ageMinus ?? "Not reported"} / +${r.agePlus ?? "Not reported"} yr`,
              `Age error type: ${r.ageErrorType}`,
              `Sigma count: ${r.sigmas}`,
              ...(component.key === "intensity" || component.key === "vadm"
                ? [`${component.label} error: ${err ?? "Not reported"} ${component.unit}`]
                : []),
            ].join("<br>");
          },
        },
      });
    }
  }
  if (o.cursorYear !== null && o.cursorYear !== undefined && Number.isFinite(o.cursorYear)) {
    series.push({
      name: "__cursor",
      type: "line",
      data: [],
      silent: true,
      markLine: {
        symbol: "none",
        silent: true,
        label: { show: false },
        lineStyle: { color: "#7f4a96", width: 1.5, type: "dotted" },
        data: [{ xAxis: o.cursorYear }],
      },
    });
  }
  const legendRows = Math.max(
    1,
    Math.ceil(
      legend.reduce((sum, n) => sum + n.length * 7 + 40, 0) / Math.max(300, size.width - 80),
    ),
  );
  const legendHeight = Math.min(exporting ? 8 : 3, legendRows) * (exporting ? 30 : 20);
  const selected = Object.fromEntries(legend.map((n) => [n, !hidden.has(n)]));
  const empty = seriesFor(result, component).length === 0;
  return {
    animation: false,
    backgroundColor: exporting ? "#ffffff" : "transparent",
    title: exporting
      ? {
          text: o.exportTitle,
          left: "center",
          top: 16,
          textStyle: { fontSize: 24, color: pc.text },
        }
      : empty
        ? {
            text: "No matching measurement locations for model curves",
            left: "center",
            top: "middle",
            textStyle: { fontSize: 13, color: pc.text, fontWeight: "normal" },
          }
        : undefined,
    grid: {
      left: exporting ? 130 : 64,
      right: exporting ? 35 : 20,
      top: exporting ? 80 : 16,
      bottom: (exporting ? 90 : 46) + legendHeight,
      containLabel: false,
    },
    legend: {
      type: exporting ? "plain" : "scroll",
      bottom: 4,
      left: exporting ? 20 : 8,
      right: 8,
      data: legend,
      selected,
      itemWidth: 16,
      itemHeight: 8,
      textStyle: { color: pc.text, fontSize: font },
      pageTextStyle: { color: pc.text },
    },
    tooltip: {
      trigger: "item",
      confine: true,
      backgroundColor: pc.tooltip,
      borderColor: pc.tooltipLine,
      textStyle: { color: pc.tooltipInk, fontSize: 12 },
    },
    xAxis: {
      type: "value",
      name: "Year (BCE − / CE +)",
      nameLocation: "middle",
      nameGap: exporting ? 44 : 26,
      min: result.start_year,
      max: result.end_year,
      nameTextStyle: { color: pc.text, fontSize: exporting ? 22 : 12 },
      axisLine: {
        show: true,
        onZero: false,
        lineStyle: { color: pc.axis, width: exporting ? 1.8 : 1 },
      },
      axisTick: { show: true, length: exporting ? 7 : 4 },
      axisLabel: {
        color: pc.text,
        fontSize: font,
        formatter: (v: number) => String(Math.round(v)),
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      name: `${component.label} (${component.unit})`,
      nameLocation: "middle",
      nameGap: exporting ? 80 : 44,
      nameTextStyle: { color: pc.text, fontSize: exporting ? 22 : 12 },
      axisLine: {
        show: true,
        onZero: false,
        lineStyle: { color: pc.axis, width: exporting ? 1.8 : 1 },
      },
      axisTick: { show: true },
      axisLabel: { color: pc.text, fontSize: font },
      splitLine: { show: true, lineStyle: { color: pc.grid } },
    },
    series,
  };
}

/** Counts for a chart's status line. */
export function chartStatus(o: CurveChartOptions): string {
  const curves = seriesFor(o.result, o.component).length;
  const points = o.measurements
    ? o.measurements.filter((r) => dataValue(o.component, r) !== null).length
    : 0;
  let text = `${curves.toLocaleString()} model curves at ${locationCount(o.result, o.component)} location(s)`;
  if (o.measurements) text += ` · ${points.toLocaleString()} search measurements`;
  if (o.component.key === "delta_incl" && o.measurements) {
    const omitted = o.measurements.filter(
      (r) => r.incl !== null && !Number.isFinite(gad(r.latitude ?? Number.NaN)),
    ).length;
    if (omitted)
      text += ` · ${omitted} inclinations lack a valid latitude and cannot be converted to ΔI`;
  }
  return `${text}.`;
}
