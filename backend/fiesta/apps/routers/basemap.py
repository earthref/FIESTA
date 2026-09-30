"""The maps' basemap data, fetched once a day and cached here (the upstream
services serve it uncacheable, or slowly):

    /v2/basemap/world               Esri Ocean as a low-resolution plate carrée
                                    image for the result thumbnails, blank past
                                    Web Mercator's ±85.05°
    /v2/basemap/arctic              Esri's Arctic version of it, over the band
                                    past that
    /v2/basemap/moon, /mars         the other planetary bodies' thumbnail
                                    images, pole to pole
    /v2/basemap/undersea-features   the IHO-IOC GEBCO Gazetteer of Undersea
                                    Feature Names as GeoJSON, for the map labels

The SPA's maps (frontend/src/components/map/basemap.ts) take the basemap's
tiles straight from Esri and the other labels from OpenFreeMap.
"""

import asyncio
import json
import math
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Response

router = APIRouter(prefix="/basemap", tags=["basemap"])

# Must match THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT / THUMBNAIL_POLAR_ROWS in
# frontend/src/components/map/basemap.ts.
WIDTH, HEIGHT = 1024, 512
MERCATOR_LAT = 85.0511287798
POLAR_ROWS = math.ceil((90 - MERCATOR_LAT) / 180 * HEIGHT)
POLAR_DEGREES = POLAR_ROWS * 180 / HEIGHT
ESRI = "https://services.arcgisonline.com/arcgis/rest/services"
EXPORT = "bboxSR=4326&imageSR=4326&format=jpg&f=image"
# The other bodies' thumbnails, from USGS Astrogeology's WMS: the LROC WAC
# mosaic of the Moon and the Viking MDIM 2.1 colour mosaic of Mars, to the
# poles (so without the Earth images' polar patch-up).
USGS = "https://planetarymaps.usgs.gov/cgi-bin/mapserv"
WMS = (
    "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&SRS=EPSG:4326&BBOX=-180,-90,180,90"
    f"&WIDTH={WIDTH}&HEIGHT={HEIGHT}&FORMAT=image/jpeg&STYLES="
)
IMAGES = {
    "world": f"{ESRI}/Ocean/World_Ocean_Base/MapServer/export"
    f"?bbox=-180,-90,180,90&size={WIDTH},{HEIGHT}&{EXPORT}",
    "arctic": f"{ESRI}/Polar/Arctic_Ocean_Base/MapServer/export"
    f"?bbox=-180,{90 - POLAR_DEGREES},180,90&size={WIDTH},{POLAR_ROWS}&{EXPORT}",
    "moon": f"{USGS}?map=/maps/earth/moon_simp_cyl.map&LAYERS=LROC_WAC&{WMS}",
    "mars": f"{USGS}?map=/maps/mars/mars_simp_cyl.map&LAYERS=MDIM21_color&{WMS}",
}
MAX_AGE = 24 * 3600
_cache: dict[str, tuple[float, str, bytes]] = {}
_locks: dict[str, asyncio.Lock] = {}

# The gazetteer's feature service (hosted by NOAA NCEI): point features
# (seamounts, knolls, ...) and line features (ridges, trenches, ...) keep their
# geometry; areas (basins, plains, ...) become the middle of their outline.
UNDERSEA = (
    "https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services"
    "/Undersea_Features/FeatureServer"
)
UNDERSEA_LAYERS = [(0, "point"), (1, "line"), (2, "area")]
UNDERSEA_PAGE = 2000


async def _cached(key: str, fetch) -> tuple[float, str, bytes]:
    """The cached (time, media type, body) for key, refreshed by fetch() once
    a day; a stale copy is kept when a refresh fails."""
    async with _locks.setdefault(key, asyncio.Lock()):
        cached = _cache.get(key)
        if cached is None or time.time() - cached[0] > MAX_AGE:
            try:
                kind, body = await fetch()
                cached = _cache[key] = (time.time(), kind, body)
            except (httpx.HTTPError, ValueError, KeyError) as error:
                if cached is None:
                    raise HTTPException(502, f"{key} unavailable: {error}") from None
        return cached


def _response(cached: tuple[float, str, bytes]) -> Response:
    return Response(
        cached[2], media_type=cached[1], headers={"Cache-Control": f"public, max-age={MAX_AGE}"}
    )


def undersea_label(name: str, kind: str) -> str:
    """ "Gorda" + "Ridge" -> "Gorda Ridge", unless the name already says it."""
    return name if not kind or kind.lower() in name.lower() else f"{name} {kind}"


def middle_of(geometry: dict) -> list[float] | None:
    """The mean of an area's outer ring(s), with longitudes taken near the first
    one so that it can straddle the antimeridian."""
    if geometry.get("type") == "Polygon":
        rings = [geometry["coordinates"][0]]
    elif geometry.get("type") == "MultiPolygon":
        rings = [polygon[0] for polygon in geometry["coordinates"]]
    else:
        return None
    points = [point for ring in rings for point in ring]
    if not points:
        return None
    lon0 = points[0][0]
    lon = sum(p[0] + 360 * round((lon0 - p[0]) / 360) for p in points) / len(points)
    lat = sum(p[1] for p in points) / len(points)
    return [(lon + 540) % 360 - 180, lat]


def undersea_features(layers: list[tuple[str, list[dict]]]) -> dict:
    """The gazetteer's layers as one FeatureCollection of {name, kind} features."""
    features: list[dict[str, Any]] = []
    for kind, layer in layers:
        for feature in layer:
            props = feature.get("properties") or {}
            name, generic = (
                str(props.get("NAME") or "").strip(),
                str(props.get("TYPE") or "").strip(),
            )
            geometry = feature.get("geometry")
            if not name or not geometry:
                continue
            properties = {"name": undersea_label(name, generic), "kind": kind}
            if kind == "area":
                middle = middle_of(geometry)
                if middle is None:
                    continue
                geometry = {"type": "Point", "coordinates": middle}
            features.append({"type": "Feature", "properties": properties, "geometry": geometry})
    return {"type": "FeatureCollection", "features": features}


async def _fetch_undersea() -> tuple[str, bytes]:
    async def layer(client: httpx.AsyncClient, number: int) -> list[dict]:
        features: list[dict] = []
        for offset in range(0, 1_000_000, UNDERSEA_PAGE):
            # Simplified to ~1 km, which is finer than labels need.
            response = await client.get(
                f"{UNDERSEA}/{number}/query",
                params={
                    "where": "1=1",
                    "outFields": "NAME,TYPE",
                    "returnGeometry": "true",
                    "geometryPrecision": 3,
                    "maxAllowableOffset": 0.01,
                    "resultOffset": offset,
                    "resultRecordCount": UNDERSEA_PAGE,
                    "f": "geojson",
                },
            )
            response.raise_for_status()
            page = response.json().get("features")
            if not isinstance(page, list):
                raise ValueError(f"no features for layer {number}")
            features += page
            if len(page) < UNDERSEA_PAGE:
                break
        return features

    async with httpx.AsyncClient(timeout=60) as client:
        layers = await asyncio.gather(*(layer(client, n) for n, _ in UNDERSEA_LAYERS))
    collection = undersea_features(
        [(kind, f) for (_, kind), f in zip(UNDERSEA_LAYERS, layers, strict=True)]
    )
    return "application/json", json.dumps(collection, separators=(",", ":")).encode()


@router.get("/undersea-features")
async def get_undersea_features() -> Response:
    return _response(await _cached("undersea-features", _fetch_undersea))


@router.get("/{name}")
async def get_basemap(name: str) -> Response:
    url = IMAGES.get(name)
    if url is None:
        raise HTTPException(404, f"unknown basemap image {name!r}")

    async def fetch() -> tuple[str, bytes]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(url)
        kind = response.headers.get("content-type", "")
        # ArcGIS errors come back as JSON or HTML with a 200.
        if response.status_code != 200 or not kind.startswith("image/"):
            raise ValueError(f"{response.status_code} {kind}")
        return kind, response.content

    return _response(await _cached(name, fetch))
