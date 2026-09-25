import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageSpinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import type { MethodCodeGroup, MethodCodes } from "../lib/types";
import { cx } from "../lib/utils";

const routeApi = getRouteApi("/method-codes");

function MethodCodeGroupEntry({
  name,
  group,
  filter,
}: {
  name: string;
  group: MethodCodeGroup;
  filter: string;
}) {
  const [open, setOpen] = useState(false);
  const codes = filter
    ? group.codes.filter(
        (code) =>
          code.code.toLowerCase().includes(filter) ||
          (code.definition ?? "").toLowerCase().includes(filter),
      )
    : group.codes;

  // Auto-expand groups while filtering so matches are visible.
  const expanded = open || (!!filter && codes.length > 0);

  return (
    <Card>
      <CardContent className="py-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        >
          <span className="text-sm font-medium text-gray-900">{group.label || name}</span>
          <span className="flex items-center gap-2 text-xs text-gray-500">
            {codes.length.toLocaleString()} code{codes.length === 1 ? "" : "s"}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={cx("h-4 w-4 transition-transform", expanded && "rotate-180")}
            >
              <path
                fillRule="evenodd"
                d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        </button>
        {expanded && codes.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <Table>
              <THead>
                <Tr>
                  <Th>Code</Th>
                  <Th>Definition</Th>
                </Tr>
              </THead>
              <TBody>
                {codes.map((code) => (
                  <Tr key={code.code}>
                    <Td className="whitespace-nowrap font-mono text-xs">{code.code}</Td>
                    <Td>{code.definition}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MethodCodesPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const filter = (search.q ?? "").toLowerCase();

  const query = useQuery({
    queryKey: ["method-codes"],
    queryFn: () => api<MethodCodes>("/config/method-codes"),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (query.isPending) return <PageSpinner label="Loading method codes…" />;
  if (query.error) return <ErrorMessage error={query.error} />;

  const groups = Object.entries(query.data ?? {})
    .filter(([name, group]) => {
      if (!filter) return true;
      if (name.toLowerCase().includes(filter)) return true;
      if ((group.label ?? "").toLowerCase().includes(filter)) return true;
      return group.codes.some(
        (code) =>
          code.code.toLowerCase().includes(filter) ||
          (code.definition ?? "").toLowerCase().includes(filter),
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Method codes</h1>
      <p className="mb-4 text-sm text-gray-600">
        Standardized codes describing how measurements and interpretations were made.
      </p>
      <div className="mb-4">
        <label htmlFor="method-filter" className="sr-only">
          Filter method codes
        </label>
        <Input
          id="method-filter"
          type="search"
          placeholder="Filter groups, codes, and definitions…"
          value={search.q ?? ""}
          onChange={(event) =>
            navigate({ search: { q: event.target.value || undefined }, replace: true })
          }
        />
      </div>
      <div className="space-y-2">
        {groups.map(([name, group]) => (
          <MethodCodeGroupEntry key={name} name={name} group={group} filter={filter} />
        ))}
      </div>
      {groups.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-500">No method codes match the filter.</p>
      )}
    </div>
  );
}
