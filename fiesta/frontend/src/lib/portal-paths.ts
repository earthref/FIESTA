// Which router paths show the FIESTA portal's identity (header, theme color,
// favicon) instead of the node's. No imports: `npm test` loads it in Node.

/** The pages the FIESTA portal serves besides its home, each over every node
 * (routes/portal-pages.tsx). A per-node build serves them under the node. */
export const PORTAL_PAGES: string[] = ["/references", "/users"];

function trim(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** A router path ("/", "/users") the portal serves. */
export function isPortalPath(path: string): boolean {
  const trimmed = trim(path);
  return trimmed === "/" || PORTAL_PAGES.includes(trimmed);
}

/** One of PORTAL_PAGES ("/references", "/users/"), wherever it is served. */
export function isPortalPage(path: string): boolean {
  return PORTAL_PAGES.includes(trim(path));
}

/**
 * Whether the page at router path `path` shows the FIESTA identity: every page
 * of the portal (`portalHome`: base.ts PORTAL, the multi-node build base), and
 * References and Users wherever they are served -- also under a node's base
 * path (a per-node build, or /MagIC/references typed in), where "/" is the
 * node's own home and keeps the node's identity.
 */
export function showsPortalIdentity(portalHome: boolean, path: string): boolean {
  return portalHome || isPortalPage(path);
}
