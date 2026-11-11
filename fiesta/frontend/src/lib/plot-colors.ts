/**
 * Plot colors for canvases. A canvas takes no CSS variables, so a chart reads
 * the theme's --er-plot-* tokens (src/index.css) when it is built; `EChart`
 * rebuilds on a theme switch. SVG charts use the same tokens as var() directly.
 */
import { useTheme } from "./theme";

export interface PlotColors {
  /** The plot background: hollow markers' fill, filled markers' halo. */
  surface: string;
  /** Axis names, tick labels, point labels. */
  text: string;
  /** Split (grid) lines. */
  grid: string;
  /** Axis lines. */
  axis: string;
  /** Stereonet circles and ticks, zero axes, neutral curves. */
  net: string;
  /** Reference lines and their labels' lines. */
  reference: string;
  /** A dark (light, in dark mode) accent line, e.g. a fitted line. */
  strong: string;
  /** Excluded / "other" points. */
  muted: string;
  /** Points behind a selection. */
  faded: string;
  /** Tooltip background, border and text. */
  tooltip: string;
  tooltipLine: string;
  tooltipInk: string;
  /** The node's color, lightened in dark mode like `--node-ink`. */
  node: string;
}

const LIGHT: Omit<PlotColors, "node"> = {
  surface: "#ffffff",
  text: "#52514e",
  grid: "#ebeae6",
  axis: "#b4b3ad",
  net: "#8a8984",
  reference: "#6b6b66",
  strong: "#333333",
  muted: "#9a9a95",
  faded: "#d8d7d2",
  tooltip: "#ffffff",
  tooltipLine: "#cccccc",
  tooltipInk: "#666666",
};

const TOKENS: Record<keyof typeof LIGHT, string> = {
  surface: "--er-plot-surface",
  text: "--er-plot-text",
  grid: "--er-plot-grid",
  axis: "--er-plot-axis",
  net: "--er-plot-net",
  reference: "--er-plot-reference",
  strong: "--er-plot-strong",
  muted: "--er-plot-muted",
  faded: "--er-plot-faded",
  tooltip: "--er-plot-tooltip",
  tooltipLine: "--er-plot-tooltip-line",
  tooltipInk: "--er-plot-tooltip-ink",
};

/** `color` mixed with white, `keep` (0-1) of it, as #rrggbb (canvas-safe). */
function lighten(color: string, keep: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = Number.parseInt(m[1], 16);
  const channel = (shift: number) =>
    Math.round(((n >> shift) & 255) * keep + 255 * (1 - keep))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** A brand color drawn on a plot: itself in light mode, lightened in dark mode
 * (the same mix as inkColor() in src/lib/config.ts), as a canvas-safe hex. */
export function plotInk(color: string, dark: boolean): string {
  return dark ? lighten(color, 0.55) : color;
}

/** plotColors() in a component: re-renders on a theme switch, and the object
 * is the same between switches, so it can be a memo's dependency. */
export function usePlotColors(fallbackNode?: string): PlotColors {
  useTheme();
  return plotColors(fallbackNode);
}

let cached: { key: string; colors: PlotColors } | null = null;

/** The active theme's plot colors; `fallbackNode` when no node color is set.
 * Cheap to call per point: the tokens are read once per theme and node color. */
export function plotColors(fallbackNode = "#1f77b4"): PlotColors {
  if (typeof document === "undefined") return { ...LIGHT, node: fallbackNode };
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const node = root.style.getPropertyValue("--node-color").trim() || fallbackNode;
  const key = `${dark}|${node}`;
  if (cached?.key === key) return cached.colors;
  const style = getComputedStyle(root);
  const colors = { ...LIGHT };
  for (const [name, token] of Object.entries(TOKENS) as [keyof typeof LIGHT, string][]) {
    colors[name] = style.getPropertyValue(token).trim() || LIGHT[name];
  }
  cached = { key, colors: { ...colors, node: plotInk(node, dark) } };
  return cached.colors;
}
