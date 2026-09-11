import {
  faChartBar as faChartBarRegular,
  faFileLines as faFileLinesRegular,
  faFile as faFileRegular,
} from "@fortawesome/free-regular-svg-icons";
import {
  faBook,
  faCalculator,
  faChartBar,
  faChartColumn,
  faChartLine,
  faCheck,
  faCircleQuestion,
  faCircleXmark,
  faCode,
  faDatabase,
  faDownload,
  faEnvelope,
  faFileLines,
  faFlask,
  faGlobe,
  faHeadphones,
  faInfo,
  faList,
  faMagnifyingGlass,
  faMap,
  faPencil,
  faPlus,
  faQuestion,
  faRightLeft,
  faSitemap,
  faTable,
  faTriangleExclamation,
  faTv,
  faUpload,
  faUsers,
  type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import type { CSSProperties } from "react";

/**
 * Font Awesome glyphs (the icon font behind Semantic UI's `i.icon`), keyed by
 * the Semantic icon names the legacy JSX and the node YAML use, so
 * `icon: sitemap` in config renders the same glyph as `<i class="sitemap icon">`.
 * Font Awesome Free icons are CC BY 4.0 (https://fontawesome.com/license/free).
 */
export const SEMANTIC_ICONS: Record<string, IconDefinition> = {
  database: faDatabase,
  search: faMagnifyingGlass,
  table: faTable,
  add: faPlus,
  plus: faPlus,
  checkmark: faCheck,
  check: faCheck,
  "file text outline": faFileRegular,
  "file alternate outline": faFileLinesRegular,
  "file text": faFileLines,
  "file outline": faFileRegular,
  sitemap: faSitemap,
  lab: faFlask,
  flask: faFlask,
  write: faPencil,
  pencil: faPencil,
  list: faList,
  info: faInfo,
  "bar chart": faChartColumn,
  "chart bar": faChartBar,
  "bar chart outline": faChartBarRegular,
  "chart line": faChartLine,
  calculator: faCalculator,
  book: faBook,
  code: faCode,
  tv: faTv,
  headphones: faHeadphones,
  exchange: faRightLeft,
  question: faQuestion,
  "question circle": faCircleQuestion,
  "remove circle": faCircleXmark,
  "times circle": faCircleXmark,
  users: faUsers,
  download: faDownload,
  upload: faUpload,
  globe: faGlobe,
  map: faMap,
  mail: faEnvelope,
  warning: faTriangleExclamation,
};

/** One FA glyph, 1em tall, width from its aspect ratio (like `i.icon`).
 * `outline` draws a white stroke behind the glyph, in viewBox units (legacy
 * corner icons have a 1px white text-shadow on every side). */
export function FaIcon({
  icon,
  className,
  style,
  outline,
}: {
  icon: IconDefinition;
  className?: string;
  style?: CSSProperties;
  outline?: number;
}) {
  const [width, height, , , path] = icon.icon;
  const d = Array.isArray(path) ? path.join(" ") : path;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{
        height: "1em",
        width: `${width / height}em`,
        display: "inline-block",
        verticalAlign: "-0.125em",
        ...style,
      }}
    >
      {outline && <path d={d} stroke="#fff" strokeWidth={outline} strokeLinejoin="round" />}
      <path d={d} />
    </svg>
  );
}

/** Render a Semantic icon name from config; unknown names render nothing. */
export function SemanticIcon({
  name,
  className,
  style,
  outline,
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
  outline?: number;
}) {
  const icon = SEMANTIC_ICONS[name];
  return icon ? <FaIcon icon={icon} className={className} style={style} outline={outline} /> : null;
}

/** `.ui.button > .icon`: a 1.18em × 1em box, margin 0 .43em 0 −.21em, opacity .8. */
export const buttonIconStyle: CSSProperties = {
  width: "1.18em",
  height: "1em",
  margin: "0 0.42857143em 0 -0.21428571em",
  opacity: 0.8,
};
