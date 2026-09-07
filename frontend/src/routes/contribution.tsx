import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ErrorMessage } from "../components/error-message";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import type { SearchResult } from "../lib/types";
import { formatDate, formatNumber, getPath } from "../lib/utils";

const routeApi = getRouteApi("/contributions/$id");

function Reference({ reference }: { reference: unknown }) {
  if (!reference) return null;
  if (typeof reference === "string") return <p className="text-sm text-gray-700">{reference}</p>;
  if (typeof reference !== "object") return null;
  const ref = reference as Record<string, unknown>;
  const citation =
    (typeof ref.citation === "string" && ref.citation) ||
    (typeof ref.long_citation === "string" && ref.long_citation) ||
    (typeof ref.title === "string" && ref.title) ||
    "";
  const doi = typeof ref.doi === "string" ? ref.doi : undefined;
  return (
    <div className="text-sm text-gray-700">
      {citation && <p>{citation}</p>}
      {doi && (
        <a
          href={`https://doi.org/${doi}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-node hover:underline"
        >
          doi:{doi}
        </a>
      )}
    </div>
  );
}

export function ContributionPage() {
  const { id } = routeApi.useParams();
  const { private_key: privateKey } = routeApi.useSearch();
  const { data: config } = useNodeConfig();

  const query = useQuery({
    queryKey: ["contribution", id, privateKey],
    queryFn: () =>
      api<SearchResult>(`/api/contributions/${id}`, {
        params: { private_key: privateKey },
      }),
  });

  if (query.isPending) return <PageSpinner label="Loading contribution…" />;
  if (query.error) return <ErrorMessage error={query.error} />;

  const doc = query.data ?? {};
  const summary = (getPath(doc, "summary.contribution") ?? {}) as Record<string, unknown>;
  const reference = summary._reference;
  const contributor =
    getPath(doc, "summary.contribution.contributor") ?? doc.contributor_name ?? doc.contributor;
  const timestamp = summary.timestamp ?? doc.created_at;
  const isActivated = doc._is_activated ?? doc.is_activated;
  const keyParam = privateKey ? `?private_key=${encodeURIComponent(privateKey)}` : "";

  const counts = (config?.search_levels ?? [])
    .filter((level) => level.count_field)
    .map((level) => ({ level, count: getPath(doc, level.count_field as string) }))
    .filter((entry) => typeof entry.count === "number");

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Contribution {id}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            {summary.version !== undefined && <span>Version {String(summary.version)}</span>}
            {formatDate(timestamp) && <span>{formatDate(timestamp)}</span>}
            {isActivated === false && <Badge variant="warning">Private</Badge>}
          </div>
        </div>
        <a
          href={siteUrl(`/api/contributions/${id}/download${keyParam}`)}
          download
          className="rounded-md bg-node px-3.5 py-2 text-sm font-medium text-white hover:bg-node-dark focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node focus-visible:ring-offset-2"
        >
          Download
        </a>
      </div>

      <div className="space-y-4">
        {reference !== undefined && reference !== null && (
          <Card>
            <CardHeader>
              <CardTitle>Reference</CardTitle>
            </CardHeader>
            <CardContent>
              <Reference reference={reference} />
            </CardContent>
          </Card>
        )}

        {contributor !== undefined && contributor !== null && (
          <Card>
            <CardHeader>
              <CardTitle>Contributors</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">
                {Array.isArray(contributor)
                  ? contributor.map(String).join(", ")
                  : String(contributor)}
              </p>
            </CardContent>
          </Card>
        )}

        {counts.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Contents</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {counts.map(({ level, count }) => (
                  <Badge key={level.name} variant="node">
                    {level.name}: {formatNumber(count)}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Summary document</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded-md bg-gray-50 p-3 text-xs text-gray-700">
              {JSON.stringify(doc, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
