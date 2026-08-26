import { useQuery } from "@tanstack/react-query";
import { ErrorMessage } from "../../components/error-message";
import { contributionId } from "../../components/result-item";
import { PageSpinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import type { NodeConfig } from "../../lib/types";
import type { PluginModule, PluginSubTabContext } from "../index";

interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

interface CoreData {
  name: string;
  rows: Record<string, unknown>[];
}

interface SeriesPoints {
  def: SeriesDef;
  points: { depth: number; value: number }[];
}

function seriesDefsOf(config: NodeConfig): SeriesDef[] {
  const defs = config.plugins["depth-plot"]?.series_defs;
  if (!Array.isArray(defs)) return [];
  return defs
    .filter((def) => def && typeof def === "object" && "key" in def)
    .map((def) => {
      const record = def as Record<string, unknown>;
      return {
        key: String(record.key),
        label: typeof record.label === "string" ? record.label : String(record.key),
        color: typeof record.color === "string" ? record.color : "var(--node-color)",
      };
    });
}

function depthOf(row: Record<string, unknown>): number | undefined {
  for (const key of ["depth", "core_depth", "depth_m", "composite_depth"]) {
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function coreNameOf(row: Record<string, unknown>): string {
  for (const key of ["core", "core_name", "hole", "section"]) {
    if (typeof row[key] === "string" && row[key]) return row[key] as string;
  }
  return "Core";
}

/** Accept several plausible measurement payload shapes defensively. */
function extractCores(data: unknown): CoreData[] {
  if (!data) return [];
  const record =
    typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;

  const coresField = record?.cores;
  if (Array.isArray(coresField)) {
    return coresField
      .filter((core) => core && typeof core === "object")
      .map((core) => {
        const entry = core as Record<string, unknown>;
        const rows = entry.measurements ?? entry.rows ?? entry.points;
        return {
          name:
            (typeof entry.name === "string" && entry.name) ||
            (typeof entry.core === "string" && entry.core) ||
            "Core",
          rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
        };
      });
  }

  const rows = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : Array.isArray(record?.measurements)
      ? (record?.measurements as Record<string, unknown>[])
      : [];
  const byCore = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = coreNameOf(row);
    const list = byCore.get(name) ?? [];
    list.push(row);
    byCore.set(name, list);
  }
  return [...byCore.entries()].map(([name, coreRows]) => ({ name, rows: coreRows }));
}

const PANEL_WIDTH = 120;
const PANEL_GAP = 12;
const PLOT_HEIGHT = 400;
const AXIS_LEFT = 44;
const HEADER = 28;
const FOOTER = 18;

function CoreTracks({ core, defs }: { core: CoreData; defs: SeriesDef[] }) {
  const series: SeriesPoints[] = defs
    .map((def) => ({
      def,
      points: core.rows
        .map((row) => {
          const depth = depthOf(row);
          const value = Number(row[def.key]);
          return depth !== undefined && Number.isFinite(value) ? { depth, value } : null;
        })
        .filter((point): point is { depth: number; value: number } => point !== null)
        .sort((a, b) => a.depth - b.depth),
    }))
    .filter((entry) => entry.points.length > 0);

  if (series.length === 0) {
    return <p className="text-[13px] text-[#AAAAAA]">No plottable series for {core.name}.</p>;
  }

  const depths = series.flatMap((entry) => entry.points.map((point) => point.depth));
  const depthMin = Math.min(...depths);
  const depthMax = Math.max(...depths);
  const depthSpan = depthMax - depthMin || 1;
  const y = (depth: number) => HEADER + ((depth - depthMin) / depthSpan) * PLOT_HEIGHT;

  const width = AXIS_LEFT + series.length * (PANEL_WIDTH + PANEL_GAP);
  const height = HEADER + PLOT_HEIGHT + FOOTER;
  const depthTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => depthMin + f * depthSpan);

  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-[13px] font-bold">{core.name}</div>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Depth plot for ${core.name}`}
        className="bg-white"
      >
        {/* Shared depth axis (increasing downward) */}
        <line
          x1={AXIS_LEFT - 6}
          y1={HEADER}
          x2={AXIS_LEFT - 6}
          y2={HEADER + PLOT_HEIGHT}
          stroke="#9ca3af"
        />
        {depthTicks.map((tick) => (
          <g key={`tick-${tick}`}>
            <line
              x1={AXIS_LEFT - 10}
              y1={y(tick)}
              x2={AXIS_LEFT - 6}
              y2={y(tick)}
              stroke="#9ca3af"
            />
            <text x={AXIS_LEFT - 12} y={y(tick) + 3} textAnchor="end" fontSize={9} fill="#6b7280">
              {tick.toFixed(1)}
            </text>
          </g>
        ))}
        <text
          x={10}
          y={HEADER + PLOT_HEIGHT / 2}
          fontSize={9}
          fill="#6b7280"
          transform={`rotate(-90 10 ${HEADER + PLOT_HEIGHT / 2})`}
          textAnchor="middle"
        >
          Depth (m)
        </text>

        {series.map((entry, index) => {
          const x0 = AXIS_LEFT + index * (PANEL_WIDTH + PANEL_GAP);
          const values = entry.points.map((point) => point.value);
          const valueMin = Math.min(...values);
          const valueMax = Math.max(...values);
          const valueSpan = valueMax - valueMin || 1;
          const x = (value: number) => x0 + ((value - valueMin) / valueSpan) * PANEL_WIDTH;
          const path = entry.points
            .map((point) => `${x(point.value).toFixed(1)},${y(point.depth).toFixed(1)}`)
            .join(" ");
          return (
            <g key={entry.def.key}>
              <rect
                x={x0}
                y={HEADER}
                width={PANEL_WIDTH}
                height={PLOT_HEIGHT}
                fill="none"
                stroke="#d1d5db"
              />
              <text
                x={x0 + PANEL_WIDTH / 2}
                y={HEADER - 8}
                textAnchor="middle"
                fontSize={10}
                fontWeight="bold"
                fill={entry.def.color}
              >
                {entry.def.label}
              </text>
              <polyline points={path} fill="none" stroke={entry.def.color} strokeWidth={1.25} />
              <text x={x0} y={height - 4} fontSize={9} fill="#6b7280">
                {valueMin.toPrecision(3)}
              </text>
              <text
                x={x0 + PANEL_WIDTH}
                y={height - 4}
                textAnchor="end"
                fontSize={9}
                fill="#6b7280"
              >
                {valueMax.toPrecision(3)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ContributionDepthPlots({
  id,
  privateKey,
  config,
}: {
  id: string;
  privateKey?: string;
  config: NodeConfig;
}) {
  const query = useQuery({
    queryKey: ["plugin", "depth-plot", id, privateKey],
    queryFn: () =>
      api<unknown>(`/api/plugins/depth-plot/contributions/${id}/measurements`, {
        params: { private_key: privateKey },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const defs = seriesDefsOf(config);
  const cores = extractCores(query.data);

  return (
    <div className="mb-6 border-b border-gray-200 pb-4">
      <h3 className="mb-2 text-[13px] font-bold">Contribution {id}</h3>
      {query.isPending && <PageSpinner label={`Loading measurements for ${id}…`} />}
      {query.error && <ErrorMessage error={query.error} />}
      {query.data !== undefined && cores.length === 0 && (
        <p className="text-[13px] text-[#AAAAAA]">No depth measurements available.</p>
      )}
      <div className="flex flex-wrap gap-6">
        {cores.map((core) => (
          <CoreTracks key={core.name} core={core} defs={defs} />
        ))}
      </div>
    </div>
  );
}

function DepthPlotsView({ hits, config, privateKey }: PluginSubTabContext) {
  const ids = [...new Set(hits.map((hit) => contributionId(hit)).filter(Boolean))] as string[];
  if (ids.length === 0) {
    return <p className="py-6 text-center text-[13px] text-gray-500">No results to plot.</p>;
  }
  return (
    <div className="py-3">
      {ids.map((id) => (
        <ContributionDepthPlots key={id} id={id} privateKey={privateKey} config={config} />
      ))}
    </div>
  );
}

export const depthPlotPlugin: PluginModule = {
  levelSubTabs(level, config) {
    const levels = config.plugins["depth-plot"]?.levels;
    const enabled = Array.isArray(levels) ? levels.map(String) : [];
    if (!enabled.includes(level.name)) return [];
    return [{ name: "Plots", render: (ctx) => <DepthPlotsView {...ctx} /> }];
  },
};
