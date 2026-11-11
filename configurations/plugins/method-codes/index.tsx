// The method-codes plugin's UI: the Method Codes page, its home resource card
// and the codes' definitions beside facet values (README.md).
import type { FacetValueDescription, PluginModule } from "@/plugins";
import { hasCodes, type MethodCodes, methodCodesQuery } from "./method-codes-data";
import { MethodCodesPage } from "./method-codes-page";

/** Each code's definition, its group's label, and the group's place in the file. */
function describe(data: unknown): Map<string, FacetValueDescription> {
  const out = new Map<string, FacetValueDescription>();
  Object.values((data ?? {}) as MethodCodes).forEach((group, order) => {
    for (const code of group.codes) {
      out.set(code.code, { definition: code.definition ?? "", group: group.label, order });
    }
  });
  return out;
}

const plugin: PluginModule = {
  pages: [
    {
      path: "/method-codes",
      component: MethodCodesPage,
      validateSearch: (search) => ({ q: typeof search.q === "string" ? search.q : undefined }),
    },
  ],
  resourceCards(config) {
    if (!hasCodes(config)) return [];
    return [
      {
        title: "Method\nCodes",
        icon: "lab",
        corner_icon: "write",
        to: "/method-codes",
        href: null,
      },
    ];
  },
  facetDescriptions(config) {
    return hasCodes(config) ? { ...methodCodesQuery, select: describe } : null;
  },
};

export default plugin;
