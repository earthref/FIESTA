"""Earth's present-day tectonic plates (Bird 2003, PB2002: 52 plates), for the
maps' plate-boundary layer and the Geospatial filter's plates.

`data/plates.json` is the GeoJSON both use, made by fiesta/scripts/plates.py:
one feature per plate, `{code, name}`, its polygons split at the antimeridian
and closed over a pole where they circle one, so that OpenSearch's geo_shape
query reads them as drawn. The edges that adds (along ±180° and ±90°) are not
boundaries, and the maps leave them out.
"""

import json
from functools import cache
from pathlib import Path

from fastapi import HTTPException

PLATES_FILE = Path(__file__).parent / "data" / "plates.json"


@cache
def plates_geojson() -> dict:
    return json.loads(PLATES_FILE.read_text())


@cache
def _polygons() -> dict[str, list[list[list[list[float]]]]]:
    """Each plate's polygons (rings of [lon, lat]) by its code."""
    out: dict[str, list] = {}
    for feature in plates_geojson()["features"]:
        geometry = feature["geometry"]
        coordinates = geometry["coordinates"]
        out[feature["properties"]["code"]] = (
            coordinates if geometry["type"] == "MultiPolygon" else [coordinates]
        )
    return out


def parse_plates(values: list[str] | None) -> tuple[str, ...]:
    """`plate=` codes (repeated, or comma separated), upper-cased and
    de-duplicated in order; 422 for one that names no plate."""
    codes: list[str] = []
    for value in values or []:
        for code in value.split(","):
            code = code.strip().upper()
            if code and code not in codes:
                codes.append(code)
    unknown = [code for code in codes if code not in _polygons()]
    if unknown:
        raise HTTPException(422, f"unknown plate code(s): {', '.join(unknown)}")
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
