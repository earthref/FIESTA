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
"""

import json
from functools import cache
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


def parse_plates(values: list[str] | None) -> tuple[str, ...]:
    """`plate=` codes (repeated, or comma separated), de-duplicated in order:
    a plate's upper-cased, a province's lower-cased; 422 for one that names
    neither."""
    polygons = _polygons()
    codes: list[str] = []
    for value in values or []:
        for code in value.split(","):
            code = code.strip()
            code = code.upper() if code.upper() in polygons else code.lower()
            if code and code not in codes:
                codes.append(code)
    unknown = [code for code in codes if code not in polygons]
    if unknown:
        raise HTTPException(422, f"unknown plate or province code(s): {', '.join(unknown)}")
    return tuple(codes)


def plates_shape(codes: tuple[str, ...]) -> dict:
    """The plates as one GeoJSON MultiPolygon, for a geo_shape query."""
    polygons = _polygons()
    return {
        "type": "MultiPolygon",
        "coordinates": [polygon for code in codes for polygon in polygons[code]],
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
    polygons = _polygons()
    return any(
        _in_ring(lon, lat, rings[0]) and not any(_in_ring(lon, lat, hole) for hole in rings[1:])
        for code in codes
        for rings in polygons[code]
    )
