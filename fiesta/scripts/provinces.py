# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2"]
# ///
"""Build fiesta/backend/fiesta/data/provinces.json, the outlines of the
`plate_block` vocabulary's cratons, blocks and terranes, from Hasterok et al.
(2022)'s geologic provinces and fiesta/scripts/province_terms.json.

The source is `plates&provinces/global_gprv.gmt` (OGR GMT, already split at
the antimeridian) from the CC-BY-4.0 Zenodo record 10.5281/zenodo.6586972
(global_tectonics.zip). Each term becomes one feature, `{code, name, sources}`:
the union of its provinces and province groups, simplified to about 1 km,
counter-clockwise, coordinates rounded to 4 decimals the way plates.py rounds
them (OpenSearch refuses the repeats and spikes rounding leaves). `code` is
the term as a slug ("kaapvaal-craton"): lower case, so it never collides with
PB2002's two-letter plate codes.

    uv run fiesta/scripts/provinces.py <global_gprv.gmt> \\
        fiesta/scripts/province_terms.json fiesta/backend/fiesta/data/provinces.json
"""

import csv
import json
import re
import sys
from collections import defaultdict

from plates import rounded
from shapely.geometry import MultiPolygon, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.validation import make_valid

SIMPLIFY = 0.01  # degrees


def read_gmt(path: str) -> list[tuple[dict, list[Polygon]]]:
    """(attributes, polygons) per feature of an OGR GMT polygon file: `>`
    starts a feature, `# @D` holds its attributes, `# @H` starts a hole, and
    `>` with no attributes since the last one starts another polygon."""
    header: list[str] = []
    features: list[tuple[dict, list[Polygon]]] = []
    rings: list[list[tuple[float, float]]] = []
    ring: list[tuple[float, float]] | None = None

    def close_polygon():
        nonlocal rings
        if rings and len(rings[0]) > 3:
            features[-1][1].append(Polygon(rings[0], [r for r in rings[1:] if len(r) > 3]))
        rings = []

    with open(path, encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line.startswith("# @N"):
                header = line[4:].split("|")
            elif line.startswith("# @D"):
                close_polygon()
                values = next(csv.reader([line[4:]], delimiter="|"))
                features.append((dict(zip(header, values, strict=False)), []))
            elif line.startswith("# @P"):
                close_polygon()
                ring = []
                rings.append(ring)
            elif line.startswith("# @H"):
                ring = []
                rings.append(ring)
            elif line.startswith(">"):
                if features and rings:
                    close_polygon()
                ring = []
                rings.append(ring)
            elif line and not line.startswith("#") and ring is not None:
                lon, lat = map(float, line.split()[:2])
                ring.append((lon, lat))
    close_polygon()
    return features


def kept(geometry: dict) -> dict:
    """The rounded geometry without the rings rounding left under four points
    (a hole, or a polygon whose shell, gone)."""
    polygons = rounded(geometry)
    if geometry["type"] == "Polygon":
        polygons = [polygons]
    polygons = [
        [ring for ring in rings if len(ring) >= 4] for rings in polygons if len(rings[0]) >= 4
    ]
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main(source: str, terms_path: str, target: str) -> None:
    by_name: dict[str, list[Polygon]] = defaultdict(list)
    by_group: dict[str, list[Polygon]] = defaultdict(list)
    for attributes, polygons in read_gmt(source):
        by_name[attributes["prov_name"]].extend(polygons)
        if attributes.get("prov_group"):
            by_group[attributes["prov_group"]].extend(polygons)
    with open(terms_path) as file:
        terms = json.load(file)["terms"]
    features = []
    for term in terms:
        parts: list[Polygon] = []
        for name in term.get("provinces", []):
            if name not in by_name:
                raise SystemExit(f"{term['name']}: no province named {name!r}")
            parts.extend(by_name[name])
        for group in term.get("groups", []):
            if group not in by_group:
                raise SystemExit(f"{term['name']}: no province group {group!r}")
            parts.extend(by_group[group])
        shape = make_valid(unary_union([make_valid(p) for p in parts]))
        shape = shape.simplify(SIMPLIFY, preserve_topology=True)
        # Without the slivers left where neighbouring provinces' edges miss.
        polygons = [
            orient(
                Polygon(p.exterior, [i for i in p.interiors if Polygon(i).area > SIMPLIFY]),
                1.0,
            )
            for p in getattr(shape, "geoms", [shape])
            if isinstance(p, Polygon) and p.area > SIMPLIFY**2
        ]
        shape = polygons[0] if len(polygons) == 1 else MultiPolygon(polygons)
        geometry = mapping(shape)
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "code": slug(term["name"]),
                    "name": term["name"],
                    "sources": sorted(term.get("provinces", []) + term.get("groups", [])),
                },
                "geometry": kept(geometry),
            }
        )
    features.sort(key=lambda f: f["properties"]["name"])
    with open(target, "w") as out:
        json.dump({"type": "FeatureCollection", "features": features}, out, separators=(",", ":"))
        out.write("\n")


if __name__ == "__main__":
    main(*sys.argv[1:4])
