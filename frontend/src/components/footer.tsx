import { siteUrl } from "../lib/base";
import { useNodeConfig } from "../lib/config";
import { PORTALS } from "../lib/portals";
import { Icon } from "./ui/icon";

/** `ui header <color>` at 1rem: bold, node-colored inline link. */
const headerLink = "font-bold text-node hover:underline";

/** `ui button compact basic <color>` with inline margin .5em 1em (layout.jsx). */
function basicButtonStyle(color: string) {
  return {
    color,
    boxShadow: `0 0 0 1px ${color} inset`,
    background: "#fff",
    fontSize: "1rem",
    fontWeight: 400,
    lineHeight: "1em",
    padding: "0.58928571em 1.125em",
    margin: "0.5em 1em",
    borderRadius: "0.28571429rem",
  } as const;
}

const earthrefColor = PORTALS[0]?.color ?? "#006600";

/**
 * Legacy `ui bottom fixed small menu footer` (layout.jsx:117-160, layout.less):
 * fixed, bg #F8F8F8, 13px, container width calc(100% - 4em); left/right
 * `ui vertical segment`s (14px, padding .25em 0) and two basic buttons between
 * them, centred by the left/right menus' auto margins.
 */
export function Footer() {
  const { data: config } = useNodeConfig();

  return (
    <footer
      className="bg-[#F8F8F8] sm:fixed sm:inset-x-0 sm:bottom-0 sm:z-40"
      style={{
        fontSize: "0.92857143rem",
        minHeight: "2.85714286em",
        borderTop: "1px solid rgba(34,36,38,.15)",
        boxShadow: "0 1px 2px 0 rgba(34,36,38,.15)",
        color: "rgba(0,0,0,.87)",
      }}
    >
      <div
        className="flex flex-col items-center gap-y-2 sm:flex-row sm:items-start sm:gap-y-0"
        style={{ margin: "0 2em" }}
      >
        <div className="flex w-full justify-center text-center sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-start sm:text-left">
          <div style={{ fontSize: "1rem", padding: "0.25em 0", lineHeight: "1.4285em" }}>
            <div>
              Sponsored by{" "}
              <a href="https://www.nsf.gov" target="_blank" rel="noreferrer" className={headerLink}>
                NSF
              </a>
              .
            </div>
            <div>
              Supported by{" "}
              <a
                href="https://scripps.ucsd.edu/"
                target="_blank"
                rel="noreferrer"
                className={headerLink}
              >
                UCSD-SIO
              </a>
              {" and "}
              <a
                href="http://ceoas.oregonstate.edu/"
                target="_blank"
                rel="noreferrer"
                className={headerLink}
              >
                OSU-CEOAS
              </a>
              .
            </div>
          </div>
        </div>
        <div className="flex min-w-0 shrink flex-col items-center sm:min-w-fit sm:shrink-0 xl:flex-row">
          <a
            href={`mailto:webmaster@earthref.org?subject=[${config?.key ?? "FIESTA"} Help]`}
            className="inline-block self-center text-center sm:whitespace-nowrap"
            style={basicButtonStyle("var(--node-color)")}
          >
            <Icon
              name="mail"
              style={{ width: "1.18em", height: "1em", margin: "0 0.42857143em 0 -0.21428571em" }}
            />
            <b>Having trouble?</b>
            {" Email Us"}
          </a>
          <a
            href="https://github.com/earthref/FIESTA#readme"
            target="_blank"
            rel="noreferrer"
            className="inline-block self-center text-center sm:whitespace-nowrap"
            style={basicButtonStyle(earthrefColor)}
          >
            Powered by
            <img
              src={siteUrl("/FIESTA.png")}
              alt=""
              style={{
                display: "inline",
                verticalAlign: "baseline",
                height: "1.75em",
                margin: "-1.25em 0.5em -0.5em",
              }}
            />
            <b>FIESTA</b>
          </a>
        </div>
        <div className="flex w-full justify-center text-center sm:w-auto sm:min-w-0 sm:flex-1 sm:justify-end sm:text-right">
          <div
            className="sm:text-right"
            style={{ fontSize: "1rem", padding: "0.25em 0", lineHeight: "1.4285em" }}
          >
            <div>
              Unless otherwise noted,{" "}
              <a
                href="https://earthref.org/"
                target="_blank"
                rel="noreferrer"
                className={headerLink}
              >
                EarthRef.org
              </a>
            </div>
            <div>
              content is licensed under{" "}
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noreferrer"
                className={headerLink}
              >
                CC BY 4.0
              </a>
              .
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
