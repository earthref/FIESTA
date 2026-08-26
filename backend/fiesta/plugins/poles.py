"""MagIC: paleomagnetic poles — derived, searchable pole documents.

The legacy app had a `Poles` view (a sub-tab of the Locations level) querying
docs with `type: "poles"`, but nothing ever indexed them (the view was driven
client-side from location rows). This plugin makes the intent real: at
summarize time, every locations row carrying both `pole_lat` and `pole_lon`
becomes a `poles` search doc. `poles` is a searchable table (not a top-level
tab); the frontend surfaces it as a sub-tab of Locations, after "Rows".
"""

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from fiesta.apps.deps import NodeDep
from fiesta.domain.parse import ParsedContribution
from fiesta.domain.summarize import FACETABLE_COLUMNS
from fiesta.nodeconfig import NodeConfig
from fiesta.plugins.base import FiestaPlugin
from fiesta.plugins.util import to_float

# MagIC age_unit controlled vocabulary → years-before-present multiplier.
AGE_UNIT_YEARS = {
    "Ga": 1e9,
    "Ma": 1e6,
    "ka": 1e3,
    "Ka": 1e3,
    "Years": 1.0,
    "Years BP": 1.0,
    "Years Cal BP": 1.0,
    "Years AD": 1.0,
    "Years Cal AD": 1.0,
}


class PolesPlugin(FiestaPlugin):
    name = "poles"

    #: Columns surfaced on the pole list item, in render order (MagIC 3.0
    #: names the a95 column `pole_alpha95`).
    DISPLAY_COLUMNS = ["pole_lat", "pole_lon", "pole_alpha95", "age", "age_unit"]

    #: Poles attach as a sub-tab of this level (after its "Rows" view),
    #: matching the legacy MagIC layout — not a top-level tab.
    BASE_LEVEL = "Locations"

    def search_tables(self, node: NodeConfig) -> list[str]:
        return ["poles"]

    def derive_docs(
        self, node: NodeConfig, parsed: ParsedContribution, contribution_meta: dict
    ) -> list[dict]:
        docs: list[dict] = []
        for row in parsed.tables.get("locations", []):
            pole_lat = to_float(row.get("pole_lat"))
            pole_lon = to_float(row.get("pole_lon"))
            if pole_lat is None or pole_lon is None:
                continue
            all_block: dict[str, Any] = {
                "pole_lat": [str(pole_lat)],
                "pole_lon": [str(pole_lon)],
            }
            for column in FACETABLE_COLUMNS:
                if row.get(column):
                    all_block[column] = [
                        v.strip() for v in str(row[column]).split(":") if v.strip()
                    ]
            if -90 <= pole_lat <= 90:
                all_block["_geo_point"] = {
                    "lat": pole_lat,
                    "lon": ((pole_lon + 180) % 360) - 180,
                }
            # Numeric copies (JSON numbers map to numeric OpenSearch fields)
            # so age/alpha95 range filters work; string row values don't. Age
            # is normalized to years-before-present via age_unit so the color
            # gradient and legend are consistent across mixed-unit poles.
            numeric_block = {"pole_lat": pole_lat, "pole_lon": pole_lon}
            alpha95 = to_float(row.get("pole_alpha95"))
            if alpha95 is not None:
                numeric_block["pole_alpha95"] = alpha95
            unit_factor = AGE_UNIT_YEARS.get((row.get("age_unit") or "Ma").strip(), 1e6)
            age = to_float(row.get("age"))
            if age is None:
                low, high = to_float(row.get("age_low")), to_float(row.get("age_high"))
                if low is not None and high is not None:
                    age = (low + high) / 2
            if age is not None:
                numeric_block["age"] = age * unit_factor  # years before present
            docs.append(
                {
                    "type": "poles",
                    "summary": {
                        "contribution": contribution_meta,
                        "locations": dict(row),
                        "poles": numeric_block,
                        "_all": all_block,
                    },
                    "rows": [row],
                }
            )
        return docs

    def build_router(self, node: NodeConfig) -> APIRouter:
        router = APIRouter()

        @router.get("/plate-boundaries")
        async def plate_boundaries(node: NodeDep) -> dict:
            """Tectonic plate boundary polygons (GeoJSON) for the globes."""
            path = node.base_dir / node.node.slug / "plate_boundaries.json"
            if not path.exists():
                raise HTTPException(404, "this node has no plate boundary data")
            import json

            return json.loads(path.read_text())

        @router.get("/base-texture")
        async def base_texture(node: NodeDep) -> FileResponse:
            """Earth relief image used as the globe surface texture."""
            path = node.base_dir / node.node.slug / "global_relief_map.jpg"
            if not path.exists():
                raise HTTPException(404, "this node has no globe texture")
            return FileResponse(path, media_type="image/jpeg")

        return router

    def frontend_config(self, node: NodeConfig) -> dict:
        return {
            "view": "poles",
            "table": "poles",
            # Rendered as a sub-tab of this level, placed after its "Rows" view.
            "base_level": self.BASE_LEVEL,
            "after_sub_tab": "Rows",
            "display_columns": self.DISPLAY_COLUMNS,
            # Structured filter definitions: the UI renders these controls and
            # maps them onto the search API's `range`/`bbox` params.
            "filters": [
                {
                    "name": "Age",
                    "type": "range",
                    "field": "summary.poles.age",
                    "unit": "Ma",
                    # Field is stored in years; multiply the Ma input by this.
                    "scale": 1e6,
                },
                {
                    "name": "Pole A95",
                    "type": "range",
                    "field": "summary.poles.pole_alpha95",
                    "unit": "°",
                },
                {"name": "Geospatial", "type": "bbox"},
            ],
            "has_plate_boundaries": (
                node.base_dir / node.node.slug / "plate_boundaries.json"
            ).exists(),
            "has_base_texture": (
                node.base_dir / node.node.slug / "global_relief_map.jpg"
            ).exists(),
            # Poles are colored by an age gradient (young→old): yellow→red,
            # black for unknown age, purple for the selected pole.
            "age_color": {
                "young": "#ffff00",
                "old": "#ff0000",
                "unknown": "#000000",
                "selected": "#800080",
            },
            "plate_boundary_color": "#990000",
        }
