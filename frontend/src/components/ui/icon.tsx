import type { CSSProperties } from "react";

/**
 * Hand-rolled flat SVG icon set (Semantic UI / FA5-solid style): single-path
 * 24x24 glyphs, fill currentColor, sized in em. No gradients, no two-tone.
 */
const PATHS = {
  search:
    "M9.6 1.4a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Zm0 3.2a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM15.1 17.5l2.4-2.4 5.3 5.3-2.4 2.4z",
  close:
    "M6.22 4.81 4.81 6.22 10.59 12l-5.78 5.78 1.41 1.41L12 13.41l5.78 5.78 1.41-1.41L13.41 12l5.78-5.78-1.41-1.41L12 10.59 6.22 4.81Z",
  "remove-circle":
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.9 6.1 1.4 1.4-2.5 2.5 2.5 2.5-1.4 1.4-2.5-2.5-2.5 2.5-1.4-1.4 2.5-2.5-2.5-2.5 1.4-1.4 2.5 2.5z",
  download: "M9.8 2h4.4v8.2h4.2L12 17.4 5.6 10.2h4.2V2ZM3 18.6h18V22H3v-3.4Z",
  upload:
    "M12 3.59l5.95 5.94-1.41 1.42L13 7.41V17h-2V7.41l-3.54 3.54-1.41-1.42L12 3.59ZM4 19h16v2H4v-2Z",
  user: "M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 11c4.42 0 8 2.24 8 5v2H4v-2c0-2.76 3.58-5 8-5Z",
  mail: "M2 5h20v14H2V5Zm2 2.41V17h16V7.41l-8 5.34-8-5.34ZM18.8 7H5.2l6.8 4.53L18.8 7Z",
  warning: "M12 2 1 21h22L12 2Zm0 4.06L19.53 19H4.47L12 6.06ZM11 11h2v4h-2v-4Zm0 5h2v2h-2v-2Z",
  "question-circle":
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6Zm-.06 2.8a3.55 3.55 0 0 0-3.56 3.27l1.99.3c.09-.87.73-1.57 1.57-1.57.86 0 1.56.62 1.56 1.4 0 .67-.4 1.02-1.28 1.66-.9.65-1.42 1.26-1.42 2.44v.5h2v-.34c0-.66.31-.98 1.26-1.67.92-.66 1.5-1.4 1.5-2.59a3.42 3.42 0 0 0-3.62-3.4ZM11 16.5h2v2h-2v-2Z",
  "file-text":
    "M6 2h8l6 6v14H6V2Zm2 2v16h10V9h-5V4H8Zm7 .41V7h2.59L15 4.41ZM9 12h8v1.5H9V12Zm0 3.5h8V17H9v-1.5Z",
  "file-plus":
    "M6 2h8l6 6v14H6V2Zm2 2v16h10V9h-5V4H8Zm7 .41V7h2.59L15 4.41ZM11 11h2v2.5h2.5v2H13V18h-2v-2.5H8.5v-2H11V11Z",
  table:
    "M3 4h18v16H3V4Zm2 2v3h6.5V6H5Zm8.5 0v3H19V6h-5.5ZM5 11v3h6.5v-3H5Zm8.5 0v3H19v-3h-5.5ZM5 16v2h6.5v-2H5Zm8.5 0v2H19v-2h-5.5Z",
  database:
    "M12 2C7.58 2 4 3.34 4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5c0-1.66-3.58-3-8-3Zm6 17c0 .37-2.13 1.2-6 1.2S6 19.37 6 19v-3.08C7.45 16.6 9.6 17 12 17s4.55-.4 6-1.08V19Zm0-5c0 .37-2.13 1.2-6 1.2S6 14.37 6 14v-3.08C7.45 11.6 9.6 12 12 12s4.55-.4 6-1.08V14Zm-6-5C8.13 9 6 8.17 6 7.8V5c0-.37 2.13-1.2 6-1.2s6 .83 6 1.2v2.8C18 8.17 15.87 9 12 9Z",
  "folder-open":
    "M2 4h7l2 2h9v3h2l-3.2 10H2V4Zm2 2v9.03L5.76 9H18V8h-7.83l-2-2H4Zm3.24 5-2.56 8h13.64l2.56-8H7.24Z",
  external: "M5 5h6v2H7v10h10v-4h2v6H5V5Zm8-2h8v8h-2V6.41l-7.29 7.3-1.42-1.42L17.59 5H13V3Z",
  "caret-down": "M5 8h14l-7 8-7-8Z",
  "caret-up": "M5 16l7-8 7 8H5Z",
  "caret-right": "M8 5l8 7-8 7V5Z",
  "chevron-left": "M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6 4.6-4.6Z",
  "chevron-right": "M8.6 7.4 10 6l6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6Z",
  edit: "M16.77 3.11a2.9 2.9 0 0 1 4.12 4.12l-1.6 1.6-4.12-4.12 1.6-1.6ZM13.76 6.12l4.12 4.12L7.7 20.42 2.9 21.1l.68-4.8L13.76 6.12Z",
  share:
    "M17 3a3.2 3.2 0 1 1-3 4.36L9.3 10.1a3.24 3.24 0 0 1 0 3.8l4.7 2.74a3.2 3.2 0 1 1-.94 1.77l-5.06-2.95a3.2 3.2 0 1 1 0-4.92l5.06-2.95A3.2 3.2 0 0 1 17 3Z",
  trash:
    "M9 3h6l1 2h5v2H3V5h5l1-2ZM5 9h14l-1.05 13H6.05L5 9Zm4.1 2 .35 9h1.5l-.35-9H9.1Zm4.3 0-.35 9h1.5l.35-9h-1.5Z",
  check: "M9.55 16.17 5.3 11.93l-1.42 1.41 5.67 5.67L20.11 8.45 18.7 7.04l-9.15 9.13Z",
  "check-clipboard":
    "M9 2h6v2h4v18H5V4h4V2Zm-2 4v14h10V6h-2v2H9V6H7Zm4-2v2h2V4h-2Zm-.55 11.61-2.1-2.1-1.41 1.42 3.51 3.51 5.61-5.6-1.41-1.42-4.2 4.19Z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z",
  "add-circle":
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6ZM11 7h2v4h4v2h-4v4h-2v-4H7v-2h4V7Z",
  globe:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.2c.94 0 2.4 2.24 2.9 5.8H9.1c.5-3.56 1.96-5.8 2.9-5.8Zm-3.02.62C8.28 6.24 7.75 8 7.5 10H4.46a7.85 7.85 0 0 1 4.52-5.18ZM4.46 14H7.5c.25 2 .78 3.76 1.48 5.18A7.85 7.85 0 0 1 4.46 14Zm4.64 0h5.8c-.5 3.56-1.96 5.8-2.9 5.8s-2.4-2.24-2.9-5.8Zm7.4 5.18c.7-1.42 1.23-3.18 1.48-5.18h3.04a7.85 7.85 0 0 1-4.52 5.18ZM19.54 10H16.5c-.25-2-.78-3.76-1.48-5.18A7.85 7.85 0 0 1 19.54 10Z",
  "map-marker":
    "M12 2a7 7 0 0 1 7 7c0 5.25-7 13-7 13S5 14.25 5 9a7 7 0 0 1 7-7Zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  "chart-line":
    "M3 3h2v16h16v2H3V3Zm16.3 4.7-5.3 5.3-3-3-4.3 4.3-1.4-1.4 5.7-5.7 3 3 3.9-3.9 1.4 1.4Z",
  sidebar: "M3 5h18v2H3V5Zm0 6h18v2H3v-2Zm0 6h18v2H3v-2Z",
} as const;

export type IconName = keyof typeof PATHS;

/** Glyphs whose cut-outs are same-direction sub-paths (need even-odd filling). */
const EVENODD: ReadonlySet<IconName> = new Set<IconName>(["search", "remove-circle"]);

/** Semantic UI size scale in em. */
const SIZES = {
  small: "0.875em",
  medium: "1em",
  large: "1.5em",
  big: "2em",
  huge: "4em",
} as const;

export type IconSize = keyof typeof SIZES;

export function Icon({
  name,
  size = "medium",
  className,
  style,
}: {
  name: IconName;
  size?: IconSize;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        width: SIZES[size],
        height: SIZES[size],
        display: "inline-block",
        verticalAlign: "-0.125em",
        flexShrink: 0,
        ...style,
      }}
    >
      <path d={PATHS[name]} fillRule={EVENODD.has(name) ? "evenodd" : undefined} />
    </svg>
  );
}
