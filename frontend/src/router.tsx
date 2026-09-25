import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { BASE_PATH } from "./lib/base";
import { AdminPage } from "./routes/admin";
import { AdminNodePage } from "./routes/admin-node";
import { ContactPage } from "./routes/contact";
import { ContributionPage } from "./routes/contribution";
import { DataModelPage, DataModelsIndex } from "./routes/data-models";
import { HomePage } from "./routes/home";
import { RootLayout } from "./routes/layout";
import { LoginPage } from "./routes/login";
import { MethodCodesPage } from "./routes/method-codes";
import { NotFoundPage } from "./routes/not-found";
import { ContentPage } from "./routes/page";
import { PrivateWorkspacePage } from "./routes/private";
import { SearchPage } from "./routes/search";
import { UploadPage } from "./routes/upload";
import { ValidatePage } from "./routes/validate";
import { VocabulariesPage } from "./routes/vocabularies";

export interface SearchParams {
  q?: string;
  level?: string;
  sort?: string;
  /** Plugin range filters, each "field:gte:lte" (blank = open end). */
  ranges?: string[];
  /** Plugin bounding-box filter: "minLon,minLat,maxLon,maxLat". */
  bbox?: string;
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

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: str(search.q),
    level: str(search.level),
    sort: str(search.sort),
    ranges: strArray(search.ranges),
    bbox: str(search.bbox),
  }),
  component: SearchPage,
});

const contributionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contributions/$id",
  validateSearch: (search: Record<string, unknown>): PrivateKeyParams => ({
    private_key: str(search.private_key),
  }),
  component: ContributionPage,
});

const uploadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/upload",
  component: UploadPage,
});

const privateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/private",
  component: PrivateWorkspacePage,
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

const methodCodesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/method-codes",
  validateSearch: (search: Record<string, unknown>): FilterParams => ({
    q: str(search.q),
  }),
  component: MethodCodesPage,
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
// above win over this one; unknown slugs render the not-found page.
const contentPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$page",
  component: ContentPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  searchRoute,
  contributionRoute,
  uploadRoute,
  privateRoute,
  validateRoute,
  dataModelsIndexRoute,
  dataModelRoute,
  vocabulariesRoute,
  methodCodesRoute,
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
