import * as maplibregl from "maplibre-gl";

/**
 * The geologic map's tiles at one level of detail for the whole view.
 *
 * Macrostrat's "carto" tiles show a coarser or finer compilation of maps by
 * tile zoom (its tiny, small, medium and large scales), and MapLibre picks a
 * tile zoom per tile: on a globe it changes as the view pans (the camera zoom
 * follows the centre's latitude, and past zoom 4 each tile's distance), so
 * the map's detail jumped as it moved. Here the level is chosen once for the
 * view from its scale on screen (`contentZoom`, one level coarser than the
 * tile zoom MapLibre would use, which read too busy), and each tile MapLibre
 * asks for is cut from, or put together out of, Macrostrat's tiles at that
 * level by the `geology://` protocol.
 */

const PROTOCOL = "geology";
// Macrostrat's tiles are 512 pixels; so are the ones made here.
const SIZE = 512;
// The level is this many below the view's tile zoom (less busy).
const COARSER = 1;

type View = { map: maplibregl.Map; upstream: string; maxzoom: number; level: number };
const views = new Map<string, View>();
let nextId = 0;

/** The level of detail for a map's view: its scale on screen as a Web
 * Mercator tile zoom at the equator (on a sphere, the same wherever the view
 * pans; in Mercator, the map's zoom), less COARSER. */
const contentZoom = (map: maplibregl.Map, maxzoom: number) => {
  let zoom = map.getZoom();
  if (map.getProjection()?.type !== "mercator") {
    // A half degree along the meridian through the centre, towards the equator.
    const { lng, lat } = map.getCenter();
    const toward = lat > 0 ? -0.5 : 0.5;
    const pixels = map.project([lng, lat]).dist(map.project([lng, lat + toward]));
    if (pixels > 0) zoom = Math.log2(((pixels / 0.5) * 360) / SIZE);
  }
  return Math.min(maxzoom, Math.max(0, Math.round(zoom) - COARSER));
};

// The upstream tiles, by URL, most recently used last (each made tile reads
// one, or four or sixteen of them; neighbours share them).
const CACHE_SIZE = 256;
const cache = new Map<string, Promise<ImageBitmap | null>>();
const upstreamTile = (template: string, z: number, x: number, y: number) => {
  const url = template
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  let tile = cache.get(url);
  if (tile) cache.delete(url);
  else {
    // None there (404, or an empty body) is remembered; a failure (the
    // network, a server error) is not, so that a later request tries again.
    const fetched: Promise<ImageBitmap | null> = fetch(url)
      .then((response) => {
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) throw new Error(`${response.status}`);
        return response.blob();
      })
      .then((blob) => (blob && blob.size > 0 ? createImageBitmap(blob) : null))
      .catch(() => {
        if (cache.get(url) === fetched) cache.delete(url);
        return null;
      });
    tile = fetched;
  }
  cache.set(url, tile);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return tile;
};

/** Tile z/x/y drawn from the upstream tiles at `level`: a part of one above
 * it scaled up, or those under it scaled down (up to 2 levels below a tile
 * of the whole-globe zooms, 1 elsewhere: further, its level drops to that). */
const makeTile = async (view: View, z: number, x: number, y: number) => {
  const level = Math.min(view.level, z + (z <= 2 ? 2 : 1));
  if (level === z) return upstreamTile(view.upstream, z, x, y);
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  if (level < z) {
    const d = z - level;
    const tile = await upstreamTile(view.upstream, level, x >> d, y >> d);
    if (!tile) return null;
    const part = tile.width / (1 << d);
    const [col, row] = [x - ((x >> d) << d), y - ((y >> d) << d)];
    context.drawImage(tile, col * part, row * part, part, part, 0, 0, SIZE, SIZE);
  } else {
    const n = 1 << (level - z);
    const step = SIZE / n;
    const tiles = await Promise.all(
      Array.from({ length: n * n }, (_, i) =>
        upstreamTile(view.upstream, level, x * n + (i % n), y * n + Math.floor(i / n)),
      ),
    );
    if (tiles.every((tile) => !tile)) return null;
    tiles.forEach((tile, i) => {
      if (tile) context.drawImage(tile, (i % n) * step, Math.floor(i / n) * step, step, step);
    });
  }
  return canvas.transferToImageBitmap();
};

let registered = false;
const register = () => {
  if (registered) return;
  registered = true;
  // geology://<view>/<level>/<z>/<x>/<y>: the level is in the URL so that a
  // new one loads new tiles.
  maplibregl.addProtocol(PROTOCOL, async ({ url }) => {
    const [id, , z, x, y] = url.slice(`${PROTOCOL}://`.length).split("/");
    const view = views.get(id);
    const tile = view && (await makeTile(view, Number(z), Number(x), Number(y)));
    // No tile (off land, or failed): an empty body, which MapLibre leaves blank.
    return { data: tile ?? new ArrayBuffer(0) };
  });
};

// The tiles are always made at the view's current level; the one in the URL
// only makes MapLibre load them again when it changes.
const tilesUrl = (id: string, level: number) => `${PROTOCOL}://${id}/${level}/{z}/{x}/{y}`;

/**
 * The geologic map's source tiles for a map about to be made (`upstream` its
 * {z}/{x}/{y} template), and `attach`, which ties them to the map as soon as
 * it is made (before it loads a tile): it sets the level from the view, and
 * again once the style loads and after each move that changes the view's
 * scale, and returns the function that lets them go.
 */
export const geologyTiles = (upstream: string, maxzoom: number) => {
  register();
  const id = String(nextId++);
  return {
    tiles: [tilesUrl(id, 0)],
    attach: (map: maplibregl.Map, sourceId: string) => {
      const view: View = { map, upstream, maxzoom, level: contentZoom(map, maxzoom) };
      views.set(id, view);
      const update = () => {
        const level = contentZoom(map, maxzoom);
        if (level === view.level) return;
        view.level = level;
        (map.getSource(sourceId) as maplibregl.RasterTileSource | undefined)?.setTiles([
          tilesUrl(id, level),
        ]);
      };
      map.on("load", update);
      map.on("moveend", update);
      return () => {
        map.off("load", update);
        map.off("moveend", update);
        views.delete(id);
      };
    },
  };
};
