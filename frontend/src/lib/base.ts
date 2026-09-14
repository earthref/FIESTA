// Where this SPA is served from and which FIESTA node and API it talks to.
//
// Two layouts:
//
//  * One node per build (a deployment). Vite's `base` -- BUILD_BASE -- is "/"
//    or the node's prefix ("/MagIC/" on earthref.org; the BASE_PATH build arg,
//    VITE_BASE_PATH for a local build) and the node is fixed: VITE_NODE at
//    build time or FIESTA_NODE in the nginx image. BASE_PATH == BUILD_BASE.
//
//  * Every node on one origin (the local stack, `make up`). The build sits at
//    "/" and `fiesta-env.js` lists the served nodes; the first path segment
//    names the node (http://localhost:8080/MagIC/, /cdr/ -- any case) and
//    becomes the router base, so NODE and BASE_PATH come from the URL at load.
//    A URL outside every node prefix is sent to the same path under the
//    default node (REDIRECT).
//
// `fiesta-env.js` is a tiny script index.html loads before the bundle:
//   window.__FIESTA__ = { node, apiUrl, nodes }
// `node` is the default node, `nodes` (comma-separated, optional) switches on
// the multi-node layout, and `apiUrl` is the API origin -- "" means same
// origin: the dev proxy or nginx forwards <BUILD_BASE>v2/ to the API. The
// nginx image renders it from its FIESTA_NODE / FIESTA_NODES / API_URL
// environment (one image serves any node or every node), the Vite dev server
// from the same variables, and `vite build` emits one with the build-time
// values so a static deployment works without nginx.

declare global {
  interface Window {
    __FIESTA__?: { node?: string; apiUrl?: string; nodes?: string };
  }
}

const runtime = window.__FIESTA__ ?? {};

/** Path the build is served under ("/" or "/MagIC/"): assets, fiesta-env.js and the API proxy live here. */
export const BUILD_BASE: string = import.meta.env.BASE_URL;

/** Nodes this origin serves under <BUILD_BASE><node>/ (multi-node layout); empty otherwise. */
export const NODES: string[] = (runtime.nodes ?? "")
  .split(",")
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);

const defaultNode = runtime.node || NODES[0] || import.meta.env.VITE_NODE || "magic";

// Multi-node layout: the first path segment below the build base, if it is a
// served node, selects the node and extends the base path.
const segment = NODES.length
  ? (location.pathname.slice(BUILD_BASE.length).split("/")[0] ?? "")
  : "";
const inNodePrefix = segment !== "" && NODES.includes(segment.toLowerCase());

/** Node slug (magic, cdr, ...) whose /v2/{node} routes this SPA uses. */
export const NODE: string = inNodePrefix ? segment.toLowerCase() : defaultNode;

/** Path the SPA's routes live under (router basepath); ends with "/". */
export const BASE_PATH: string = inNodePrefix ? `${BUILD_BASE}${segment}/` : BUILD_BASE;

/** Multi-node layout only: the URL to load instead of this one, or null.
 * "/" and "/search" become "/magic/" and "/magic/search" (the default node);
 * a bare "/MagIC" gains its trailing slash so the router base matches. */
export const REDIRECT: string | null = (() => {
  if (!NODES.length) return null;
  const rest = location.search + location.hash;
  if (!inNodePrefix) {
    return `${BUILD_BASE}${defaultNode}${location.pathname.slice(BUILD_BASE.length - 1)}${rest}`;
  }
  if (location.pathname === BASE_PATH.slice(0, -1)) return `${BASE_PATH}${rest}`;
  return null;
})();

/** API origin, e.g. "https://api.earthref.org"; "" for same-origin under the build base. */
export const API_URL: string = (runtime.apiUrl || import.meta.env.VITE_API_URL || "").replace(
  /\/+$/,
  "",
);

/** Resolve a root-relative SPA path ("/contributions/1") under this node's base path. */
export function siteUrl(path: string): string {
  return `${BASE_PATH.replace(/\/$/, "")}${path}`;
}

/** Resolve a static file of the build ("/FIESTA.png" from public/) under the build base. */
export function assetUrl(path: string): string {
  return `${BUILD_BASE.replace(/\/$/, "")}${path}`;
}

/** Absolute URL of an API route given relative to /v2 ("/auth/login", "/magic/config"). */
export function apiUrl(path: string): string {
  return `${API_URL || assetUrl("")}/v2${path}`;
}

/** Absolute URL of a route of this node ("/config" -> .../v2/magic/config). */
export function nodeUrl(path: string): string {
  return apiUrl(`/${NODE}${path}`);
}
