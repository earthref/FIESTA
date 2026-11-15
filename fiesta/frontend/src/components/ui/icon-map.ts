import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Book,
  Calculator,
  Camera,
  ChartColumn,
  ChartLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CirclePlus,
  CircleQuestionMark,
  CircleX,
  ClipboardCheck,
  Code,
  Database,
  Download,
  ExternalLink,
  File,
  FilePlus,
  FileSearch,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  FolderOpen,
  Funnel,
  Globe,
  Headphones,
  Info,
  List,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  MapPin,
  Menu,
  Moon,
  MousePointer2,
  Move,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Sun,
  Table,
  Trash2,
  TriangleAlert,
  Tv,
  Upload,
  User,
  Users,
  X,
  ZoomIn,
} from "lucide-react";

/**
 * Every icon name FIESTA uses, in code and in the node YAMLs, mapped to one
 * Lucide (https://lucide.dev, ISC) outline glyph. Names are kebab-case; the
 * Semantic UI names the legacy JSX and the YAMLs use ("file text outline",
 * "bar chart") are looked up with spaces turned into dashes, so both spellings
 * resolve. Add a name here before using it in code or configuration.
 */
export const ICONS = {
  // Actions
  search: Search,
  close: X,
  "remove-circle": CircleX,
  "times-circle": CircleX,
  download: Download,
  upload: Upload,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  /** The upload page's drop target: a tray with an arrow into it. */
  "drop-files": Download,
  edit: Pencil,
  write: Pencil,
  pencil: Pencil,
  share: Share2,
  trash: Trash2,
  check: Check,
  checkmark: Check,
  "check-clipboard": ClipboardCheck,
  plus: Plus,
  add: Plus,
  "add-circle": CirclePlus,
  external: ExternalLink,
  exchange: ArrowLeftRight,
  filter: Funnel,
  refresh: RefreshCw,
  camera: Camera,
  // Plot tools
  "mouse-pointer": MousePointer2,
  "zoom-in": ZoomIn,
  move: Move,
  "rotate-left": RotateCcw,
  // Navigation
  "caret-down": ChevronDown,
  "caret-up": ChevronUp,
  "caret-right": ChevronRight,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  sidebar: Menu,
  // People and messages
  user: User,
  users: Users,
  mail: Mail,
  warning: TriangleAlert,
  info: Info,
  question: CircleQuestionMark,
  "question-circle": CircleQuestionMark,
  // Files and data
  file: File,
  "file-outline": File,
  "file-text": FileText,
  "file-text-outline": FileText,
  "file-alternate-outline": FileText,
  "file-excel": FileSpreadsheet,
  "file-excel-outline": FileSpreadsheet,
  "file-spreadsheet": FileSpreadsheet,
  "file-plus": FilePlus,
  "file-search": FileSearch,
  "folder-open": FolderOpen,
  table: Table,
  database: Database,
  sitemap: Network,
  list: List,
  code: Code,
  // Science and resources
  lab: FlaskConical,
  flask: FlaskConical,
  "bar-chart": ChartColumn,
  "chart-bar": ChartColumn,
  "bar-chart-outline": ChartColumn,
  "chart-line": ChartLine,
  calculator: Calculator,
  book: Book,
  tv: Tv,
  headphones: Headphones,
  globe: Globe,
  map: MapIcon,
  "map-marker": MapPin,
  // Theme
  moon: Moon,
  sun: Sun,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** What an unknown name from configuration renders: a plain page. */
export const FALLBACK_ICON: IconName = "file";

/** A configured name in its lookup form: lower case, spaces as dashes,
 * a trailing Semantic "icon" dropped ("Question Circle icon" → "question-circle"). */
export function normalizeIconName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+icon$/, "")
    .replace(/[\s_]+/g, "-");
}

const NAMES: ReadonlySet<string> = new Set(Object.keys(ICONS));

/** Whether a name from configuration (a node YAML's icon) is in the table. */
export function isIconName(name: string): name is IconName {
  return NAMES.has(name);
}

/** The table's name for a configured icon (a node YAML's `icon`, a page's
 * menu icon), or `fallback` when the name is missing or unknown. */
export function iconName(
  name: string | null | undefined,
  fallback: IconName = FALLBACK_ICON,
): IconName {
  if (!name) return fallback;
  const key = normalizeIconName(name);
  return isIconName(key) ? key : fallback;
}
