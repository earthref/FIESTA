import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { isAnyAdmin, isNodeAdmin } from "../lib/admin";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import type { NodeConfig, UserOut } from "../lib/types";
import { isSourceMode } from "./source-mode-notice";
import { Icon, type IconName } from "./ui/icon";

const entryClass =
  "flex w-full items-center whitespace-nowrap px-4 py-2 text-left text-ink " +
  "hover:bg-shade/5 hover:text-ink-strong focus-visible:bg-shade/5 focus-visible:outline-hidden";

const iconStyle: CSSProperties = { width: "1.18em", height: "1em", marginRight: "0.5em" };

function Entry({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <>
      <Icon name={icon} style={iconStyle} />
      {children}
    </>
  );
}

/**
 * The signed-in user's name in the portal bar opens this menu: Private
 * Workspace (not while the node mirrors its source), Account, Admin (node or
 * super admins), the light/dark switch and Log Out. Escape or a click outside
 * closes it; arrow keys move between its entries.
 */
export function UserMenu({
  user,
  config,
  className,
  style,
}: {
  user: UserOut;
  config: NodeConfig | undefined;
  className: string;
  style: CSSProperties;
}) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on route change only
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative flex items-stretch">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={className}
        style={{ ...style, color: "var(--node-ink)" }}
        title={user.email}
      >
        <Icon name="user" style={{ marginRight: "0.35714286em" }} />
        {user.name}
        <Icon name="caret-down" style={{ marginLeft: "0.35714286em", width: "0.75em" }} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-50 mt-[2px] min-w-[13rem] rounded-b-sm border border-edge bg-surface py-1 text-sm shadow-lg"
        >
          <div className="border-b border-edge px-4 pb-2 pt-1 text-xs text-ink-faint">
            {user.email}
          </div>
          {!isSourceMode(config) && (
            <Link to="/private" role="menuitem" className={entryClass} onClick={close}>
              <Entry icon="folder-open">Private Workspace</Entry>
            </Link>
          )}
          <Link to="/account" role="menuitem" className={entryClass} onClick={close}>
            <Entry icon="user">Account</Entry>
          </Link>
          {isAnyAdmin(user) && (
            // Straight to this node's settings when the user administers it.
            <Link
              {...(config && isNodeAdmin(user, config.slug)
                ? { to: "/admin/nodes/$slug", params: { slug: config.slug } }
                : { to: "/admin" })}
              role="menuitem"
              className={entryClass}
              onClick={close}
            >
              <Entry icon="edit">Admin</Entry>
            </Link>
          )}
          <div className="my-1 border-t border-edge" />
          <button type="button" role="menuitem" className={entryClass} onClick={toggleTheme}>
            <Entry icon={theme === "dark" ? "sun" : "moon"}>
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </Entry>
          </button>
          <button
            type="button"
            role="menuitem"
            className={entryClass}
            onClick={() => {
              close();
              logout();
              navigate({ to: "/" });
            }}
          >
            <Entry icon="close">Log Out</Entry>
          </button>
        </div>
      )}
    </div>
  );
}
