import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { isAnyAdmin, isNodeAdmin } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { PORTAL } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { EARTHREF, FIESTA_PORTAL, PORTALS, portalUrl } from "../lib/portals";
import { useLoginModal } from "./login-modal";
import { MobileDrawer } from "./mobile-drawer";
import { Icon } from "./ui/icon";

/**
 * Legacy `ui top fixed secondary pointing menu top-menu` (layout.jsx:89-160,
 * measured): 40px tall, bg #F8F8F8, 2px bottom border; every item 14px/400,
 * padding .857em 1.143em, line-height 1em, rgba(0,0,0,.87), aligned to the
 * bottom edge with a 2px transparent border. The active portal is node-colored
 * with a node-colored border. A sidebar (hamburger) item comes first below
 * 1024px; wide screens show the full portal bar instead, so it is hidden there.
 */
const itemClass =
  "flex items-center self-end whitespace-nowrap text-[rgba(0,0,0,0.87)] " +
  "hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.95)] focus-visible:outline-hidden " +
  "focus-visible:ring-2 focus-visible:ring-node";

const itemStyle: CSSProperties = {
  padding: "0.85714286em 1.14285714em",
  lineHeight: "1em",
  margin: "0 0 -2px",
  borderBottom: "2px solid transparent",
};

/** Fixed thin EarthRef portal bar across the very top of every page. */
export function PortalBar() {
  const { data: nodeConfig } = useNodeConfig();
  // The portal home is no node's page: the bar highlights EarthRef.org instead.
  const config = PORTAL ? undefined : nodeConfig;
  // Nodes whose web app production does not serve are left out (node YAML `publish.web`).
  const portals = PORTALS.filter((portal) => !nodeConfig?.hidden_nodes?.includes(portal.label));
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
    <div
      className="fixed inset-x-0 top-0 z-40 bg-[#F8F8F8]"
      style={{ borderBottom: "2px solid rgba(34,36,38,.15)", minHeight: 40 }}
    >
      <div className="flex items-stretch" style={{ minHeight: 38 }}>
        {/* Sidebar button (legacy `a.item.sidebar-button` with `i.sidebar.icon`), narrow only */}
        <button
          ref={hamburgerRef}
          type="button"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
          className={`${itemClass} lg:hidden`}
          style={itemStyle}
        >
          <Icon name="sidebar" style={{ width: "1.18em", height: "1em", marginRight: 5 }} />
        </button>
        {/* Narrow (<1024px): active portal label next to the sidebar button */}
        <Link
          to="/"
          className={`${itemClass} font-bold lg:hidden`}
          style={{ ...itemStyle, color: (config ?? FIESTA_PORTAL).color }}
        >
          {(config ?? FIESTA_PORTAL).key}
        </Link>

        {/* Wide (≥1024px): full portal bar */}
        <nav aria-label="EarthRef portals" className="hidden items-stretch lg:flex">
          {portals.map((portal) => {
            const active = PORTAL ? portal === EARTHREF : portal.label === config?.key;
            const style = {
              ...itemStyle,
              ...(active ? { color: portal.color, borderBottomColor: portal.color } : {}),
            };
            return active ? (
              <Link key={portal.label} to="/" className={itemClass} style={style}>
                {portal.label}
              </Link>
            ) : (
              <a
                key={portal.label}
                href={portalUrl(portal, nodeConfig?.deployment_nodes)}
                className={itemClass}
                style={style}
              >
                {portal.label}
              </a>
            );
          })}
        </nav>

        {/* User / login menu (always visible, right) */}
        <div className="ml-auto flex shrink-0 items-stretch">
          {user ? (
            <>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate({ to: "/" });
                }}
                className={itemClass}
                style={itemStyle}
              >
                <Icon name="close" style={{ marginRight: "0.35714286em" }} />
                Log Out
              </button>
              {isAnyAdmin(user) && (
                // Straight to this node's settings when the user administers it.
                <Link
                  {...(config && isNodeAdmin(user, config.slug)
                    ? { to: "/admin/nodes/$slug", params: { slug: config.slug } }
                    : { to: "/admin" })}
                  className={itemClass}
                  style={itemStyle}
                >
                  <Icon name="edit" style={{ marginRight: "0.35714286em" }} />
                  Admin
                </Link>
              )}
              <Link
                to="/private"
                className={itemClass}
                style={{ ...itemStyle, color: "var(--node-color)" }}
                title={user.email}
              >
                <Icon name="user" style={{ marginRight: "0.35714286em" }} />
                {user.name}
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={openLogin}
              className={itemClass}
              style={{ ...itemStyle, color: "var(--node-color)" }}
            >
              <Icon name="user" style={{ marginRight: "0.35714286em" }} />
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
