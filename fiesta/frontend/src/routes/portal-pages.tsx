// The EarthRef portal's References and Users pages (portals.ts `path`): one
// grid over every node -- a row per publication or contributor, a column per
// node with how many public contributions it has there (each count a link to
// those contributions in that node's search), and the total. Served by
// /v2/portal (fiesta.apps.routers.portal).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type CSSProperties, type ReactNode, useDeferredValue, useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { InlineHtml } from "../components/result-item";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Table, TBody, Td, THead, Th, Tr } from "../components/ui/table";
import { api } from "../lib/api";
import { BASE_PATH, NODES, nodeSiteUrl } from "../lib/base";
import { inkColor } from "../lib/config";

const PAGE = 100;

interface PortalNode {
  slug: string;
  key: string;
  color: string;
}

interface Counted {
  counts: Record<string, number>;
  total: number;
}

interface PortalUser extends Counted {
  id: number;
  name: string;
  handle: string | null;
  orcid: string | null;
}

interface PortalReference extends Counted {
  doi: string;
  citation: string | null;
  title: string | null;
  journal: string | null;
  year: number | null;
  long_citation: string | null;
}

/** A node's search for `q`: the node next to this one in the multi-node
 * layout, else this deployment's own node (a per-node build serves only it). */
function nodeSearchUrl(node: PortalNode, q: string): string {
  const query = `?q=${encodeURIComponent(q)}`;
  if (NODES.length) return nodeSiteUrl(node.key, `/search${query}`);
  return `${BASE_PATH}search${query}`;
}

interface Column<T> {
  key: string;
  label: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

interface GridProps<T extends Counted> {
  title: string;
  intro: string;
  path: string;
  field: "references" | "users";
  noun: string;
  placeholder: string;
  /** The columns before the node columns, the first one the default A-Z sort. */
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  /** The search query that finds the row's contributions on a node. */
  search: (row: T) => string;
}

/** A count in a node's colors: a tint of it behind a dark shade of it, legible
 * for the light ones (CDR's yellow) and in dark mode. */
function countStyle(color: string): CSSProperties {
  const mix = (percent: number, other: string) =>
    `color-mix(in srgb, ${color} ${percent}%, ${other})`;
  return {
    color: `light-dark(${mix(70, "black")}, ${mix(45, "white")})`,
    backgroundColor: `light-dark(${mix(14, "white")}, ${mix(30, "#181a1f")})`,
  };
}

function SortHeader({
  label,
  active,
  order,
  onClick,
  color,
  className,
}: {
  label: string;
  active: boolean;
  order: "asc" | "desc";
  onClick: () => void;
  color?: string;
  className?: string;
}) {
  return (
    <Th
      className={className}
      aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        // A node's key keeps its case (KdD, KArAr).
        className={`inline-flex items-center gap-1 hover:underline ${color ? "normal-case" : "uppercase"}`}
        style={color ? { color: inkColor(color) } : undefined}
      >
        {label}
        <span aria-hidden className={active ? "" : "invisible"}>
          {order === "asc" ? "▲" : "▼"}
        </span>
      </button>
    </Th>
  );
}

function NodeGrid<T extends Counted>({
  title,
  intro,
  path,
  field,
  noun,
  placeholder,
  columns,
  rowKey,
  search,
}: GridProps<T>) {
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q.trim());
  const [sort, setSort] = useState("total");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["portal", field, deferredQ, sort, order, offset],
    queryFn: () =>
      api<{ nodes: PortalNode[]; total: number } & Record<typeof field, T[]>>(path, {
        params: { q: deferredQ, sort, order, offset, limit: PAGE },
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const nodes = query.data?.nodes ?? [];
  const rows = query.data?.[field] ?? [];
  const total = query.data?.total ?? 0;

  /** Sort by `key`: numbers start high, text starts A-Z; again flips it. */
  const sortBy = (key: string, numeric: boolean) => {
    setOrder(sort === key ? (order === "asc" ? "desc" : "asc") : numeric ? "desc" : "asc");
    setSort(key);
    setOffset(0);
  };

  return (
    <div className="pb-6">
      <h2 className="mb-1 text-xl font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-gray-600">{intro}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          className="max-w-sm"
          placeholder={placeholder}
          aria-label={`Search ${noun}`}
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setOffset(0);
          }}
        />
        <span className="text-sm text-gray-500">
          {query.data ? `${total.toLocaleString()} ${noun}` : ""}
        </span>
        {query.isFetching && <Spinner />}
      </div>
      {query.error && <ErrorMessage error={query.error} />}
      {query.isPending ? (
        <Spinner />
      ) : (
        <Table>
          <THead>
            <tr>
              {columns.map((column) => (
                <SortHeader
                  key={column.key}
                  label={column.label}
                  active={sort === column.key}
                  order={order}
                  onClick={() => sortBy(column.key, false)}
                  className={column.className}
                />
              ))}
              {nodes.map((node) => (
                <SortHeader
                  key={node.slug}
                  label={node.key}
                  color={node.color}
                  active={sort === node.slug}
                  order={order}
                  onClick={() => sortBy(node.slug, true)}
                  className="text-right"
                />
              ))}
              <SortHeader
                label="Total"
                active={sort === "total"}
                order={order}
                onClick={() => sortBy("total", true)}
                className="text-right"
              />
            </tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={rowKey(row)}>
                {columns.map((column) => (
                  <Td key={column.key} className={column.className}>
                    {column.cell(row)}
                  </Td>
                ))}
                {nodes.map((node) => {
                  const count = row.counts[node.slug];
                  return (
                    <Td key={node.slug} className="text-right tabular-nums">
                      {count ? (
                        <a
                          href={nodeSearchUrl(node, search(row))}
                          className="inline-block min-w-[2.5em] rounded-sm px-1.5 font-semibold hover:underline"
                          style={countStyle(node.color)}
                          title={`${count} ${node.key} contribution${count === 1 ? "" : "s"}`}
                        >
                          {count.toLocaleString()}
                        </a>
                      ) : (
                        <span className="text-gray-300">·</span>
                      )}
                    </Td>
                  );
                })}
                <Td className="text-right font-semibold tabular-nums">
                  {row.total.toLocaleString()}
                </Td>
              </Tr>
            ))}
            {rows.length === 0 && (
              <Tr>
                <Td colSpan={columns.length + nodes.length + 1} className="text-gray-500">
                  No {noun} found.
                </Td>
              </Tr>
            )}
          </TBody>
        </Table>
      )}
      {total > PAGE && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export function UsersPage() {
  return (
    <NodeGrid<PortalUser>
      title="Users"
      intro="Everyone with a public contribution in an EarthRef repository, and how many they have contributed to each."
      path="/v2/portal/users"
      field="users"
      noun="users"
      placeholder="Search name, handle or ORCID"
      rowKey={(user) => user.id}
      search={(user) => `contributor:"${user.name}"`}
      columns={[
        { key: "name", label: "Name", cell: (user) => user.name },
        { key: "handle", label: "Handle", cell: (user) => user.handle ?? "" },
        {
          key: "orcid",
          label: "ORCID",
          cell: (user) =>
            user.orcid ? (
              <a
                href={`https://orcid.org/${user.orcid}`}
                target="_blank"
                rel="noreferrer"
                className="whitespace-nowrap hover:underline"
              >
                {user.orcid}
              </a>
            ) : (
              ""
            ),
        },
      ]}
    />
  );
}

export function ReferencesPage() {
  return (
    <NodeGrid<PortalReference>
      title="References"
      intro="Every publication a public contribution in an EarthRef repository cites, and how many contributions cite it in each."
      path="/v2/portal/references"
      field="references"
      noun="references"
      placeholder="Search DOI, authors, title, journal or year"
      rowKey={(ref) => ref.doi}
      search={(ref) => `doi:"${ref.doi}"`}
      columns={[
        {
          key: "citation",
          label: "Reference",
          className: "min-w-[20em]",
          cell: (ref) => (
            <div>
              <div className="font-semibold">{ref.citation ?? "Unknown reference"}</div>
              {ref.title && <InlineHtml html={ref.title} className="block text-gray-700" />}
              {ref.journal && <div className="text-xs italic text-gray-500">{ref.journal}</div>}
            </div>
          ),
        },
        { key: "year", label: "Year", cell: (ref) => ref.year ?? "" },
        {
          key: "doi",
          label: "DOI",
          cell: (ref) => (
            <a
              href={`https://doi.org/${ref.doi}`}
              target="_blank"
              rel="noreferrer"
              className="whitespace-nowrap hover:underline"
            >
              {ref.doi}
            </a>
          ),
        },
      ]}
    />
  );
}
