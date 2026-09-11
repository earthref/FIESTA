import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { ErrorMessage } from "../components/error-message";
import { IconButton, type IconButtonProps } from "../components/icon-button";
import { contributionId, ResultDivider, ResultItem } from "../components/result-item";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { useNodeConfig } from "../lib/config";
import type { SearchPage } from "../lib/types";
import { pluginHomeCards } from "../plugins";

const RULE = "rgba(34,36,38,.15)";

/** `h2.ui.horizontal.divider.header` (measured): 24px/700 on a 24px line,
 * margin calc(2rem − .14em) 0 1rem (the first one has no bottom margin),
 * centred between two 1px rules. */
function DividerHeader({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <h2
      className="flex items-center whitespace-nowrap font-bold"
      style={{
        fontSize: "1.71428571rem",
        lineHeight: "1em",
        color: "rgba(0,0,0,.87)",
        margin: `calc(2rem - 0.14285714em) 0 ${first ? 0 : "1rem"}`,
        gap: "1em",
      }}
    >
      <span aria-hidden="true" className="h-px flex-1" style={{ background: RULE }} />
      <span>{children}</span>
      <span aria-hidden="true" className="h-px flex-1" style={{ background: RULE }} />
    </h2>
  );
}

/** `ui three cards`: wrapper margin −.875em −1em, each card margin .875em 1em
 * and width calc(33.33% − 2em). */
const threeCards: CSSProperties = { margin: "-0.875em -1em" };
const threeCard: CSSProperties = { margin: "0.875em 1em", width: "calc(33.3333% - 2em)" };
/** `ui nine cards` (10px cards): wrapper margin 0 −.5em −.875em, cards margin
 * .875em .5em and width calc(11.11% − 1em). */
const nineCards: CSSProperties = { margin: "0 -5px -8.75px" };
const nineCard: CSSProperties = {
  margin: "8.75px 5px",
  width: "calc(11.1111% - 10px)",
  minWidth: 84,
};

/** `ui fitted divider` inside the news column (margin 1rem 0). */
function Rule() {
  return (
    <hr
      style={{
        margin: "1rem 0",
        border: 0,
        borderTop: `1px solid ${RULE}`,
        borderBottom: "1px solid rgba(255,255,255,.1)",
      }}
    />
  );
}

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

  const resources: IconButtonProps[] = [
    {
      to: `/data-models/${config.data_model_latest}`,
      icon: "table",
      title: (
        <>
          Data
          <br />
          Model
        </>
      ),
    },
    ...(config.has_method_codes
      ? [
          {
            to: "/method-codes",
            icon: "file-text" as IconName,
            title: (
              <>
                Method
                <br />
                Codes
              </>
            ),
          },
        ]
      : []),
    {
      to: "/vocabularies",
      icon: "file-text",
      title: (
        <>
          Vocabulary
          <br />
          Lists
        </>
      ),
    },
    ...(config.features.pages.includes("jupyter-notebooks")
      ? [
          {
            to: "/jupyter-notebooks",
            icon: "external" as IconName,
            title: (
              <>
                Jupyter
                <br />
                Notebooks
              </>
            ),
          },
        ]
      : []),
    {
      href: "https://api.earthref.org/",
      icon: "external",
      title: (
        <>
          {config.key}/FIESTA
          <br />
          API
        </>
      ),
    },
    ...(config.features.pages.includes("help")
      ? [
          {
            to: "/help",
            icon: "question-circle" as IconName,
            title: (
              <>
                {config.key} FAQ
                <br />
                and Help
              </>
            ),
          },
        ]
      : []),
  ];

  return (
    /* `ui grid divided`: margin −1rem, row padding 1rem 0, 12/4 columns with
       1rem side padding; the news column carries the 1px left divider. */
    <div style={{ margin: "-1rem" }}>
      <div className="flex flex-col lg:flex-row" style={{ padding: "1rem 0" }}>
        <div className="min-w-0 lg:w-3/4" style={{ padding: "0 1rem" }}>
          <div className="flex flex-wrap" style={threeCards}>
            <div style={threeCard}>
              <IconButton
                to="/search"
                icon="database"
                cornerIcon="search"
                title="Search Interface"
                subtitle="Browse, combine, and save datasets."
              />
            </div>
            <div style={threeCard}>
              <IconButton
                to="/upload"
                icon="table"
                cornerIcon="add-circle"
                title="Upload Tool"
                subtitle="Import data into your private workspace."
              />
            </div>
            <div style={threeCard}>
              <IconButton
                to="/private"
                icon="file-text"
                cornerIcon="check"
                title="Private Workspace"
                subtitle={`Manage your contributions to ${config.key}.`}
              />
            </div>
          </div>

          {/* Plugin cards (legacy: the full-width "Poles / View" tiny card) */}
          {pluginHomeCards(config).map(({ key, ...card }) => (
            <div key={key} style={{ marginTop: "0.875em" }}>
              <IconButton variant="wide" {...card} />
            </div>
          ))}

          <DividerHeader first>{config.key} Resources</DividerHeader>
          <div className="flex flex-wrap" style={nineCards}>
            {resources.map((props, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static card list
              <div key={index} style={nineCard}>
                <IconButton variant="small" {...props} />
              </div>
            ))}
          </div>

          <DividerHeader>Recent Contributions</DividerHeader>
          {recent.isPending && <PageSpinner label="Loading recent contributions…" />}
          {recent.error && <ErrorMessage error={recent.error} />}
          {recent.data && (
            <>
              <div style={{ margin: "1em 0" }}>
                {recent.data.results.map((doc, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list of 7, replaced wholesale on refetch
                    key={`${contributionId(doc) ?? "recent"}-${index}`}
                  >
                    <ResultItem doc={doc} level={contributionLevel} />
                    {recent.data.results.length > 1 && <ResultDivider />}
                  </div>
                ))}
              </div>
              <IconButton
                variant="wide"
                fontSize={15}
                titleEm={1}
                to="/search"
                title={`View More Contributions in the ${config.key} Search Interface`}
              />
            </>
          )}
        </div>

        {/* News column (4 of 16) with the grid's vertical divider */}
        <aside
          className="hidden lg:block lg:w-1/4"
          style={{ padding: "0 1rem", boxShadow: `-1px 0 0 0 ${RULE}` }}
          aria-label="News"
        >
          <Rule />
          <h3
            className="font-bold"
            style={{
              fontSize: "1.28571429em",
              lineHeight: "1.28571429em",
              margin: "calc(2rem - 0.14285714em) 0 1rem",
              color: "rgba(0,0,0,.87)",
            }}
          >
            News
          </h3>
          <p style={{ margin: "0 0 1em" }}>No news yet.</p>
          <p style={{ margin: "0 0 1em" }}>
            <Link to="/contact" className="text-node hover:underline">
              Contact the {config.key} team
            </Link>
          </p>
        </aside>
      </div>
    </div>
  );
}

type IconName = NonNullable<IconButtonProps["icon"]>;
