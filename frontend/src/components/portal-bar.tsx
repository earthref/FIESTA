import { Link, useNavigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { useNodeConfig } from "../lib/config";
import { PORTALS } from "../lib/portals";
import { useLoginModal } from "./login-modal";

/** Fixed thin EarthRef portal bar across the very top of every page. */
export function PortalBar() {
  const { data: config } = useNodeConfig();
  const { user, logout } = useAuth();
  const { openLogin } = useLoginModal();
  const navigate = useNavigate();

  return (
    <div className="fixed inset-x-0 top-0 z-40 border-b border-gray-200 bg-[#F8F8F8]">
      <div className="flex h-9 items-center gap-1 overflow-x-auto px-2">
        <nav aria-label="EarthRef portals" className="flex h-full items-center">
          {PORTALS.map((portal) => {
            const active = portal.label === config?.key;
            const className =
              "flex h-full items-center whitespace-nowrap border-b-2 px-2 text-xs hover:bg-gray-50";
            const style = {
              color: portal.color,
              borderBottomColor: active ? portal.color : "transparent",
              fontWeight: active ? 700 : 500,
            };
            return active ? (
              <Link key={portal.label} to="/" className={className} style={style}>
                {portal.label}
              </Link>
            ) : (
              <a key={portal.label} href={portal.url} className={className} style={style}>
                {portal.label}
              </a>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {user ? (
            <>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate({ to: "/" });
                }}
                className="whitespace-nowrap rounded-sm px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
              >
                Log Out
              </button>
              <Link
                to="/private"
                className="flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-semibold text-node hover:bg-gray-100"
                title={user.email}
              >
                <UserIcon />
                {user.name}
              </Link>
            </>
          ) : (
            <button
              type="button"
              onClick={openLogin}
              className="flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-xs font-semibold text-node hover:bg-gray-100"
            >
              <UserIcon />
              Log In / Register
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function UserIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z" />
    </svg>
  );
}
