// TypeScript types for the FIESTA node backend API (see docs/api.md).

export interface SearchLevel {
  name: string;
  table: string;
  count_field: string | null;
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

export interface NodeConfig {
  key: string;
  slug: string;
  title: string;
  subtitle: string;
  color: string;
  links: Record<string, string>;
  contact_email: string;
  data_model_versions: string[];
  data_model_latest: string;
  doi_prefix: string | null;
  search_levels: SearchLevel[];
  facets: string[];
  features: {
    pages: string[];
    plugins: string[];
    home?: { resources: HomeCard[]; news: HomeNews[] };
  };
  /** Active plugins with their per-node configuration, keyed by plugin name. */
  plugins: Record<string, Record<string, unknown>>;
  has_method_codes: boolean;
  /** Local-dev overrides: node slug -> URL for sibling nodes running on this
   * host, so the portal bar cross-links to the running instances. Empty in
   * production. */
  portal_urls?: Record<string, string>;
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
  is_admin: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: "bearer";
}

// --- Search ---

export interface FacetBucket {
  key: string;
  doc_count: number;
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
