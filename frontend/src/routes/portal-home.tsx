import { useQueries } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { ErrorMessage } from "../components/error-message";
import { IconButton } from "../components/icon-button";
import { contributionId, ResultDivider, ResultItem } from "../components/result-item";
import { PageSpinner } from "../components/ui/spinner";
import { api } from "../lib/api";
import { apiUrl, NODES, nodeSiteUrl } from "../lib/base";
import { NodeConfigScope } from "../lib/config";
import type { NodeConfig, SearchPage, SearchResult } from "../lib/types";
import { getPath } from "../lib/utils";
import { DividerHeader, NewsItem, Rule, threeCard, threeCardClass, threeCards } from "./home";

/** Recent contributions listed across every node. */
const RECENT = 7;

/** Scope the node color variables (text-node, the card outline) to one node. */
function nodeColorStyle(color: string): CSSProperties {
  return {
    "--node-color": color,
    "--node-color-soft": `color-mix(in srgb, ${color} 8%, white)`,
    "--node-color-dark": `color-mix(in srgb, ${color} 85%, black)`,
    "--node-color-light": `color-mix(in srgb, ${color} 80%, white)`,
  } as CSSProperties;
}

function timestampOf(doc: SearchResult): number {
  const value = getPath(doc, "summary.contribution.timestamp");
  const time =
    typeof value === "string" || typeof value === "number" ? Date.parse(String(value)) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

interface NodeRecent {
  config: NodeConfig;
  doc: SearchResult;
}

/** One contribution in the cross-node list: the node home's ResultItem,
 * rendered as its own node's (config, colors, links, downloads) and led by
 * the node's key. */
function RecentItem({ config, doc }: NodeRecent) {
  const level = config.search_levels.find((entry) => entry.table === "contribution") ?? {
    name: "Contributions",
    table: "contribution",
    count_field: null,
  };
  return (
    <NodeConfigScope.Provider value={config}>
      <div style={nodeColorStyle(config.color)}>
        <a
          href={nodeSiteUrl(config.key)}
          className="block text-[13px] font-bold text-node hover:underline"
          style={{ margin: "0 0 0.5em" }}
        >
          {config.key}
        </a>
        <ResultItem doc={doc} level={level} />
      </div>
    </NodeConfigScope.Provider>
  );
}

/**
 * The FIESTA portal home (base.ts PORTAL): the node home's layout over every
 * node this origin serves -- a card per node where a node offers search /
 * upload / private workspace, the latest contributions across all of them,
 * and every node's news, each linking into its node.
 */
export function PortalHomePage() {
  const configs = useQueries({
    queries: NODES.map((slug) => ({
      queryKey: ["portal", slug, "config"],
      queryFn: () => api<NodeConfig>(`/v2/${slug}/config`),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  const recents = useQueries({
    queries: NODES.map((slug) => ({
      queryKey: ["portal", slug, "recent", RECENT],
      queryFn: () =>
        api<SearchPage>(`/v2/${slug}/search/contribution`, { params: { size: RECENT } }),
      staleTime: 60_000,
    })),
  });

  if (configs.some((query) => query.isPending)) return <PageSpinner />;

  // A node whose config fails to load is left out rather than failing the
  // page, and so is one whose web app is not published.
  const nodes = configs.flatMap((query, index) =>
    query.data && query.data.web_published !== false
      ? [{ config: query.data, recent: recents[index] }]
      : [],
  );
  const configError = configs.find((query) => query.error)?.error;

  const recent: NodeRecent[] = nodes
    .flatMap(({ config, recent }) => (recent?.data?.results ?? []).map((doc) => ({ config, doc })))
    .sort((a, b) => timestampOf(b.doc) - timestampOf(a.doc))
    .slice(0, RECENT);
  const recentPending = recents.some((query) => query.isPending);
  const recentError = recents.find((query) => query.error)?.error;

  const news = nodes.flatMap(({ config }) =>
    (config.features.home?.news ?? []).map((item) => ({ config, item })),
  );

  return (
    /* The node home's `ui grid divided` (routes/home.tsx). */
    <div className="-mx-[1rem] lg:-my-[1rem]">
      <div className="flex flex-col py-[1rem] lg:flex-row">
        <div className="min-w-0 lg:w-3/4" style={{ padding: "0 1rem" }}>
          {configError && <ErrorMessage error={configError} />}
          <div className="flex flex-wrap" style={threeCards}>
            {nodes.map(({ config, recent }) => (
              <div
                key={config.slug}
                className={threeCardClass}
                style={{ ...threeCard, ...nodeColorStyle(config.color) }}
              >
                <IconButton
                  href={nodeSiteUrl(config.key)}
                  sameTab
                  icon="database"
                  image={
                    config.logo ? apiUrl(`/${config.slug}/config/assets/${config.logo}`) : undefined
                  }
                  title={config.key}
                  subtitle={
                    <>
                      {config.title}
                      {recent?.data && (
                        <>
                          <br />
                          {recent.data.total.toLocaleString()}{" "}
                          {recent.data.total === 1 ? "contribution" : "contributions"}
                        </>
                      )}
                    </>
                  }
                />
              </div>
            ))}
          </div>

          <DividerHeader>Recent Contributions</DividerHeader>
          {/* One node's search failing leaves the others' contributions listed. */}
          {recentError && recent.length === 0 && <ErrorMessage error={recentError} />}
          {recentPending && recent.length === 0 ? (
            <PageSpinner label="Loading recent contributions…" />
          ) : (
            <div style={{ margin: "1em 0" }}>
              {recent.map((entry, index) => (
                <div key={`${entry.config.slug}-${contributionId(entry.doc) ?? index}`}>
                  <RecentItem {...entry} />
                  {index < recent.length - 1 && <ResultDivider />}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* News column: every node's news, each under its node's key */}
        <aside
          className="mt-[1rem] lg:mt-0 lg:w-1/4 lg:shadow-[-1px_0_0_0_rgba(34,36,38,0.15)]"
          style={{ padding: "0 1rem", textAlign: "justify" }}
          aria-label="News"
        >
          <DividerHeader columnTop>News</DividerHeader>
          {news.length === 0 && <p style={{ margin: "1em 0" }}>No news yet.</p>}
          {news.map(({ config, item }, index) => (
            <div key={`${config.slug}-${item.title}`}>
              {index > 0 && <Rule />}
              <NewsItem
                item={item}
                first={index === 0}
                imageBase={apiUrl(`/${config.slug}/config/assets/`)}
                source={
                  <a
                    href={nodeSiteUrl(config.key)}
                    className="block font-bold hover:underline"
                    style={{ color: config.color, margin: "0 0 0.25rem", textAlign: "left" }}
                  >
                    {config.key}
                  </a>
                }
              />
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
