// Canonical URLs: every path is PascalCase (/MagIC/Search/Sites, /MagIC/About,
// /MagIC/Data-Models/3.0). Paths match in any case; a page reached by another
// spelling replaces its URL with the canonical one (routes/layout.tsx for a
// route's static segments, each page for its own names). No imports: `npm
// test` loads this file in Node.

/** A slug as a path segment, each hyphenated word capitalized:
 * "grand-challenges" -> "Grand-Challenges", "about" -> "About". */
export function pathSegment(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join("-");
}

/** A path ("/method-codes") with each segment a path segment
 * ("/Method-Codes"); a query string or hash is left as it is. */
export function casedPath(path: string): string {
  const cut = path.search(/[?#]/);
  const [head, rest] = cut < 0 ? [path, ""] : [path.slice(0, cut), path.slice(cut)];
  return head.split("/").map(pathSegment).join("/") + rest;
}

/**
 * `path` with each of its segments that is a static segment of the matched
 * route's pattern spelled as the pattern spells it: ("/Admin/Nodes/$slug",
 * "/admin/nodes/magic") -> "/Admin/Nodes/magic". Params (`$x`, `{-$x}`) keep
 * the path's spelling. The patterns' optional params are trailing, so
 * segments line up by position.
 */
export function withRouteCase(pattern: string, path: string): string {
  const parts = pattern.split("/");
  return path
    .split("/")
    .map((segment, index) => {
      const part = parts[index];
      if (part === undefined || part.includes("$")) return segment;
      return part.toLowerCase() === segment.toLowerCase() ? part : segment;
    })
    .join("/");
}
