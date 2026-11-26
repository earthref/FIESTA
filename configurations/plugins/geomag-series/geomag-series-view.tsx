import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LegendComponent, TitleComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { useCallback, useMemo, useState } from "react";
import { EChart, type EChartsOption, PlotsPending } from "@/components/echart";
import { ErrorMessage } from "@/components/error-message";
import type { SearchParams } from "@/components/filter-modals";
import { useColumnLabel } from "@/components/filter-modals";
import { Icon } from "@/components/ui/icon";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useNodeConfig } from "@/lib/config";
import { type PlotColors, plotColors, usePlotColors } from "@/lib/plot-colors";
import type { NodeConfig } from "@/lib/types";
import { cx, facetTitle } from "@/lib/utils";
import { useSearchSetting } from "@/plugins";
import {
  type ColorGroup,
  type Component,
  paramsFile,
  type SearchValues,
  type SeriesData,
  type SeriesOptions,
  type SeriesRecord,
  saveBlob,
  seriesFrom,
  timestamp,
  valueFields,
  type ZipFile,
  zipArchive,
} from "./geomag-series-data";

// The exported figures' legend and title (the screen's legend is HTML).
echarts.use([LegendComponent, TitleComponent]);

const CHART_HEIGHT = 260;
type Range = [number, number];

interface Plot {
  component: Component;
  label: string;
  unit: string;
  /** Its file name part (geomagia_<name>_<time>.png). */
  name: string;
  value: (r: SeriesRecord) => number | null;
  /** The y error bar's lower / upper length; none drawn without. */
  minus?: (r: SeriesRecord) => number | null;
  plus?: (r: SeriesRecord) => number | null;
}

function plotsOf(options: SeriesOptions): Record<Component, Plot> {
  return {
    ba: {
      component: "ba",
      label: "Intensity",
      unit: options.intensity_unit,
      name: "intensity",
      value: (r) => r.ba,
      minus: (r) => r.sigmaBa,
      plus: (r) => r.sigmaBa,
    },
    vadm: {
      component: "vadm",
      label: "VADM",
      unit: "10²² A·m²",
      name: "vadm",
      value: (r) => r.vadm,
      minus: (r) => r.sigmaVadm,
      plus: (r) => r.sigmaVadm,
    },
    decl: {
      component: "decl",
      label: "Declination",
      unit: "°",
      name: "declination",
      value: (r) => r.decl,
    },
    incl: {
      component: "incl",
      label: "Inclination",
      unit: "°",
      name: "inclination",
      value: (r) => r.incl,
    },
  };
}

export interface GeomagSeriesViewProps {
  options: SeriesOptions;
  /** The level search's request params (the sub-tab context's). */
  searchParams: SearchParams;
  /** Opens a record's contribution. */
  onOpen?: (contributionId: string) => void;
}

/**
 * The Plots view: the level's matching records against age, as the GEOMAGIA
 * site's search plots: intensity (or VADM) with its error bars, declination
 * and inclination, each with the age's error bars, coloured by region. Zooming
 * or panning one plot's ages moves the others', and the window is kept when
 * the search or the intensity/VADM choice redraws them.
 */
export default function GeomagSeriesView({ options, searchParams, onOpen }: GeomagSeriesViewProps) {
  const config = useNodeConfig().data;
  const fields = useMemo(() => valueFields(options), [options]);
  const values = useQuery({
    queryKey: ["plugin", "geomag-series", "values", options.table, fields, searchParams],
    queryFn: () =>
      api<SearchValues>(`/search/${options.table}/values`, {
        params: { ...searchParams, field: fields },
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const data = useMemo(
    () => (values.data ? seriesFrom(values.data, options) : null),
    [values.data, options],
  );
  const plots = useMemo(() => plotsOf(options), [options]);
  const [mode, setMode] = useSearchSetting<"ba" | "vadm">(
    "geomag-series.mode",
    "ba",
    (value) => value === "ba" || value === "vadm",
  );
  const [xView, setXView] = useState<Range | null>(null);
  const onXView = useCallback((x: Range | undefined) => setXView(x ?? null), []);
  const [status, setStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const columnLabel = useColumnLabel(options.table ?? "");
  const hoverLabels = useMemo(
    () =>
      options.hover.map((c) =>
        c.startsWith("summary.") ? facetTitle(c.split(".").pop() ?? c) : columnLabel(c),
      ),
    [options.hover, columnLabel],
  );

  if (values.isPending) return <PageSpinner label="Loading records…" />;
  if (values.error) return <ErrorMessage error={values.error} className="my-3" />;
  if (!data || !config) return null;
  if (data.records.length === 0)
    return (
      <p className="py-8 text-center text-[13px] text-ink-muted">
        No matching measurements with known ages are available to plot.
      </p>
    );

  const shown: Plot[] = [
    ...(options.intensity ? [plots[mode]] : []),
    ...(options.declination ? [plots.decl] : []),
    ...(options.inclination ? [plots.incl] : []),
  ];
  const exportable: Plot[] = [
    ...(options.intensity ? [plots.ba, plots.vadm] : []),
    ...(options.declination ? [plots.decl] : []),
    ...(options.inclination ? [plots.incl] : []),
  ];
  const label = mode === "vadm" ? "VADM" : "intensity";
  const missingLatitude = data.counts.ba - data.counts.vadm;

  const run = async (what: string, files: () => Promise<ZipFile[]>, name: string) => {
    if (exporting) return;
    setExporting(true);
    setStatus(`Preparing ${what}…`);
    try {
      saveBlob(zipArchive(await files()), name);
      setStatus(`Downloaded ${name}`);
    } catch {
      setStatus(`The ${what} could not be exported. Please try again.`);
    } finally {
      setExporting(false);
    }
  };
  const exportPlots = (chosen: Plot[], name: (stamp: string) => string, what: string) => {
    const stamp = timestamp();
    return run(
      what,
      async () => [
        ...chosen.map((plot) => ({
          name: `${options.export_name}_${plot.name}_${stamp}.png`,
          data: figurePng(config, options, data, plot, xView, hoverLabels),
        })),
        paramsFile(config, options, searchParams, data, stamp),
      ],
      name(stamp),
    );
  };

  return (
    <div className="space-y-3 py-2 text-[13px] text-ink">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-ink">
          {options.intensity && (
            <>
              <b>{data.counts[mode].toLocaleString()}</b> {label},{" "}
            </>
          )}
          <b>{data.counts.decl.toLocaleString()}</b> declination and{" "}
          <b>{data.counts.incl.toLocaleString()}</b> inclination measurements.
          {data.omitted > 0 &&
            ` ${data.omitted.toLocaleString()} records with unknown ages are omitted.`}
          {mode === "vadm" &&
            missingLatitude > 0 &&
            ` ${missingLatitude.toLocaleString()} intensity records without valid site latitudes are omitted from VADM.`}
          {values.data?.truncated &&
            ` (The first ${values.data.rows.length.toLocaleString()} of ${values.data.total.toLocaleString()} matches.)`}
        </span>
        <button
          type="button"
          disabled={exporting}
          onClick={() =>
            exportPlots(
              exportable,
              (stamp) => `${options.export_name}_graphs_${stamp}.zip`,
              "graphs",
            )
          }
          title="The intensity, VADM, declination and inclination plots as PNGs, with the search's parameters (params.txt)"
          className="rounded-sm border border-gray-300 bg-surface px-2 py-1 font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Download Graphs
        </button>
        {values.isFetching && <span className="text-ink-muted">Updating…</span>}
        {status && (
          <span className="text-ink-muted" aria-live="polite">
            {status}
          </span>
        )}
      </div>
      <p className="text-ink-muted">
        Drag a box or use the wheel to zoom (the plots share their ages); click a point to open its
        contribution.
        {xView && (
          <button
            type="button"
            onClick={() => setXView(null)}
            className="ml-2 font-bold text-node-ink hover:underline"
          >
            Show every age
          </button>
        )}
      </p>
      {shown.map((plot) => (
        <section key={plot.label} className="rounded-sm border border-line bg-surface p-2">
          <header className="mb-1 flex flex-wrap items-center gap-2">
            <h3 className="font-bold">{plot.label}</h3>
            {(plot.component === "ba" || plot.component === "vadm") && (
              <fieldset aria-label="Intensity or VADM" className="flex">
                {(["ba", "vadm"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cx(
                      "border border-gray-300 px-2 py-0.5 first:rounded-l-sm last:rounded-r-sm",
                      mode === m ? "bg-node font-bold text-white" : "bg-surface hover:bg-gray-50",
                    )}
                  >
                    {m === "ba" ? "Intensity" : "VADM"}
                  </button>
                ))}
              </fieldset>
            )}
            {plot.component === "vadm" && !options.vadm && (
              <span className="text-ink-muted">
                Calculated from the intensity and each site's own latitude.
              </span>
            )}
            <button
              type="button"
              disabled={exporting}
              onClick={() =>
                exportPlots(
                  [plot],
                  (stamp) => `${options.export_name}_${plot.name}_${stamp}.zip`,
                  `${plot.label} PNG`,
                )
              }
              title="Download PNG and search parameters"
              aria-label={`Download the ${plot.label} plot as a PNG with the search parameters`}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40"
            >
              <Icon name="camera" />
            </button>
          </header>
          {/* A new search's records are on their way: the plot still shows the last one's. */}
          <PlotsPending pending={values.isPlaceholderData}>
            <SeriesPlot
              data={data}
              options={options}
              plot={plot}
              hoverLabels={hoverLabels}
              xView={xView}
              onXView={onXView}
              onOpen={onOpen}
            />
          </PlotsPending>
        </section>
      ))}
      {options.color_by && <Legend groups={data.groups} />}
    </div>
  );
}

function SeriesPlot({
  data,
  options,
  plot,
  hoverLabels,
  xView,
  onXView,
  onOpen,
}: {
  data: SeriesData;
  options: SeriesOptions;
  plot: Plot;
  hoverLabels: string[];
  xView: Range | null;
  onXView: (x: Range | undefined) => void;
  onOpen?: (contributionId: string) => void;
}) {
  const colors = usePlotColors();
  const build = useCallback(
    () => seriesOption(data, options, plot, hoverLabels, colors, "screen"),
    [data, options, plot, hoverLabels, colors],
  );
  const open = onOpen
    ? (value: unknown) => {
        const index = Array.isArray(value) ? Number(value[2]) : Number.NaN;
        const id = data.records[index]?.contribution;
        if (id) onOpen(id);
      }
    : undefined;
  return (
    <EChart
      build={build}
      height={CHART_HEIGHT}
      zoom="xy"
      xView={xView}
      onXView={onXView}
      onClick={open}
      label={`${plot.label} versus age, with age${plot.minus ? ` and ${plot.label}` : ""} error bars`}
    />
  );
}

function Legend({ groups }: { groups: ColorGroup[] }) {
  return (
    <details className="rounded-sm border border-line bg-surface px-3 py-2" open>
      <summary className="cursor-pointer font-bold">Region colours ({groups.length})</summary>
      <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1">
        {groups.map((g) => (
          <li key={g.key} className="flex items-center gap-1.5">
            <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0" aria-hidden="true">
              <circle cx="6" cy="6" r="5" fill={g.color} />
            </svg>
            {g.name}
          </li>
        ))}
      </ul>
    </details>
  );
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const nf = (v: number) => String(Number(v.toPrecision(6)));

/** Round an extent outward to a 1/2/5 step, about a tenth of it. */
function niceExtent([lo, hi]: Range): Range {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 10;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? power * 10;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

const errors = (minus: number | null, plus: number | null) =>
  minus === null && plus === null
    ? "not reported"
    : `${minus === null ? "lower not reported" : `−${nf(minus)}`} / ${
        plus === null ? "upper not reported" : `+${nf(plus)}`
      }`;

type Style = "screen" | "print";

/** A plot's echarts option: the age error bars (and the y error bars, for
 * intensity and VADM) under the points, one scatter series per colour. */
function seriesOption(
  data: SeriesData,
  options: SeriesOptions,
  plot: Plot,
  hoverLabels: string[],
  colors: PlotColors,
  style: Style,
): EChartsOption {
  const print = style === "print";
  const ink = print ? "#171717" : colors.text;
  const groupColor = (g: ColorGroup) => g.color || colors.node;
  const groupIndex = new Map(data.groups.map((g, i) => [g.key, i]));
  const rows = data.records.filter((r) => plot.value(r) !== null);
  const bars = rows.map((r) => {
    const y = plot.value(r) ?? 0;
    return [
      r.age,
      y,
      r.age - (r.ageMinus ?? 0),
      r.age + (r.agePlus ?? 0),
      y - (plot.minus?.(r) ?? 0),
      y + (plot.plus?.(r) ?? 0),
      groupIndex.get(r.group) ?? 0,
    ];
  });
  const barColors = data.groups.map(groupColor);
  const width = print ? 1.8 : 0.7;
  const cap = print ? 2.5 : 1;
  const errorBars = {
    type: "custom",
    name: "",
    silent: true,
    clip: true,
    z: 1,
    data: bars,
    encode: { x: [0, 2, 3], y: plot.minus ? [1, 4, 5] : [1] },
    renderItem: (
      params: { coordSys: { x: number; y: number; width: number; height: number } },
      api: { value: (i: number) => number; coord: (p: number[]) => number[] },
    ) => {
      const [x, y] = [api.value(0), api.value(1)];
      const stroke = barColors[api.value(6)] ?? colors.muted;
      const line = (x1: number, y1: number, x2: number, y2: number) => ({
        type: "line",
        shape: { x1, y1, x2, y2 },
        style: { stroke, lineWidth: width },
      });
      // Bars are cut at the plot's edges (a zoomed window, a long age range).
      const box = params.coordSys;
      const [x0, x1, y0, y1] = [box.x, box.x + box.width, box.y, box.y + box.height];
      const inX = (v: number) => v >= x0 && v <= x1;
      const inY = (v: number) => v >= y0 && v <= y1;
      const clampX = (v: number) => Math.min(x1, Math.max(x0, v));
      const clampY = (v: number) => Math.min(y1, Math.max(y0, v));
      const children = [];
      const [left, py] = api.coord([api.value(2), y]);
      const [right] = api.coord([api.value(3), y]);
      if (right - left > 0.5 && inY(py) && right >= x0 && left <= x1) {
        children.push(line(clampX(left), py, clampX(right), py));
        if (inX(left)) children.push(line(left, py - cap, left, py + cap));
        if (inX(right)) children.push(line(right, py - cap, right, py + cap));
      }
      if (plot.minus) {
        const [px, low] = api.coord([x, api.value(4)]);
        const [, high] = api.coord([x, api.value(5)]);
        if (low - high > 0.5 && inX(px) && low >= y0 && high <= y1) {
          children.push(line(px, clampY(low), px, clampY(high)));
          if (inY(low)) children.push(line(px - cap, low, px + cap, low));
          if (inY(high)) children.push(line(px - cap, high, px + cap, high));
        }
      }
      return { type: "group", children };
    },
  };
  const scatter = data.groups.map((g) => ({
    type: "scatter",
    name: g.name,
    z: 2,
    symbolSize: print ? 8 : 5,
    itemStyle: {
      color: groupColor(g),
      opacity: print ? 1 : 0.8,
      ...(print && { borderColor: "#202020", borderWidth: 0.8 }),
    },
    emphasis: { scale: 1.6 },
    data: rows.filter((r) => r.group === g.key).map((r) => [r.age, plot.value(r), r.index]),
  }));
  const [xMin, xMax] = niceExtent(data.ageRange ?? [0, 1]);
  const axis = (name: string) => ({
    type: "value",
    name,
    nameLocation: "middle",
    nameTextStyle: { color: ink, fontSize: print ? 22 : 12 },
    axisLabel: { color: ink, fontSize: print ? 18 : 11, hideOverlap: true },
    axisLine: {
      show: true,
      onZero: false,
      lineStyle: { color: print ? "#202020" : colors.axis, width: print ? 1.8 : 1 },
    },
    axisTick: { show: true, lineStyle: { color: print ? "#202020" : colors.axis } },
    splitLine: { lineStyle: { color: print ? "#dedede" : colors.grid } },
  });
  const unit = plot.unit;
  return {
    animation: false,
    backgroundColor: print ? "#ffffff" : "transparent",
    textStyle: { fontFamily: print ? "Arial, Helvetica, sans-serif" : undefined },
    grid: print
      ? { left: 130, right: 40, top: 80, bottom: 0, containLabel: false }
      : { left: 64, right: 18, top: 12, bottom: 44 },
    xAxis: {
      ...axis(options.age_label),
      min: xMin,
      max: xMax,
      nameGap: print ? 46 : 28,
      splitLine: { show: !print, lineStyle: { color: colors.grid } },
    },
    yAxis: { ...axis(`${plot.label} (${unit})`), scale: true, nameGap: print ? 86 : 46 },
    tooltip: print
      ? { show: false }
      : {
          trigger: "item",
          confine: true,
          textStyle: { fontSize: 12 },
          formatter: (params: { value?: unknown[]; color?: string }) => {
            const r = data.records[Number(params.value?.[2])];
            if (!r) return "";
            const value = plot.value(r);
            const group = data.groups.find((g) => g.key === r.group);
            const lines = [
              `Age: ${nf(r.age)} ${escapeHtml(options.age_unit)}`,
              `${plot.label}: ${value === null ? "" : nf(value)} ${escapeHtml(unit)}`,
              plot.minus
                ? `${plot.label} error: ${errors(plot.minus(r), plot.plus?.(r) ?? null)} ${escapeHtml(unit)}`
                : "",
              plot.component === "decl" || plot.component === "incl"
                ? `α95: ${r.alpha95 === null ? "not reported" : `${nf(r.alpha95)}°`}`
                : "",
              options.color_by && group ? `Region: ${escapeHtml(group.name)}` : "",
              `Age error: ${errors(r.ageMinus, r.agePlus)} ${escapeHtml(options.age_unit)}`,
              options.age_error_type
                ? `Age error type: ${escapeHtml(r.ageErrorType ?? "Not specified")}${
                    r.sigmas ? ` (${r.sigmas}σ)` : ""
                  }`
                : "",
              ...hoverLabels.map((name, i) =>
                r.hover[i] && !["-1", "0"].includes(r.hover[i] ?? "")
                  ? `${escapeHtml(name)}: ${escapeHtml(r.hover[i] ?? "")}`
                  : "",
              ),
            ];
            return lines.filter(Boolean).join("<br/>");
          },
        },
    series: [errorBars, ...scatter],
  };
}

/** The legend's rows at the exported figure's width, as the site estimates them. */
function legendRows(groups: ColorGroup[]): number {
  const fontSize = 18;
  const width = 1035;
  let rows = groups.length ? 1 : 0;
  let row = 0;
  for (const g of groups) {
    const item = Math.min(width, g.name.length * fontSize * 0.6 + 65);
    if (row && row + item > width) {
      rows++;
      row = 0;
    }
    row += item;
  }
  return rows;
}

/** A plot as a publication PNG (1200 px wide at 3× scale, as the site's),
 * over the ages shown, with its title and the regions' legend. */
function figurePng(
  config: NodeConfig,
  options: SeriesOptions,
  data: SeriesData,
  plot: Plot,
  xView: Range | null,
  hoverLabels: string[],
): Uint8Array {
  const shown = data.groups.filter((g) =>
    data.records.some((r) => r.group === g.key && plot.value(r) !== null),
  );
  const rows = options.color_by ? legendRows(shown) : 0;
  const bottom = 140 + rows * 30;
  const height = 80 + 520 + bottom;
  const div = document.createElement("div");
  div.style.cssText = `position:fixed;left:-10000px;top:0;width:1200px;height:${height}px`;
  document.body.appendChild(div);
  const chart = echarts.init(div, undefined, { renderer: "canvas", width: 1200, height });
  try {
    const option = seriesOption(data, options, plot, hoverLabels, plotColors(), "print") as {
      grid: Record<string, unknown>;
      xAxis: Record<string, unknown>;
    };
    option.grid = { ...option.grid, bottom };
    if (xView) option.xAxis = { ...option.xAxis, min: xView[0], max: xView[1] };
    chart.setOption({
      ...option,
      title: {
        text: `${config.key} — ${plot.label}`,
        left: "center",
        top: 18,
        textStyle: { fontSize: 24, color: "#171717", fontWeight: "normal" },
      },
      ...(options.color_by && {
        legend: {
          data: shown.map((g) => g.name),
          bottom: 16,
          left: 40,
          width: 1100,
          icon: "circle",
          itemGap: 18,
          textStyle: { fontSize: 18, color: "#171717" },
        },
      }),
    });
    const url = chart.getDataURL({ type: "png", pixelRatio: 3, backgroundColor: "#ffffff" });
    const binary = atob(url.split(",")[1] ?? "");
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } finally {
    chart.dispose();
    div.remove();
  }
}
