import { BASE_PATH, BUILD_BASE, NODES } from "./base";

/** EarthRef portal registry rendered in the fixed top portal bar. */
export interface Portal {
  label: string;
  url: string;
  color: string;
}

export const PORTALS: Portal[] = [
  { label: "EarthRef.org", url: "https://earthref.org/", color: "#006600" },
  { label: "MagIC", url: "https://earthref.org/MagIC", color: "#800080" },
  { label: "KdD", url: "https://earthref.org/KdD", color: "#217e5c" },
  { label: "CDR", url: "https://earthref.org/CDR", color: "#e09f00" },
  { label: "KArAr", url: "https://earthref.org/KArAr", color: "#3030bb" },
  { label: "OSU-MGR", url: "https://osu-mgr.org", color: "#D73F09" },
  { label: "GERM", url: "https://earthref.org/GERM/", color: "#bb4b1c" },
  { label: "SBN", url: "https://earthref.org/SBN/", color: "#005b87" },
  { label: "FeMO", url: "https://earthref.org/FeMO/", color: "#9f0202" },
  { label: "SCC", url: "https://earthref.org/SCC/", color: "#8b216a" },
  { label: "ERESE", url: "https://earthref.org/ERESE/", color: "#3030bb" },
  { label: "ERDA", url: "https://earthref.org/ERDA/", color: "#006600" },
  { label: "References", url: "https://earthref.org/ERR/", color: "#006600" },
  { label: "Users", url: "https://earthref.org/ERML/", color: "#006600" },
];

// Hosts the production URLs above live on: a page served from one of them
// links every portal to production.
const productionHosts = new Set(PORTALS.map((portal) => new URL(portal.url).hostname));

// Where this deployment serves its nodes, each under /<Key>/: the build base
// in the multi-node layout (http://localhost:8080/MagIC/), the parent of the
// node's own prefix with one build per node (dev.earthref.org/MagIC/). A
// build at "/" on a hostname of its own has no siblings on this origin.
const siblingBase: string | null = NODES.length
  ? BUILD_BASE
  : BASE_PATH === "/"
    ? null
    : BASE_PATH.replace(/[^/]+\/$/, "");

/**
 * The URL a portal links to. Off the production hosts (a local stack, the dev
 * server), a node this deployment also serves -- listed in fiesta-env.js for
 * the multi-node layout, else the API's `deployment_nodes` -- links to its
 * instance next to this one; everything else keeps its production URL.
 */
export function portalUrl(portal: Portal, deploymentNodes: string[] = []): string {
  if (siblingBase === null || productionHosts.has(location.hostname)) return portal.url;
  const slug = portal.label.toLowerCase();
  const served = NODES.length ? NODES : deploymentNodes.map((key) => key.toLowerCase());
  return served.includes(slug) ? `${siblingBase}${portal.label}/` : portal.url;
}
