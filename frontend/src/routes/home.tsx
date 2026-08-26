import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ErrorMessage } from "../components/error-message";
import { IconButton } from "../components/icon-button";
import { contributionId, ResultItem } from "../components/result-item";
import { Icon } from "../components/ui/icon";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useNodeConfig } from "../lib/config";
import type { SearchPage } from "../lib/types";

/** h2.ui.horizontal.divider.header — centered text with a rule through it. */
function DividerHeader({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <h2
      className="flex items-center gap-4 text-[1.3em] font-bold text-gray-800"
      style={{ margin: first ? "1.5em 0 0" : "1.5em 0 1em" }}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-[rgba(34,36,38,0.15)]" />
      <span>{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-[rgba(34,36,38,0.15)]" />
    </h2>
  );
}

// Primary cards: base icon ~2em (big). Resource cards: base icon ~1em (medium).
const icons = {
  search: <Icon name="database" size="big" />,
  upload: <Icon name="table" size="big" />,
  workspace: <Icon name="file-text" size="big" />,
  model: <Icon name="table" size="medium" />,
  book: <Icon name="file-text" size="medium" />,
  code: <Icon name="external" size="medium" />,
  help: <Icon name="question-circle" size="medium" />,
};

export function HomePage() {
  const { data: config } = useNodeConfig();

  const recent = useQuery({
    queryKey: ["search", "contribution", "", "recent-7"],
    queryFn: () => api<SearchPage>("/api/search/contribution", { params: { size: 7 } }),
    staleTime: 60_000,
  });

  if (!config) return <PageSpinner />;

  const contributionLevel = config.search_levels.find(
    (level) => level.table === "contribution",
  ) ?? {
    name: "Contributions",
    table: "contribution",
    count_field: null,
  };

  return (
    /* Grid divided: 12/4 split of 16 with a divider between */
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="min-w-0" style={{ flex: "12 12 0%" }}>
        {/* ui three cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <IconButton
            to="/search"
            icon={icons.search}
            cornerIcon={<Icon name="search" />}
            title="Search Interface"
            subtitle="Browse, combine, and save datasets."
          />
          <IconButton
            to="/upload"
            icon={icons.upload}
            cornerIcon={<Icon name="add-circle" />}
            title="Upload Tool"
            subtitle="Import data into your private workspace."
          />
          <IconButton
            to="/private"
            icon={icons.workspace}
            cornerIcon={<Icon name="check" />}
            title="Private Workspace"
            subtitle={`Manage your contributions to ${config.key}.`}
          />
        </div>

        <DividerHeader first>{config.key} Resources</DividerHeader>
        {/* ui nine cards, borderless */}
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          <IconButton
            small
            borderless
            to={`/data-models/${config.data_model_latest}`}
            icon={icons.model}
            title={
              <>
                Data
                <br />
                Model
              </>
            }
          />
          <IconButton
            small
            borderless
            to="/vocabularies"
            icon={icons.book}
            title={
              <>
                Vocabulary
                <br />
                Lists
              </>
            }
          />
          {config.has_method_codes && (
            <IconButton
              small
              borderless
              to="/method-codes"
              icon={icons.book}
              title={
                <>
                  Method
                  <br />
                  Codes
                </>
              }
            />
          )}
          <IconButton
            small
            borderless
            href="https://api.earthref.org/"
            icon={icons.code}
            title={
              <>
                {config.key}/FIESTA
                <br />
                API
              </>
            }
          />
          {config.features.pages.includes("help") && (
            <IconButton
              small
              borderless
              to="/help"
              icon={icons.help}
              title={
                <>
                  Help
                  <br />
                  Pages
                </>
              }
            />
          )}
        </div>

        <DividerHeader>Recent Contributions</DividerHeader>
        {recent.isPending && <PageSpinner label="Loading recent contributions…" />}
        {recent.error && <ErrorMessage error={recent.error} />}
        {recent.data && (
          <>
            <div className="divide-y divide-gray-200">
              {recent.data.results.map((doc, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list of 7, replaced wholesale on refetch
                  key={`${contributionId(doc) ?? "recent"}-${index}`}
                >
                  <ResultItem doc={doc} level={contributionLevel} />
                </div>
              ))}
            </div>
            <div className="mt-4 max-w-xs">
              <IconButton
                small
                to="/search"
                icon={<Icon name="search" size="medium" />}
                title={`View More Contributions in the ${config.key} Search Interface`}
              />
            </div>
          </>
        )}
      </div>

      {/* News column (4 of 16) with divider */}
      <aside
        className="hidden shrink-0 border-l border-[rgba(34,36,38,0.15)] pl-6 lg:block"
        style={{ flex: "4 4 0%" }}
        aria-label="News"
      >
        <h2 className="mb-2 text-[1.2em] font-bold text-gray-800">News</h2>
        <p className="text-[13px] text-gray-500">No news yet.</p>
        <p className="mt-4 text-[13px]">
          <Link to="/contact" className="text-node hover:underline">
            Contact the {config.key} team
          </Link>
        </p>
      </aside>
    </div>
  );
}
