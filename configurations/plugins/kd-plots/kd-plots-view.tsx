// The Kd plots: a search's (or one contribution's) partition coefficients as
// a spider diagram, an Onuma diagram (Kd against ionic radius) or Kd by
// element, coloured by a pattern column. Lazily loaded with echarts.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { EChart, type EChartsOption, PlotsPending } from "@/components/echart";
import { ErrorMessage } from "@/components/error-message";
import { PageSpinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { type PlotColors, plotColors, usePlotColors } from "@/lib/plot-colors";
import type { SearchScope } from "@/lib/types";
import { cx } from "@/lib/utils";
import { isBoolean, isString, useSearchSetting } from "@/plugins";
import {
  type ColorBy,
  type Group,
  groupPatterns,
  type KdData,
  type KdPlotsOptions,
  type KdRow,
  kdDataFrom,
  type Pattern,
  type SearchValues,
  valueFields,
} from "./kd-plots-data";
import { axisElements, type Coordination, type ElementOrder, ORDERS } from "./kd-plots-elements";

export interface KdPlotsViewProps {
  options: KdPlotsOptions;
  query: string;
  ranges: string[];
  bbox?: string;
  /** Only this contribution (the contribution modal's tab). */
  contribution?: string;
  privateKey?: string;
  scope?: SearchScope;
  /** Opens a row's contribution; not given inside its own modal. */
  onOpen?: (contributionId: string) => void;
}

type View = "spider" | "onuma" | "distribution";
const VIEWS: [View, string][] = [
  ["spider", "Spider diagram"],
  ["onuma", "Onuma diagram"],
  ["distribution", "Kd by element"],
];

const CHART_HEIGHT = 440;

export default function KdPlotsView({
  options,
  query,
  ranges,
  bbox,
  contribution,
  privateKey,
  scope,
  onOpen,
}: KdPlotsViewProps) {
  // Only this table's range filters; another level's would match nothing.
  const ownRanges = ranges.filter((r) => r.startsWith(`summary.${options.table}.`));
  const fields = valueFields(options);
  const values = useQuery({
    queryKey: ["plugin", "kd-plots", options.table, query, ownRanges, bbox, contribution, scope],
    queryFn: () =>
      api<SearchValues>(`/search/${options.table}/values`, {
        params: {
          ...scope,
          field: fields,
          query: query || undefined,
          range: ownRanges.length > 0 ? ownRanges : undefined,
          bbox: bbox || undefined,
          contribution,
          private_key: contribution ? privateKey : undefined,
        },
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const data = useMemo(
    () => (values.data ? kdDataFrom(values.data, options) : undefined),
    [values.data, options],
  );

  if (values.isPending) return <PageSpinner label="Loading partition coefficients…" />;
  if (values.error) return <ErrorMessage error={values.error} className="m-4" />;
  if (!data || data.rows.length === 0)
    return (
      <p className="py-6 text-center text-[13px] text-ink-faint">
        No partition coefficients to plot.
      </p>
    );
  return (
    // A new search's values are on their way: the plots still show the last one's.
    <PlotsPending pending={values.isPlaceholderData}>
      <Plots data={data} options={options} onOpen={onOpen} />
    </PlotsPending>
  );
}

function Plots({
  data,
  options,
  onOpen,
}: {
  data: KdData;
  options: KdPlotsOptions;
  onOpen?: (contributionId: string) => void;
}) {
  const colors = usePlotColors();
  // The plot, its coloring, coordination and error bars are settings of the
  // saved search (a shared link keeps them).
  const [view, setView] = useSearchSetting<View>("kd-plots.view", "spider", isString);
  const [colorBy, setColorByState] = useSearchSetting<ColorBy>(
    "kd-plots.color",
    options.pattern_columns[0] ?? "contribution",
    isString,
  );
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const setColorBy = (by: ColorBy) => {
    setColorByState(by);
    setHidden(new Set());
  };
  // The incompatible-element order while most rows are in it, else every
  // element by atomic number; until the reader picks one.
  const [orderPick, setOrder] = useState<ElementOrder | null>(null);
  const autoOrder = useMemo<ElementOrder>(() => {
    const incompatible = new Set(ORDERS[0][2]);
    const inIt = data.rows.filter((r) => incompatible.has(r.element.symbol)).length;
    return inIt * 2 >= data.rows.length ? "incompatible" : "atomic";
  }, [data]);
  const order = orderPick ?? autoOrder;
  const [cn, setCn] = useSearchSetting<Coordination>("kd-plots.cn", "VIII", isString);
  const [errors, setErrors] = useSearchSetting("kd-plots.errors", true, isBoolean);

  const { groups, of } = useMemo(() => groupPatterns(data.patterns, colorBy), [data, colorBy]);
  const ctx = useMemo<ChartContext>(
    () => ({ data, groups, of, hidden, errors, colors, labels: options.labels }),
    [data, groups, of, hidden, errors, colors, options.labels],
  );

  const open = useCallback(
    (value: unknown) => {
      const index = Array.isArray(value) ? Number(value[2]) : Number.NaN;
      const row = data.rows[index];
      if (onOpen && row?.contribution) onOpen(row.contribution);
    },
    [data, onOpen],
  );

  const colorChoices: [ColorBy, string][] = [
    ...options.pattern_columns.map((c): [ColorBy, string] => [c, options.labels[c] ?? c]),
    ["contribution", "Contribution"],
  ];
  const toggle = (i: number) => {
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setHidden(next);
  };

  return (
    <div className="px-3 py-4">
      <section className="min-w-0 rounded-sm border border-gray-300 bg-surface">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 px-3 py-2">
          <div
            role="tablist"
            aria-label="Plot"
            className="flex overflow-hidden rounded-sm border border-gray-300"
          >
            {VIEWS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={cx(
                  "border-l border-gray-300 px-2.5 py-1 text-[13px] first:border-l-0",
                  view === key ? "bg-node font-bold text-white" : "text-gray-700 hover:bg-gray-100",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {view !== "onuma" && (
              <Select
                label="Elements"
                value={order}
                onChange={(v) => setOrder(v as ElementOrder)}
                choices={ORDERS.map(([key, label]) => [key, label])}
              />
            )}
            {view === "onuma" && (
              <Select
                label="Coordination"
                value={cn}
                onChange={(v) => setCn(v as Coordination)}
                choices={[
                  ["VIII", "VIII (eight-fold)"],
                  ["VI", "VI (six-fold)"],
                ]}
              />
            )}
            <Select label="Color by" value={colorBy} onChange={setColorBy} choices={colorChoices} />
            {view !== "distribution" && (
              <label className="flex items-center gap-1 text-[13px] text-gray-600">
                <input
                  type="checkbox"
                  checked={errors}
                  onChange={(e) => setErrors(e.target.checked)}
                />
                Error bars
              </label>
            )}
          </div>
        </header>
        <Legend groups={groups} hidden={hidden} toggle={toggle} />
        <div className="px-1">
          {view === "spider" && <SpiderDiagram ctx={ctx} order={order} onClick={open} />}
          {view === "onuma" && <OnumaDiagram ctx={ctx} cn={cn} onClick={open} />}
          {view === "distribution" && <Distribution ctx={ctx} order={order} onClick={open} />}
        </div>
        <Notes data={data} view={view} order={order} cn={cn} />
      </section>
    </div>
  );
}

const Select = ({
  label,
  value,
  onChange,
  choices,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: [string, string][];
}) => (
  <label className="flex items-center gap-1 text-[13px] text-gray-600">
    {label}
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-sm border border-gray-300 px-1 py-0.5 text-[13px]"
    >
      {choices.map(([key, name]) => (
        <option key={key} value={key}>
          {name}
        </option>
      ))}
    </select>
  </label>
);

/** The colour groups, each a toggle that hides or shows its patterns. */
function Legend({
  groups,
  hidden,
  toggle,
}: {
  groups: Group[];
  hidden: Set<number>;
  toggle: (i: number) => void;
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-2 text-[12px] text-gray-700">
      {groups.map((g, i) =>
        g.patterns === 0 ? null : (
          <li key={g.name}>
            <button
              type="button"
              aria-pressed={!hidden.has(i)}
              onClick={() => toggle(i)}
              title={hidden.has(i) ? "Show" : "Hide"}
              className={cx(
                "flex items-center gap-1.5",
                hidden.has(i) && "opacity-40 line-through",
              )}
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: g.color }}
              />
              {g.name}
              <span className="text-gray-500">
                {g.patterns.toLocaleString()} {g.patterns === 1 ? "pattern" : "patterns"}
              </span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** What isn't plotted and why, and how the values are drawn. */
function Notes({
  data,
  view,
  order,
  cn,
}: {
  data: KdData;
  view: View;
  order: ElementOrder;
  cn: Coordination;
}) {
  const notes: ReactNode[] = [];
  const fixed = ORDERS.find(([key]) => key === order)?.[2];
  if (view !== "onuma" && fixed) {
    const out = countBy(data.rows.filter((r) => !fixed.includes(r.element.symbol)));
    if (out.size)
      notes.push(
        <>
          Not in this element order: {list(out)}. Choose "All elements by atomic number" to see
          them.
        </>,
      );
  }
  if (view === "onuma") {
    const out = countBy(
      data.rows.filter((r) => r.element.valence === null || r.element.radius[cn] === null),
    );
    if (out.size)
      notes.push(
        <>
          No ionic radius in {cn}-fold coordination: {list(out)}.
        </>,
      );
    notes.push(
      <>
        Effective ionic radii of Shannon (1976) for each element's common valence in silicate
        systems (Eu as Eu³⁺, Fe and Mn as 2+, Sn and the HFSE as 4+, Nb, Ta and P as 5+, Mo and W as
        6+); a pattern's elements of one valence are joined by a curve.
      </>,
    );
  }
  if (view !== "distribution")
    notes.push(
      <>
        Filled points are Kd values; hollow points are the geometric middle of a Kd range (or its
        one given end). Error bars are Kd ± σ or the range.
      </>,
    );
  else notes.push(<>Each element's black tick is the median Kd of the shown rows.</>);
  if (data.skipped.noValue)
    notes.push(<>{data.skipped.noValue.toLocaleString()} rows have no positive Kd or range.</>);
  if (data.skipped.unknown.size)
    notes.push(<>Not an element symbol: {list(data.skipped.unknown)}.</>);
  if (data.truncated)
    notes.push(
      <>
        Showing the first {data.rows.length.toLocaleString()} of {data.total.toLocaleString()} rows;
        narrow the search to plot the rest.
      </>,
    );
  return (
    <ul className="list-disc space-y-0.5 border-t border-gray-200 px-3 py-2 pl-7 text-[12px] text-gray-500">
      {notes.map((note, i) => (
        <li key={i}>{note}</li>
      ))}
    </ul>
  );
}

function countBy(rows: KdRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.element.symbol, (out.get(r.element.symbol) ?? 0) + 1);
  return out;
}

const list = (counts: Map<string, number>) =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} (${n})`)
    .join(", ");

// --- Charts --------------------------------------------------------------------------

interface ChartContext {
  data: KdData;
  groups: Group[];
  /** Each pattern's group index. */
  of: number[];
  hidden: Set<number>;
  errors: boolean;
  colors: PlotColors;
  labels: Record<string, string>;
}

const nf = (v: number) => {
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 1e-3 && a < 1e5 ? String(Number(v.toPrecision(3))) : v.toExponential(1);
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A log axis's limits: whole decades around every value and error end. */
function logExtent(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0);
  if (finite.length === 0) return [0.01, 100];
  let lo = 10 ** Math.floor(Math.log10(Math.min(...finite)));
  let hi = 10 ** Math.ceil(Math.log10(Math.max(...finite)));
  if (lo === hi) [lo, hi] = [lo / 10, hi * 10];
  return [lo, hi];
}

const pc = () => plotColors();

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** A decade's label: 0.001 … 1000 as written, else a power of ten (10⁻⁶). */
function decade(v: number): string {
  const exponent = Math.round(Math.log10(v));
  if (exponent >= -3 && exponent <= 3) return nf(v);
  const digits = [...String(Math.abs(exponent))].map((d) => SUPERSCRIPT[Number(d)]).join("");
  return `10${exponent < 0 ? "⁻" : ""}${digits}`;
}

function kdAxis([min, max]: [number, number]) {
  return {
    type: "log",
    name: "Kd",
    nameLocation: "middle",
    nameGap: 44,
    nameTextStyle: { color: pc().text, fontSize: 12 },
    min,
    max,
    // A tick per decade (a log axis's interval is in exponent space).
    interval: 1,
    axisLine: { show: true, lineStyle: { color: pc().axis } },
    axisLabel: { color: pc().text, fontSize: 11, formatter: decade },
    splitLine: { lineStyle: { color: pc().grid } },
  };
}

/** A dashed Kd = 1 line: compatible above, incompatible below. */
const unityLine = (c: PlotColors) => ({
  type: "line",
  data: [],
  silent: true,
  markLine: {
    silent: true,
    symbol: "none",
    lineStyle: { color: c.reference, type: "dashed", width: 1 },
    // Past the plot's right edge, clear of the points.
    label: { formatter: "Kd = 1", color: c.text, fontSize: 11, position: "end" },
    data: [{ yAxis: 1 }],
  },
});

function tooltip(ctx: ChartContext) {
  const c = ctx.colors;
  return {
    trigger: "item",
    confine: true,
    backgroundColor: c.tooltip,
    borderColor: c.tooltipLine,
    textStyle: { color: c.tooltipInk, fontSize: 12 },
    formatter: (params: { value?: unknown }) => {
      const index = Array.isArray(params.value) ? Number(params.value[2]) : Number.NaN;
      const row = ctx.data.rows[index];
      return row ? rowTooltip(row, ctx) : "";
    },
  };
}

function rowTooltip(row: KdRow, ctx: ChartContext): string {
  const pattern = ctx.data.patterns[row.pattern];
  const kd =
    row.kd !== undefined
      ? `Kd ${nf(row.kd)}${row.sigma ? ` ± ${nf(row.sigma)}` : ""}`
      : `Kd ${row.low !== undefined ? nf(row.low) : "?"} – ${row.high !== undefined ? nf(row.high) : "?"}`;
  const range =
    row.kd !== undefined && (row.low !== undefined || row.high !== undefined)
      ? ` (range ${row.low !== undefined ? nf(row.low) : "?"} – ${row.high !== undefined ? nf(row.high) : "?"})`
      : "";
  const attrs = Object.entries(row.attrs)
    .filter(([, v]) => v)
    .map(([c, v]) => `${escapeHtml(ctx.labels[c] ?? c)}: ${escapeHtml(v)}`);
  return [
    `<b>${escapeHtml(row.element.symbol)}</b> ${kd}${range}`,
    ...attrs,
    `${escapeHtml(row.citation ?? "Contribution")} (${escapeHtml(row.contribution)})${
      pattern && pattern.part > 1 ? `, set ${pattern.part}` : ""
    }`,
  ].join("<br/>");
}

/** The shown patterns, "Other" first so the coloured groups draw on top. */
function shownPatterns(ctx: ChartContext): Pattern[] {
  return ctx.data.patterns
    .filter((p) => !ctx.hidden.has(ctx.of[p.index]))
    .sort((a, b) => ctx.of[b.index] - ctx.of[a.index]);
}

/** A plotted row: filled for a Kd, hollow (the plot's surface inside a
 * ring of its colour, either theme) for a range's middle or end. */
const point = (x: number, row: KdRow, symbol: string, color: string, surface: string) => ({
  value: [x, row.value, row.index],
  symbol,
  ...(row.fromRange && {
    itemStyle: { color: surface, borderColor: color, borderWidth: 1.5, opacity: 1 },
  }),
});

/** Vertical error bars with caps, one custom series per colour group;
 * each datum is [x, low end, high end]. */
function errorBars(name: string, color: string, data: [number, number, number][]) {
  return {
    type: "custom",
    name,
    silent: true,
    data,
    encode: { x: 0, y: [1, 2] },
    z: 1,
    renderItem: (
      _params: unknown,
      api: { value: (i: number) => number; coord: (p: number[]) => number[] },
    ) => {
      const [x, y0] = api.coord([api.value(0), api.value(1)]);
      const [, y1] = api.coord([api.value(0), api.value(2)]);
      const style = { stroke: color, lineWidth: 1, opacity: 0.7 };
      return {
        type: "group",
        children: [
          { type: "line", shape: { x1: x, y1: y0, x2: x, y2: y1 }, style },
          { type: "line", shape: { x1: x - 3, y1: y0, x2: x + 3, y2: y0 }, style },
          { type: "line", shape: { x1: x - 3, y1: y1, x2: x + 3, y2: y1 }, style },
        ],
      };
    },
  };
}

function errorData(rows: KdRow[], x: (r: KdRow) => number | undefined): [number, number, number][] {
  return rows.flatMap((r) => {
    const at = x(r);
    if (at === undefined || (r.lo === undefined && r.hi === undefined)) return [];
    return [[at, r.lo ?? r.value, r.hi ?? r.value]];
  });
}

const GRID = { left: 64, right: 52, top: 20, bottom: 48 };

function categoryLabels(c: PlotColors, n: number) {
  return { color: c.text, fontSize: n > 30 ? 10 : 11, interval: 0, rotate: n > 30 ? 90 : 0 };
}

// Spider diagram ----------------------------------------------------------------------

function SpiderDiagram({
  ctx,
  order,
  onClick,
}: {
  ctx: ChartContext;
  order: ElementOrder;
  onClick: (value: unknown) => void;
}) {
  const elements = useMemo(
    () =>
      axisElements(
        order,
        ctx.data.rows.map((r) => r.element.symbol),
      ),
    [order, ctx.data],
  );
  const build = useCallback(() => {
    const c = ctx.colors;
    const at = new Map(elements.map((s, i) => [s, i]));
    const patterns = shownPatterns(ctx);
    const series: Record<string, unknown>[] = [unityLine(c)];
    const plotted: KdRow[] = [];
    const bars = new Map<number, KdRow[]>();
    for (const p of patterns) {
      const group = ctx.groups[ctx.of[p.index]];
      const rows = p.rows
        .filter((r) => at.has(r.element.symbol))
        .sort((a, b) => (at.get(a.element.symbol) ?? 0) - (at.get(b.element.symbol) ?? 0));
      if (rows.length === 0) continue;
      plotted.push(...rows);
      const gi = ctx.of[p.index];
      bars.set(gi, [...(bars.get(gi) ?? []), ...rows]);
      series.push({
        type: "line",
        name: group.name,
        data: rows.map((r) =>
          point(at.get(r.element.symbol) ?? 0, r, "circle", group.color, c.surface),
        ),
        symbolSize: 6,
        showAllSymbol: true,
        lineStyle: { color: group.color, width: 1.5, opacity: 0.75 },
        itemStyle: { color: group.color, borderColor: c.surface, borderWidth: 1 },
        emphasis: { focus: "series", lineStyle: { width: 2.5, opacity: 1 } },
        z: 2,
      });
    }
    if (ctx.errors)
      for (const [gi, rows] of bars) {
        const g = ctx.groups[gi];
        series.push(
          errorBars(
            g.name,
            g.color,
            errorData(rows, (r) => at.get(r.element.symbol)),
          ),
        );
      }
    const ends = plotted.flatMap((r) => [r.value, ...(ctx.errors ? [r.lo, r.hi] : [])]);
    return {
      animation: false,
      grid: { ...GRID, bottom: elements.length > 30 ? 40 : 32 },
      tooltip: tooltip(ctx),
      xAxis: {
        type: "category",
        data: elements,
        boundaryGap: true,
        axisLine: { lineStyle: { color: c.axis } },
        axisTick: { alignWithLabel: true },
        axisLabel: categoryLabels(c, elements.length),
      },
      yAxis: kdAxis(logExtent(ends.filter((v): v is number => v !== undefined))),
      series,
    } as EChartsOption;
  }, [ctx, elements]);
  return (
    <EChart
      build={build}
      height={CHART_HEIGHT}
      onClick={onClick}
      label="Spider diagram of partition coefficients by element"
    />
  );
}

// Onuma diagram -----------------------------------------------------------------------

// A valence's marker; the shape repeats the valence the tooltip names.
const VALENCE_SYMBOLS: Record<number, string> = {
  1: "triangle",
  2: "rect",
  3: "circle",
  4: "diamond",
  5: "pin",
  6: "arrow",
};

function OnumaDiagram({
  ctx,
  cn,
  onClick,
}: {
  ctx: ChartContext;
  cn: Coordination;
  onClick: (value: unknown) => void;
}) {
  const radiusOf = useCallback(
    (r: KdRow) => (r.element.valence === null ? undefined : (r.element.radius[cn] ?? undefined)),
    [cn],
  );
  const valences = useMemo(
    () =>
      [
        ...new Set(ctx.data.rows.flatMap((r) => (radiusOf(r) ? [r.element.valence ?? 0] : []))),
      ].sort(),
    [ctx.data, radiusOf],
  );
  const build = useCallback(() => {
    const c = ctx.colors;
    const patterns = shownPatterns(ctx);
    const rows = patterns.flatMap((p) => p.rows.filter((r) => radiusOf(r) !== undefined));
    const labelled = rows.length <= 150;
    const series: Record<string, unknown>[] = [unityLine(c)];
    // A curve per pattern and valence, through its elements by radius.
    for (const p of patterns) {
      const g = ctx.groups[ctx.of[p.index]];
      const byValence = new Map<number, KdRow[]>();
      for (const r of p.rows) {
        if (radiusOf(r) === undefined) continue;
        const v = r.element.valence ?? 0;
        byValence.set(v, [...(byValence.get(v) ?? []), r]);
      }
      for (const members of byValence.values()) {
        if (members.length < 2) continue;
        series.push({
          type: "line",
          silent: true,
          data: members
            .map((r) => [radiusOf(r), r.value])
            .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)),
          symbol: "none",
          lineStyle: { color: g.color, width: 1, opacity: 0.45 },
          z: 1,
        });
      }
    }
    // Points per colour group and valence.
    const shown = [...new Set(patterns.map((p) => ctx.of[p.index]))].sort((a, b) => b - a);
    for (const gi of shown) {
      const g = ctx.groups[gi];
      const members = rows.filter((r) => ctx.of[r.pattern] === gi);
      for (const v of valences) {
        const symbol = VALENCE_SYMBOLS[v] ?? "circle";
        const data = members
          .filter((r) => r.element.valence === v)
          .map((r) => ({
            ...point(radiusOf(r) ?? 0, r, symbol, g.color, c.surface),
            label: labelled ? { show: true, formatter: r.element.symbol } : undefined,
          }));
        if (data.length === 0) continue;
        series.push({
          type: "scatter",
          name: g.name,
          data,
          symbolSize: 8,
          itemStyle: { color: g.color, borderColor: c.surface, borderWidth: 1 },
          label: { position: "right", distance: 3, color: c.text, fontSize: 10 },
          labelLayout: { hideOverlap: true },
          emphasis: { scale: 1.4 },
          z: 3,
        });
      }
      if (ctx.errors) series.push(errorBars(g.name, g.color, errorData(members, radiusOf)));
    }
    const radii = rows.map((r) => radiusOf(r) ?? 0);
    // Ticks every 0.1 Å, or 0.2 Å over a wide span, from a multiple of the step.
    const [lo, hi] = radii.length
      ? [Math.min(...radii) - 0.05, Math.max(...radii) + 0.05]
      : [0.2, 1.8];
    const step = hi - lo > 1 ? 0.2 : 0.1;
    const rMin = Math.floor(lo / step) * step;
    const rMax = Math.ceil(hi / step) * step;
    const ends = rows.flatMap((r) => [r.value, ...(ctx.errors ? [r.lo, r.hi] : [])]);
    return {
      animation: false,
      grid: GRID,
      tooltip: tooltip(ctx),
      xAxis: {
        type: "value",
        name: `Ionic radius (Å), ${cn}-fold coordination`,
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: c.text, fontSize: 12 },
        min: Math.max(0, rMin),
        max: rMax,
        interval: step,
        axisLine: { lineStyle: { color: c.axis } },
        axisLabel: { color: c.text, fontSize: 11, formatter: (v: number) => v.toFixed(1) },
        splitLine: { lineStyle: { color: c.grid } },
      },
      yAxis: kdAxis(logExtent(ends.filter((v): v is number => v !== undefined))),
      series,
    } as EChartsOption;
  }, [ctx, cn, radiusOf, valences]);
  return (
    <>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 text-[12px] text-gray-600">
        {valences.map((v) => (
          <li key={v} className="flex items-center gap-1.5">
            <ValenceMark symbol={VALENCE_SYMBOLS[v] ?? "circle"} />
            {v}+
          </li>
        ))}
      </ul>
      <EChart
        build={build}
        height={CHART_HEIGHT}
        zoom="xy"
        onClick={onClick}
        label="Onuma diagram of partition coefficients against ionic radius"
      />
    </>
  );
}

/** A valence's marker shape for the legend, in the gray ink. */
function ValenceMark({ symbol }: { symbol: string }) {
  const shapes: Record<string, ReactNode> = {
    triangle: <polygon points="5,1 9,9 1,9" />,
    rect: <rect x="1.5" y="1.5" width="7" height="7" />,
    circle: <circle cx="5" cy="5" r="4" />,
    diamond: <polygon points="5,0.5 9.5,5 5,9.5 0.5,5" />,
    pin: <path d="M5 9.5 L2 5 A3.4 3.4 0 1 1 8 5 Z" />,
    arrow: <polygon points="5,0.5 9,9.5 5,7 1,9.5" />,
  };
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-gray-600" aria-hidden="true">
      {shapes[symbol]}
    </svg>
  );
}

// Kd by element -----------------------------------------------------------------------

/** A row's fixed horizontal jitter in its element's column, ±0.3. */
const jitter = (index: number) => {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 0.6;
};

function Distribution({
  ctx,
  order,
  onClick,
}: {
  ctx: ChartContext;
  order: ElementOrder;
  onClick: (value: unknown) => void;
}) {
  const elements = useMemo(
    () =>
      axisElements(
        order,
        ctx.data.rows.map((r) => r.element.symbol),
      ),
    [order, ctx.data],
  );
  const build = useCallback(() => {
    const c = ctx.colors;
    const at = new Map(elements.map((s, i) => [s, i]));
    const patterns = shownPatterns(ctx);
    const rows = patterns.flatMap((p) => p.rows.filter((r) => at.has(r.element.symbol)));
    const series: Record<string, unknown>[] = [unityLine(c)];
    const shown = [...new Set(patterns.map((p) => ctx.of[p.index]))].sort((a, b) => b - a);
    for (const gi of shown) {
      const g = ctx.groups[gi];
      series.push({
        type: "scatter",
        name: g.name,
        data: rows
          .filter((r) => ctx.of[r.pattern] === gi)
          .map((r) =>
            point(
              (at.get(r.element.symbol) ?? 0) + jitter(r.index),
              r,
              "circle",
              g.color,
              c.surface,
            ),
          ),
        symbolSize: rows.length > 1000 ? 5 : 7,
        itemStyle: { color: g.color, opacity: 0.8, borderColor: c.surface, borderWidth: 0.5 },
        emphasis: { scale: 1.5 },
        z: 2,
      });
    }
    // Each element's median (of logs: the geometric median), as a tick.
    const medians = elements.flatMap((s, i) => {
      const logs = rows
        .filter((r) => r.element.symbol === s)
        .map((r) => Math.log10(r.value))
        .sort((a, b) => a - b);
      if (logs.length === 0) return [];
      const m = logs.length;
      const median = m % 2 ? logs[(m - 1) / 2] : (logs[m / 2 - 1] + logs[m / 2]) / 2;
      return [[i, 10 ** median]];
    });
    series.push({
      type: "custom",
      silent: true,
      data: medians,
      z: 3,
      renderItem: (
        _params: unknown,
        api: { value: (i: number) => number; coord: (p: number[]) => number[] },
      ) => {
        const [x0, y] = api.coord([api.value(0) - 0.4, api.value(1)]);
        const [x1] = api.coord([api.value(0) + 0.4, api.value(1)]);
        return {
          type: "line",
          shape: { x1: x0, y1: y, x2: x1, y2: y },
          style: { stroke: c.strong, lineWidth: 2 },
        };
      },
    });
    return {
      animation: false,
      grid: { ...GRID, bottom: elements.length > 30 ? 40 : 32 },
      tooltip: tooltip(ctx),
      // The elements' names on a category axis; the jittered points on a
      // hidden value axis whose -0.5 … n-0.5 spans the same slots.
      xAxis: [
        {
          type: "category",
          data: elements,
          axisLine: { lineStyle: { color: c.axis } },
          axisTick: { alignWithLabel: true },
          axisLabel: categoryLabels(c, elements.length),
        },
        { type: "value", show: false, min: -0.5, max: elements.length - 0.5 },
      ],
      yAxis: kdAxis(logExtent(rows.map((r) => r.value))),
      series: series.map((s) => ({ ...s, xAxisIndex: 1 })),
    } as EChartsOption;
  }, [ctx, elements]);
  return (
    <EChart
      build={build}
      height={CHART_HEIGHT}
      onClick={onClick}
      label="Partition coefficients by element"
    />
  );
}
