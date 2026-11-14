import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "./api";
import { setNodeFavicon } from "./node-logo";
import type { NodeConfig } from "./types";

export const configQueryOptions = {
  queryKey: ["config"] as const,
  queryFn: () => api<NodeConfig>("/config"),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
};

/** Renders a subtree as another node's: the portal home lists every node's
 * contributions with the node's own ResultItem (see useNodeLinks). */
export const NodeConfigScope = createContext<NodeConfig | null>(null);

/** The node config is fetched once at bootstrap and cached forever; inside a
 * NodeConfigScope it is the scoped node's. */
export function useNodeConfig() {
  const scoped = useContext(NodeConfigScope);
  const query = useQuery(configQueryOptions);
  return scoped ? ({ ...query, data: scoped } as typeof query) : query;
}

/** The CSS custom properties derived from a node color (src/index.css :root).
 * Each is a light-dark() pair, so it follows the color scheme where it is used:
 * dark mode lightens the node color as text and tints the dark surface. */
export function nodeColorVars(color: string): Record<string, string> {
  return {
    ...nodeColorBase(color),
    "--node-ink": inkColor(color),
  };
}

/** A brand color used as text or an outline: itself in light mode, lightened
 * in dark mode so it stays legible on the dark surface. 35% keeps every node's
 * ink >= 8:1 on --er-surface and >= 5.9:1 on --er-panel-strong (2026-11-13);
 * 55% left MagIC at 4.4:1 on panels. */
export function inkColor(color: string): string {
  return `light-dark(${color}, color-mix(in srgb, ${color} 35%, white))`;
}

function nodeColorBase(color: string): Record<string, string> {
  const mix = (percent: number, other: string) =>
    `color-mix(in srgb, ${color} ${percent}%, ${other})`;
  return {
    "--node-color": color,
    "--node-color-soft": `light-dark(${mix(8, "white")}, ${mix(22, "#181a1f")})`,
    "--node-color-dark": mix(85, "black"),
    "--node-color-light": `light-dark(${mix(80, "white")}, ${mix(70, "white")})`,
    // Hover ink: darker in light mode, lighter than --node-ink in dark mode.
    "--node-ink-strong": `light-dark(${mix(85, "black")}, ${mix(15, "white")})`,
  };
}

/** Apply runtime branding: CSS custom properties, document title, and the
 * node's letter logo as the favicon. */
export function applyNodeTheme(config: Pick<NodeConfig, "key" | "color" | "title">): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(nodeColorVars(config.color))) {
    root.style.setProperty(name, value);
  }
  document.title = config.title;
  setNodeFavicon(config.key, config.color);
}
