import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useNodeConfig } from "../lib/config";
import { PORTALS, portalUrl } from "../lib/portals";
import { type NodeMenuItem, nodeMenuItems } from "./node-menu";
import { Icon } from "./ui/icon";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Focus is restored here when the drawer closes (the hamburger button). */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

/** Left slide-in navigation drawer for narrow (<1024px) viewports. */
export function MobileDrawer({ open, onClose, returnFocusRef }: MobileDrawerProps) {
  const { data: config } = useNodeConfig();
  const panelRef = useRef<HTMLDivElement>(null);
  const { left, right } = nodeMenuItems(config);
  const menuItems = [...left, ...right];

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // Move focus into the drawer, restore it to the hamburger on close.
    const previouslyFocused = returnFocusRef.current;
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose, returnFocusRef]);

  if (!open) return null;

  const menuLink = (item: NodeMenuItem) => {
    const className =
      "flex items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 " +
      "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node " +
      "[&.active]:font-semibold [&.active]:text-node";
    return item.href ? (
      <a
        key={item.key}
        href={item.href}
        target="_blank"
        rel="noreferrer"
        className={className}
        onClick={onClose}
      >
        {item.icon && <Icon name={item.icon} size="small" className="text-[#555555]" />}
        {item.label}
      </a>
    ) : (
      <Link
        key={item.key}
        to={item.to ?? "/"}
        className={className}
        activeOptions={item.exact ? { exact: true } : undefined}
        onClick={onClose}
      >
        {item.icon && <Icon name={item.icon} size="small" className="text-[#555555]" />}
        {item.label}
      </Link>
    );
  };

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Translucent backdrop */}
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 cursor-default bg-gray-900/40"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col overflow-y-auto bg-white shadow-xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
          <span className="text-sm font-semibold text-gray-900">Menu</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-sm p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          >
            <Icon name="close" size="small" />
          </button>
        </div>

        {/* All EarthRef portal links (brand colors, active bold) */}
        <nav aria-label="EarthRef portals" className="flex flex-col p-2">
          {PORTALS.map((portal) => {
            const active = portal.label === config?.key;
            const className =
              "rounded-sm px-3 py-1.5 text-sm hover:bg-gray-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node";
            const style = { color: portal.color, fontWeight: active ? 700 : 500 };
            return active ? (
              <Link key={portal.label} to="/" className={className} style={style} onClick={onClose}>
                {portal.label}
              </Link>
            ) : (
              <a
                key={portal.label}
                href={portalUrl(portal, config?.deployment_nodes)}
                className={className}
                style={style}
              >
                {portal.label}
              </a>
            );
          })}
        </nav>

        <div className="mx-2 border-t border-gray-200" />

        {/* Node menu items */}
        <nav aria-label="Node" className="flex flex-col p-2">
          {menuItems.map(menuLink)}
        </nav>
      </div>
    </div>
  );
}
