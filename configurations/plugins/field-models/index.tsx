import { lazy, Suspense } from "react";
import { PageSpinner } from "@/components/ui/spinner";
import type { PluginModule } from "@/plugins";
import { fieldModelsConfig } from "./field-models-data";

// The view (echarts, the Mollweide maps, the coastlines) is a lazy chunk.
const FieldModelsView = lazy(() => import("./field-models-view"));

const VIEW_NAME = "Field Models";

const fieldModelsPlugin: PluginModule = {
  // Field Models is a sub-tab of its base level (GEOMAGIA: Sites).
  levelSubTabs(level, config) {
    const fconfig = fieldModelsConfig(config);
    if (!fconfig || fconfig.base_level !== level.name) return [];
    return [
      {
        name: VIEW_NAME,
        render: ({ query, ranges, bbox, scope, contribution }) =>
          contribution ? null : (
            <Suspense fallback={<PageSpinner label="Loading field models…" />}>
              <FieldModelsView
                node={config}
                config={fconfig}
                query={query}
                ranges={ranges}
                bbox={bbox}
                scope={scope}
              />
            </Suspense>
          ),
      },
    ];
  },
};

export default fieldModelsPlugin;
