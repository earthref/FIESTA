import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { BASE_PATH, PORTAL } from "./lib/base";
import { useNodeConfig } from "./lib/config";
import { ADMIN_TABS } from "./lib/portal-paths";
import { saveSearchState } from "./lib/saved-search";
import { hasLegacyParams, slug, stateFromLegacy } from "./lib/search-state";
import { normalizeView } from "./lib/utils";
import { pluginPages } from "./plugins";
import { AccountPage } from "./routes/account";
import { AdminPage } from "./routes/admin";
import { AdminNodeRoutePage, CurrentNodeAdminPage } from "./routes/admin-node";
import { ContactPage } from "./routes/contact";
import { DataModelPage, DataModelsIndex } from "./routes/data-models";
import { HomePage } from "./routes/home";
import { RootLayout } from "./routes/layout";
import { LoginPage } from "./routes/login";
import { NotFoundPage } from "./routes/not-found";
import { ContentPage } from "./routes/page";
import { PortalHomePage } from "./routes/portal-home";
import { ReferencesPage, UsersPage } from "./routes/portal-pages";
import { PrivateWorkspacePage } from "./routes/private";
import { ContributionRoutePage, SearchRoutePage } from "./routes/search";
import { UpgradePage } from "./routes/upgrade";
import { UploadPage } from "./routes/upload";
import { ValidatePage } from "./routes/validate";
import { VocabulariesPage } from "./routes/vocabularies";

// Paths match in any case (the router's default): /search and /Search are the
// same route, so every link below written before the clean URLs still lands.

/** The search page's one query param: its saved search (lib/search-state.ts).
 * The rest are the legacy params a link from before the saved searches
 * carries (`/MagIC/search?q=basalt&level=Sites&sort=...`); the route turns
 * them into a saved search and redirects, so none of them stays in the URL. */
export interface SearchRouteParams {
  /** A saved search's id; legacy links: free text. */
  q?: string;
  level?: string;
  view?: string;
  sort?: string;
  ranges?: string[];
  filter?: string[];
  has?: string[];
  bbox?: string;
  area?: string;
  plates?: string;
  mine?: "in_prep" | "published";
  versions?: "all";
  contribution?: number;
  tab?: string;
  row?: number;
  plot?: string;
  private_key?: string;
}

/** A contribution's modal (/MagIC/16901/Sites): the row selected in a level
 * tab (its 1-based place in the file's table) and a column of it to point
 * at, the plot in a plot tab, a private one's key. `row_id` is a persistent
 * row link's row (/CDR/672.59: the file's row with that `row_id`), which the
 * modal swaps for its level tab and `row` once found. */
export interface ContributionRouteParams {
  row?: number;
  row_id?: number;
  column?: string;
  plot?: string;
  private_key?: string;
}

/** The search a contribution's modal opens over (the history entry's, so a
 * reload keeps it): the search route's params. */
export interface SearchBackground {
  level?: string;
  view?: string;
  q?: string;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    background?: SearchBackground;
  }
}

export interface PrivateKeyParams {
  private_key?: string;
}

export interface FilterParams {
  q?: string;
}

/** Legacy `/admin?tab=users` and `/admin/nodes/magic?section=files`. */
export interface AdminLegacyParams {
  tab?: string;
  section?: string;
}

function strArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) {
    const entries = value.filter((entry) => typeof entry === "string" && entry !== "");
    return entries.length > 0 ? (entries as string[]) : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A name param: a record's name may be all digits (`?plot=34178`), which
 * the router parses as a number. */
function name(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
}

/** An id param (a number, so the URL reads `?row=12`). */
function id(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

function contributionParams(search: Record<string, unknown>): ContributionRouteParams {
  return {
    row: id(search.row),
    row_id: id(search.row_id),
    column: str(search.column),
    plot: name(search.plot),
    private_key: str(search.private_key),
  };
}

/** A persistent link's path segment: a contribution (`672`), one of its
 * file's rows (`672.59`, by `row_id`) or a data point, a column of that row
 * (`672.59.measurement`). */
const CONTRIBUTION_LINK = /^(\d+)(?:\.(\d+)(?:\.([A-Za-z_]\w*))?)?$/;

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: PORTAL ? PortalHomePage : HomePage,
});

// The search page: /Search/<level>/<view>?q=<saved search>. Level and view
// are optional (the first level, its default view).
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Search/{-$level}/{-$view}",
  validateSearch: (search: Record<string, unknown>): SearchRouteParams => ({
    q: name(search.q),
    level: str(search.level),
    view: str(search.view),
    sort: str(search.sort),
    ranges: strArray(search.ranges),
    filter: strArray(search.filter),
    has: strArray(search.has),
    bbox: str(search.bbox),
    area: str(search.area),
    plates: str(search.plates),
    mine: search.mine === "in_prep" || search.mine === "published" ? search.mine : undefined,
    versions: search.versions === "all" ? "all" : undefined,
    contribution: id(search.contribution),
    tab: str(search.tab),
    row: id(search.row),
    plot: name(search.plot),
    private_key: str(search.private_key),
  }),
  beforeLoad: async ({ params, search, preload }) => {
    // A hovered legacy link is not saved until it is followed.
    if (preload || !hasLegacyParams(search as Record<string, unknown>)) return;
    const level = search.level ?? params.level;
    // The old URLs did not carry the open view; a raw row column's sort
    // (`rows.<column>`) was the Data grid's.
    const view = search.view
      ? normalizeView(search.view)
      : (params.view ?? (search.sort?.startsWith("rows.") ? "Data" : undefined));
    const state = stateFromLegacy(search as Record<string, unknown>);
    // The state is lost if the API is down; the level and view still open.
    const q = await saveSearchState(state, { level, view }).catch(() => undefined);
    const background: SearchBackground = {
      level: level && slug(level),
      view: view && slug(view),
      q,
    };
    if (search.contribution !== undefined) {
      throw redirect({
        to: "/$id/$tab",
        params: { id: String(search.contribution), tab: search.tab ?? "Contribution" },
        search: { row: search.row, plot: search.plot, private_key: search.private_key },
        state: { background },
        replace: true,
      });
    }
    throw redirect({
      to: "/Search/{-$level}/{-$view}",
      params: { level: background.level, view: background.view },
      search: { q },
      replace: true,
    });
  },
  component: SearchRoutePage,
});

// A contribution's modal over the search page: /MagIC/16901/Contribution,
// /MagIC/16901/Sites?row=3 (the tab is its label, any case).
const contributionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$id/$tab",
  validateSearch: contributionParams,
  beforeLoad: ({ params }) => {
    if (!/^\d+$/.test(params.id)) throw notFound();
  },
  component: ContributionRoutePage,
});

// Older contribution links: /contributions/16901 (and /16901, below).
const legacyContributionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contributions/$id",
  validateSearch: (search: Record<string, unknown>): PrivateKeyParams => ({
    private_key: str(search.private_key),
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/$id/$tab",
      params: { id: params.id, tab: "Contribution" },
      search: { private_key: search.private_key },
      replace: true,
    });
  },
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Upload",
  // ?to=<id>: upload into that private contribution (its Add Data link).
  validateSearch: (search: Record<string, unknown>): { to?: number } => {
    const to = Number(search.to);
    return Number.isInteger(to) && to > 0 ? { to } : {};
  },
  component: UploadPage,
});

const privateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Private",
  component: PrivateWorkspacePage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Account",
  component: AccountPage,
});

const validateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Validate",
  component: ValidatePage,
});

const upgradeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Upgrade",
  component: UpgradePage,
});

const dataModelsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-models",
  component: DataModelsIndex,
});

const dataModelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-models/$version",
  validateSearch: (search: Record<string, unknown>): FilterParams => ({
    q: str(search.q),
  }),
  component: DataModelPage,
});

const vocabulariesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Vocabularies",
  validateSearch: (search: Record<string, unknown>): FilterParams => ({
    q: str(search.q),
  }),
  component: VocabulariesPage,
});

// Plugin pages (PluginModule.pages): every plugin's, a not-found page on a
// node that does not activate it.
function pluginPageComponent(plugin: string, Page: ComponentType): () => ReactNode {
  return function PluginPage() {
    const { data: config } = useNodeConfig();
    if (!config) return null;
    return plugin in (config.plugins ?? {}) ? <Page /> : <NotFoundPage />;
  };
}

const pluginRoutes = pluginPages().map(({ plugin, page }) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: page.path,
    validateSearch: page.validateSearch ?? (() => ({})),
    component: pluginPageComponent(plugin, page.component),
  }),
);

// The portal's References and Users grids over every node (portals.ts `path`):
// at the portal in the multi-node layout, under the node in a per-node build.
const referencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/References",
  component: ReferencesPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Users",
  component: UsersPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Login",
  component: LoginPage,
});

const contactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Contact",
  component: ContactPage,
});

// Admin (super admins and node admins; the API enforces who sees what). At
// the portal, /Admin is its Nodes tab and /Admin/Accounts the accounts; a
// node's settings are under the node, /MagIC/Admin/<section>, or at the
// portal's /Admin/Nodes/<slug>/<section> for a node no app serves yet.
function adminTab(segment: string | undefined): string | undefined {
  return ADMIN_TABS.find((tab) => tab.toLowerCase() === segment?.toLowerCase());
}

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Admin",
  validateSearch: (search: Record<string, unknown>): AdminLegacyParams => ({
    tab: str(search.tab),
  }),
  beforeLoad: ({ search }) => {
    // Legacy /admin?tab=users|nodes.
    if (search.tab) {
      throw redirect({
        to: "/Admin/$tab",
        params: { tab: search.tab === "users" ? "Accounts" : "Nodes" },
        replace: true,
      });
    }
  },
  component: function AdminIndex() {
    return PORTAL ? <AdminPage tab="Nodes" /> : <CurrentNodeAdminPage />;
  },
});

const adminTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Admin/$tab",
  component: function AdminTab() {
    const { tab } = adminTabRoute.useParams();
    const portalTab = adminTab(tab);
    if (portalTab) return <AdminPage tab={portalTab} />;
    return PORTAL ? <NotFoundPage /> : <CurrentNodeAdminPage section={tab} />;
  },
});

const adminNodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/Admin/Nodes/$slug/{-$section}",
  validateSearch: (search: Record<string, unknown>): AdminLegacyParams => ({
    section: str(search.section),
  }),
  beforeLoad: ({ params, search }) => {
    // Legacy /admin/nodes/magic?section=files.
    if (search.section) {
      throw redirect({
        to: "/Admin/Nodes/$slug/{-$section}",
        params: { slug: params.slug, section: search.section },
        replace: true,
      });
    }
  },
  component: AdminNodeRoutePage,
});

// Content pages from the node YAML (`pages`): /about, /help, ... Static routes
// above win over this one; unknown slugs render the not-found page. A number
// is a contribution (earthref.org/MagIC/16901): its modal on the search page.
const contentPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$page",
  validateSearch: (search: Record<string, unknown>): PrivateKeyParams => ({
    private_key: str(search.private_key),
  }),
  beforeLoad: ({ params, search }) => {
    const link = CONTRIBUTION_LINK.exec(params.page);
    if (link) {
      const [, contribution, rowId, column] = link;
      throw redirect({
        to: "/$id/$tab",
        params: { id: contribution, tab: "Contribution" },
        search: {
          row_id: rowId ? Number(rowId) : undefined,
          column,
          private_key: search.private_key,
        },
        replace: true,
      });
    }
  },
  component: ContentPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  searchRoute,
  contributionRoute,
  legacyContributionRoute,
  uploadRoute,
  privateRoute,
  accountRoute,
  validateRoute,
  upgradeRoute,
  dataModelsIndexRoute,
  dataModelRoute,
  vocabulariesRoute,
  ...pluginRoutes,
  referencesRoute,
  usersRoute,
  loginRoute,
  contactRoute,
  adminRoute,
  adminTabRoute,
  adminNodeRoute,
  contentPageRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: BASE_PATH,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
