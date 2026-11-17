import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { ErrorMessage } from "@/components/error-message";
import { contributionId, NoPlotsCell } from "@/components/result-item";
import { PageSpinner, Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { NodeConfig } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { PluginModule, PluginSubTabContext } from "@/plugins";
import {
  depthOf,
  parsePayload,
  type Row,
  seriesDefsOf,
  splitOffScale,
  type TrackDef,
  trackPoints,
  valueDomain,
} from "./depth-plot-data";
import { ContributionPlots } from "./depth-plot-view";

/** A contribution's measurements (the plugin route), shared by the modal, the
 * Plots sub-tab and the summary grid's thumbnails. */
function useMeasurements(id: string, privateKey?: string) {
  return useQuery({
    queryKey: ["plugin", "depth-plot", id, privateKey],
    queryFn: () =>
      api<unknown>(`/plugins/depth-plot/contributions/${id}/measurements`, {
        params: { private_key: privateKey },
      }),
    staleTime: 5 * 60 * 1000,
  });
}

const THUMB_HEIGHT = 98;
const THUMB_GAP = 2;
/** At most this many points per series in a thumbnail (a core has thousands). */
const THUMB_POINTS = 300;

/** Legacy CDR `renderDepthThumbnailSVG`: one panel per series with data,
 * depth increasing downward, no ticks or labels; negative depths
 * (calibration) and flagged rows left out; values scaled like the full plot
 * (2nd–98th percentile, log where the series says so) and clamped to the
 * panel; null when no series has a value. */
function depthThumbnail(rows: Row[], defs: TrackDef[], width: number): ReactNode | null {
  const kept = rows.filter((row) => (depthOf(row) ?? -1) >= 0);
  const series = defs
    .map((def) => {
      const all = trackPoints(kept, def, { bad: false, log: def.log });
      const step = Math.ceil(all.length / THUMB_POINTS);
      return { def, points: all.filter((_, i) => i % step === 0) };
    })
    .filter((entry) => entry.points.length > 0);
  if (series.length === 0) return null;

  const depths = series.flatMap((entry) => entry.points.map((point) => point.depth));
  const depthMin = Math.min(...depths);
  const depthSpan = Math.max(...depths) - depthMin || 1;
  const y = (depth: number) => ((depth - depthMin) / depthSpan) * THUMB_HEIGHT;
  const panel = Math.max(8, (width - THUMB_GAP * (series.length - 1)) / series.length);

  return (
    <svg
      width={width}
      height={THUMB_HEIGHT}
      aria-hidden="true"
      className="er-light block bg-surface"
    >
      {series.map((entry, index) => {
        const x0 = index * (panel + THUMB_GAP);
        const log = entry.def.log;
        const [lo, hi] = valueDomain(
          entry.points.map((point) => point.value),
          log,
        );
        const x = (value: number) => {
          const fraction = ((log ? Math.log10(value) : value) - lo) / (hi - lo || 1);
          return x0 + Math.min(1, Math.max(0, fraction)) * panel;
        };
        // Far off-scale values (a failed scan's zeros) break the line.
        const path = splitOffScale([entry.points], [lo, hi], log)
          .runs.map((run) =>
            run
              .map((p, i) => `${i ? "L" : "M"}${x(p.value).toFixed(1)},${y(p.depth).toFixed(1)}`)
              .join(""),
          )
          .join("");
        return (
          <g key={entry.def.key}>
            <rect
              x={x0}
              y={0}
              width={panel}
              height={THUMB_HEIGHT}
              fill="none"
              stroke="var(--color-gray-200)"
            />
            <path d={path} fill="none" stroke={entry.def.color} strokeWidth={1} />
          </g>
        );
      })}
    </svg>
  );
}

/** The summary grid's plot tile: the contribution's tracks, or on a core's
 * card that core's; opens the modal's Depth Plots tab. */
function DepthPlotTile({
  id,
  core,
  privateKey,
  config,
  width,
}: {
  id: string;
  core?: string;
  privateKey?: string;
  config: NodeConfig;
  width: number;
}) {
  const openContribution = useOpenContribution();
  const query = useMeasurements(id, privateKey);
  if (query.isPending) {
    return (
      <NoPlotsCell width={width}>
        <div className="flex h-[98px] items-center justify-center">
          <Spinner />
        </div>
      </NoPlotsCell>
    );
  }
  const { cores } = parsePayload(query.data, []);
  const rows =
    (core && cores.find((entry) => entry.name === core)?.rows) ||
    cores.flatMap((entry) => entry.rows);
  const thumbnail = depthThumbnail(rows, seriesDefsOf(config), width - 2);
  if (!thumbnail) {
    return (
      <NoPlotsCell width={width}>
        <br />
        No
        <br />
        <b>
          Depth
          <br />
          Plots
        </b>
      </NoPlotsCell>
    );
  }
  return (
    <NoPlotsCell width={width}>
      <button
        type="button"
        onClick={() => openContribution(id, "depth-plots", undefined, { privateKey })}
        title="Open the depth plots"
        aria-label={`Open the depth plots of ${core ? `core ${core}` : `contribution ${id}`}`}
        className="block size-full cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        {thumbnail}
      </button>
    </NoPlotsCell>
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
  const query = useMeasurements(id, privateKey);

  const payload = useMemo(
    () => parsePayload(query.data, seriesDefsOf(config)),
    [query.data, config],
  );

  return (
    <div className="mb-6 border-b border-gray-200 pb-4">
      <h3 className="mb-2 text-[13px] font-bold">Contribution {id}</h3>
      {query.isPending && <PageSpinner label={`Loading measurements for ${id}…`} />}
      {query.error && <ErrorMessage error={query.error} />}
      {query.data !== undefined && payload.cores.length === 0 && (
        <p className="text-[13px] text-ink-faint">No depth measurements available.</p>
      )}
      {payload.cores.length > 0 && <ContributionPlots payload={payload} />}
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

const depthPlotPlugin: PluginModule = {
  // A contribution's depth plots, in its modal, when it has rows at a plotted level.
  contributionTabs(config) {
    const levels = config.plugins["depth-plot"]?.levels;
    const names = Array.isArray(levels) ? levels.map(String) : [];
    const table = config.search_levels.find((level) => names.includes(level.name))?.table;
    if (!table) return [];
    return [
      {
        key: "depth-plots",
        label: "Depth Plots",
        countTable: table,
        render: ({ id, privateKey, config: node }) => (
          <div className="p-4 sm:p-6">
            <ContributionDepthPlots id={id} privateKey={privateKey} config={node} />
          </div>
        ),
      },
    ];
  },
  levelSubTabs(level, config) {
    const levels = config.plugins["depth-plot"]?.levels;
    const enabled = Array.isArray(levels) ? levels.map(String) : [];
    if (!enabled.includes(level.name)) return [];
    return [{ name: "Plots", render: (ctx) => <DepthPlotsView {...ctx} /> }];
  },
  // The summary grid's plot tile (legacy CDR's depth thumbnail), wherever the
  // node YAML places a `plot` cell.
  gridCell({ column, hit, level, config, privateKey }) {
    if (column.cell !== "plot") return null;
    const id = contributionId(hit);
    if (!id) return null;
    const core = level.table === "cores" ? getPath(hit, "summary.cores.core") : undefined;
    return (
      <DepthPlotTile
        id={id}
        core={typeof core === "string" && core ? core : undefined}
        privateKey={privateKey}
        config={config}
        width={column.width}
      />
    );
  },
};

export default depthPlotPlugin;
