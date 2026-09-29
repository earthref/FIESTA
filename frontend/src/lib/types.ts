// TypeScript types for the FIESTA node backend API (see docs/api.md).

export interface SearchLevel {
  name: string;
  table: string;
  count_field: string | null;
  /** Its rows can carry a position (lat/lon columns), so it has a Map tab. */
  geo?: boolean;
}

/** features.home.resources entry: a resource card (title lines split on "\n"). */
export interface HomeCard {
  title: string;
  icon: string;
  corner_icon: string | null;
  to: string | null;
  href: string | null;
}

/** features.home.news entry; `html` is trusted markup from the node YAML. */
export interface HomeNews {
  title: string;
  html: string;
  image: string | null;
  link: string | null;
}

/** One filter sidebar control (backend `SearchFilter`). `levels` / `views`
 * empty = shown on every search level / result view. */
export interface SearchFilter {
  type: "facet" | "range" | "bbox";
  /** facet: a column name; range: a `summary.*` document path; bbox: null. */
  field: string | null;
  label: string | null;
  levels: string[];
  views: string[];
  unit: string | null;
  /** range: typed value × scale is what the API receives (Ma → years). */
  scale: number;
  min: number | null;
  max: number | null;
}

/** A number the search map can color its markers by (backend `MapColor`),
 * sent as `color_by=<field>`; offered on the levels whose table is in `tables`. */
export interface MapColorOption {
  label: string;
  field: string;
  unit: string | null;
  /** A value / scale is what the legend shows (T → μT with 1e-6). */
  scale: number;
  log: boolean;
  tables: string[];
}

/** A content page (backend `PageConfig`); its HTML comes from /config/pages/{slug}. */
export interface NodePage {
  slug: string;
  title: string;
  menu: "left" | "right" | "hidden";
  icon: string | null;
}

export interface NodeConfig {
  key: string;
  slug: string;
  title: string;
  subtitle: string;
  color: string;
  links: Record<string, string>;
  data_model_versions: string[];
  data_model_latest: string;
  doi_prefix: string | null;
  search_levels: SearchLevel[];
  /** Columns aggregated as term buckets (the facet filters' fields). */
  facets: string[];
  /** The filter sidebar's controls (node YAML `search.filters`). */
  filters: SearchFilter[];
  /** The search map's "Color by" menu (node YAML `search.map_colors`). */
  map_colors?: MapColorOption[];
  /** Content pages (node YAML `pages`), in menu order. */
  pages: NodePage[];
  features: {
    plugins: string[];
    home?: { resources: HomeCard[]; news: HomeNews[] };
  };
  /** Active plugins with their per-node configuration, keyed by plugin name. */
  plugins: Record<string, Record<string, unknown>>;
  has_method_codes: boolean;
  /** Keys of every node the API serves; the portal bar links them to their
   * instances next to this one off the production hosts (lib/portals.ts). */
  deployment_nodes?: string[];
  /** Keys of the nodes whose web app production does not serve: the portal bar leaves them out. */
  hidden_nodes?: string[];
  /** False when production does not serve this node's web app (node YAML `publish.web`). */
  web_published?: boolean;
}

export interface HealthStatus {
  status: string;
  database: boolean;
  search: boolean;
  storage: boolean;
}

// --- Auth ---

export interface UserOut {
  id: number;
  email: string;
  name: string;
  orcid: string | null;
  /** Super admin: every node, node creation, accounts. */
  is_admin: boolean;
  /** Slugs of the nodes this user administers. */
  admin_nodes: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
}

// --- Search ---

export interface FacetBucket {
  key: string;
  doc_count: number;
  /** The value's rows (levels with a count field) and, with `totals`, its
   * positioned docs: the sidebar counts follow the Rows and Map sub-tabs. */
  rows_count?: number;
  mapped_count?: number;
}

/**
 * A search hit is an OpenSearch `_source` document. Its exact shape varies by
 * node and level; the summary hierarchy is traversed defensively via `getPath`.
 */
export type SearchResult = Record<string, unknown>;

export interface SearchPage {
  total: number;
  results: SearchResult[];
  aggregations: Record<string, FacetBucket[]> | null;
  /** With `totals`: the matches' rows, and those with a position. */
  rows_total?: number | null;
  mapped_total?: number | null;
}

// --- Private workspace ---

export type ContributionStatus =
  | "created"
  | "uploaded"
  | "parsing"
  | "validating"
  | "summarizing"
  | "ready"
  | "failed";

export interface ContributionOut {
  head_revision: string | null;
  published_revision: string | null;
  indexing_status: string;
  id: number;
  version: number;
  previous_id: number | null;
  contributor_id: number;
  contributor_name: string;
  private_key?: string;
  is_activated: boolean;
  is_latest: boolean;
  data_model_version: string;
  reference_doi: string | null;
  filename: string | null;
  status: ContributionStatus;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface ValidationIssue {
  table: string;
  row: number | null;
  column: string | null;
  message: string;
}

export interface ValidationResult {
  is_valid: boolean;
  validated_at: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface JobOut {
  job_id: string;
}

// --- Data models ---

export interface DataModelColumn {
  label?: string;
  group?: string;
  type?: string;
  unit?: string;
  description?: string;
  notes?: string;
  examples?: string[];
  validations?: string[];
  position?: number;
  previous_columns?: ({ table: string; column: string } | string)[];
}

export interface DataModelTable {
  label?: string;
  position?: number;
  description?: string;
  columns: Record<string, DataModelColumn>;
}

export interface DataModel {
  updated_day?: string;
  tables: Record<string, DataModelTable>;
}

// --- Vocabularies ---

export interface VocabularyItem {
  item: string;
  label?: string;
}

export interface Vocabulary {
  label: string;
  database_column?: string;
  items: VocabularyItem[];
}

export type Vocabularies = Record<string, Vocabulary>;

export interface MethodCode {
  code: string;
  definition: string;
  [key: string]: unknown;
}

export interface MethodCodeGroup {
  label: string;
  codes: MethodCode[];
}

export type MethodCodes = Record<string, MethodCodeGroup>;
