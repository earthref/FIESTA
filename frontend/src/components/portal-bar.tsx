import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import { PORTALS } from "../lib/portals";
import { useLoginModal } from "./login-modal";
import { MobileDrawer } from "./mobile-drawer";
import { Icon } from "./ui/icon";

/** Fixed thin EarthRef portal bar across the very top of every page. */
export function PortalBar() {
  const { data: config } = useNodeConfig();
  const { user, logout } = useAuth();
  const { openLogin } = useLoginModal();
  const navigate = useNavigate();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Close the drawer on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on route change only
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="fixed inset-x-0 top-0 z-40 border-b border-gray-200 bg-[#F8F8F8]">
      <div className="flex h-9 items-center gap-1 px-2">
        {/* Narrow (<1024px): hamburger + active portal label */}
        <button
          ref={hamburgerRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className="flex items-center rounded-sm px-2 py-1 text-gray-700 hover:bg-gray-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node lg:hidden"
        >
          <Icon name="sidebar" size="large" />
        </button>
        <Link
          to="/"
          className="text-base font-bold lg:hidden"
          style={{ color: config?.color ?? "inherit" }}
        >
          {config?.key}
        </Link>

        {/* Wide (≥1024px): full portal bar */}
        <nav aria-label="EarthRef portals" className="hidden h-full items-center lg:flex">
          {PORTALS.map((portal) => {
            const active = portal.label === config?.key;
            const className =
              "flex h-full items-center whitespace-nowrap border-b-2 px-2 text-base hover:bg-gray-50";
            const style = {
              color: portal.color,
              borderBottomColor: active ? portal.color : "transparent",
              fontWeight: active ? 700 : 500,
            };
            // In a multi-node local stack, cross-link to sibling nodes running
            // on this host instead of the production URLs.
            const localUrl = config?.portal_urls?.[portal.label.toLowerCase()];
            return active ? (
              <Link key={portal.label} to="/" className={className} style={style}>
                {portal.label}
              </Link>
            ) : (
              <a
                key={portal.label}
                href={localUrl ?? portal.url}
                className={className}
                style={style}
              >
                {portal.label}
              </a>
            );
          })}
        </nav>

        {/* User / login menu (always visible, right) */}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {user ? (
            <>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate({ to: "/" });
                }}
                className="whitespace-nowrap rounded-sm px-2 py-1 text-base font-medium text-gray-600 hover:bg-gray-100"
              >
                Log Out
              </button>
              <Link
                to="/private"
                className="flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-base font-semibold text-node hover:bg-gray-100"
                title={user.email}
              >
                <Icon name="user" size="small" />
                {user.name}
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={openLogin}
              className="flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-base font-semibold text-node hover:bg-gray-100"
            >
              <Icon name="user" size="small" />
              <span className="hidden sm:inline">Log In / Register</span>
              <span className="sm:hidden">Log In</span>
            </button>
          )}
        </div>
      </div>

      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        returnFocusRef={hamburgerRef}
      />
    </div>
  );
}
