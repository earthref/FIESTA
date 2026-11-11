import type { CSSProperties } from "react";
import { cx } from "../../lib/utils";

/** A pulsing gray block standing in for content that is loading (`round`: a
 * circle, for a globe thumbnail). */
export function Skeleton({
  className,
  style,
  round = false,
}: {
  className?: string;
  style?: CSSProperties;
  round?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cx("animate-pulse bg-gray-200", round ? "rounded-full" : "rounded-sm", className)}
      style={style}
    />
  );
}

// Line widths that vary from row to row and column to column, so a column of
// skeleton cells reads as text rather than as a striped block.
const WIDTHS = [72, 48, 86, 60, 38, 78, 54, 66];

/** A skeleton line's width (percent of its cell) for a row and column. */
export function skeletonWidth(row: number, column: number, offset = 0): string {
  return `${WIDTHS[(row * 3 + column * 5 + offset) % WIDTHS.length]}%`;
}
