// Base path the SPA is served under -- "/" by default, or a node prefix such as
// "/MagIC/" when several nodes share one hostname (dev.earthref.org/MagIC/,
// and eventually earthref.org/MagIC/). It comes from Vite's `base`, which the
// Docker build sets from the BASE_PATH build arg (VITE_BASE_PATH for a local
// build). Vite guarantees the leading and trailing slash.

export const BASE_PATH: string = import.meta.env.BASE_URL;

/** Resolve a root-relative path ("/api/search", "/contributions/1") under the base path. */
export function siteUrl(path: string): string {
  return `${BASE_PATH.replace(/\/$/, "")}${path}`;
}
