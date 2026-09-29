import { lazy, Suspense } from "react";
import { PageSpinner } from "../../components/ui/spinner";
import { api } from "../../lib/api";
import type { NodeConfig, SearchPage } from "../../lib/types";
import { getPath } from "../../lib/utils";
import type { PluginModule } from "../index";
import { PLOTS, type PlotType } from "./pmag-plots-data";

// echarts and the plot builders live in a lazily loaded chunk.
const PmagPlotsView = lazy(() => import("./pmag-plots-view"));

interface PmagPlotsConfig {
  table?: string;
  plot_types?: PlotType[];
}

function pmagPlotsConfig(config: NodeConfig): PmagPlotsConfig {
  return (config.plugins["pmag-plots"] ?? {}) as PmagPlotsConfig;
}

export const pmagPlotsPlugin: PluginModule = {
  // One tab per plot type (the legacy PmagPy plot types), each counted from
  // the contribution's `pmag_plots` document, fetched once for all of them.
  contributionTabs(config) {
    const pconfig = pmagPlotsConfig(config);
    const table = pconfig.table ?? "pmag_plots";
    return (pconfig.plot_types ?? []).map((type) => ({
      key: PLOTS[type].key,
      label: PLOTS[type].label,
      countQuery: (id, privateKey) => ({
        queryKey: ["plugin", "pmag-plots", "counts", id, table, privateKey],
        queryFn: () =>
          api<SearchPage>(`/search/${table}`, {
            params: {
              contribution: id,
              private_key: privateKey || undefined,
              size: 1,
            },
          }),
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
};
