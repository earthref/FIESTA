"""Earth's present-day tectonic plates (Bird 2003, PB2002: 52 plates), for the
maps' plate-boundary layer and the Geospatial filter's plates.

`data/plates.json` is the GeoJSON both use, made by fiesta/scripts/plates.py:
one feature per plate, `{code, name}`, its polygons split at the antimeridian
and closed over a pole where they circle one, so that OpenSearch's geo_shape
query reads them as drawn. The edges that adds (along ±180° and ±90°) are not
boundaries, and the maps leave them out.

`data/provinces.json` adds the `plate_block` vocabulary's cratons, blocks and
terranes that have a present-day outline (Hasterok et al. 2022, made by
fiesta/scripts/provinces.py): one feature per term, `{code, name, sources}`,
its code a lower-case slug ("kaapvaal-craton"). The Geospatial filter takes
both: `plate=` codes name plates (upper case) or provinces (lower case), and a
record on any of them matches.

A `plate=` code can also be a lasso drawn on the filter's map, inline:
`lasso:<lon>_<lat>~<lon>_<lat>~…`, its vertices in drawing order (3 to
MAX_LASSO_VERTICES; each edge the shorter way round in longitude). A lasso
that circles a pole is closed over the nearer one, and one across the
antimeridian is split at it, as the plates are (lasso_polygons).
"""

import json
import math
from functools import cache, lru_cache
from pathlib import Path

from fastapi import HTTPException

PLATES_FILE = Path(__file__).parent / "data" / "plates.json"
PROVINCES_FILE = Path(__file__).parent / "data" / "provinces.json"


@cache
def plates_geojson() -> dict:
    return json.loads(PLATES_FILE.read_text())


@cache
def provinces_geojson() -> dict:
    return json.loads(PROVINCES_FILE.read_text())


@cache
def _polygons() -> dict[str, list[list[list[list[float]]]]]:
    """Each plate's and province's polygons (rings of [lon, lat]) by its code."""
    out: dict[str, list] = {}
    for feature in plates_geojson()["features"] + provinces_geojson()["features"]:
        geometry = feature["geometry"]
        coordinates = geometry["coordinates"]
        out[feature["properties"]["code"]] = (
            coordinates if geometry["type"] == "MultiPolygon" else [coordinates]
        )
    return out


LASSO = "lasso:"
MAX_LASSO_VERTICES = 200


def _wrap(lon: float) -> float:
    """A longitude difference the shorter way round, in [-180, 180)."""
    return ((lon + 180) % 360) - 180


def _crosses(a, b, c, d) -> bool:
    """Whether segments ab and cd meet (touching or overlapping counts)."""

    def side(p, q, r) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def on(p, q, r) -> bool:
        return min(p[0], q[0]) <= r[0] <= max(p[0], q[0]) and (
            min(p[1], q[1]) <= r[1] <= max(p[1], q[1])
        )

    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    if d1 * d2 < 0 and d3 * d4 < 0:
        return True
    return (
        (d1 == 0 and on(c, d, a))
        or (d2 == 0 and on(c, d, b))
        or (d3 == 0 and on(a, b, c))
        or (d4 == 0 and on(a, b, d))
    )


def _simple(ring: list[tuple[float, float]]) -> bool:
    """Whether an open ring (its last vertex joined to its first) has no edge
    meeting another but its neighbours, at their shared vertex."""
    n = len(ring)
    edges = [(ring[i], ring[(i + 1) % n]) for i in range(n)]
    return not any(
        _crosses(*edges[i], *edges[j])
        for i in range(n)
        for j in range(i + 2, n)
        if not (i == 0 and j == n - 1)
    )


def _area(ring: list[tuple[float, float]]) -> float:
    """An open ring's shoelace area in square degrees: positive anticlockwise."""
    pairs = zip(ring, ring[1:] + ring[:1], strict=True)
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairs) / 2


def _split_at(ring: list[tuple[float, float]], cut: float) -> list[list[tuple[float, float]]]:
    """A simple open ring cut by the meridian `cut` into the rings either side
    of it: the ring's runs between crossings, each joined along the cut to the
    next run on its side. Along the cut the crossings pair up in order (the
    first two bound a stretch inside the ring, the next two another, …), and
    the run that ends at one crossing carries on from the run that starts at
    its pair."""
    points = [(x + 1e-9 if x == cut else x, y) for x, y in ring]
    path: list[tuple[float, float, bool]] = []
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        path.append((a[0], a[1], False))
        if (a[0] < cut) != (b[0] < cut):
            t = (cut - a[0]) / (b[0] - a[0])
            path.append((cut, a[1] + t * (b[1] - a[1]), True))
    first = next((i for i, p in enumerate(path) if p[2]), None)
    if first is None:
        return [points]
    path = path[first:] + path[:first]
    at = [i for i, p in enumerate(path) if p[2]]
    # Run k goes from crossing k to crossing k + 1 (the last back to the first).
    runs = [path[c : at[k + 1] if k + 1 < len(at) else len(path)] for k, c in enumerate(at)]
    order = sorted(range(len(at)), key=lambda k: path[at[k]][1])
    rank = {k: r for r, k in enumerate(order)}
    pair = {k: order[rank[k] ^ 1] for k in range(len(at))}
    rings: list[list[tuple[float, float]]] = []
    used: set[int] = set()
    for start in range(len(runs)):
        out: list[tuple[float, float]] = []
        k = start
        while k not in used:
            used.add(k)
            out.extend((x, y) for x, y, _ in runs[k])
            out.append(path[at[(k + 1) % len(at)]][:2])
            k = pair[(k + 1) % len(at)]
        if out:
            rings.append(out)
    return rings


@lru_cache(maxsize=256)
def lasso_polygons(code: str) -> list[list[list[list[float]]]]:
    """A lasso code's polygons (each one closed anticlockwise ring of
    [lon, lat] within ±180°), as a MultiPolygon's coordinates; 422 for one
    that isn't 3 to MAX_LASSO_VERTICES positions or that crosses itself."""

    def bad(why: str) -> HTTPException:
        return HTTPException(422, f"bad lasso: {why}")

    try:
        vertices = [
            (float(lon), float(lat))
            for lon, lat in (vertex.split("_") for vertex in code[len(LASSO) :].split("~"))
        ]
    except ValueError:
        raise bad("give lon_lat vertices joined by ~") from None
    if not all(math.isfinite(lon) and -90 <= lat <= 90 for lon, lat in vertices):
        raise bad("latitudes run from -90 to 90")
    vertices = [v for i, v in enumerate(vertices) if i == 0 or v != vertices[i - 1]]
    if len(vertices) > 1 and vertices[-1] == vertices[0]:
        vertices.pop()
    if not 3 <= len(vertices) <= MAX_LASSO_VERTICES:
        raise bad(f"give 3 to {MAX_LASSO_VERTICES} vertices")
    # Each edge the shorter way round, so a lasso across the antimeridian
    # runs on past ±180°, and one that circles a pole ends 360° from its start.
    lons = [_wrap(vertices[0][0])]
    for (previous, _), (lon, _) in zip(vertices, vertices[1:], strict=False):
        lons.append(lons[-1] + _wrap(lon - previous))
    ring = [(lon, lat) for lon, (_, lat) in zip(lons, vertices, strict=True)]
    turn = lons[-1] + _wrap(vertices[0][0] - vertices[-1][0]) - lons[0]
    if abs(turn) > 180:
        pole = 90.0 if sum(lat for _, lat in vertices) >= 0 else -90.0
        end = lons[0] + turn
        ring += [(end, vertices[0][1]), (end, pole), (lons[0], pole)]
    elif max(lons) - min(lons) >= 360:
        raise bad("it goes all the way round without circling a pole")
    if not _simple(ring) or abs(_area(ring)) < 1e-12:
        raise bad("it crosses itself")
    shift = 360 * math.floor((min(lon for lon, _ in ring) + 180) / 360)
    ring = [(lon - shift, lat) for lon, lat in ring]
    pieces = _split_at(ring, 180.0) if max(lon for lon, _ in ring) > 180 else [ring]
    polygons = []
    for piece in pieces:
        if min(lon for lon, _ in piece) >= 180 - 1e-9:
            piece = [(lon - 360, lat) for lon, lat in piece]
        if _area(piece) < 0:
            piece = piece[::-1]
        polygons.append([[[lon, lat] for lon, lat in piece + piece[:1]]])
    return polygons


def _rings(code: str) -> list:
    """A plate's, province's or lasso's polygons."""
    return lasso_polygons(code) if code.startswith(LASSO) else _polygons()[code]


def parse_plates(values: list[str] | None) -> tuple[str, ...]:
    """`plate=` codes (repeated, or comma separated), de-duplicated in order:
    a plate's upper-cased, a province's lower-cased, a lasso's as given; 422
    for one that names neither, or a lasso that isn't one (lasso_polygons)."""
    polygons = _polygons()
    codes: list[str] = []
    for value in values or []:
        for code in value.split(","):
            code = code.strip()
            if code.lower().startswith(LASSO):
                code = LASSO + code[len(LASSO) :]
                lasso_polygons(code)
            else:
                code = code.upper() if code.upper() in polygons else code.lower()
            if code and code not in codes:
                codes.append(code)
    unknown = [code for code in codes if not code.startswith(LASSO) and code not in polygons]
    if unknown:
        raise HTTPException(422, f"unknown plate or province code(s): {', '.join(unknown)}")
    return tuple(codes)


def plates_shape(codes: tuple[str, ...]) -> dict:
    """The plates (and lassos) as one GeoJSON MultiPolygon, for a geo_shape query."""
    return {
        "type": "MultiPolygon",
        "coordinates": [polygon for code in codes for polygon in _rings(code)],
    }


def _in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """Even-odd ray casting along the latitude (the rings are plate carrée,
    within [-180, 180])."""
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1], strict=True):
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def in_plates(lat: float, lon: float, codes: tuple[str, ...]) -> bool:
    """Whether a position is on any of these plates (true for none given)."""
    if not codes:
        return True
    lon = ((lon + 180) % 360) - 180
    return any(
        _in_ring(lon, lat, rings[0]) and not any(_in_ring(lon, lat, hole) for hole in rings[1:])
        for code in codes
        for rings in _rings(code)
    )
