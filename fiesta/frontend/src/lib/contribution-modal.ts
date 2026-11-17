import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext } from "react";
import { pluginContributionTabs } from "../plugins";
import type { SearchBackground } from "../router";
import { nodeSiteUrl } from "./base";
import { NodeConfigScope, useNodeConfig } from "./config";
import { contributionPath, slug } from "./search-state";
import type { NodeConfig } from "./types";

/** A search doc's row for the modal to find in a level tab and select. */
export interface RowMatch {
  id: string;
  table: string;
  values: Record<string, unknown>;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set by the search page's Data grid; the modal swaps it for `?row=`. */
    rowMatch?: RowMatch;
  }
}

/** The search page a contribution's modal opens over (its route params);
 * the search page provides it, so the modal closes back onto that search. */
export const SearchBackgroundContext = createContext<SearchBackground | undefined>(undefined);

/** A modal tab's label (its path segment) for its key: "sites" -> "Sites",
 * "map" -> "Map", a plugin tab's key -> its label. */
export function contributionTabLabel(config: NodeConfig | undefined, key: string): string {
  if (key === "contribution") return "Contribution";
  if (key === "map") return "Map";
  const level = config?.search_levels.find((entry) => entry.table === key);
  if (level) return level.name;
  const plugin = config ? pluginContributionTabs(config).find((tab) => tab.key === key) : undefined;
  return plugin?.label ?? key;
}

/**
 * Opens a contribution's modal: /<id>/<tab> (the modal's tab, by key:
 * "contribution", a level's table, "map" or a plugin tab's key; the URL names
 * it by its label), over the current search. `match` is a row of that level's
 * table for the modal to find and select (carried in the history entry, not
 * the URL). `options.plot` selects a plot in a plot tab (`?plot=`), and
 * `options.privateKey` opens a private contribution (the private
 * workspace's). On the portal home (NodeConfigScope) it loads the scoped
 * node's page instead.
 */
export function useOpenContribution(): (
  id: string,
  tab?: string,
  match?: Record<string, unknown>,
  options?: { plot?: string; privateKey?: string },
) => void {
  const scoped = useContext(NodeConfigScope);
  const background = useContext(SearchBackgroundContext);
  const { data: config } = useNodeConfig();
  const navigate = useNavigate();
  return (id, tab, match, options) => {
    const plot = options?.plot;
    const privateKey = options?.privateKey;
    const label = tab ? contributionTabLabel(config, tab) : undefined;
    if (scoped) {
      const query = new URLSearchParams({
        ...(plot ? { plot } : {}),
        ...(privateKey ? { private_key: privateKey } : {}),
      });
      const suffix = query.size ? `?${query}` : "";
      window.location.assign(nodeSiteUrl(scoped.key, `${contributionPath(id, label)}${suffix}`));
      return;
    }
    navigate({
      to: "/$id/$tab",
      params: { id, tab: label ? slug(label) : "Contribution" },
      search: { plot, private_key: privateKey },
      state: {
        background,
        ...(match && tab ? { rowMatch: { id, table: tab, values: match } } : {}),
      },
    });
  };
}
