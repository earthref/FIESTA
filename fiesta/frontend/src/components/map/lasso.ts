/**
 * A lasso drawn on the Geospatial filter's map. It rides in the filter's
 * `plate=` codes inline, `lasso:<lon>_<lat>~<lon>_<lat>~…`, and the API reads
 * it as fiesta/backend/fiesta/plates.py's lasso_polygons does: each edge the
 * shorter way round in longitude, closed over the nearer pole when it circles
 * one, never crossing itself. The checks here match the API's, so a lasso
 * drawn on the map is never refused.
 */

export type LonLat = [number, number];

export const LASSO = "lasso:";
/** The API takes up to 200; fewer keep the URL short. */
export const MAX_LASSO_VERTICES = 100;

export const isLasso = (code: string) => code.toLowerCase().startsWith(LASSO);

/** A longitude difference the shorter way round, in [-180, 180). */
const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

const side = (p: LonLat, q: LonLat, r: LonLat) =>
  (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const on = (p: LonLat, q: LonLat, r: LonLat) =>
  Math.min(p[0], q[0]) <= r[0] &&
  r[0] <= Math.max(p[0], q[0]) &&
  Math.min(p[1], q[1]) <= r[1] &&
  r[1] <= Math.max(p[1], q[1]);

/** Whether segments ab and cd meet (touching or overlapping counts). */
export const crosses = (a: LonLat, b: LonLat, c: LonLat, d: LonLat) => {
  const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    (d1 === 0 && on(c, d, a)) ||
    (d2 === 0 && on(c, d, b)) ||
    (d3 === 0 && on(a, b, c)) ||
    (d4 === 0 && on(a, b, d))
  );
};

/** Each vertex's longitude carried on from the one before it (each edge the
 * shorter way round), so a lasso across the antimeridian runs past ±180°. */
export const unwrapPath = (vertices: LonLat[]): LonLat[] => {
  const out: LonLat[] = [];
  for (const [lon, lat] of vertices) {
    const previous = out[out.length - 1];
    out.push([previous ? previous[0] + wrap(lon - previous[0]) : lon, lat]);
  }
  return out;
};

/**
 * The ring the API reads a lasso as: its vertices unwrapped and, when they
 * circle a pole (ending 360° from where they started), closed over the
 * nearer one by `closure` (the edges that adds are not drawn). Null when it
 * isn't a lasso the API takes: fewer than 3 vertices, all the way round
 * without circling a pole, crossing itself, or no area.
 */
export const lassoRing = (vertices: LonLat[]): { ring: LonLat[]; closure: number } | null => {
  if (vertices.length < 3) return null;
  const ring = unwrapPath(vertices);
  const [first, last] = [ring[0], ring[ring.length - 1]];
  const turn = last[0] + wrap(first[0] - last[0]) - first[0];
  const lons = ring.map(([lon]) => lon);
  let closure = 0;
  if (Math.abs(turn) > 180) {
    const pole = vertices.reduce((sum, [, lat]) => sum + lat, 0) >= 0 ? 90 : -90;
    const end = first[0] + turn;
    ring.push([end, first[1]], [end, pole], [first[0], pole]);
    closure = 3;
  } else if (Math.max(...lons) - Math.min(...lons) >= 360) {
    return null;
  }
  const n = ring.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (crosses(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return null;
    }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [[x1, y1], [x2, y2]] = [ring[i], ring[(i + 1) % n]];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2) < 1e-12 ? null : { ring, closure };
};

const round = (degrees: number) => Math.round(degrees * 1e4) / 1e4;

export const encodeLasso = (vertices: LonLat[]) =>
  LASSO + vertices.map(([lon, lat]) => `${round(wrap(lon))}_${round(lat)}`).join("~");

export const decodeLasso = (code: string): LonLat[] | null => {
  if (!isLasso(code)) return null;
  const vertices = code
    .slice(LASSO.length)
    .split("~")
    .map((vertex) => vertex.split("_").map(Number) as LonLat);
  return vertices.every((v) => v.length === 2 && v.every(Number.isFinite)) ? vertices : null;
};

/** A lasso's outline to draw, as one line: around its vertices and back to
 * its start, or, circling a pole, around them without the edges over it. */
export const lassoOutline = (code: string): LonLat[] | null => {
  const vertices = decodeLasso(code);
  const closed = vertices && lassoRing(vertices);
  if (!closed) return null;
  const { ring, closure } = closed;
  return closure ? ring.slice(0, ring.length - closure + 1) : [...ring, ring[0]];
};

type Drawn = { lonLat: LonLat; x: number; y: number };

// Douglas–Peucker on the screen positions: the indexes of the vertices kept.
const simplify = (path: Drawn[], tolerance: number): number[] => {
  const keep = new Set([0, path.length - 1]);
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [p, q] = [path[a], path[b]];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    let [far, distance] = [-1, tolerance];
    for (let i = a + 1; i < b; i++) {
      const r = path[i];
      const d =
        length === 0
          ? Math.hypot(r.x - p.x, r.y - p.y)
          : Math.abs((q.x - p.x) * (p.y - r.y) - (p.x - r.x) * (q.y - p.y)) / length;
      if (d > distance) [far, distance] = [i, d];
    }
    if (far < 0) continue;
    keep.add(far);
    stack.push([a, far], [far, b]);
  }
  return [...keep].sort((x, y) => x - y);
};

/**
 * The lasso a drag drew: its path (in drawing order, never crossing itself)
 * simplified to at most MAX_LASSO_VERTICES vertices a pixel or two off it,
 * rounded as encoded, and cut back from its end until closing it crosses
 * nothing. Null when too little is left.
 */
export const finishLasso = (path: Drawn[]): LonLat[] | null => {
  if (path.length < 3) return null;
  let tolerance = 1.5;
  let kept = simplify(path, tolerance);
  while (kept.length > MAX_LASSO_VERTICES) {
    tolerance *= 1.5;
    kept = simplify(path, tolerance);
  }
  const vertices = kept
    .map((i) => path[i].lonLat)
    .map(([lon, lat]) => [round(wrap(lon)), round(lat)] as LonLat)
    .filter((v, i, all) => i === 0 || v[0] !== all[i - 1][0] || v[1] !== all[i - 1][1]);
  while (vertices.length >= 3 && !lassoRing(vertices)) vertices.pop();
  return vertices.length >= 3 ? vertices : null;
};

/** Whether the next point of a lasso being drawn keeps it from crossing itself
 * (its path unwrapped, the point carried on from the last). */
export const extendsLasso = (path: LonLat[], next: LonLat) => {
  const last = path[path.length - 1];
  for (let i = 0; i + 2 < path.length; i++)
    if (crosses(path[i], path[i + 1], last, next)) return false;
  return true;
};

/** A position carried on in longitude from the one before it. */
export const unwrapNext = (previous: LonLat | undefined, [lon, lat]: LonLat): LonLat =>
  previous ? [previous[0] + wrap(lon - previous[0]), lat] : [lon, lat];
