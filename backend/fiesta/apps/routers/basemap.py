"""The result thumbnails' basemap: Esri Ocean as two low-resolution plate
carrée images, fetched once and cached here (Esri serves them uncacheable).

    /v2/basemap/world    the whole world, blank past Web Mercator's ±85.05°
    /v2/basemap/arctic   Esri's Arctic version of it, over the band past that

The SPA's maps (frontend/src/components/map/basemap.ts) take the same
basemap's tiles straight from Esri.
"""

import math
import time

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
IMAGES = {
    "world": f"{ESRI}/Ocean/World_Ocean_Base/MapServer/export"
    f"?bbox=-180,-90,180,90&size={WIDTH},{HEIGHT}&{EXPORT}",
    "arctic": f"{ESRI}/Polar/Arctic_Ocean_Base/MapServer/export"
    f"?bbox=-180,{90 - POLAR_DEGREES},180,90&size={WIDTH},{POLAR_ROWS}&{EXPORT}",
}
MAX_AGE = 24 * 3600
_cache: dict[str, tuple[float, str, bytes]] = {}


@router.get("/{name}")
async def get_basemap(name: str) -> Response:
    url = IMAGES.get(name)
    if url is None:
        raise HTTPException(404, f"unknown basemap image {name!r}")
    cached = _cache.get(name)
    if cached is None or time.time() - cached[0] > MAX_AGE:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.get(url)
            kind = response.headers.get("content-type", "")
            # ArcGIS errors come back as JSON or HTML with a 200.
            if response.status_code != 200 or not kind.startswith("image/"):
                raise ValueError(f"{response.status_code} {kind}")
            cached = _cache[name] = (time.time(), kind, response.content)
        except (httpx.HTTPError, ValueError) as error:
            if cached is None:
                raise HTTPException(502, f"basemap image unavailable: {error}") from None
    return Response(
        cached[2],
        media_type=cached[1],
        headers={"Cache-Control": f"public, max-age={MAX_AGE}"},
    )
