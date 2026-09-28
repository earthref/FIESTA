import { CustomChart, LineChart, ScatterChart } from "echarts/charts";
import {
  BrushComponent,
  GridComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";

echarts.use([
  CustomChart,
  LineChart,
  ScatterChart,
  BrushComponent,
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

/**
 * One echarts chart, rebuilt from `build` (given its size) whenever that
 * changes. With `brush`, dragging always draws a selection ("rect" over x and
 * y, "lineX" a band of x) and `onBrush` gets its range in data coordinates
 * when the drag ends; `onClick` gets a clicked item's value.
 */
export function EChart({
  build,
  height,
  brush,
  onBrush,
  onClick,
  label,
}: {
  build: (size: Size) => EChartsOption;
  height: number;
  brush?: "rect" | "lineX";
  onBrush?: (range: BrushRange) => void;
  onClick?: (value: unknown) => void;
  label: string;
}) {
  const divRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const handlers = useRef({ onBrush, onClick });
  handlers.current = { onBrush, onClick };

  useEffect(() => {
    const div = divRef.current;
    if (!div) return;
    const chart = echarts.init(div);
    chartRef.current = chart;
    chart.on("brushEnd", (event: unknown) => {
      const [area] = (event as { areas?: BrushArea[] }).areas ?? [];
      const range = area && toDataRange(chart, area);
      if (range) handlers.current.onBrush?.(range);
    });
    chart.on("click", (params: unknown) => {
      handlers.current.onClick?.((params as { value?: unknown }).value);
    });
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

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !size || size.width === 0) return;
    chart.setOption(
      {
        ...build(size),
        ...(brush && {
          // Dragging always brushes (takeGlobalCursor below), so the brush
          // component's tool buttons stay hidden.
          toolbox: { show: false },
          brush: {
            xAxisIndex: 0,
            ...(brush === "rect" && { yAxisIndex: 0 }),
            brushMode: "single",
            transformable: false,
            brushStyle: { color: "rgba(42,120,214,0.08)", borderColor: "rgba(42,120,214,0.6)" },
            outOfBrush: { opacity: 1 },
          },
        }),
      },
      { notMerge: true },
    );
    if (brush)
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: { brushType: brush, brushMode: "single" },
      });
  }, [build, size, brush]);

  return (
    <div
      ref={divRef}
      style={{ height, width: "100%" }}
      role="img"
      aria-label={label}
      className={brush ? "cursor-crosshair" : undefined}
    />
  );
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
