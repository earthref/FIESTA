import { Link } from "@tanstack/react-router";
import { useNodeConfig } from "../lib/config";

/**
 * Node letter-logo, title, and subtitle (legacy page.jsx/page.less):
 * page-logo = serif bold capital letter, font-size 2.75em in a 1.5em square
 * bordered button floating left; h1 page-title margin 0; h4 page-subtitle.
 */
export function NodeHeader() {
  const { data: config } = useNodeConfig();

  return (
    <div className="mx-auto w-full max-w-6xl px-4">
      <div className="pt-2">
        <Link
          to="/"
          aria-label={`${config?.key ?? "Node"} home`}
          className="float-left mr-[0.25em] block border border-node bg-white text-center align-middle font-serif font-bold text-node hover:bg-gray-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-node"
          style={{
            fontSize: "2.75em",
            width: "1.5em",
            height: "1.5em",
            minHeight: "1.5em",
            lineHeight: "1.5em",
            borderRadius: "0.28571429rem",
          }}
        >
          {config?.key?.charAt(0) ?? "F"}
        </Link>
        <Link to="/" className="block min-w-0 overflow-hidden focus-visible:outline-hidden">
          <h1 className="m-0 truncate text-[2rem] font-bold leading-tight text-[rgba(0,0,0,0.87)]">
            {config?.title}
          </h1>
          <h4 className="mt-0 line-clamp-2 text-[1.07rem] font-normal text-[rgba(0,0,0,0.87)]">
            {config?.subtitle}
          </h4>
        </Link>
        <div className="clear-both" />
      </div>
    </div>
  );
}
