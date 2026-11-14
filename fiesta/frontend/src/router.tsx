import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { BASE_PATH, PORTAL } from "./lib/base";
import { useNodeConfig } from "./lib/config";
import { pluginPages } from "./plugins";
import { AccountPage } from "./routes/account";
import { AdminPage } from "./routes/admin";
import { AdminNodePage } from "./routes/admin-node";
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
import { SearchPage } from "./routes/search";
import { UploadPage } from "./routes/upload";
import { ValidatePage } from "./routes/validate";
import { VocabulariesPage } from "./routes/vocabularies";

export interface SearchParams {
  q?: string;
  level?: string;
  /** The result sub-tab to open with (Summaries, Rows, Map, a plugin view). */
  view?: string;
  sort?: string;
  /** Plugin range filters, each "field:gte:lte" (blank = open end). */
  ranges?: string[];
  /** Summary grid column filters, each "<column key>:<text>". */
  filter?: string[];
  /** With/without data filters, each "<table>:<column>" (a value in it) or
   * "!<table>:<column>" (has the table, not that column). */
  has?: string[];
  /** Plugin bounding-box filter: "minLon,minLat,maxLon,maxLat". */
  bbox?: string;
  /** The Map tab's area filter: "west,south,east,north", east past 180 across the antimeridian. */
  area?: string;
  /** The contribution whose modal is open, its tab, the row selected in a
   * level tab (its 1-based place in the file's table), and a private one's key. */
  contribution?: number;
  tab?: string;
  row?: number;
  /** The plot selected in a plot tab (the plugin's key for it). */
  plot?: string;
  private_key?: string;
  /** "My contributions": the signed-in user's own, unpublished or published. */
  mine?: "in_prep" | "published";
  /** "all" also shows older versions of contributions. */
  versions?: "all";
}

function strArray(value: unknown): string[] | undefined {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) {
    const entries = value.filter((entry) => typeof entry === "string" && entry !== "");
    return entries.length > 0 ? (entries as string[]) : undefined;
  }
  return undefined;
}

export interface PrivateKeyParams {
  private_key?: string;
}

export interface FilterParams {
  q?: string;
}

export interface AdminParams {
  tab?: string;
}

export interface AdminNodeParams {
  section?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A name param: a record's name may be all digits (`?plot=34178`), which
 * the router parses as a number. */
function name(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
}

/** An id param (a number, so the URL reads `?contribution=16901`). */
function id(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: PORTAL ? PortalHomePage : HomePage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: str(search.q),
    level: str(search.level),
    view: str(search.view),
    sort: str(search.sort),
    ranges: strArray(search.ranges),
    filter: strArray(search.filter),
    has: strArray(search.has),
    bbox: str(search.bbox),
    area: str(search.area),
    contribution: id(search.contribution),
    tab: str(search.tab),
    row: id(search.row),
    plot: name(search.plot),
    private_key: str(search.private_key),
    mine: search.mine === "in_prep" || search.mine === "published" ? search.mine : undefined,
    versions: search.versions === "all" ? "all" : undefined,
  }),
  component: SearchPage,
});

// A contribution opens as a modal over the search page: /contributions/<id>
// (and /<id>, below) land there.
const contributionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contributions/$id",
  validateSearch: (search: Record<string, unknown>): PrivateKeyParams => ({
    private_key: str(search.private_key),
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/search",
      search: { contribution: id(params.id), private_key: search.private_key },
      replace: true,
    });
  },
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  // ?to=<id>: upload into that private contribution (its Add Data link).
  validateSearch: (search: Record<string, unknown>): { to?: number } => {
    const to = Number(search.to);
    return Number.isInteger(to) && to > 0 ? { to } : {};
  },
  component: UploadPage,
});

const privateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/private",
  component: PrivateWorkspacePage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountPage,
});

const validateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/validate",
  component: ValidatePage,
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
  path: "/vocabularies",
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
  path: "/references",
  component: ReferencesPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users",
  component: UsersPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const contactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contact",
  component: ContactPage,
});

// Admin settings (super admins and node admins; the API enforces who sees what).
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  validateSearch: (search: Record<string, unknown>): AdminParams => ({ tab: str(search.tab) }),
  component: AdminPage,
});

const adminNodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/nodes/$slug",
  validateSearch: (search: Record<string, unknown>): AdminNodeParams => ({
    section: str(search.section),
  }),
  component: AdminNodePage,
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
    if (/^\d+$/.test(params.page)) {
      throw redirect({
        to: "/search",
        search: { contribution: Number(params.page), private_key: search.private_key },
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
  uploadRoute,
  privateRoute,
  accountRoute,
  validateRoute,
  dataModelsIndexRoute,
  dataModelRoute,
  vocabulariesRoute,
  ...pluginRoutes,
  referencesRoute,
  usersRoute,
  loginRoute,
  contactRoute,
  adminRoute,
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
