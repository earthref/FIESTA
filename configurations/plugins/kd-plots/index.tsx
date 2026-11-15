// The kd-plots plugin's UI: a "Kd Plots" sub-tab on its search levels and a
// tab in the contribution modal, both the spider / Onuma / Kd-by-element
// view (kd-plots-view.tsx) over the matching Kd rows.
import { lazy, Suspense } from "react";
import { PageSpinner } from "@/components/ui/spinner";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { PluginModule, PluginSubTabContext } from "@/plugins";
import { type KdPlotsOptions, kdPlotsOptions } from "./kd-plots-data";

// echarts lives in a lazily loaded chunk so other views never pay for it.
const KdPlotsView = lazy(() => import("./kd-plots-view"));

const VIEW_NAME = "Kd Plots";
const TAB_KEY = "kd-plots";

function KdPlotsSubTab({ ctx, options }: { ctx: PluginSubTabContext; options: KdPlotsOptions }) {
  const openContribution = useOpenContribution();
  return (
    <Suspense fallback={<PageSpinner label="Loading plots…" />}>
      <KdPlotsView
        options={options}
        query={ctx.query}
        ranges={ctx.ranges}
        bbox={ctx.bbox}
        contribution={ctx.contribution}
        privateKey={ctx.privateKey}
        scope={ctx.scope}
        onOpen={(id) => openContribution(id, TAB_KEY)}
      />
    </Suspense>
  );
}

const kdPlotsPlugin: PluginModule = {
  // A contribution's Kd rows on the same plots, in its modal.
  contributionTabs(config) {
    if (!config.plugins["kd-plots"]) return [];
    const options = kdPlotsOptions(config);
    return [
      {
        key: TAB_KEY,
        label: VIEW_NAME,
        countTable: options.table,
        render: ({ id, privateKey }) => (
          <Suspense fallback={<PageSpinner label="Loading plots…" />}>
            <KdPlotsView
              options={options}
              query=""
              ranges={[]}
              contribution={id}
              privateKey={privateKey}
            />
          </Suspense>
        ),
      },
    ];
  },
  levelSubTabs(level, config) {
    if (!config.plugins["kd-plots"]) return [];
    const options = kdPlotsOptions(config);
    if (!options.levels.includes(level.name)) return [];
    return [
      {
        name: VIEW_NAME,
        countTable: options.table,
        render: (ctx) => <KdPlotsSubTab ctx={ctx} options={options} />,
      },
    ];
  },
};

export default kdPlotsPlugin;
