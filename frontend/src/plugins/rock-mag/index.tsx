import { lazy, Suspense } from "react";
import { PageSpinner } from "../../components/ui/spinner";
import { useOpenContribution } from "../../lib/contribution-modal";
import type { NodeConfig } from "../../lib/types";
import type { PluginModule, PluginSubTabContext } from "../index";

// echarts lives in a lazily loaded chunk so other views never pay for it.
const RockMagView = lazy(() => import("./rock-mag-view"));

const VIEW_NAME = "Rock Magnetism";

interface RockMagPluginConfig {
  base_level?: string;
  table?: string;
}

function rockMagConfig(config: NodeConfig): RockMagPluginConfig {
  return (config.plugins["rock-mag"] ?? {}) as RockMagPluginConfig;
}

function RockMagSubTab({ query, ranges, bbox }: PluginSubTabContext) {
  const openContribution = useOpenContribution();
  return (
    <Suspense fallback={<PageSpinner label="Loading plots…" />}>
      <RockMagView
        query={query}
        ranges={ranges}
        bbox={bbox}
        onOpen={(id) => openContribution(id, "rock-mag")}
      />
    </Suspense>
  );
}

export const rockMagPlugin: PluginModule = {
  // A "Rock Magnetism / View" card beside the Poles one on the home page.
  homeCards(config) {
    const rconfig = rockMagConfig(config);
    if (!rconfig.base_level) return [];
    return [
      {
        key: "rock-mag",
        title: "Rock Magnetism\nView",
        to: "/search",
        search: { level: rconfig.base_level, view: VIEW_NAME },
      },
    ];
  },
  // A contribution's specimens on the same plots, in its modal.
  contributionTabs(config) {
    const rconfig = rockMagConfig(config);
    if (!rconfig.base_level) return [];
    return [
      {
        key: "rock-mag",
        label: "Rock Magnetism",
        countTable: rconfig.table ?? "rock_mag",
        render: ({ id, privateKey }) => (
          <Suspense fallback={<PageSpinner label="Loading plots…" />}>
            <RockMagView query="" ranges={[]} contribution={id} privateKey={privateKey} />
          </Suspense>
        ),
      },
    ];
  },
  // Rock Magnetism is a sub-tab of its base level (Specimens).
  levelSubTabs(level, config) {
    const rconfig = rockMagConfig(config);
    if (!rconfig.base_level || rconfig.base_level !== level.name) return [];
    return [
      {
        name: VIEW_NAME,
        countTable: rconfig.table ?? "rock_mag",
        render: (ctx) => <RockMagSubTab {...ctx} />,
      },
    ];
  },
};
