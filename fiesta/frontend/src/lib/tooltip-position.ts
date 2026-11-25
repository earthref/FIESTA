/** Where the tooltip goes: beside its anchor, kept inside the viewport. */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  side: "top" | "bottom";
}

/** Space between the anchor and the tooltip. */
export const GAP = 6;
/** Space kept between the tooltip and the viewport's edges. */
export const MARGIN = 8;

/** An anchor larger than this (a card, a table, a plot) gets its tooltip at
 * the pointer instead: centred on it, the tooltip would be far from the eye. */
const LARGE = { width: 320, height: 96 };
/** Clearance below the pointer, for the cursor itself. */
const CURSOR = 14;

/**
 * The tooltip's fixed position: centred above the anchor, below it where there
 * is no room above (or on whichever side has more room when neither fits), and
 * moved sideways, then vertically, to stay `MARGIN` inside the viewport.
 */
export function placeTooltip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  prefer: "top" | "bottom" = "top",
): Placement {
  const above = anchor.top - GAP - size.height;
  const below = anchor.top + anchor.height + GAP;
  const fitsAbove = above >= MARGIN;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const roomAbove = anchor.top;
  const roomBelow = viewport.height - (anchor.top + anchor.height);
  let side = prefer;
  if (prefer === "top" && !fitsAbove) side = fitsBelow || roomBelow > roomAbove ? "bottom" : "top";
  if (prefer === "bottom" && !fitsBelow)
    side = fitsAbove || roomAbove > roomBelow ? "top" : "bottom";

  const clamp = (value: number, max: number) => Math.max(MARGIN, Math.min(value, max));
  return {
    left: clamp(
      anchor.left + anchor.width / 2 - size.width / 2,
      viewport.width - MARGIN - size.width,
    ),
    top: clamp(side === "top" ? above : below, viewport.height - MARGIN - size.height),
    side,
  };
}

/**
 * What the tooltip is placed against: the anchor's box, or, for a large anchor
 * hovered with a pointer, a box under the pointer (so the tooltip opens below
 * the cursor, like a native one).
 */
export function anchorBox(
  rect: Box,
  pointer: { x: number; y: number } | null,
): { box: Box; prefer: "top" | "bottom" } {
  if (pointer && (rect.width > LARGE.width || rect.height > LARGE.height)) {
    return {
      box: { left: pointer.x, top: pointer.y, width: 0, height: CURSOR },
      prefer: "bottom",
    };
  }
  return { box: rect, prefer: "top" };
}
