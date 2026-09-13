import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { ErrorMessage } from "../components/error-message";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import type { Vocabularies, Vocabulary } from "../lib/types";
import { cx } from "../lib/utils";

const routeApi = getRouteApi("/vocabularies");
const ITEM_LIMIT = 300;

function VocabularyEntry({
  name,
  vocabulary,
  filter,
}: {
  name: string;
  vocabulary: Vocabulary;
  filter: string;
}) {
  const [open, setOpen] = useState(false);
  const items = filter
    ? vocabulary.items.filter(
        (item) =>
          item.item.toLowerCase().includes(filter) ||
          (item.label ?? "").toLowerCase().includes(filter),
      )
    : vocabulary.items;

  return (
    <Card>
      <CardContent className="py-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-3 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
        >
          <span>
            <span className="text-sm font-medium text-gray-900">{vocabulary.label || name}</span>
            {vocabulary.database_column && (
              <span className="ml-2 font-mono text-xs text-gray-400">
                {vocabulary.database_column}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2 text-xs text-gray-500">
            {items.length.toLocaleString()} item{items.length === 1 ? "" : "s"}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={cx("h-4 w-4 transition-transform", open && "rotate-180")}
            >
              <path
                fillRule="evenodd"
                d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        </button>
        {open && (
          <ul className="mt-3 grid gap-x-6 gap-y-1 border-t border-gray-100 pt-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.slice(0, ITEM_LIMIT).map((item) => (
              <li
                key={item.item}
                className="truncate text-sm text-gray-700"
                title={item.label ?? item.item}
              >
                {item.item}
                {item.label && item.label !== item.item && (
                  <span className="ml-1 text-xs text-gray-400">{item.label}</span>
                )}
              </li>
            ))}
            {items.length > ITEM_LIMIT && (
              <li className="text-xs text-gray-400">
                …and {(items.length - ITEM_LIMIT).toLocaleString()} more (refine the filter)
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function VocabulariesPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const filter = (search.q ?? "").toLowerCase();

  const query = useQuery({
    queryKey: ["vocabularies", "controlled"],
    queryFn: () => api<Vocabularies>("/config/vocabularies/controlled"),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (query.isPending) return <PageSpinner label="Loading vocabularies…" />;
  if (query.error) return <ErrorMessage error={query.error} />;

  const vocabularies = Object.entries(query.data ?? {})
    .filter(([name, vocabulary]) => {
      if (!filter) return true;
      if (name.toLowerCase().includes(filter)) return true;
      if ((vocabulary.label ?? "").toLowerCase().includes(filter)) return true;
      return vocabulary.items.some(
        (item) =>
          item.item.toLowerCase().includes(filter) ||
          (item.label ?? "").toLowerCase().includes(filter),
      );
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-semibold text-gray-900">Controlled vocabularies</h1>
      <p className="mb-4 text-sm text-gray-600">
        Allowed values for controlled columns in the data model.
      </p>
      <div className="mb-4">
        <label htmlFor="vocab-filter" className="sr-only">
          Filter vocabularies
        </label>
        <Input
          id="vocab-filter"
          type="search"
          placeholder="Filter vocabularies and items…"
          value={search.q ?? ""}
          onChange={(event) =>
            navigate({ search: { q: event.target.value || undefined }, replace: true })
          }
        />
      </div>
      <div className="space-y-2">
        {vocabularies.map(([name, vocabulary]) => (
          <VocabularyEntry key={name} name={name} vocabulary={vocabulary} filter={filter} />
        ))}
      </div>
      {vocabularies.length === 0 && (
        <p className="py-8 text-center text-sm text-gray-500">No vocabularies match the filter.</p>
      )}
    </div>
  );
}
