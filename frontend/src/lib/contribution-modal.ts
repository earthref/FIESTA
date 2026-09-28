import { useNavigate } from "@tanstack/react-router";
import { useContext } from "react";
import type { SearchParams } from "../router";
import { nodeSiteUrl } from "./base";
import { NodeConfigScope } from "./config";

/**
 * Opens a contribution's modal: the search page with `?contribution=<id>`
 * (and `tab`, the modal's tab: "contribution", a level's table, "map" or a
 * plugin tab's key), keeping the current search behind it. On the portal
 * home (NodeConfigScope) it loads the scoped node's search page instead.
 */
export function useOpenContribution(): (id: string, tab?: string) => void {
  const scoped = useContext(NodeConfigScope);
  const navigate = useNavigate();
  return (id, tab) => {
    if (scoped) {
      const query = new URLSearchParams({ contribution: id, ...(tab ? { tab } : {}) });
      window.location.assign(nodeSiteUrl(scoped.key, `/search?${query}`));
      return;
    }
    navigate({
      to: "/search",
      search: (prev: SearchParams) => ({ ...prev, contribution: Number(id), tab }),
    });
  };
}
