// A link to a node's settings page. A node's settings live under the node
// (/MagIC/Admin, /MagIC/Admin/Files): this app's own node by the router,
// another node this origin serves by a page load, and a node no app serves
// yet (just created) at the portal's /Admin/Nodes/<slug>/<section>.
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { NODE, NODES, PORTAL } from "../../lib/base";
import { nodePageUrl } from "../../lib/portals";

export interface NodeAdminTarget {
  slug: string;
  key: string;
  /** The API serves it (with one build per node, so does an app). */
  served: boolean;
}

/** Whether this app shows the node's settings under its own /Admin route. */
function isOwnNode(slug: string): boolean {
  return !PORTAL && slug === NODE;
}

/** The node's settings page's URL on another app of this origin, or null
 * for a router link. */
function nodeAdminHref(node: NodeAdminTarget, section?: string): string | null {
  if (isOwnNode(node.slug)) return null;
  const appServes = NODES.length ? NODES.includes(node.slug) : node.served;
  if (!appServes) return null;
  return nodePageUrl(node.key, section ? `/Admin/${section}` : "/Admin");
}

export function NodeAdminLink({
  node,
  section,
  className,
  children,
}: {
  node: NodeAdminTarget;
  /** The section's path segment ("Files"); none: Settings. */
  section?: string;
  className?: string;
  children: ReactNode;
}) {
  const href = nodeAdminHref(node, section);
  if (href) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  if (isOwnNode(node.slug)) {
    return section ? (
      <Link to="/Admin/$tab" params={{ tab: section }} className={className}>
        {children}
      </Link>
    ) : (
      <Link to="/Admin" className={className}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/Admin/Nodes/$slug/{-$section}"
      params={{ slug: node.slug, section }}
      className={className}
    >
      {children}
    </Link>
  );
}

/** Go to a node's settings page (after creating it, a section tab). */
export function useOpenNodeAdmin(): (node: NodeAdminTarget, section?: string) => void {
  const navigate = useNavigate();
  return (node, section) => {
    const href = nodeAdminHref(node, section);
    if (href) window.location.assign(href);
    else if (isOwnNode(node.slug)) {
      if (section) navigate({ to: "/Admin/$tab", params: { tab: section } });
      else navigate({ to: "/Admin" });
    } else {
      navigate({ to: "/Admin/Nodes/$slug/{-$section}", params: { slug: node.slug, section } });
    }
  };
}
