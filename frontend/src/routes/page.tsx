// A content page from the node YAML's `pages` list: /<slug> renders the HTML
// of config/<node>/pages/<slug>.html, served by /config/pages/{slug}. One
// route covers every page, so an admin can add one without a deploy.

import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ErrorMessage } from "../components/error-message";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useNodeConfig } from "../lib/config";
import { sanitizeHtml } from "../lib/sanitize";
import type { NodePage } from "../lib/types";
import { NotFoundPage } from "./not-found";

export function ContentPage() {
  const { page: slug } = useParams({ from: "/$page" });
  const { data: config } = useNodeConfig();
  const page = config?.pages.find((entry) => entry.slug === slug);
  const content = useQuery({
    queryKey: ["page", slug],
    queryFn: () => api<NodePage & { html: string }>(`/config/pages/${slug}`),
    enabled: !!page,
    staleTime: 60_000,
  });
  if (!config) return <PageSpinner />;
  if (!page) return <NotFoundPage />;
  return (
    <div className="py-6">
      <h1 className="mb-3 text-xl font-semibold text-gray-900">{page.title}</h1>
      {content.error ? (
        <ErrorMessage error={content.error} />
      ) : content.data ? (
        <div
          className="er-content text-sm text-[#555555]"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: admin-authored HTML, sanitized by DOMPurify
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(content.data.html) }}
        />
      ) : (
        <PageSpinner />
      )}
    </div>
  );
}
