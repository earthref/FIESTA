import {
  faChartBar as faChartBarRegular,
  faFileLines as faFileLinesRegular,
  faFile as faFileRegular,
} from "@fortawesome/free-regular-svg-icons";
import {
  faBook,
  faCalculator,
  faChartBar,
  faChartLine,
  faCheck,
  faCircleQuestion,
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
  "file text outline": faFileLinesRegular,
  "file text": faFileLines,
  "file outline": faFileRegular,
  sitemap: faSitemap,
  lab: faFlask,
  flask: faFlask,
  write: faPencil,
  pencil: faPencil,
  list: faList,
  info: faInfo,
  "bar chart": faChartBar,
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
  users: faUsers,
  download: faDownload,
  upload: faUpload,
  globe: faGlobe,
  map: faMap,
  mail: faEnvelope,
  warning: faTriangleExclamation,
};

/** One FA glyph, 1em tall, width from its aspect ratio (like `i.icon`). */
export function FaIcon({
  icon,
  className,
  style,
}: {
  icon: IconDefinition;
  className?: string;
  style?: CSSProperties;
}) {
  const [width, height, , , path] = icon.icon;
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
      <path d={Array.isArray(path) ? path.join(" ") : path} />
    </svg>
  );
}

/** Render a Semantic icon name from config; unknown names render nothing. */
export function SemanticIcon({
  name,
  className,
  style,
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
}) {
  const icon = SEMANTIC_ICONS[name];
  return icon ? <FaIcon icon={icon} className={className} style={style} /> : null;
}
