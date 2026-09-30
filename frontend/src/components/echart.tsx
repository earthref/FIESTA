import {
  faArrowPointer,
  faMagnifyingGlassPlus,
  faRotateLeft,
  faUpDownLeftRight,
  type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { CustomChart, LineChart, ScatterChart } from "echarts/charts";
import {
  BrushComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/utils";
import { FaIcon } from "./ui/fa-icon";

echarts.use([
  CustomChart,
  LineChart,
  ScatterChart,
  BrushComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type EChartsOption = echarts.EChartsCoreOption;

/** A brushed range in data coordinates: x only for a histogram's band. */
export type BrushRange = { x: [number, number]; y?: [number, number] };

type Size = { width: number; height: number };

/** What dragging does: brush a selection, draw a box to zoom into, or pan. */
type Mode = "select" | "zoom" | "pan";

type Range = [number, number];
/** The zoomed window per axis, in data coordinates; an absent axis shows its full range. */
type View = { x?: Range; y?: Range };
type AxisKey = keyof View;
type BaseAxis = {
  type?: string;
  min?: unknown;
  max?: unknown;
  axisLabel?: Record<string, unknown>;
};

const WHEEL_STEP = 1.2;

/**
 * One echarts chart, rebuilt from `build` (given its size) whenever that
 * changes. With `brush`, dragging draws a selection ("rect" over x and y,
 * "lineX" a band of x) and `onBrush` gets its range in data coordinates when
 * the drag ends; `onClick` gets a clicked item's value.
 *
 * With `zoom`, a toolbar switches dragging between select, box zoom and pan,
 * the wheel zooms about the cursor (ctrl/⌘ + wheel while selecting, so the page
 * still scrolls), and reset returns to the full view. It zooms by overriding the
 * axes' min/max (which `build` must give as numbers) in their own space, so a log
 * axis zooms and pans by decades, which echarts' dataZoom does not do. "x" zooms
 * only the x axis; "square" keeps both axes at one scale (a stereonet). The view
 * survives rebuilds and resets when an axis's type, name or limits change.
 */
export function EChart({
  build,
  height,
  brush,
  onBrush,
  onClick,
  zoom,
  label,
}: {
  build: (size: Size) => EChartsOption;
  height: number;
  brush?: "rect" | "lineX";
  onBrush?: (range: BrushRange) => void;
  onClick?: (value: unknown) => void;
  zoom?: "xy" | "x" | "square";
  label: string;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [mode, setMode] = useState<Mode | null>(brush ? "select" : null);
  const [zoomed, setZoomed] = useState(false);
  const zoomAxes: AxisKey[] = zoom === "x" ? ["x"] : zoom ? ["x", "y"] : [];
  // Read from the chart's event handlers, which are bound once.
  const live = useRef({ onBrush, onClick, mode, zoom, zoomAxes });
  live.current = { onBrush, onClick, mode, zoom, zoomAxes };
  const base = useRef<{ x?: BaseAxis; y?: BaseAxis; key?: string }>({});
  const view = useRef<View>({});

  // The full range of an axis, or its zoomed window.
  const windowOf = (a: AxisKey): Range | undefined => {
    const b = base.current[a];
    if (view.current[a]) return view.current[a];
    if (typeof b?.min === "number" && typeof b.max === "number") return [b.min, b.max];
    return undefined;
  };

  const axisOption = (a: AxisKey) => {
    const b = base.current[a];
    const w = view.current[a];
    if (!b) return {};
    // A zoomed window's edges are arbitrary numbers, so they aren't labelled.
    return w
      ? { min: w[0], max: w[1], axisLabel: { showMinLabel: false, showMaxLabel: false } }
      : {
          min: b.min,
          max: b.max,
          axisLabel: {
            showMinLabel: b.axisLabel?.showMinLabel,
            showMaxLabel: b.axisLabel?.showMaxLabel,
          },
        };
  };

  const setView = (next: View) => {
    view.current = next;
    setZoomed(Boolean(next.x || next.y));
    chartRef.current?.setOption(
      { xAxis: axisOption("x"), yAxis: axisOption("y") },
      { lazyUpdate: true },
    );
  };

  // Scale every zoomed axis's window by `factor` about a point (in data coordinates).
  const scaleAbout = (point: number[], factor: number) => {
    const next: View = { ...view.current };
    for (const a of live.current.zoomAxes) {
      const w = windowOf(a);
      if (!w) continue;
      const [t, inv] = transform(base.current[a]);
      const c = t(point[a === "x" ? 0 : 1]);
      next[a] = [inv(c - (c - t(w[0])) * factor), inv(c + (t(w[1]) - c) * factor)];
    }
    setView(next);
  };

  // Bound once per chart: the handlers read props through `live` and the view through refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const div = divRef.current;
    if (!div) return;
    const chart = echarts.init(div);
    chartRef.current = chart;
    chart.on("brushEnd", (event: unknown) => {
      const [area] = (event as { areas?: BrushArea[] }).areas ?? [];
      const range = area && toDataRange(chart, area);
      if (!range) return;
      if (live.current.mode !== "zoom") {
        live.current.onBrush?.(range);
        return;
      }
      chart.dispatchAction({ type: "brush", areas: [] });
      setView(boxView(range));
    });
    // A drag that panned ends in a click, which mustn't open the point under it.
    let panned = false;
    chart.on("click", (params: unknown) => {
      if (panned) return;
      live.current.onClick?.((params as { value?: unknown }).value);
    });

    const zr = chart.getZr();
    const inGrid = (x: number, y: number) => chart.containPixel({ gridIndex: 0 }, [x, y]);
    zr.on("mousewheel", (e) => {
      const { mode, zoomAxes } = live.current;
      const native = e.event as unknown as WheelEvent | undefined;
      if (!zoomAxes.length || !inGrid(e.offsetX, e.offsetY)) return;
      if (mode !== "zoom" && mode !== "pan" && !(native?.ctrlKey || native?.metaKey)) return;
      native?.preventDefault();
      const point = chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as number[];
      scaleAbout(point, (e.wheelDelta ?? 0) > 0 ? 1 / WHEEL_STEP : WHEEL_STEP);
    });
    let drag: { x: number; y: number; view: View; px: Record<AxisKey, number> } | null = null;
    zr.on("mousedown", (e) => {
      panned = false;
      if (live.current.mode !== "pan" || !inGrid(e.offsetX, e.offsetY)) return;
      const [x, y] = [windowOf("x"), windowOf("y")];
      if (!x || !y) return;
      // Pixels across each axis's window, signed (y grows downward).
      const [x0, y0] = chart.convertToPixel({ gridIndex: 0 }, [x[0], y[0]]) as number[];
      const [x1, y1] = chart.convertToPixel({ gridIndex: 0 }, [x[1], y[1]]) as number[];
      drag = { x: e.offsetX, y: e.offsetY, view: { x, y }, px: { x: x1 - x0, y: y1 - y0 } };
    });
    zr.on("mousemove", (e) => {
      if (!drag) return;
      const moved = { x: e.offsetX - drag.x, y: e.offsetY - drag.y };
      if (Math.abs(moved.x) + Math.abs(moved.y) > 3) panned = true;
      const next: View = { ...view.current };
      for (const a of live.current.zoomAxes) {
        const w = drag.view[a];
        if (!w || !drag.px[a]) continue;
        const [t, inv] = transform(base.current[a]);
        const shift = (-moved[a] / drag.px[a]) * (t(w[1]) - t(w[0]));
        next[a] = [inv(t(w[0]) + shift), inv(t(w[1]) + shift)];
      }
      setView(next);
    });
    const endDrag = () => {
      drag = null;
    };
    zr.on("mouseup", endDrag);
    zr.on("globalout", endDrag);

    const observer = new ResizeObserver(() => {
      chart.resize();
      setSize({ width: div.clientWidth, height: div.clientHeight });
    });
    observer.observe(div);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // A box drawn in zoom mode, as the new view: x only for "x"; for "square",
  // widened about its centre so both axes keep one scale.
  const boxView = (range: BrushRange): View => {
    const { zoom } = live.current;
    if (zoom === "x" || !range.y) return { ...view.current, x: range.x };
    if (zoom !== "square") return { x: range.x, y: range.y };
    const [x, y] = [windowOf("x"), windowOf("y")];
    if (!x || !y) return view.current;
    const scale = Math.max(
      (range.x[1] - range.x[0]) / (x[1] - x[0]),
      (range.y[1] - range.y[0]) / (y[1] - y[0]),
    );
    const about = (r: Range, w: Range): Range => {
      const [mid, half] = [(r[0] + r[1]) / 2, ((w[1] - w[0]) * scale) / 2];
      return [mid - half, mid + half];
    };
    return { x: about(range.x, x), y: about(range.y, y) };
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: axisOption reads refs, not state
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !size || size.width === 0) return;
    const option = build(size) as { xAxis?: BaseAxis; yAxis?: BaseAxis };
    const key = JSON.stringify(
      [option.xAxis, option.yAxis].map((a) => [
        a?.type,
        (a as { name?: string })?.name,
        a?.min,
        a?.max,
      ]),
    );
    if (key !== base.current.key || !zoom) view.current = {};
    base.current = { x: option.xAxis, y: option.yAxis, key };
    setZoomed(Boolean(view.current.x || view.current.y));
    const brushType = mode === "zoom" ? (zoom === "x" ? "lineX" : "rect") : brush;
    chart.setOption(
      {
        ...option,
        ...(zoom && {
          xAxis: merge(option.xAxis, axisOption("x")),
          yAxis: merge(option.yAxis, axisOption("y")),
        }),
        ...((brush || zoom) && {
          // Dragging brushes (takeGlobalCursor below), so the brush
          // component's tool buttons stay hidden.
          toolbox: { show: false },
          brush: {
            xAxisIndex: 0,
            ...(brushType === "rect" && { yAxisIndex: 0 }),
            brushMode: "single",
            transformable: false,
            brushStyle: { color: "rgba(42,120,214,0.08)", borderColor: "rgba(42,120,214,0.6)" },
            outOfBrush: { opacity: 1 },
          },
        }),
      },
      { notMerge: true },
    );
    if (brush || zoom)
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: {
          brushType: mode === "pan" || !mode ? false : brushType,
          brushMode: "single",
        },
      });
  }, [build, size, brush, zoom, mode]);

  const tools: [Mode, IconDefinition, string][] = [
    ["select", faArrowPointer, "Select: drag to choose points"],
    ["zoom", faMagnifyingGlassPlus, "Box zoom: drag a box to zoom in, wheel to zoom"],
    ["pan", faUpDownLeftRight, "Pan: drag to move, wheel to zoom"],
  ];
  const shown = brush ? tools : tools.filter(([m]) => m !== "select");

  return (
    <div className="group relative">
      <div
        ref={divRef}
        style={{ height, width: "100%" }}
        role="img"
        aria-label={label}
        className={cx(
          mode === "pan"
            ? "cursor-move"
            : mode === "zoom"
              ? "cursor-zoom-in"
              : mode && "cursor-crosshair",
        )}
      />
      {zoom && (
        <div
          role="toolbar"
          aria-label={`${label}: tools`}
          className={cx(
            "absolute top-0 right-1 flex gap-px rounded-sm border border-gray-200 bg-white/90 p-px text-[12px] text-gray-600 transition-opacity",
            "opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
            (zoomed || mode !== (brush ? "select" : null)) && "opacity-100",
          )}
        >
          {shown.map(([m, icon, title]) => (
            <button
              key={m}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={mode === m}
              onClick={() => setMode(mode === m && !brush ? null : m)}
              className={cx(
                "flex h-6 w-6 items-center justify-center rounded-sm hover:bg-gray-100",
                mode === m && "bg-gray-200 text-gray-900 hover:bg-gray-200",
              )}
            >
              <FaIcon icon={icon} />
            </button>
          ))}
          <button
            type="button"
            title="Reset axes"
            aria-label="Reset axes"
            disabled={!zoomed}
            onClick={() => setView({})}
            className="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <FaIcon icon={faRotateLeft} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A log axis zooms and pans in log10 space, a value axis linearly. */
function transform(axis?: BaseAxis): [(v: number) => number, (v: number) => number] {
  return axis?.type === "log" ? [Math.log10, (v) => 10 ** v] : [(v) => v, (v) => v];
}

/** An axis option with a view's min/max (and label flags) laid over it. */
function merge(axis: BaseAxis | undefined, over: { axisLabel?: Record<string, unknown> }) {
  return axis && { ...axis, ...over, axisLabel: { ...axis.axisLabel, ...over.axisLabel } };
}

type BrushArea = {
  brushType?: string;
  range?: number[] | number[][];
  coordRange?: number[] | number[][];
};

/** A brush area in data coordinates, from its coordRange or its pixels. */
function toDataRange(chart: echarts.ECharts, area: BrushArea): BrushRange | null {
  const sorted = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);
  if (area.coordRange) {
    const c = area.coordRange;
    if (Array.isArray(c[0])) {
      const [xs, ys] = c as number[][];
      return { x: sorted(xs[0], xs[1]), y: sorted(ys[0], ys[1]) };
    }
    const xs = c as number[];
    return { x: sorted(xs[0], xs[1]) };
  }
  if (!area.range) return null;
  const toData = (px: [number, number]) =>
    chart.convertFromPixel({ gridIndex: 0 }, px) as unknown as [number, number];
  if (Array.isArray(area.range[0])) {
    const [[x0, x1], [y0, y1]] = area.range as number[][];
    const [a, b] = [toData([x0, y0]), toData([x1, y1])];
    return { x: sorted(a[0], b[0]), y: sorted(a[1], b[1]) };
  }
  const [x0, x1] = area.range as number[];
  return { x: sorted(toData([x0, 0])[0], toData([x1, 0])[0]) };
}
