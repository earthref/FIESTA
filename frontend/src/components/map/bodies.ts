// The planetary bodies the maps and thumbnails draw: Earth, and those a node's
// `search.bodies` can put a record on (a lunar location's sites: the API gives
// their points a `body`; backend/fiesta/nodeconfig.py Body). Their basemaps
// are body-basemaps.ts (loaded with the maps).
export type Body = "earth" | "moon" | "mars";
export const BODIES: [Body, string][] = [
  ["earth", "Earth"],
  ["moon", "Moon"],
  ["mars", "Mars"],
];

export const isBody = (value: unknown): value is Body => BODIES.some(([body]) => body === value);

/** Where the points are, most first (Earth first of equals), for a map to open on. */
export function bodiesOf(points: { body?: Body }[]): Body[] {
  const counts = new Map<Body, number>();
  for (const { body = "earth" } of points) counts.set(body, (counts.get(body) ?? 0) + 1);
  return BODIES.map(([body]) => body)
    .filter((body) => counts.has(body))
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}
