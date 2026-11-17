# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2"]
# ///
"""Convert a plate-polygon GeoJSON (Bird 2003, PB2002: features with `Code`
and `PlateName`, rings wrapping continuously across ±180°) into the form the
platform serves and queries, fiesta/backend/fiesta/data/plates.json:

- each plate a Polygon or MultiPolygon with every longitude in [-180, 180],
  split at the antimeridian, so OpenSearch's geo_shape query reads it as drawn;
- a ring that circles a pole (Antarctica, North America) closed over that pole;
- properties trimmed to {code, name}, coordinates rounded to 4 decimals.

The added edges (along ±180° and ±90°) are not boundaries: the maps leave them
out (fiesta/frontend/src/components/map/plates.ts).

    uv run fiesta/scripts/plates.py <source.geojson> fiesta/backend/fiesta/data/plates.json
"""

import json
import sys

from shapely.geometry import MultiPolygon, Polygon, box, mapping
from shapely.validation import make_valid


def unwrap(ring: list[list[float]]) -> list[tuple[float, float]]:
    """The ring with continuous longitudes (no ±360° jumps between points)."""
    out = [(ring[0][0], ring[0][1])]
    for lon, lat in ring[1:]:
        step = lon - out[-1][0] + 180
        step = step % 360 - 180
        out.append((out[-1][0] + step, lat))
    return out


def close_over_pole(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """A ring circling a pole (its unwrapped longitudes end 360° from where
    they start) closed over the pole nearer its points."""
    start, end = ring[0][0], ring[-1][0]
    if abs(end - start) < 180:
        return ring
    pole = 90.0 if sum(lat for _, lat in ring) > 0 else -90.0
    return [*ring, (end, pole), (start, pole), ring[0]]


def pieces(geometry: dict) -> list[Polygon]:
    polygons = (
        geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else [geometry["coordinates"]]
    )
    out: list[Polygon] = []
    for rings in polygons:
        shell = close_over_pole(unwrap(rings[0]))
        holes = [unwrap(ring) for ring in rings[1:]]
        shape = make_valid(Polygon(shell, holes))
        west, _, east, _ = shape.bounds
        # Each 360° band the unwrapped shape reaches, shifted back into [-180, 180].
        for k in range(int((west + 180) // 360), int((east + 180) // 360) + 1):
            band = box(-180 + 360 * k, -90, 180 + 360 * k, 90)
            part = shape.intersection(band)
            for poly in getattr(part, "geoms", [part]):
                if isinstance(poly, Polygon) and poly.area > 0:
                    out.append(
                        Polygon(
                            [(x - 360 * k, y) for x, y in poly.exterior.coords],
                            [
                                [(x - 360 * k, y) for x, y in i.coords]
                                for i in poly.interiors
                            ],
                        )
                    )
    return out


def rounded_ring(ring) -> list[list[float]]:
    """Rounded to 4 decimals without the repeats and spikes (A, B, A) that
    rounding leaves, which OpenSearch refuses ("edges ... coincide")."""
    out: list[list[float]] = []
    for x, y in ring:
        point = [round(x, 4), round(y, 4)]
        if out and point == out[-1]:
            continue
        if len(out) > 1 and point == out[-2]:
            out.pop()
            continue
        out.append(point)
    return out


def rounded(geometry: dict) -> list:
    polygons = (
        geometry["coordinates"]
        if geometry["type"] == "MultiPolygon"
        else [geometry["coordinates"]]
    )
    out = [[rounded_ring(ring) for ring in rings] for rings in polygons]
    return out if geometry["type"] == "MultiPolygon" else out[0]


def main(source: str, target: str) -> None:
    features = []
    with open(source) as file:
        source_features = json.load(file)["features"]
    for feature in source_features:
        parts = pieces(feature["geometry"])
        shape = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        geometry = mapping(shape)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "code": feature["properties"]["Code"],
                    "name": feature["properties"]["PlateName"],
                },
                "geometry": {
                    "type": geometry["type"],
                    "coordinates": rounded(geometry),
                },
            }
        )
    features.sort(key=lambda f: f["properties"]["name"])
    with open(target, "w") as out:
        json.dump(
            {"type": "FeatureCollection", "features": features},
            out,
            separators=(",", ":"),
        )
        out.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:3])
