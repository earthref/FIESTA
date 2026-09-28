import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { api } from "./api";
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

/** Apply runtime branding: CSS custom properties + document title. */
export function applyNodeTheme(config: Pick<NodeConfig, "color" | "title">): void {
  const root = document.documentElement;
  root.style.setProperty("--node-color", config.color);
  root.style.setProperty("--node-color-soft", `color-mix(in srgb, ${config.color} 8%, white)`);
  root.style.setProperty("--node-color-dark", `color-mix(in srgb, ${config.color} 85%, black)`);
  root.style.setProperty("--node-color-light", `color-mix(in srgb, ${config.color} 80%, white)`);
  document.title = config.title;
}
