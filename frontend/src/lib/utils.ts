/** Join class names, skipping falsy values. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Defensively read a dotted path (e.g. "summary.sites._n_results") from a document. */
export function getPath(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return "";
  return n.toLocaleString();
}

/** Numeral-style abbreviation, e.g. 1234 → "1.2 k". */
export function abbreviateNumber(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 1000) return String(n);
  const units: [number, string][] = [
    [1e9, "b"],
    [1e6, "m"],
    [1e3, "k"],
  ];
  for (const [threshold, suffix] of units) {
    if (Math.abs(n) >= threshold) {
      const scaled = n / threshold;
      const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "");
      return `${text} ${suffix}`;
    }
  }
  return String(n);
}

/** method_codes → "Method Codes" */
export function titleCase(name: string): string {
  return name
    .split(/[_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Naive English singular: "classes" → "class", "lithologies" → "lithology". */
export function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
  if (/(ss|sh|ch|x|z)es$/i.test(word)) return word.replace(/es$/i, "");
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** Legacy filter titles are singular: method_codes → "Method Code". */
export function facetTitle(name: string): string {
  return name
    .split(/[_\s]+/)
    .map(singularize)
    .map(titleCase)
    .join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Parse `field:"value"` tokens out of a query string. */
export function parseQueryTokens(q: string): { tokens: [string, string][]; freeText: string } {
  const tokens: [string, string][] = [];
  const tokenRe = /([\w.]+):"([^"]*)"/g;
  const freeText = q
    .replace(tokenRe, (_match, field: string, value: string) => {
      tokens.push([field, value]);
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { tokens, freeText };
}

export function buildQuery(freeText: string, tokens: [string, string][]): string {
  const parts = tokens.map(([field, value]) => `${field}:"${value}"`);
  if (freeText) parts.unshift(freeText);
  return parts.join(" ");
}

/** Toggle a `field:"value"` token in a query string. */
export function toggleQueryToken(q: string, field: string, value: string): string {
  const { tokens, freeText } = parseQueryTokens(q);
  const index = tokens.findIndex(([f, v]) => f === field && v === value);
  if (index >= 0) {
    tokens.splice(index, 1);
  } else {
    tokens.push([field, value]);
  }
  return buildQuery(freeText, tokens);
}

export function hasQueryToken(q: string, field: string, value: string): boolean {
  return parseQueryTokens(q).tokens.some(([f, v]) => f === field && v === value);
}

/** Extract the value of a token (e.g. private_key) from a query string. */
export function getQueryToken(q: string, field: string): string | undefined {
  return parseQueryTokens(q).tokens.find(([f]) => f === field)?.[1];
}
