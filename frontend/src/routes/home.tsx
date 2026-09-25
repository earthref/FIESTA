import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { ErrorMessage } from "../components/error-message";
import { IconButton, type IconButtonProps } from "../components/icon-button";
import { contributionId, ResultDivider, ResultItem } from "../components/result-item";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { nodeUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { sanitizeHtml } from "../lib/sanitize";
import type { HomeCard, HomeNews, NodeConfig, SearchPage } from "../lib/types";
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
const threeCard: CSSProperties = { margin: "0.875em 1em" };
/** Full-width on phones, a third of the row from sm up. */
const threeCardClass = "w-full sm:w-[calc(33.3333%-2em)]";
/** `ui nine cards` (10px cards): wrapper margin 0 −.5em −.875em, cards margin
 * .875em .5em and width calc(11.11% − 1em). */
const nineCards: CSSProperties = { margin: "0 -5px -8.75px" };
const nineCard: CSSProperties = {
  margin: "8.75px 5px",
  width: "calc(11.1111% - 10px)",
  minWidth: 84,
};

/** `ui divider` (margin 1rem 0). */
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

/** Resource cards for a node whose YAML defines none. */
function defaultResources(config: NodeConfig): HomeCard[] {
  const cards: HomeCard[] = [
    {
      title: "Data\nModel",
      icon: "sitemap",
      corner_icon: "table",
      to: `/data-models/${config.data_model_latest}`,
      href: null,
    },
  ];
  if (config.has_method_codes) {
    cards.push({
      title: "Method\nCodes",
      icon: "lab",
      corner_icon: "write",
      to: "/method-codes",
      href: null,
    });
  }
  cards.push({
    title: "Vocabulary\nLists",
    icon: "list",
    corner_icon: "info",
    to: "/vocabularies",
    href: null,
  });
  cards.push({
    title: `${config.key}/FIESTA\nAPI`,
    icon: "exchange",
    corner_icon: "info",
    to: null,
    href: "https://api.earthref.org/",
  });
  if (config.pages.some((page) => page.slug === "help")) {
    cards.push({
      title: "Help\nPages",
      icon: "question",
      corner_icon: null,
      to: "/help",
      href: null,
    });
  }
  return cards;
}

function cardProps(card: HomeCard): IconButtonProps {
  return {
    title: card.title,
    icon: card.icon,
    cornerIcon: card.corner_icon ?? undefined,
    to: card.to ?? undefined,
    href: card.href ?? undefined,
  };
}

function imageUrl(image: string): string {
  return /^https?:\/\//.test(image) ? image : nodeUrl(`/config/assets/${image}`);
}

/** Legacy home_news.jsx: `h3` with a `ui mini image floated left` (35px), then
 * a justified paragraph; items separated by `ui divider`s. The HTML is
 * admin-authored (node YAML), so it is sanitized on render. */
function NewsItem({ item, first }: { item: HomeNews; first?: boolean }) {
  const heading = item.link ? (
    <a href={item.link} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
      {item.title}
    </a>
  ) : (
    item.title
  );
  return (
    <>
      <h3
        className="flex items-center font-bold"
        style={{
          fontSize: "1.28571429em",
          lineHeight: "1.28571429em",
          margin: first ? "0 0 1rem" : "calc(2rem - 0.14285714em) 0 1rem",
          color: "rgba(0,0,0,.87)",
        }}
      >
        {item.image && (
          <img
            src={imageUrl(item.image)}
            alt=""
            className="shrink-0"
            style={{ width: 35, marginRight: "1em" }}
          />
        )}
        <span>{heading}</span>
      </h3>
      <p
        style={{ margin: "0 0 1em" }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: admin-authored HTML, sanitized by DOMPurify
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(item.html) }}
      />
    </>
  );
}

export function HomePage() {
  const { data: config } = useNodeConfig();

  const recent = useQuery({
    queryKey: ["search", "contribution", "", "recent-7"],
    queryFn: () => api<SearchPage>("/search/contribution", { params: { size: 7 } }),
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

  const home = config.features.home ?? { resources: [], news: [] };
  const resources = home.resources.length > 0 ? home.resources : defaultResources(config);

  return (
    /* `ui grid divided`: margin −1rem, row padding 1rem 0, 12/4 columns with
       1rem side padding; the news column carries the 1px left divider. */
    <div className="-mx-[1rem] lg:-my-[1rem]">
      <div className="flex flex-col py-[1rem] lg:flex-row">
        <div className="min-w-0 lg:w-3/4" style={{ padding: "0 1rem" }}>
          <div className="flex flex-wrap" style={threeCards}>
            <div className={threeCardClass} style={threeCard}>
              <IconButton
                to="/search"
                icon="database"
                cornerIcon="search"
                title="Search Interface"
                subtitle="Browse, combine, and save datasets."
              />
            </div>
            <div className={threeCardClass} style={threeCard}>
              <IconButton
                to="/upload"
                icon="table"
                cornerIcon="add"
                title="Upload Tool"
                subtitle="Import data into your private workspace."
              />
            </div>
            <div className={threeCardClass} style={threeCard}>
              <IconButton
                to="/private"
                icon="file text outline"
                cornerIcon="checkmark"
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
            {resources.map((card) => (
              <div key={card.title} style={nineCard}>
                <IconButton variant="small" {...cardProps(card)} />
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

        {/* News column (4 of 16) with the grid's vertical divider; justified like legacy */}
        <aside
          className="mt-[1rem] lg:mt-0 lg:w-1/4 lg:shadow-[-1px_0_0_0_rgba(34,36,38,0.15)]"
          style={{ padding: "0 1rem", textAlign: "justify" }}
          aria-label="News"
        >
          <DividerHeader>News</DividerHeader>
          {home.news.length === 0 && (
            <>
              <p style={{ margin: "1em 0" }}>No news yet.</p>
              <p style={{ margin: "0 0 1em" }}>
                <Link to="/contact" className="text-node hover:underline">
                  Contact the {config.key} team
                </Link>
              </p>
            </>
          )}
          {home.news.map((item, index) => (
            <div key={item.title}>
              {index > 0 && <Rule />}
              <NewsItem item={item} first={index === 0} />
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
