import { api } from "@/lib/api";
import type { NodeConfig } from "@/lib/types";

export interface MethodCode {
  code: string;
  definition: string;
  [key: string]: unknown;
}

export interface MethodCodeGroup {
  label: string;
  codes: MethodCode[];
}

/** GET /v2/{node}/plugins/method-codes: the codes by group. */
export type MethodCodes = Record<string, MethodCodeGroup>;

/** The codes' query, shared by the page and the facet definitions. */
export const methodCodesQuery = {
  queryKey: ["method-codes"] as const,
  queryFn: () => api<MethodCodes>("/plugins/method-codes"),
};

/** The plugin's `frontend_config`: whether the node has a codes file. */
export function hasCodes(config: NodeConfig): boolean {
  return config.plugins?.["method-codes"]?.has_codes === true;
}
