import type { CSSProperties } from "react";
import { ICONS, type IconName } from "./icon-map";

export { FALLBACK_ICON, type IconName, iconName, isIconName } from "./icon-map";

/**
 * One icon set for the whole SPA: Lucide outline glyphs (see icon-map.ts),
 * stroked in currentColor and sized in em like Semantic UI's `i.icon`, so a
 * call site keeps the size it had. `corner` adds a badge at the bottom right
 * (Semantic's `i.icons` + `corner icon`): a node-colored circle with a white
 * glyph and a ring of the surface color (`--er-icon-outline` where the
 * background is not the page surface).
 */

/** Semantic UI size scale in em. */
const SIZES = {
  small: "0.875em",
  medium: "1em",
  large: "1.5em",
  big: "2em",
  huge: "4em",
} as const;

export type IconSize = keyof typeof SIZES;

/** `.ui.button > .icon`: a 1.18em × 1em box, margin 0 .43em 0 −.21em, opacity .8. */
export const buttonIconStyle: CSSProperties = {
  width: "1.18em",
  height: "1em",
  margin: "0 0.42857143em 0 -0.21428571em",
  opacity: 0.8,
};

/** The body font size the em sizes are estimated against (Semantic's 14px). */
const BASE_PX = 14;

/** The rendered size in px, as well as it can be told before layout. */
function estimatePx(size: IconSize | number, style?: CSSProperties): number {
  const width = style?.width;
  if (typeof width === "number") return width;
  if (typeof width === "string") {
    const value = Number.parseFloat(width);
    if (width.endsWith("px")) return value;
    if (width.endsWith("em")) return value * BASE_PX;
  }
  if (typeof size === "number") return size;
  return Number.parseFloat(SIZES[size]) * BASE_PX;
}

/** Stroke width in the 24-unit viewBox: 2 up to 20px, 1.75 at 24px, 1.5
 * from 32px, linear between, so large glyphs do not turn heavy. */
export function strokeWidthFor(px: number): number {
  if (px <= 20) return 2;
  if (px <= 24) return 2 - ((px - 20) / 4) * 0.25;
  if (px < 32) return 1.75 - ((px - 24) / 8) * 0.25;
  return 1.5;
}

export function Icon({
  name,
  size = "medium",
  corner,
  strokeWidth,
  className,
  style,
}: {
  name: IconName;
  /** A Semantic size name (em of the font size) or a size in px. */
  size?: IconSize | number;
  /** A glyph badged at the bottom right, in a node-colored circle. */
  corner?: IconName;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const Glyph = ICONS[name];
  const dimension = typeof size === "number" ? size : SIZES[size];
  const stroke = strokeWidth ?? strokeWidthFor(estimatePx(size, style));
  const box: CSSProperties = {
    width: dimension,
    height: dimension,
    display: "inline-block",
    verticalAlign: "-0.125em",
    flexShrink: 0,
  };
  if (!corner) {
    return (
      <Glyph
        aria-hidden="true"
        focusable="false"
        strokeWidth={stroke}
        className={className}
        style={{ ...box, ...style }}
      />
    );
  }
  const Corner = ICONS[corner];
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ ...box, position: "relative", lineHeight: 0, ...style }}
    >
      <Glyph
        focusable="false"
        strokeWidth={stroke}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      <span
        style={{
          position: "absolute",
          right: "-15%",
          bottom: "-15%",
          width: "45%",
          height: "45%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          background: "var(--node-color)",
          color: "#fff",
          boxShadow: "0 0 0 1.5px var(--er-icon-outline, var(--er-surface))",
        }}
      >
        <Corner
          focusable="false"
          strokeWidth={2.75}
          style={{ display: "block", width: "66%", height: "66%" }}
        />
      </span>
    </span>
  );
}
