import { useMemo } from "react";
import type { SearchResult } from "../lib/types";
import { Table, TBody, Td, THead, Th, Tr } from "./ui/table";

/** The raw rows of search hits as one table, columns in first-seen order
 * (the search page's Rows view and the contribution modal's level tabs). */
export function RowsTable({ results }: { results: SearchResult[] }) {
  const rows = useMemo(
    () => results.flatMap((hit) => (Array.isArray(hit.rows) ? (hit.rows as unknown[]) : [])),
    [results],
  );
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows.slice(0, 50)) {
      if (row && typeof row === "object") {
        for (const key of Object.keys(row as object)) keys.add(key);
      }
    }
    return [...keys];
  }, [rows]);

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[13px] text-gray-500">No row data for these results.</p>
    );
  }

  return (
    <Table>
      <THead>
        <Tr>
          {columns.map((column) => (
            <Th key={column}>{column}</Th>
          ))}
        </Tr>
      </THead>
      <TBody>
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: raw OpenSearch rows have no stable id; the list is replaced wholesale per query
          <Tr key={`row-${index}-${columns.length}`}>
            {columns.map((column) => {
              const value = (row as Record<string, unknown>)[column];
              return (
                <Td key={column} className="whitespace-nowrap">
                  {value === undefined || value === null
                    ? ""
                    : typeof value === "object"
                      ? JSON.stringify(value)
                      : String(value)}
                </Td>
              );
            })}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}
