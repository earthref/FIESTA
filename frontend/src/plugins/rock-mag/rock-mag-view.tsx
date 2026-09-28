import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { ErrorMessage } from "../../components/error-message";
import { PageSpinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import { cx } from "../../lib/utils";
import { type BrushRange, EChart, type EChartsOption } from "./echart";
import {
  axisName,
  COLOR_BY,
  type ColorBy,
  DAY_BOUNDARIES,
  equalArea,
  type Group,
  groupSpecimens,
  PARAMS,
  type Param,
  type ParamKey,
  paramOf,
  quantile,
  SD_SQUARENESS,
  type SearchValues,
  type Specimen,
  specimensCsv,
  specimensFrom,
  TRANSITIONS,
  VALUE_FIELDS,
} from "./rock-mag-data";

const CHART_HEIGHT = 300;
const TEXT = "#52514e";
const GRID_LINE = "#ebeae6";
const REFERENCE = "#6b6b66";
const FADED = 0.12;

export interface RockMagViewProps {
  query: string;
  ranges: string[];
  bbox?: string;
  /** Only this contribution (the contribution modal's tab). */
  contribution?: string;
  privateKey?: string;
  /** Opens a specimen's contribution; not given inside its own modal. */
  onOpen?: (contributionId: string) => void;
}

/** A brushed selection: which panel made it and the specimens in it. */
type Selection = { panel: string; indices: Set<number> };

/**
 * The Rock Magnetism view: every matching specimen's rock-magnetic
 * parameters on linked plots. Dragging over a plot selects the specimens
 * under it on every plot (the rest fade) and lists them below.
 */
export default function RockMagView({
  query,
  ranges,
  bbox,
  contribution,
  privateKey,
  onOpen,
}: RockMagViewProps) {
  // Only this view's range filters: others (the Poles view's) name fields its
  // docs don't have, and would match nothing.
  const ownRanges = ranges.filter((r) => r.startsWith("summary.rock_mag."));
  const values = useQuery({
    queryKey: ["plugin", "rock-mag", "values", query, ownRanges, bbox, contribution],
    queryFn: () =>
      api<SearchValues>("/search/rock_mag/values", {
        params: {
          field: VALUE_FIELDS,
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

  const specimens = useMemo(() => (values.data ? specimensFrom(values.data) : []), [values.data]);
  const [colorBy, setColorBy] = useState<ColorBy>("none");
  const groups = useMemo(() => groupSpecimens(specimens, colorBy), [specimens, colorBy]);
  const [selection, setSelection] = useState<Selection | null>(null);
  // A new search starts without a selection.
  const [selectionFor, setSelectionFor] = useState(values.data);
  if (selectionFor !== values.data) {
    setSelectionFor(values.data);
    setSelection(null);
  }
  const selected = selection?.indices ?? null;

  const select = useCallback(
    (panel: string, test: (s: Specimen) => boolean) => {
      setSelection({
        panel,
        indices: new Set(specimens.filter(test).map((s) => s.index)),
      });
    },
    [specimens],
  );

  const open = onOpen
    ? (value: unknown) => {
        const index = Array.isArray(value) ? Number(value[value.length - 1]) : Number.NaN;
        const id = specimens[index]?.contribution;
        if (id) onOpen(id);
      }
    : undefined;

  if (values.isPending) return <PageSpinner label="Loading rock magnetic data…" />;
  if (values.error) return <ErrorMessage error={values.error} className="my-3" />;
  if (specimens.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-gray-500">
        No specimens with rock magnetic data match this search.
      </p>
    );
  }

  const panelProps = { groups, specimens, selected, select, open };
  const count = (key: ParamKey) => specimens.filter((s) => s[key] !== undefined).length;

  return (
    <div className="space-y-3 py-2 text-[13px]">
      {/* Summary + controls: one row above the plots */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-gray-700">
          <b>{specimens.length.toLocaleString()}</b> specimens
          {values.data?.truncated && ` (the first of ${values.data.total.toLocaleString()})`}:{" "}
          {count("mr_ms").toLocaleString()} hysteresis · {count("tc").toLocaleString()} critical
          temperatures · {count("chi_mass").toLocaleString()} susceptibilities ·{" "}
          {count("pj").toLocaleString()} anisotropy
        </span>
        <label className="flex items-center gap-1.5">
          <span className="font-bold">Color by</span>
          <select
            value={colorBy}
            onChange={(e) => setColorBy(e.target.value as ColorBy)}
            className="rounded-sm border border-gray-300 px-1.5 py-1"
          >
            {COLOR_BY.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => downloadCsv(specimens)}
          className="rounded-sm border border-gray-300 bg-white px-2 py-1 font-bold text-gray-700 hover:bg-gray-50"
        >
          Download CSV
        </button>
        {values.isFetching && <span className="text-gray-500">Updating…</span>}
      </div>
      {colorBy !== "none" && <Legend groups={groups} />}
      <p className="text-gray-500">
        Drag over a plot to select specimens on every plot; click a point to open its contribution.
      </p>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <DayPlot {...panelProps} />
        <SquarenessPlot {...panelProps} />
        <TransitionsPlot {...panelProps} />
        <JelinekPlot {...panelProps} />
        <DistributionPanel {...panelProps} />
        <StereonetPanel {...panelProps} />
        <ExplorerPanel {...panelProps} />
      </div>

      {selection && (
        <SelectionTable
          specimens={specimens.filter((s) => selection.indices.has(s.index))}
          onClear={() => setSelection(null)}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

function downloadCsv(specimens: Specimen[]) {
  const blob = new Blob([specimensCsv(specimens)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "rock-magnetism.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function Legend({ groups }: { groups: Group[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-gray-700">
      {groups.map((g) => (
        <span key={g.name} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: g.color }} />
          {g.name} ({g.members.length.toLocaleString()})
        </span>
      ))}
    </div>
  );
}

// --- Panels ------------------------------------------------------------------------------

interface PanelProps {
  groups: Group[];
  specimens: Specimen[];
  selected: Set<number> | null;
  select: (panel: string, test: (s: Specimen) => boolean) => void;
  open?: (value: unknown) => void;
}

function Panel({
  title,
  subtitle,
  controls,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-sm border border-gray-300 bg-white">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">{title}</h4>
        {subtitle && <span className="text-[12px] text-gray-500">{subtitle}</span>}
        {controls && <div className="ml-auto flex flex-wrap items-center gap-2">{controls}</div>}
      </header>
      <div className="px-1">{children}</div>
    </section>
  );
}

const LogToggle = ({
  log,
  setLog,
  label,
}: {
  log: boolean;
  setLog: (log: boolean) => void;
  label: string;
}) => (
  <label className="flex items-center gap-1 text-[12px] text-gray-600">
    <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
    {label}
  </label>
);

const ParamSelect = ({
  value,
  onChange,
  label,
}: {
  value: ParamKey;
  onChange: (key: ParamKey) => void;
  label: string;
}) => (
  <label className="flex items-center gap-1 text-[12px] text-gray-600">
    {label}
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ParamKey)}
      className="rounded-sm border border-gray-300 px-1 py-0.5 text-[12px]"
    >
      {PARAMS.map((p) => (
        <option key={p.key} value={p.key}>
          {axisName(p)}
        </option>
      ))}
    </select>
  </label>
);

const nf = (value: number) =>
  Math.abs(value) >= 1e4 || (Math.abs(value) < 1e-2 && value !== 0)
    ? value.toExponential(2)
    : Number(value.toPrecision(3)).toString();

/** Axis limits over most of the values (0.5–99.5%), so a few outliers don't
 * squash the rest; on a log axis only positive values count. */
function extent(values: number[], log: boolean, fixed?: [number?, number?]): [number, number] {
  const sorted = values.filter((v) => Number.isFinite(v) && (!log || v > 0)).sort((a, b) => a - b);
  let lo = quantile(sorted, 0.005);
  let hi = quantile(sorted, 0.995);
  if (!Number.isFinite(lo)) [lo, hi] = log ? [0.1, 10] : [0, 1];
  if (log) {
    [lo, hi] = [lo / 1.5, hi * 1.5];
  } else {
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.05;
    [lo, hi] = [lo - pad, hi + pad];
  }
  return [fixed?.[0] ?? lo, fixed?.[1] ?? hi];
}

const axis = (
  name: string,
  log: boolean,
  [min, max]: [number, number | undefined],
  extra = {},
) => ({
  type: log ? "log" : "value",
  name,
  nameLocation: "middle",
  nameGap: 28,
  nameTextStyle: { color: TEXT, fontSize: 12 },
  min,
  max,
  axisLine: { lineStyle: { color: "#b4b3ad" } },
  axisLabel: {
    color: TEXT,
    fontSize: 11,
    formatter: (v: number) => nf(v),
    hideOverlap: true,
    // Limits from the data (137, 7.52) aren't labelled; round ones (0, 1) are.
    showMinLabel: isRound(min),
    showMaxLabel: max === undefined || isRound(max),
  },
  splitLine: { lineStyle: { color: GRID_LINE } },
  ...extra,
});

const isRound = (v: number) => v === 0 || Number(v.toPrecision(1)) === v;

const GRID = { left: 56, right: 18, top: 16, bottom: 44 };

type XY = (s: Specimen) => [number | undefined, number | undefined];

/** Scatter series per colour group; with a selection, the rest fade under
 * the selected specimens. Each point's last value is its specimen's index. */
function scatterSeries(
  groups: Group[],
  xy: XY,
  selected: Set<number> | null,
  log: [boolean, boolean],
  symbol = "circle",
) {
  const total = groups.reduce((n, g) => n + g.members.length, 0);
  const symbolSize = total > 5000 ? 3 : total > 1000 ? 4 : 6;
  const series: Record<string, unknown>[] = [];
  const valid = (v: number | undefined, isLog: boolean) =>
    v !== undefined && Number.isFinite(v) && (!isLog || v > 0);
  const points = (members: Specimen[]) =>
    members.flatMap((s) => {
      const [x, y] = xy(s);
      return valid(x, log[0]) && valid(y, log[1]) ? [[x, y, s.index]] : [];
    });
  const base = (name: string, color: string, data: unknown[], opacity: number) => ({
    type: "scatter",
    name,
    data,
    symbol,
    symbolSize,
    large: data.length > 5000,
    largeThreshold: 5000,
    itemStyle: {
      color,
      opacity,
      borderColor: "#ffffff",
      borderWidth: data.length > 1000 ? 0 : 0.5,
    },
    emphasis: { scale: 1.6 },
  });
  for (const g of groups) {
    if (!selected) {
      series.push(base(g.name, g.color, points(g.members), 0.85));
      continue;
    }
    series.push(
      base(g.name, g.color, points(g.members.filter((s) => !selected.has(s.index))), FADED),
    );
  }
  if (selected) {
    for (const g of groups)
      series.push(base(g.name, g.color, points(g.members.filter((s) => selected.has(s.index))), 1));
  }
  const plotted = series.reduce((n, s) => n + (s.data as unknown[]).length, 0);
  return { series, plotted };
}

function tooltip(specimens: Specimen[], x: Param | string, y: Param | string) {
  const name = (p: Param | string) => (typeof p === "string" ? p : axisName(p));
  return {
    trigger: "item",
    confine: true,
    textStyle: { fontSize: 12 },
    formatter: (params: { value?: unknown[] }) => {
      const value = params.value ?? [];
      const s = specimens[Number(value[value.length - 1])];
      if (!s) return "";
      const lines = [
        `<b>${escapeHtml(s.specimen ?? "Specimen")}</b>`,
        s.contribution ? `Contribution ${escapeHtml(s.contribution)}` : "",
        s.lithology ? escapeHtml(s.lithology) : "",
        `${name(x)}: ${nf(Number(value[0]))}`,
        `${name(y)}: ${nf(Number(value[1]))}`,
      ];
      return lines.filter(Boolean).join("<br/>");
    },
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Reference lines (and their labels) drawn by an empty series. */
function references(markLines: unknown[]) {
  return {
    type: "line",
    data: [],
    silent: true,
    markLine: {
      silent: true,
      symbol: "none",
      animation: false,
      lineStyle: { color: REFERENCE, type: "dashed", width: 1 },
      label: { color: TEXT, fontSize: 11 },
      data: markLines,
    },
  };
}

/** Text placed at data coordinates (region names). */
function regionLabels(labels: { text: string; at: [number, number] }[]) {
  return {
    type: "scatter",
    silent: true,
    symbolSize: 0,
    data: labels.map(({ text, at }) => ({ value: at, name: text })),
    label: {
      show: true,
      formatter: "{b}",
      color: REFERENCE,
      fontSize: 13,
      fontWeight: "bold",
    },
    tooltip: { show: false },
  };
}

const inRange = (v: number | undefined, [a, b]: [number, number]) =>
  v !== undefined && v >= a && v <= b;

function useScatterBrush(
  panel: string,
  select: PanelProps["select"],
  xy: XY,
): (range: BrushRange) => void {
  return useCallback(
    (range: BrushRange) =>
      select(panel, (s) => {
        const [x, y] = xy(s);
        return inRange(x, range.x) && (!range.y || inRange(y, range.y));
      }),
    [panel, select, xy],
  );
}

const PlottedCount = ({ n }: { n: number }) => <>n = {n.toLocaleString()}</>;

// Day plot (Day et al. 1977) --------------------------------------------------------------

const dayXY: XY = (s) => [s.bcr_bc, s.mr_ms];

function DayPlot({ groups, specimens, selected, select, open }: PanelProps) {
  const [log, setLog] = useState(false);
  const onBrush = useScatterBrush("day", select, dayXY);
  const { series, plotted } = useMemo(
    () => scatterSeries(groups, dayXY, selected, [log, log]),
    [groups, selected, log],
  );
  const build = useCallback(() => {
    const xs = specimens.map((s) => s.bcr_bc ?? Number.NaN);
    const ys = specimens.map((s) => s.mr_ms ?? Number.NaN);
    // Linear: from Bcr/Bc 1 and Mr/Ms 0, to round numbers past the data.
    const [xMin, xMax] = log ? extent(xs, true) : [1, Math.ceil(Math.max(6, extent(xs, false)[1]))];
    const [yMin, yMax] = log
      ? extent(ys, true, [undefined, 1])
      : [0, Math.min(1, Math.ceil(Math.max(0.6, extent(ys, false)[1]) * 10) / 10)];
    const [mdY, sdY] = DAY_BOUNDARIES.mrMs;
    const [sdX, mdX] = DAY_BOUNDARIES.bcrBc;
    const mid = (a: number, b: number) => (log ? Math.sqrt(a * b) : (a + b) / 2);
    return {
      animation: false,
      grid: GRID,
      tooltip: tooltip(specimens, "Bcr/Bc", "Mr/Ms"),
      xAxis: axis("Bcr/Bc", log, [xMin, xMax]),
      yAxis: axis("Mr/Ms", log, [yMin, yMax], { nameGap: 40 }),
      series: [
        references([
          [{ coord: [xMin, sdY] }, { coord: [xMax, sdY] }],
          [{ coord: [xMin, mdY] }, { coord: [xMax, mdY] }],
          [{ coord: [sdX, yMin] }, { coord: [sdX, yMax] }],
          [{ coord: [mdX, yMin] }, { coord: [mdX, yMax] }],
        ]),
        regionLabels([
          { text: "SD", at: [mid(xMin, sdX), mid(sdY, yMax)] },
          { text: "PSD", at: [mid(sdX, mdX), mid(mdY, sdY)] },
          { text: "MD", at: [mid(mdX, xMax), mid(Math.max(yMin, log ? 1e-3 : 0), mdY)] },
        ]),
        ...series,
      ],
    } as EChartsOption;
  }, [series, specimens, log]);
  return (
    <Panel
      title="Day plot"
      subtitle={
        <>
          Domain state (Day et al. 1977) · <PlottedCount n={plotted} />
        </>
      }
      controls={<LogToggle log={log} setLog={setLog} label="Log axes" />}
    >
      <EChart
        build={build}
        height={CHART_HEIGHT}
        brush="rect"
        onBrush={onBrush}
        onClick={open}
        label="Day plot of Mr/Ms against Bcr/Bc"
      />
    </Panel>
  );
}

// Squareness–coercivity (Néel plot) ---------------------------------------------------------

const neelXY: XY = (s) => [s.bc, s.mr_ms];

function SquarenessPlot({ groups, specimens, selected, select, open }: PanelProps) {
  const onBrush = useScatterBrush("neel", select, neelXY);
  const { series, plotted } = useMemo(
    () => scatterSeries(groups, neelXY, selected, [true, false]),
    [groups, selected],
  );
  const build = useCallback(() => {
    const [xMin, xMax] = extent(
      specimens.map((s) => s.bc ?? Number.NaN),
      true,
    );
    return {
      animation: false,
      grid: GRID,
      tooltip: tooltip(specimens, paramOf("bc"), "Mr/Ms"),
      xAxis: axis("Bc (mT)", true, [xMin, xMax]),
      yAxis: axis("Mr/Ms", false, [0, 1], { nameGap: 40 }),
      series: [
        references(
          SD_SQUARENESS.map(({ value, label }) => ({
            yAxis: value,
            label: { formatter: label, position: "insideStartTop" },
          })),
        ),
        ...series,
      ],
    } as EChartsOption;
  }, [series, specimens]);
  return (
    <Panel
      title="Squareness–coercivity"
      subtitle={
        <>
          Mr/Ms against Bc (Néel plot; Tauxe et al. 2002) · <PlottedCount n={plotted} />
        </>
      }
    >
      <EChart
        build={build}
        height={CHART_HEIGHT}
        brush="rect"
        onBrush={onBrush}
        onClick={open}
        label="Mr/Ms against coercivity"
      />
    </Panel>
  );
}

// Jelinek plot -------------------------------------------------------------------------------

const jelinekXY: XY = (s) => [s.pj, s.t];

function JelinekPlot({ groups, specimens, selected, select, open }: PanelProps) {
  const onBrush = useScatterBrush("jelinek", select, jelinekXY);
  const { series, plotted } = useMemo(
    () => scatterSeries(groups, jelinekXY, selected, [false, false]),
    [groups, selected],
  );
  const build = useCallback(() => {
    const [, xMax] = extent(
      specimens.map((s) => s.pj ?? Number.NaN),
      false,
    );
    const max = Math.max(1.1, xMax);
    return {
      animation: false,
      grid: GRID,
      tooltip: tooltip(specimens, "P′", "T"),
      xAxis: axis("P′ (corrected degree of anisotropy)", false, [1, max]),
      yAxis: axis("T (shape)", false, [-1, 1], { nameGap: 36 }),
      series: [
        references([{ yAxis: 0, label: { show: false } }]),
        regionLabels([
          { text: "Oblate", at: [1 + (max - 1) * 0.9, 0.85] },
          { text: "Prolate", at: [1 + (max - 1) * 0.9, -0.85] },
        ]),
        ...series,
      ],
    } as EChartsOption;
  }, [series, specimens]);
  return (
    <Panel
      title="Jelinek plot"
      subtitle={
        <>
          Anisotropy shape against degree (Jelinek 1981) · <PlottedCount n={plotted} />
        </>
      }
    >
      <EChart
        build={build}
        height={CHART_HEIGHT}
        brush="rect"
        onBrush={onBrush}
        onClick={open}
        label="Jelinek plot of T against P′"
      />
    </Panel>
  );
}

// Explorer: any two parameters ---------------------------------------------------------------

function ExplorerPanel({ groups, specimens, selected, select, open }: PanelProps) {
  const [xKey, setXKey] = useState<ParamKey>("bcr");
  const [yKey, setYKey] = useState<ParamKey>("chi_mass");
  const [xLog, setXLog] = useState(true);
  const [yLog, setYLog] = useState(true);
  const setX = (key: ParamKey) => {
    setXKey(key);
    setXLog(paramOf(key).log === true);
  };
  const setY = (key: ParamKey) => {
    setYKey(key);
    setYLog(paramOf(key).log === true);
  };
  const xy = useCallback<XY>((s) => [s[xKey], s[yKey]], [xKey, yKey]);
  const onBrush = useScatterBrush("explorer", select, xy);
  const { series, plotted } = useMemo(
    () => scatterSeries(groups, xy, selected, [xLog, yLog]),
    [groups, xy, selected, xLog, yLog],
  );
  const build = useCallback(() => {
    const [x, y] = [paramOf(xKey), paramOf(yKey)];
    return {
      animation: false,
      grid: { ...GRID, left: 64 },
      tooltip: tooltip(specimens, x, y),
      xAxis: axis(
        axisName(x),
        xLog,
        extent(
          specimens.map((s) => s[xKey] ?? Number.NaN),
          xLog,
        ),
      ),
      yAxis: axis(
        axisName(y),
        yLog,
        extent(
          specimens.map((s) => s[yKey] ?? Number.NaN),
          yLog,
        ),
        { nameGap: 48 },
      ),
      series,
    } as EChartsOption;
  }, [series, specimens, xKey, yKey, xLog, yLog]);
  return (
    <Panel
      title="Explorer"
      subtitle={<PlottedCount n={plotted} />}
      controls={
        <>
          <ParamSelect label="X" value={xKey} onChange={setX} />
          <LogToggle log={xLog} setLog={setXLog} label="log" />
          <ParamSelect label="Y" value={yKey} onChange={setY} />
          <LogToggle log={yLog} setLog={setYLog} label="log" />
        </>
      }
    >
      <EChart
        build={build}
        height={CHART_HEIGHT}
        brush="rect"
        onBrush={onBrush}
        onClick={open}
        label="Scatter plot of two chosen rock magnetic parameters"
      />
    </Panel>
  );
}

// Histograms ---------------------------------------------------------------------------------

const BINS = 40;

/** Stacked histogram series (a custom series draws each bar between its
 * edges): the colour groups, or with a selection the selected specimens
 * stacked over the rest in grey. */
function histogramSeries(
  groups: Group[],
  value: (s: Specimen) => number | undefined,
  selected: Set<number> | null,
  log: boolean,
  [min, max]: [number, number],
) {
  const [lo, hi] = log ? [Math.log10(min), Math.log10(max)] : [min, max];
  const width = (hi - lo) / BINS;
  const edge = (i: number) => (log ? 10 ** (lo + i * width) : lo + i * width);
  const binOf = (v: number) => {
    const x = log ? Math.log10(v) : v;
    const i = Math.floor((x - lo) / width);
    return i >= 0 && i < BINS ? i : -1;
  };
  const layers: { name: string; color: string; members: Specimen[] }[] = selected
    ? [
        {
          name: "Not selected",
          color: "#d8d7d2",
          members: groups.flatMap((g) => g.members.filter((s) => !selected.has(s.index))),
        },
        ...groups.map((g) => ({ ...g, members: g.members.filter((s) => selected.has(s.index)) })),
      ]
    : groups;
  const base = new Array(BINS).fill(0);
  let counted = 0;
  const series = layers.map((layer) => {
    const counts = new Array(BINS).fill(0);
    for (const s of layer.members) {
      const v = value(s);
      if (v === undefined || (log && v <= 0)) continue;
      const i = binOf(v);
      if (i >= 0) counts[i]++;
    }
    const data = counts.flatMap((n, i) => {
      if (!n) return [];
      counted += n;
      const item = [edge(i), edge(i + 1), base[i], base[i] + n];
      base[i] += n;
      return [item];
    });
    return {
      type: "custom",
      name: layer.name,
      data,
      encode: { x: [0, 1], y: [2, 3] },
      renderItem: (
        _params: unknown,
        api: { value: (i: number) => number; coord: (p: number[]) => number[] },
      ) => {
        const [x0, y1] = api.coord([api.value(0), api.value(3)]);
        const [x1, y0] = api.coord([api.value(1), api.value(2)]);
        return {
          type: "rect",
          shape: { x: x0 + 0.5, y: y1, width: Math.max(1, x1 - x0 - 1), height: y0 - y1 },
          style: { fill: layer.color },
        };
      },
      tooltip: {
        formatter: (params: { value: number[]; seriesName: string }) =>
          `${escapeHtml(params.seriesName)}<br/>${nf(params.value[0])} – ${nf(params.value[1])}: ${(
            params.value[3] - params.value[2]
          ).toLocaleString()}`,
      },
    };
  });
  return { series, counted };
}

function Histogram({
  panel,
  title,
  subtitle,
  controls,
  param,
  value,
  log,
  range,
  markLines,
  groups,
  selected,
  select,
}: PanelProps & {
  panel: string;
  title: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
  param: Param;
  value: (s: Specimen) => number | undefined;
  log: boolean;
  range: [number, number];
  markLines?: Record<string, unknown>[];
}) {
  const { series, counted } = useMemo(
    () => histogramSeries(groups, value, selected, log, range),
    [groups, value, selected, log, range],
  );
  const onBrush = useCallback(
    (brushed: BrushRange) => select(panel, (s) => inRange(value(s), brushed.x)),
    [panel, select, value],
  );
  const build = useCallback(
    () =>
      ({
        animation: false,
        grid: GRID,
        tooltip: { trigger: "item", confine: true, textStyle: { fontSize: 12 } },
        xAxis: axis(axisName(param), log, range),
        // Counts up to a round number echarts picks.
        yAxis: axis("Specimens", false, [0, undefined], { nameGap: 40, minInterval: 1 }),
        series: [...(markLines ? [references(markLines)] : []), ...series],
      }) as EChartsOption,
    [series, param, log, range, markLines],
  );
  return (
    <Panel
      title={title}
      subtitle={
        <>
          {subtitle}
          {subtitle && " · "}
          <PlottedCount n={counted} />
        </>
      }
      controls={controls}
    >
      <EChart
        build={build}
        height={CHART_HEIGHT}
        brush="lineX"
        onBrush={onBrush}
        label={`Histogram of ${axisName(param)}`}
      />
    </Panel>
  );
}

const TC_RANGE: [number, number] = [-200, 800];
const tcValue = (s: Specimen) => s.tc;
const TC_LINES = TRANSITIONS.map(({ value, label }) => ({
  xAxis: value,
  label: { formatter: label, position: "insideEndTop" },
}));

function TransitionsPlot(props: PanelProps) {
  return (
    <Histogram
      {...props}
      panel="tc"
      title="Critical temperatures"
      subtitle="Curie, Néel and low-temperature transitions, with those of common minerals"
      param={paramOf("tc")}
      value={tcValue}
      log={false}
      range={TC_RANGE}
      markLines={TC_LINES}
    />
  );
}

function DistributionPanel(props: PanelProps) {
  const [key, setKey] = useState<ParamKey>("bcr");
  const [log, setLog] = useState(true);
  const value = useCallback((s: Specimen) => s[key], [key]);
  const range = useMemo(
    () =>
      extent(
        props.specimens.map((s) => s[key] ?? Number.NaN),
        log,
      ),
    [props.specimens, key, log],
  );
  return (
    <Histogram
      {...props}
      panel="distribution"
      title="Distribution"
      param={paramOf(key)}
      value={value}
      log={log}
      range={range}
      controls={
        <>
          <ParamSelect
            label="Of"
            value={key}
            onChange={(next) => {
              setKey(next);
              setLog(paramOf(next).log === true);
            }}
          />
          <LogToggle log={log} setLog={setLog} label="log" />
        </>
      }
    />
  );
}

// Stereonet of anisotropy axes -----------------------------------------------------------------

const CIRCLE = Array.from({ length: 181 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 180;
  return [Math.sin(a), Math.cos(a)];
});

function StereonetPanel({ groups, specimens, selected, open }: PanelProps) {
  const axes = useMemo(() => {
    const series: Record<string, unknown>[] = [];
    let plotted = 0;
    const total = specimens.filter((s) => s.v1_dec !== undefined).length;
    const layer = (g: Group, members: Specimen[], opacity: number) => {
      for (const [axisKey, symbol, name] of [
        ["v1", "rect", "V1 (maximum)"],
        ["v3", "circle", "V3 (minimum)"],
      ] as const) {
        const data = members.flatMap((s) => {
          const dec = s[`${axisKey}_dec`];
          const inc = s[`${axisKey}_inc`];
          if (dec === undefined || inc === undefined) return [];
          return [[...equalArea(dec, inc), dec, inc, s.index]];
        });
        plotted += data.length;
        series.push({
          type: "scatter",
          name: `${g.name}: ${name}`,
          data,
          symbol,
          symbolSize: (symbol === "rect" ? 0 : 1) + (total > 1000 ? 3 : total > 200 ? 4 : 6),
          large: data.length > 5000,
          itemStyle:
            symbol === "rect"
              ? { color: g.color, opacity, borderColor: "#fff", borderWidth: 0.5 }
              : { color: "rgba(0,0,0,0)", borderColor: g.color, borderWidth: 1.5, opacity },
        });
      }
    };
    for (const g of groups) {
      if (!selected) layer(g, g.members, 0.85);
      else
        layer(
          g,
          g.members.filter((s) => !selected.has(s.index)),
          FADED,
        );
    }
    if (selected)
      for (const g of groups)
        layer(
          g,
          g.members.filter((s) => selected.has(s.index)),
          1,
        );
    return { series, plotted };
  }, [groups, specimens, selected]);

  const build = useCallback(
    ({ width, height }: { width: number; height: number }) => {
      const size = Math.max(100, Math.min(width - 20, height - 30));
      const hidden = { show: false };
      const unit = {
        type: "value",
        min: -1.04,
        max: 1.04,
        axisLine: hidden,
        axisTick: hidden,
        axisLabel: hidden,
        splitLine: hidden,
      };
      return {
        animation: false,
        grid: { width: size, height: size, left: (width - size) / 2, top: 20 },
        xAxis: unit,
        yAxis: unit,
        tooltip: {
          trigger: "item",
          confine: true,
          textStyle: { fontSize: 12 },
          formatter: (params: { value?: number[]; seriesName?: string }) => {
            const v = params.value ?? [];
            const s = specimens[v[4]];
            if (!s) return "";
            return [
              `<b>${escapeHtml(s.specimen ?? "Specimen")}</b>`,
              s.contribution ? `Contribution ${escapeHtml(s.contribution)}` : "",
              escapeHtml(params.seriesName ?? ""),
              `Dec ${nf(v[2])}°, Inc ${nf(v[3])}°`,
            ]
              .filter(Boolean)
              .join("<br/>");
          },
        },
        series: [
          {
            type: "line",
            data: CIRCLE,
            silent: true,
            symbol: "none",
            lineStyle: { color: "#8a8984", width: 1 },
            tooltip: { show: false },
          },
          {
            type: "scatter",
            silent: true,
            symbol: "path://M0,-1L0,1M-1,0L1,0",
            symbolSize: 10,
            data: [[0, 0]],
            itemStyle: { color: "none", borderColor: "#8a8984", borderWidth: 1 },
            tooltip: { show: false },
          },
          {
            ...regionLabels([{ text: "N", at: [0, 1.04] }]),
            label: { show: true, formatter: "{b}", color: TEXT, fontSize: 12, position: "top" },
          },
          ...axes.series,
        ],
      } as EChartsOption;
    },
    [axes, specimens],
  );

  return (
    <Panel
      title="Anisotropy axes"
      subtitle={
        <>
          Equal-area, lower hemisphere: ■ V1 maximum, ○ V3 minimum ·{" "}
          <PlottedCount n={axes.plotted} />
        </>
      }
    >
      {axes.plotted > 0 ? (
        <EChart
          build={build}
          height={CHART_HEIGHT}
          onClick={open}
          label="Stereonet of maximum and minimum anisotropy axes"
        />
      ) : (
        <p
          className="flex items-center justify-center text-center text-gray-500"
          style={{ height: CHART_HEIGHT }}
        >
          No anisotropy axes match: they come from specimens' eigenparameters (aniso_v1, aniso_v3).
        </p>
      )}
    </Panel>
  );
}

// Selected specimens -----------------------------------------------------------------------

const TABLE_LIMIT = 200;
const TABLE_COLUMNS: ParamKey[] = ["mr_ms", "bcr_bc", "bc", "bcr", "tc", "chi_mass", "pj", "t"];

function SelectionTable({
  specimens,
  onClear,
  onOpen,
}: {
  specimens: Specimen[];
  onClear: () => void;
  onOpen?: (id: string) => void;
}) {
  const cell = "border-b border-gray-200 px-2 py-1 text-left whitespace-nowrap";
  return (
    <section className="rounded-sm border border-gray-300 bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-200 px-3 py-2">
        <h4 className="text-[14px] font-bold text-gray-900">
          {specimens.length.toLocaleString()} selected specimens
        </h4>
        <button
          type="button"
          onClick={() => downloadCsv(specimens)}
          className="rounded-sm border border-gray-300 px-2 py-0.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50"
        >
          Download CSV
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded-sm border border-gray-300 px-2 py-0.5 text-[12px] font-bold text-gray-700 hover:bg-gray-50"
        >
          Clear selection
        </button>
        {specimens.length > TABLE_LIMIT && (
          <span className="text-[12px] text-gray-500">The first {TABLE_LIMIT} are listed.</span>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-gray-50 text-gray-700">
            <tr>
              <th className={cell}>Specimen</th>
              <th className={cell}>Contribution</th>
              <th className={cell}>Lithology</th>
              {TABLE_COLUMNS.map((key) => (
                <th key={key} className={cx(cell, "text-right")}>
                  {axisName(paramOf(key))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {specimens.slice(0, TABLE_LIMIT).map((s) => (
              <tr key={s.index}>
                <td className={cell}>{s.specimen ?? "—"}</td>
                <td className={cell}>
                  {s.contribution && onOpen ? (
                    <button
                      type="button"
                      onClick={() => onOpen(s.contribution as string)}
                      className="text-node hover:underline"
                    >
                      {s.contribution}
                    </button>
                  ) : (
                    (s.contribution ?? "—")
                  )}
                </td>
                <td className={cell}>{s.lithology ?? "—"}</td>
                {TABLE_COLUMNS.map((key) => (
                  <td key={key} className={cx(cell, "text-right tabular-nums")}>
                    {s[key] !== undefined ? nf(s[key] as number) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
