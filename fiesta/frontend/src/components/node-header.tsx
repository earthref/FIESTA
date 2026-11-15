import { Link } from "@tanstack/react-router";
import { assetUrl, PORTAL } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { FIESTA_PORTAL } from "../lib/portals";
import { NodeMark } from "./node-mark";

// The legacy page-logo square: 1.5em of 2.75em on the 14px body.
const HEADER_TILE = 57.75;

/**
 * Node tile, title, and subtitle (legacy page.jsx/page.less, measured):
 * page-logo = `ui menu basic button <color>` — a 1.5em square (57.75px) at
 * 2.75em, 1px segment border + 1px inset node-colored shadow, floated left
 * with margin-right .25em; h1 28px/36px; h4 15px bold/19.3px. The serif
 * letter it held is now the node tile (components/node-mark.tsx), framed alike.
 */
export function NodeHeader() {
  const { data: nodeConfig } = useNodeConfig();
  const config = PORTAL ? FIESTA_PORTAL : nodeConfig;

  return (
    // Legacy `.full-width` layout variant (padding 0 2em) frames the header too.
    <div className="w-full px-[2em]">
      <div>
        {PORTAL ? (
          // The portal home's fireworks logo in the letter-logo's 1.5em square.
          <Link
            to="/"
            aria-label="FIESTA home"
            className="float-left block focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
            style={{ fontSize: "2.75em", width: "1.5em", height: "1.5em", margin: "0 0.25em 0 0" }}
          >
            <img src={assetUrl("/FIESTA.png")} alt="" className="h-full w-full object-contain" />
          </Link>
        ) : (
          // The node tile in the legacy letter logo's 1.5em square (57.75px).
          <Link
            to="/"
            aria-label={`${config?.key ?? "Node"} home`}
            className="float-left block hover:opacity-85 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
            style={{ fontSize: "2.75em", width: "1.5em", height: "1.5em", margin: "0 0.25em 0 0" }}
          >
            {nodeConfig && (
              <NodeMark
                size={HEADER_TILE}
                color={nodeConfig.color}
                label={nodeConfig.logo_label || nodeConfig.key}
                svg={nodeConfig.logo_svg}
                style={nodeConfig.logo_style}
              />
            )}
          </Link>
        )}
        <Link to="/" className="block min-w-0 overflow-hidden focus-visible:outline-hidden">
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
        </Link>
      </div>
    </div>
  );
}
