import { useNavigate } from "@tanstack/react-router";
import { useContext } from "react";
import type { SearchParams } from "../router";
import { nodeSiteUrl } from "./base";
import { NodeConfigScope } from "./config";

/** A search doc's row for the modal to find in a level tab and select. */
export interface RowMatch {
  id: string;
  table: string;
  values: Record<string, unknown>;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set by the search page's Rows grid; the modal swaps it for `?row=`. */
    rowMatch?: RowMatch;
  }
}

/**
 * Opens a contribution's modal: the search page with `?contribution=<id>`
 * (and `tab`, the modal's tab: "contribution", a level's table, "map" or a
 * plugin tab's key), keeping the current search behind it. `match` is a row
 * of that level's table for the modal to find and select (carried in the
 * history entry, not the URL). `options.plot` selects a plot in a plot tab
 * (`?plot=`), and `options.privateKey` opens a private contribution (the
 * private workspace's). On the portal home (NodeConfigScope) it loads the
 * scoped node's search page instead.
 */
export function useOpenContribution(): (
  id: string,
  tab?: string,
  match?: Record<string, unknown>,
  options?: { plot?: string; privateKey?: string },
) => void {
  const scoped = useContext(NodeConfigScope);
  const navigate = useNavigate();
  return (id, tab, match, options) => {
    const plot = options?.plot;
    const privateKey = options?.privateKey;
    if (scoped) {
      const query = new URLSearchParams({
        contribution: id,
        ...(tab ? { tab } : {}),
        ...(plot ? { plot } : {}),
        ...(privateKey ? { private_key: privateKey } : {}),
      });
      window.location.assign(nodeSiteUrl(scoped.key, `/search?${query}`));
      return;
    }
    navigate({
      to: "/search",
      search: (prev: SearchParams) => ({
        ...prev,
        contribution: Number(id),
        tab,
        row: undefined,
        plot,
        ...(privateKey ? { private_key: privateKey } : {}),
      }),
      state: match && tab ? { rowMatch: { id, table: tab, values: match } } : undefined,
    });
  };
}
