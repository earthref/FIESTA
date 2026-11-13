import type { ReactNode } from "react";
import { Cell, contributionId, NoDataCell } from "@/components/result-item";
import { Spinner } from "@/components/ui/spinner";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { NodeConfig, SearchResult } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { ContributionTab, PluginGridCellProps, PluginModule } from "@/plugins";
import { type ArgonData, useArgon } from "./argon-data";
import { AgeSpectrum, SpecimenSpectra } from "./argon-plots";
import { EXPERIMENT_TAB, ExperimentAgePlots, SPECIMEN_TAB, SpecimenAgePlots } from "./argon-view";

function nameOf(hit: SearchResult, table: string, column: string): string | undefined {
  const fromSummary = getPath(hit, `summary.${table}.${column}`);
  if (typeof fromSummary === "string" && fromSummary) return fromSummary;
  if (Array.isArray(fromSummary) && fromSummary.length > 0) return String(fromSummary[0]);
  const row = Array.isArray(hit.rows) ? hit.rows[0] : undefined;
  const value =
    row && typeof row === "object" ? (row as Record<string, unknown>)[column] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

function levelsOption(config: NodeConfig, key: string): string[] {
  const levels = config.plugins["plateau-calculations"]?.[key];
  return Array.isArray(levels) ? levels.map(String) : [];
}

/** A grid tile: the plot, opening the modal tab at it. */
function PlotTile({
  id,
  privateKey,
  width,
  tab,
  plot,
  label,
  query,
  render,
}: {
  id: string;
  privateKey?: string;
  width: number;
  tab: string;
  plot: string;
  label: string;
  query: ReturnType<typeof useArgon>;
  render: (data: ArgonData) => ReactNode | null;
}) {
  const openContribution = useOpenContribution();
  if (query.isPending) {
    return (
      <Cell width={width}>
        <div className="flex h-[80px] items-center justify-center">
          <Spinner />
        </div>
      </Cell>
    );
  }
  const content = query.data ? render(query.data) : null;
  if (!content) return <NoDataCell label="Plot" width={width} />;
  return (
    <Cell width={width}>
      <button
        type="button"
        onClick={() => openContribution(id, tab, undefined, { plot, privateKey })}
        aria-label={label}
        className="block cursor-pointer border border-gray-300 hover:border-node focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
      >
        {content}
      </button>
    </Cell>
  );
}

function ExperimentTile(props: {
  id: string;
  experiment: string;
  privateKey?: string;
  width: number;
}) {
  const query = useArgon(props.id, props.privateKey, { experiment: props.experiment });
  return (
    <PlotTile
      {...props}
      tab={EXPERIMENT_TAB}
      plot={props.experiment}
      label={`Open the age plots of experiment ${props.experiment}`}
      query={query}
      render={(data) =>
        data.experiments[0] ? (
          <AgeSpectrum experiment={data.experiments[0]} width={props.width - 4} height={80} />
        ) : null
      }
    />
  );
}

function SpecimenTile(props: { id: string; specimen: string; privateKey?: string; width: number }) {
  const query = useArgon(props.id, props.privateKey, { specimen: props.specimen });
  return (
    <PlotTile
      {...props}
      tab={SPECIMEN_TAB}
      plot={props.specimen}
      label={`Open the age plots of specimen ${props.specimen}`}
      query={query}
      render={(data) =>
        data.specimens[0] ? (
          <SpecimenSpectra
            specimen={data.specimens[0]}
            experiments={data.experiments}
            width={props.width - 4}
            height={80}
          />
        ) : null
      }
    />
  );
}

/** The search table a tab counts: its option's first level's. */
function levelTable(config: NodeConfig, key: string): string | undefined {
  const names = levelsOption(config, key);
  return config.search_levels.find((level) => names.includes(level.name))?.table;
}

const plateauPlugin: PluginModule = {
  // Two asset tabs, each counted by its level's records: Specimen Age Plots
  // (a specimen's experiments under its preferred age) and Experiment Age
  // Plots (an experiment's spectrum, isochrons and ages).
  contributionTabs(config) {
    const tabs: ContributionTab[] = [];
    const specimens = levelTable(config, "specimen_levels");
    if (specimens)
      tabs.push({
        key: SPECIMEN_TAB,
        label: "Specimen Age Plots",
        countTable: specimens,
        render: ({ id, privateKey, plot, onPlot }) => (
          <SpecimenAgePlots id={id} privateKey={privateKey} plot={plot} onPlot={onPlot} />
        ),
      });
    const experiments = levelTable(config, "experiment_levels");
    if (experiments)
      tabs.push({
        key: EXPERIMENT_TAB,
        label: "Experiment Age Plots",
        countTable: experiments,
        render: ({ id, privateKey, plot, onPlot }) => (
          <ExperimentAgePlots id={id} privateKey={privateKey} plot={plot} onPlot={onPlot} />
        ),
      });
    return tabs;
  },
  // The summary grid's plot tile: an experiment's age spectrum, or a
  // specimen's experiments under its preferred age.
  gridCell(props: PluginGridCellProps) {
    if (props.column.cell !== "plot") return null;
    const id = contributionId(props.hit);
    if (!id) return null;
    const common = { id, privateKey: props.privateKey, width: props.column.width };
    if (levelsOption(props.config, "experiment_levels").includes(props.level.name)) {
      const experiment = nameOf(props.hit, props.level.table, "experiment");
      return experiment ? <ExperimentTile {...common} experiment={experiment} /> : null;
    }
    if (levelsOption(props.config, "specimen_levels").includes(props.level.name)) {
      const specimen = nameOf(props.hit, props.level.table, "specimen");
      return specimen ? <SpecimenTile {...common} specimen={specimen} /> : null;
    }
    return null;
  },
};

export default plateauPlugin;
