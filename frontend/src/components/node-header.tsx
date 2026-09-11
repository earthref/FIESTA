import { Link } from "@tanstack/react-router";
import { useNodeConfig } from "../lib/config";

/**
 * Node letter-logo, title, and subtitle (legacy page.jsx/page.less, measured):
 * page-logo = `ui menu basic button <color>` — serif bold 2.75em letter in a
 * 1.5em square (57.75px), 1px segment border + 1px inset node-colored shadow,
 * floated left with margin-right .25em; h1 28px/36px; h4 15px bold/19.3px.
 */
export function NodeHeader({ fullWidth = false }: { fullWidth?: boolean }) {
  const { data: config } = useNodeConfig();

  return (
    // Legacy `.full-width` layout variant (padding 0 2em) frames the header too.
    <div className={fullWidth ? "w-full px-[2em]" : "er-container"}>
      <div>
        <Link
          to="/"
          aria-label={`${config?.key ?? "Node"} home`}
          className="float-left block bg-white text-center align-middle font-serif font-bold text-node hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          style={{
            fontSize: "2.75em",
            width: "1.5em",
            height: "1.5em",
            minHeight: "1.5em",
            lineHeight: "1.5em",
            margin: "0 0.25em 0 0",
            border: "1px solid rgba(34,36,38,.15)",
            boxShadow: "0 0 0 1px var(--node-color) inset",
            borderRadius: "0.28571429rem",
          }}
        >
          {config?.key?.charAt(0) ?? "F"}
        </Link>
        <Link to="/" className="block min-w-0 overflow-hidden focus-visible:outline-hidden">
          <h1
            className="m-0 truncate font-bold text-[rgba(0,0,0,0.87)]"
            style={{ fontSize: "2rem", lineHeight: "1.28571429em" }}
          >
            {config?.title}
          </h1>
          <h4
            className="m-0 line-clamp-2 font-bold text-[rgba(0,0,0,0.87)]"
            style={{ fontSize: "1.07142857rem", lineHeight: "1.28571429em" }}
          >
            {config?.subtitle}
          </h4>
        </Link>
      </div>
    </div>
  );
}
