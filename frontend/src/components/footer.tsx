import { useNodeConfig } from "../lib/config";

const footerLink = "text-node hover:underline";
// Legacy: "ui button compact basic" with margin 0.5em 1em (layout.jsx)
const outlinedButton =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-gray-300 bg-white " +
  "px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 m-[0.5em_1em]";

/** Fixed full-width bottom bar, bg #F8F8F8, segment padding 0.25em (layout.less). */
export function Footer() {
  const { data: config } = useNodeConfig();

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-[#F8F8F8]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 px-4 py-[0.25em] text-xs text-gray-500">
        <div className="leading-snug">
          <div>
            Sponsored by{" "}
            <a href="https://www.nsf.gov" target="_blank" rel="noreferrer" className={footerLink}>
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
              className={footerLink}
            >
              UCSD-SIO
            </a>{" "}
            and{" "}
            <a
              href="http://ceoas.oregonstate.edu/"
              target="_blank"
              rel="noreferrer"
              className={footerLink}
            >
              OSU-CEOAS
            </a>
            .
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`mailto:webmaster@earthref.org?subject=[${config?.key ?? "FIESTA"} Help]`}
            className={outlinedButton}
          >
            <span aria-hidden="true">✉</span> Having trouble? Email Us
          </a>
          <a
            href="https://github.com/earthref/FIESTA#readme"
            target="_blank"
            rel="noreferrer"
            className={outlinedButton}
          >
            Powered by FIESTA
          </a>
        </div>
        <div className="text-right leading-snug">
          <div>
            Unless otherwise noted,{" "}
            <a href="https://earthref.org/" target="_blank" rel="noreferrer" className={footerLink}>
              EarthRef.org
            </a>
          </div>
          <div>
            content is licensed under{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              target="_blank"
              rel="noreferrer"
              className={footerLink}
            >
              CC BY 4.0
            </a>
            .
          </div>
        </div>
      </div>
    </footer>
  );
}
