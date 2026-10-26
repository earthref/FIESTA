import type { NodeConfig } from "../lib/types";

/** Where to contribute while a node mirrors its data source (contributions_mode
 * "source"); nothing when the node takes contributions here. */
export function SourceModeNotice({ config }: { config?: NodeConfig }) {
  if (config?.contributions_mode !== "source") return null;
  const website = config.links.website;
  return (
    <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-gray-800">
      {config.key} contributions are still made{" "}
      {website ? (
        <>
          at{" "}
          <a href={website} className="text-node underline">
            {website.replace(/^https?:\/\//, "")}
          </a>
        </>
      ) : (
        "at its data source"
      )}{" "}
      and copied here, so this site does not take uploads or changes to them yet.
    </div>
  );
}
