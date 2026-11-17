// Search page URLs. The level and result view are path segments
// (/MagIC/Search/Locations/Data); everything else -- the query, the sidebar's
// filters, the sort, plugin view settings -- is a saved search on the API
// (/v2/{node}/searches, fiesta.services.searches) whose id is the one query
// param (`?q=<id>`). A saved search never changes: its id is derived from its
// state, so a shared link keeps showing what it showed. No imports from the
// router: `npm test` loads this file in Node.

/** What a saved search holds (fiesta.services.searches.SearchState). */
export interface SearchState {
  /** Free text and `field:"value"` facet tokens. */
  query?: string;
  sort?: string;
  ranges?: string[];
  filter?: string[];
  has?: string[];
  bbox?: string;
  area?: string;
  plates?: string;
  mine?: "in_prep" | "published";
  versions?: "all";
  /** View settings, "<owner>.<key>" -> JSON ("map.color", "poles.vgps"). */
  settings?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A saved search id (not a legacy free-text `q`). */
export function isSearchId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** A name as a path segment: "Rock Magnetism" -> "Rock-Magnetism". */
export function slug(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}

/** Whether a path segment names `name` (any case; spaces or hyphens). */
export function slugMatches(name: string, segment: string | undefined): boolean {
  if (!segment) return false;
  const norm = (text: string) => slug(text).toLowerCase();
  return norm(name) === norm(decodeURIComponent(segment));
}

/** The state without empty fields; `{}` is the node's default search. */
export function canonicalState(state: SearchState): SearchState {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === "settings") {
      const settings = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(settings).length === 0) continue;
      out[key] = settings;
      continue;
    }
    out[key] = value;
  }
  return out as SearchState;
}

export function isEmptyState(state: SearchState): boolean {
  return Object.keys(canonicalState(state)).length === 0;
}

/** Order-independent comparison key for a state. */
export function stateKey(state: SearchState): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value as object)
          .sort()
          .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(sorted(canonicalState(state)));
}

function list(value: unknown): string[] | undefined {
  if (typeof value === "string" && value !== "") return [value];
  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === "string" && !!entry);
    return entries.length ? entries : undefined;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The legacy search params (`/MagIC/search?q=basalt&level=Sites&sort=...`)
 * that become a saved search's state. */
export const LEGACY_STATE_PARAMS = [
  "sort",
  "ranges",
  "filter",
  "has",
  "bbox",
  "area",
  "plates",
  "mine",
  "versions",
] as const;

/** A legacy search URL's params as a saved search's state. Its `q` is free
 * text (a saved search's id is not: check `isSearchId` first). */
export function stateFromLegacy(search: Record<string, unknown>): SearchState {
  return canonicalState({
    query: isSearchId(search.q) ? undefined : text(search.q),
    sort: text(search.sort),
    ranges: list(search.ranges),
    filter: list(search.filter),
    has: list(search.has),
    bbox: text(search.bbox),
    area: text(search.area),
    plates: text(search.plates),
    mine: search.mine === "in_prep" || search.mine === "published" ? search.mine : undefined,
    versions: search.versions === "all" ? "all" : undefined,
  });
}

/** Whether a search URL carries legacy params to convert. */
export function hasLegacyParams(search: Record<string, unknown>): boolean {
  if (search.q !== undefined && !isSearchId(search.q)) return true;
  return (
    LEGACY_STATE_PARAMS.some((key) => search[key] !== undefined) ||
    search.level !== undefined ||
    search.view !== undefined ||
    search.contribution !== undefined
  );
}

/** A search page's path below the node: "/Search", "/Search/Sites",
 * "/Search/Sites/Data". */
export function searchPath(level?: string, view?: string): string {
  if (!level) return "/Search";
  return view ? `/Search/${slug(level)}/${slug(view)}` : `/Search/${slug(level)}`;
}

/** A contribution's path below the node: "/16901", "/16901/Sites". */
export function contributionPath(id: number | string, tab?: string): string {
  return tab ? `/${id}/${slug(tab)}` : `/${id}/Contribution`;
}
