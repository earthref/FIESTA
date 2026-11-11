import { lazy, Suspense } from "react";
import { contributionId } from "@/components/result-item";
import { PageSpinner } from "@/components/ui/spinner";
import type { NodeConfig, SearchPage } from "@/lib/types";
import { getPath } from "@/lib/utils";
import type { PluginModule } from "@/plugins";
import { PLOTS, type PlotType } from "./pmag-plots-data";
import { PmagPlotThumbnail, pmagPlotsDocQuery } from "./pmag-plots-thumbnail";

// echarts and the plot builders live in a lazily loaded chunk.
const PmagPlotsView = lazy(() => import("./pmag-plots-view"));

interface PmagPlotsConfig {
  table?: string;
  plot_types?: PlotType[];
}

/** The levels with a Plot tile (plugin.py `RecordTable`). */
const RECORD_TABLES = ["contribution", "locations", "sites", "samples", "specimens"];

function pmagPlotsConfig(config: NodeConfig): PmagPlotsConfig {
  return (config.plugins["pmag-plots"] ?? {}) as PmagPlotsConfig;
}

const pmagPlotsPlugin: PluginModule = {
  // One tab per plot type (the legacy PmagPy plot types), each counted from
  // the contribution's `pmag_plots` document, fetched once for all of them.
  contributionTabs(config) {
    const pconfig = pmagPlotsConfig(config);
    const table = pconfig.table ?? "pmag_plots";
    return (pconfig.plot_types ?? []).map((type) => ({
      key: PLOTS[type].key,
      label: PLOTS[type].label,
      countQuery: (id, privateKey) => ({
        ...pmagPlotsDocQuery(id, table, privateKey),
        select: (page) => {
          const hit = (page as SearchPage).results[0];
          return Number(getPath(hit, `summary.pmag_plots.${type}`) ?? 0);
        },
      }),
      render: ({ id, privateKey }) => (
        <Suspense fallback={<PageSpinner label="Loading plots…" />}>
          <PmagPlotsView type={type} id={id} privateKey={privateKey} />
        </Suspense>
      ),
    }));
  },

  // A record's Plot tile: one of its plots and their total (legacy
  // SearchPlotThumbnail), for a contribution or a location, site, sample or
  // specimen of it (the plots of the specimens below it and its groups).
  gridCell({ column, hit, level, config, privateKey }) {
    if (column.cell !== "plot" || !RECORD_TABLES.includes(level.table)) return null;
    const id = contributionId(hit);
    if (!id) return null;
    const pconfig = pmagPlotsConfig(config);
    const column_ = level.table.replace(/s$/, "");
    const name = getPath(hit, `summary.${level.table}.${column_}`);
    if (level.table !== "contribution" && (typeof name !== "string" || !name)) return null;
    return (
      <PmagPlotThumbnail
        id={id}
        table={level.table}
        name={typeof name === "string" ? name : undefined}
        docTable={pconfig.table ?? "pmag_plots"}
        plotTypes={pconfig.plot_types ?? []}
        privateKey={privateKey}
        width={column.width}
      />
    );
  },
};

export default pmagPlotsPlugin;
