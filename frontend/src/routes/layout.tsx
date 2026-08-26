import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorMessage } from "../components/error-message";
import { Footer } from "../components/footer";
import { LoginModalProvider } from "../components/login-modal";
import { NodeHeader } from "../components/node-header";
import { NodeMenu } from "../components/node-menu";
import { PortalBar } from "../components/portal-bar";
import { PageSpinner } from "../components/ui/spinner";
import { applyNodeTheme, useNodeConfig } from "../lib/config";

export function RootLayout() {
  const { data: config, isLoading, error } = useNodeConfig();

  useEffect(() => {
    if (config) applyNodeTheme(config);
  }, [config]);

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
        <ErrorMessage error={error ?? new Error("Could not load /api/config")} />
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
        <div className="pb-[4em] pt-[4em]">
          <NodeHeader />
          <NodeMenu />
          <main className="mx-auto w-full max-w-6xl px-4 py-4">
            <Outlet />
          </main>
        </div>
        <Footer />
      </div>
    </LoginModalProvider>
  );
}
