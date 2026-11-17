// Which router paths show the FIESTA portal's identity (header, theme color,
// favicon) instead of the node's. No imports: `npm test` loads it in Node.
// Router paths match in any case (/References, /references).

/** The pages the FIESTA portal serves besides its home, each over every node
 * (routes/portal-pages.tsx). A per-node build serves them under the node. */
export const PORTAL_PAGES: string[] = ["/References", "/Users"];

/** Admin: at the portal, `/Admin` and its tabs (`/Admin/Nodes`,
 * `/Admin/Accounts`, a node's page at `/Admin/Nodes/<slug>`); under a node,
 * `/Admin` and `/Admin/<section>` are that node's settings and keep its
 * identity, while the portal's tabs keep the FIESTA one. */
export const ADMIN = "/Admin";
export const ADMIN_TABS: string[] = ["Nodes", "Accounts"];

function norm(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.toLowerCase();
}

function isAdminPath(path: string): boolean {
  const p = norm(path);
  const admin = ADMIN.toLowerCase();
  return p === admin || p.startsWith(`${admin}/`);
}

/** A portal tab of Admin (/Admin/Nodes, /Admin/Nodes/magic, /Admin/Accounts). */
export function isPortalAdminPath(path: string): boolean {
  const p = norm(path);
  return ADMIN_TABS.some((tab) => {
    const prefix = `${ADMIN}/${tab}`.toLowerCase();
    return p === prefix || p.startsWith(`${prefix}/`);
  });
}

/** A router path ("/", "/Users", "/Admin/Nodes/magic") the portal serves. */
export function isPortalPath(path: string): boolean {
  return norm(path) === "/" || isPortalPage(path) || isAdminPath(path);
}

/** One of PORTAL_PAGES ("/References", "/users/") or a portal tab of Admin,
 * wherever it is served. */
export function isPortalPage(path: string): boolean {
  const p = norm(path);
  return PORTAL_PAGES.some((page) => page.toLowerCase() === p) || isPortalAdminPath(path);
}

/**
 * Whether the page at router path `path` shows the FIESTA identity: every page
 * of the portal (`portalHome`: base.ts PORTAL, the multi-node build base), and
 * References, Users and Admin's portal tabs wherever they are served -- also
 * under a node's base path (a per-node build, or /MagIC/References typed in),
 * where "/" is the node's own home and `/Admin` the node's own settings.
 */
export function showsPortalIdentity(portalHome: boolean, path: string): boolean {
  return portalHome || isPortalPage(path);
}
