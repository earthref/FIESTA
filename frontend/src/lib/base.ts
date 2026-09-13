// Where this SPA is served from and which FIESTA node and API it talks to.
//
// BASE_PATH is the path the SPA is served under -- "/" by default, or a node
// prefix such as "/MagIC/" when several nodes share one hostname
// (dev.earthref.org/MagIC/, and eventually earthref.org/MagIC/). It comes
// from Vite's `base`, which the Docker build sets from the BASE_PATH build
// arg (VITE_BASE_PATH for a local build). Vite guarantees both slashes.
//
// NODE and API_URL come from `fiesta-env.js`, a tiny script index.html loads
// before the bundle. The nginx image renders it from its FIESTA_NODE and
// API_URL environment (one image serves any node), the Vite dev server from
// the same variables, and `vite build` emits one with the build-time values
// (VITE_NODE / VITE_API_URL) so a static deployment works without nginx.
// An empty API_URL means "same origin, under the base path" -- the dev proxy
// or nginx forwards <base>v1/ to the API.

declare global {
  interface Window {
    __FIESTA__?: { node?: string; apiUrl?: string };
  }
}

const runtime = window.__FIESTA__ ?? {};

export const BASE_PATH: string = import.meta.env.BASE_URL;

/** Node slug (magic, cdr, ...) whose /v1/{node} routes this SPA uses. */
export const NODE: string = runtime.node || import.meta.env.VITE_NODE || "magic";

/** API origin, e.g. "https://api.earthref.org"; "" for same-origin under the base path. */
export const API_URL: string = (runtime.apiUrl || import.meta.env.VITE_API_URL || "").replace(
  /\/+$/,
  "",
);

/** Resolve a root-relative SPA path ("/contributions/1") under the base path. */
export function siteUrl(path: string): string {
  return `${BASE_PATH.replace(/\/$/, "")}${path}`;
}

/** Absolute URL of an API route given relative to /v1 ("/auth/login", "/magic/config"). */
export function apiUrl(path: string): string {
  return `${API_URL || siteUrl("")}/v1${path}`;
}

/** Absolute URL of a route of this node ("/config" -> .../v1/magic/config). */
export function nodeUrl(path: string): string {
  return apiUrl(`/${NODE}${path}`);
}
