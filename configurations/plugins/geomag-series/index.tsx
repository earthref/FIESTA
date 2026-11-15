import { lazy, Suspense } from "react";
import { PageSpinner } from "@/components/ui/spinner";
import { useOpenContribution } from "@/lib/contribution-modal";
import type { PluginFilter, PluginModule, PluginSubTabContext } from "@/plugins";
import { type SeriesOptions, seriesOptions } from "./geomag-series-data";
import { NameSearchFilter, RADIUS_TOKEN, RadiusFilter } from "./geomag-series-filters";

// echarts lives in a lazily loaded chunk so other views never pay for it.
const GeomagSeriesView = lazy(() => import("./geomag-series-view"));

const VIEW_NAME = "Plots";

function PlotsSubTab({ ctx, options }: { ctx: PluginSubTabContext; options: SeriesOptions }) {
  const openContribution = useOpenContribution();
  return (
    <Suspense fallback={<PageSpinner label="Loading plots…" />}>
      <GeomagSeriesView
        options={options}
        searchParams={ctx.searchParams ?? { query: ctx.query || undefined, ...ctx.scope }}
        onOpen={(id) => openContribution(id)}
      />
    </Suspense>
  );
}

const geomagSeriesPlugin: PluginModule = {
  // Plots is a sub-tab of its base level (GEOMAGIA's Sites): the level's own
  // records, searched as its Summaries are.
  levelSubTabs(level, config) {
    const options = seriesOptions(config);
    if (!options || options.base_level !== level.name) return [];
    return [
      {
        name: VIEW_NAME,
        records: true,
        render: (ctx) => <PlotsSubTab ctx={ctx} options={options} />,
      },
    ];
  },
  // The site's name and radius searches, after the node's filters, on every
  // level (both are query tokens every record and contribution doc answers).
  sidebarFilters(_levelName, _subTabName, config) {
    const options = seriesOptions(config);
    if (!options) return [];
    const filters: PluginFilter[] = [];
    const column = options.name_search;
    if (column) {
      filters.push({
        key: "geomag-series-name",
        fields: [column],
        render: (ctx) => (
          <NameSearchFilter ctx={ctx} column={column} label={options.name_search_label} />
        ),
      });
    }
    if (options.radius_search) {
      filters.push({
        key: "geomag-series-radius",
        fields: [RADIUS_TOKEN],
        render: (ctx) => <RadiusFilter ctx={ctx} label="Radius Search" />,
      });
    }
    return filters;
  },
};

export default geomagSeriesPlugin;
