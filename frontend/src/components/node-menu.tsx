import { Link } from "@tanstack/react-router";
import { useNodeConfig } from "../lib/config";

const itemClass =
  "flex items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm " +
  "font-medium text-gray-600 hover:text-gray-900 focus-visible:outline-hidden " +
  "focus-visible:ring-2 focus-visible:ring-node " +
  "[&.active]:border-node [&.active]:font-semibold [&.active]:text-node";

interface FeaturePage {
  page: string;
  label: string;
  to: string;
}

const featurePages: FeaturePage[] = [
  { page: "about", label: "About", to: "/about" },
  { page: "technology", label: "Technology", to: "/technology" },
  { page: "grand-challenges", label: "Grand Challenges", to: "/grand-challenges" },
  { page: "workshops", label: "Workshops", to: "/workshops" },
  { page: "links", label: "Links", to: "/links" },
];

/** Node-colored secondary pointing menu directly under the node header. */
export function NodeMenu() {
  const { data: config } = useNodeConfig();
  const pages = config?.features.pages ?? [];

  return (
    <nav aria-label="Node" className="border-b border-gray-200">
      <div className="mx-auto flex w-full max-w-6xl items-center overflow-x-auto px-4">
        <div className="flex items-center">
          <Link to="/" className={itemClass} activeOptions={{ exact: true }}>
            Home
          </Link>
          {featurePages
            .filter((entry) => pages.includes(entry.page))
            .map((entry) => (
              <Link key={entry.page} to={entry.to} className={itemClass}>
                {entry.label}
              </Link>
            ))}
        </div>
        <div className="ml-auto flex items-center">
          {config?.links.github_issues && (
            <a
              href={config.links.github_issues}
              target="_blank"
              rel="noreferrer"
              className={itemClass}
            >
              <span aria-hidden="true">⚠</span> Report an Issue on GitHub
            </a>
          )}
          {pages.includes("help") && (
            <Link to="/help" className={itemClass}>
              <span aria-hidden="true">?</span> Help
            </Link>
          )}
          <Link to="/contact" className={itemClass}>
            <span aria-hidden="true">✉</span> Contact
          </Link>
        </div>
      </div>
    </nav>
  );
}
