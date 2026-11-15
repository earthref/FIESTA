import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { assetUrl, PORTAL } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { EARTHREF, FIESTA_PORTAL, portalUrl, usePortalIdentity } from "../lib/portals";
import { NodeMark } from "./node-mark";

// The legacy page-logo square: 1.5em of 2.75em on the 14px body.
const HEADER_TILE = 57.75;

const logoBox: CSSProperties = {
  fontSize: "2.75em",
  width: "1.5em",
  height: "1.5em",
  margin: "0 0.25em 0 0",
};
const focusRing = "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node";

/**
 * Node tile, title, and subtitle (legacy page.jsx/page.less, measured):
 * page-logo = `ui menu basic button <color>` — a 1.5em square (57.75px) at
 * 2.75em, 1px segment border + 1px inset node-colored shadow, floated left
 * with margin-right .25em; h1 28px/36px; h4 15px bold/19.3px. The serif
 * letter it held is now the node tile (components/node-mark.tsx), framed alike
 * and unnamed: the title beside it names the node.
 *
 * The portal's pages (its home, and References and Users wherever they are
 * served) show FIESTA instead (lib/portals.ts usePortalIdentity).
 */
export function NodeHeader() {
  const { data: nodeConfig } = useNodeConfig();
  const portal = usePortalIdentity();
  const config = portal ? FIESTA_PORTAL : nodeConfig;

  // Home of the identity shown: the router's "/" on the portal and in a node;
  // References or Users under a node link out to the EarthRef entry instead.
  const home = (
    className: string,
    label: string | undefined,
    children: ReactNode,
    style?: CSSProperties,
  ) =>
    portal && !PORTAL ? (
      <a
        href={portalUrl(EARTHREF, nodeConfig?.deployment_nodes)}
        aria-label={label}
        className={className}
        style={style}
      >
        {children}
      </a>
    ) : (
      <Link to="/" aria-label={label} className={className} style={style}>
        {children}
      </Link>
    );

  return (
    // Legacy `.full-width` layout variant (padding 0 2em) frames the header too.
    <div className="w-full px-[2em]">
      <div>
        {portal
          ? // The portal home's fireworks logo in the letter-logo's 1.5em square.
            home(
              `float-left block ${focusRing}`,
              "FIESTA home",
              <img src={assetUrl("/FIESTA.png")} alt="" className="h-full w-full object-contain" />,
              logoBox,
            )
          : // The node tile, drawing only, in the legacy letter logo's 1.5em square (57.75px).
            home(
              `float-left block hover:opacity-85 ${focusRing}`,
              `${config?.key ?? "Node"} home`,
              nodeConfig && (
                <NodeMark
                  size={HEADER_TILE}
                  color={nodeConfig.color}
                  label={nodeConfig.logo_label || nodeConfig.key}
                  named={false}
                  svg={nodeConfig.logo_svg}
                  style={nodeConfig.logo_style}
                />
              ),
              logoBox,
            )}
        {home(
          "block min-w-0 overflow-hidden focus-visible:outline-hidden",
          undefined, // named by its headings
          <>
            <h1
              className="m-0 truncate font-bold text-ink"
              style={{ fontSize: "2rem", lineHeight: "1.28571429em" }}
            >
              {config?.title}
            </h1>
            <h4
              className="m-0 line-clamp-2 font-bold text-ink"
              style={{ fontSize: "1.07142857rem", lineHeight: "1.28571429em" }}
            >
              {config?.subtitle}
            </h4>
          </>,
        )}
      </div>
    </div>
  );
}
