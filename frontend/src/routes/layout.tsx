import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorMessage } from "../components/error-message";
import { Footer } from "../components/footer";
import { LoginModalProvider } from "../components/login-modal";
import { NodeHeader } from "../components/node-header";
import { NodeMenu } from "../components/node-menu";
import { PortalBar } from "../components/portal-bar";
import { PageSpinner } from "../components/ui/spinner";
import { BUILD_BASE, NODE, nodeSiteUrl, PORTAL } from "../lib/base";
import { applyNodeTheme, useNodeConfig } from "../lib/config";
import { FIESTA_PORTAL } from "../lib/portals";

export function RootLayout() {
  const { data: config, isLoading, error } = useNodeConfig();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    if (config) applyNodeTheme(PORTAL ? FIESTA_PORTAL : config);
  }, [config]);

  // The portal home is the only page outside a node: any other route it links
  // to (Admin, the user's workspace) loads under the default node.
  useEffect(() => {
    if (PORTAL && pathname !== "/") {
      const { pathname: path, search, hash } = window.location;
      window.location.replace(
        nodeSiteUrl(NODE, `${path.slice(BUILD_BASE.length - 1)}${search}${hash}`),
      );
    }
  }, [pathname]);

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

  return (
    <LoginModalProvider>
      <div className="min-h-screen bg-white">
        <PortalBar />
        {/* layout-content: padding-top/bottom 4em clears the fixed bars (layout.less:41-44) */}
        <div className="pt-[4em] sm:pb-[4em]">
          {/* Every page uses the legacy `.full-width` layout variant (padding 0 2em). */}
          <NodeHeader />
          {!PORTAL && <NodeMenu />}
          <main className="clear-both w-full px-[2em] pt-[1.25em] lg:pt-0">
            <Outlet />
          </main>
        </div>
        <Footer />
      </div>
    </LoginModalProvider>
  );
}
