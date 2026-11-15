import type { CSSProperties } from "react";
import { darkInk } from "../lib/config";
import { logoMarkup, parseLogo, TILE_FONT, tileInk, tileLayout } from "../lib/node-logo";
import type { LogoStyle } from "../lib/types";

export interface NodeMarkProps {
  /** Side in px. Named (the label under the drawing) from 44px up. */
  size: number;
  /** The node color: the ring, and (darkened for contrast) the ink. */
  color: string;
  /** The node's name: the tile's accessible name and the label on it. */
  label: string;
  /** false: the drawing alone, centered, at any size (the node header, whose
   * title already names the node). A tile without a drawing keeps its name. */
  named?: boolean;
  /** The logo SVG's text (sanitized again here before it is inlined). */
  svg?: string | null;
  style?: LogoStyle | null;
  className?: string;
}

/**
 * The node tile, used wherever a node's logo shows (header, portal home,
 * admin lists; lib/node-logo.ts draws the same tile as the favicon). `tile`
 * frames the one-color drawing in the legacy letter logo's square and writes
 * the name under it; `full` draws the SVG as drawn, unframed.
 *
 * It follows the color scheme: white with the darkened tile ink in light
 * mode; in dark mode no background of its own (the page, header or card
 * shows through, and through a drawing's even-odd holes) and the lighter
 * dark-mode node ink of --node-ink (lib/config.ts inkColor). The node-colored
 * ring stays in both. The favicon (tileSvg) keeps the white badge.
 */
export function NodeMark({
  size,
  color,
  label,
  named = true,
  svg,
  style,
  className,
}: NodeMarkProps) {
  const logo = parseLogo(svg);
  const box: CSSProperties = {
    position: "relative",
    display: "block",
    flexShrink: 0,
    width: size,
    height: size,
    boxSizing: "border-box",
  };
  const ink = `light-dark(${tileInk(color)}, ${darkInk(color)})`;
  if (logo && style === "full") {
    return (
      <span
        role="img"
        aria-label={label}
        className={className}
        // Its own colors; any currentColor in it is the node ink.
        style={{ ...box, color: ink }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: rebuilt from an element/attribute allowlist by parseLogo (lib/node-logo.ts)
        dangerouslySetInnerHTML={{
          __html: logoMarkup(logo, "full").replace(/^<svg /, '<svg width="100%" height="100%" '),
        }}
      />
    );
  }
  const layout = tileLayout(size, logo && !named ? "" : label, logo);
  const drawing = layout.drawing;
  return (
    <span
      role="img"
      aria-label={label}
      className={className}
      style={{
        ...box,
        overflow: "hidden",
        // White in light mode, like the legacy letter logo; the surface beneath in dark.
        background: "light-dark(#fff, transparent)",
        border: "1px solid var(--er-line)",
        boxShadow: `inset 0 0 0 1px ${color}`,
        borderRadius: layout.radius,
      }}
    >
      {logo && drawing && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: drawing.left,
            top: drawing.top,
            width: drawing.width,
            height: drawing.height,
            color: ink,
            display: "block",
          }}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: rebuilt from an element/attribute allowlist by parseLogo (lib/node-logo.ts)
          dangerouslySetInnerHTML={{
            __html: logoMarkup(logo, "tile", layout.strokeWidth).replace(
              /^<svg /,
              '<svg width="100%" height="100%" style="display:block;overflow:visible" ',
            ),
          }}
        />
      )}
      {layout.label && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            ...(layout.labelBottom === null
              ? { top: "50%", transform: "translateY(-50%)" }
              : { bottom: layout.labelBottom }),
            color: ink,
            fontFamily: TILE_FONT,
            fontWeight: 800,
            fontSize: layout.fontSize,
            lineHeight: 1,
            textAlign: "center",
            whiteSpace: "nowrap",
            letterSpacing: 0,
          }}
        >
          {layout.label}
        </span>
      )}
    </span>
  );
}
