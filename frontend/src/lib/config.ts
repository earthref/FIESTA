import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { NodeConfig } from "./types";

export const configQueryOptions = {
  queryKey: ["config"] as const,
  queryFn: () => api<NodeConfig>("/config"),
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
};

/** The node config is fetched once at bootstrap and cached forever. */
export function useNodeConfig() {
  return useQuery(configQueryOptions);
}

/** Apply runtime branding: CSS custom properties + document title. */
export function applyNodeTheme(config: NodeConfig): void {
  const root = document.documentElement;
  root.style.setProperty("--node-color", config.color);
  root.style.setProperty("--node-color-soft", `color-mix(in srgb, ${config.color} 8%, white)`);
  root.style.setProperty("--node-color-dark", `color-mix(in srgb, ${config.color} 85%, black)`);
  root.style.setProperty("--node-color-light", `color-mix(in srgb, ${config.color} 80%, white)`);
  document.title = config.title;
}
