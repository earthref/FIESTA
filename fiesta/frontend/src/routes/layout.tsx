import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { AutoReload } from "../components/auto-reload";
import { ContactProvider } from "../components/contact-modal";
import { ErrorMessage } from "../components/error-message";
import { Footer } from "../components/footer";
import { LoginModalProvider } from "../components/login-modal";
import { NodeHeader } from "../components/node-header";
import { NodeMenu } from "../components/node-menu";
import { PortalBar } from "../components/portal-bar";
import { PageSpinner } from "../components/ui/spinner";
import { BASE_PATH, BUILD_BASE, isPortalPath, NODES, nodeSiteUrl, PORTAL } from "../lib/base";
import { withRouteCase } from "../lib/canonical-path";
import { applyNodeTheme, useNodeConfig } from "../lib/config";
import { FIESTA_PORTAL, usePortalIdentity } from "../lib/portals";

export function RootLayout() {
  const { data: config, isLoading, error } = useNodeConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The portal home, and References and Users wherever they are served, wear
  // FIESTA's identity; moving back into the node's pages restores the node's.
  const portal = usePortalIdentity();

  useEffect(() => {
    if (config) applyNodeTheme(portal ? FIESTA_PORTAL : config);
  }, [config, portal]);

  // The portal home, References, Users and Admin are the only pages outside a
  // node: any other route they link to (the user's workspace, Account) loads
  // under the default node, at its /<Key>/ prefix (the case a per-node
  // deployment serves: /MagIC/, not /magic/).
  const nodeKey = config?.key;
  useEffect(() => {
    if (PORTAL && nodeKey && !isPortalPath(pathname)) {
      const { pathname: path, search, hash } = window.location;
      window.location.replace(
        nodeSiteUrl(nodeKey, `${path.slice(BUILD_BASE.length - 1)}${search}${hash}`),
      );
    }
  }, [pathname, nodeKey]);

  // Canonical URLs (lib/canonical-path.ts): the node prefix as its key
  // (/magic/ -> /MagIC/, a reload: the router's base is fixed at load) and the
  // route's static segments as the route spells them (/search -> /Search).
  // Each page canonicalizes its own names (a level, a tab, a content page).
  const router = useRouter();
  const routePattern = useRouterState({
    select: (state) => state.matches[state.matches.length - 1]?.fullPath,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads window.location; runs on every navigation
  useEffect(() => {
    const { pathname: path, search, hash } = window.location;
    if (NODES.length && !PORTAL && nodeKey && NODES.includes(nodeKey.toLowerCase())) {
      const canonicalBase = `${BUILD_BASE}${nodeKey}/`;
      if (BASE_PATH !== canonicalBase && path.startsWith(BASE_PATH)) {
        window.location.replace(`${canonicalBase}${path.slice(BASE_PATH.length)}${search}${hash}`);
        return;
      }
    }
    const base = BASE_PATH.slice(0, -1);
    if (!routePattern || !path.startsWith(base)) return;
    const tail = path.slice(base.length) || "/";
    const cased = withRouteCase(routePattern, tail);
    if (cased !== tail) {
      router.history.replace(`${base}${cased}${search}${hash}`, router.state.location.state);
    }
  }, [pathname, routePattern, nodeKey, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <PageSpinner label="Loading repository configuration…" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="mb-3 text-lg font-semibold">FIESTA</h1>
        <ErrorMessage error={error ?? new Error("Could not load the node config")} />
        <p className="mt-3 text-sm text-gray-500">
          The repository configuration could not be loaded. Check that the backend is running and
          reachable at <code>/api</code>.
        </p>
      </div>
    );
  }

  // A node whose web app is not published (node YAML `publish.web`) is not
  // opened outside a local stack; its API may still be served.
  if (!PORTAL && config.web_published === false) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="mb-3 text-lg font-semibold">{config.key}</h1>
        <p className="text-sm text-gray-600">
          {config.key} is not published on the web yet. Visit{" "}
          <a href="https://earthref.org/" className="font-medium text-node-ink hover:underline">
            EarthRef.org
          </a>{" "}
          for the published repositories.
        </p>
      </div>
    );
  }

  // ContactProvider outside LoginModalProvider: its modal renders after (so
  // above) the sign-in modal, whose "Having trouble?" button opens it.
  return (
    <ContactProvider>
      <LoginModalProvider>
        <div className="min-h-screen bg-surface">
          <PortalBar />
          {/* layout-content: padding-top 4em clears the fixed bar (layout.less:41-44); the
            bottom tracks the fixed footer's measured height, which grows as it wraps. */}
          <div className="pt-[4em] sm:pb-[calc(var(--footer-h,3.5em)_+_0.5em)]">
            {/* Every page uses the legacy `.full-width` layout variant (padding 0 2em). */}
            <NodeHeader />
            {!portal && <NodeMenu />}
            <main className="clear-both w-full px-[2em] pt-[1.25em] lg:pt-0">
              <Outlet />
            </main>
          </div>
          <Footer />
          <AutoReload />
        </div>
      </LoginModalProvider>
    </ContactProvider>
  );
}
