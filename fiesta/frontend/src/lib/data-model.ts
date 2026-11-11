import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useNodeConfig } from "./config";
import type { DataModel, DataModelColumn, DataModelTable } from "./types";

/** The model in a `/config/data-models/{version}` response (bare, or under one key). */
export function unwrapModel(data: unknown): DataModel | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.tables && typeof record.tables === "object") return record as unknown as DataModel;
  for (const value of Object.values(record)) {
    if (value && typeof value === "object" && "tables" in (value as object)) {
      return value as DataModel;
    }
  }
  return null;
}

/** A column's type and unit as the data model pages show it ("Number in Degrees"). */
export function typeUnitLabel(column: DataModelColumn): string {
  const type = column.type ?? "";
  if (!type) return "";
  if (/^flag$/i.test(type)) return "Flag";
  const unit = column.unit ?? "";
  if (!unit || /^(custom|dimensionless)$/i.test(unit)) return type;
  return `${type} in ${unit}`;
}

/** The query for one data model version (shared with the Data Models page). */
export function dataModelQuery(version: string) {
  return {
    queryKey: ["data-model", version],
    queryFn: () => api<unknown>(`/config/data-models/${version}`),
    staleTime: Number.POSITIVE_INFINITY,
  };
}

/** A table of the node's latest data model, once loaded (undefined for one it lacks). */
export function useDataModelTable(table: string | undefined): DataModelTable | undefined {
  const { data: config } = useNodeConfig();
  const version = config?.data_model_latest;
  const { data } = useQuery({
    ...dataModelQuery(version ?? ""),
    enabled: !!version && !!table,
    select: unwrapModel,
  });
  return table ? data?.tables[table] : undefined;
}
